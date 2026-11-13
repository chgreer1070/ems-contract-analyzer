import { DOMParser } from "@xmldom/xmldom";
import path from "node:path";
import { DOCX_LIMITS, readDocxPackage } from "./docxPackage";
import { DOCX_CHUNK_PREFIX, DOCX_EXTRACTOR_VERSION, projectDocxParagraph, type DocxEvidence, type DocxParagraph, type XmlNode, type XmlSource } from "./docxEvidence";
import { sha256 } from "./docxReceipt";
import type { SourceChunk } from "./chunking";

const W="http://schemas.openxmlformats.org/wordprocessingml/2006/main";
const R="http://schemas.openxmlformats.org/officeDocument/2006/relationships";
const REL="http://schemas.openxmlformats.org/package/2006/relationships";
const CT="http://schemas.openxmlformats.org/package/2006/content-types";
const MC="http://schemas.openxmlformats.org/markup-compatibility/2006";
const REVISION_NAMES=new Set(["ins","del","moveFrom","moveTo","pPrChange","rPrChange","sectPrChange","tblPrChange","tblGridChange","trPrChange","tcPrChange","cellIns","cellDel","cellMerge","numberingChange"]);
const STORY_KINDS:Record<string,string>={document:"body",hdr:"header",ftr:"footer",footnotes:"footnotes",endnotes:"endnotes",comments:"comments"};
const CONTENT_NAMES=new Set(["document","body","hdr","ftr","footnotes","footnote","endnotes","endnote","comments","comment","p","r","t","delText","tab","br","cr","ins","del","hyperlink","bookmarkStart","bookmarkEnd","commentRangeStart","commentRangeEnd","commentReference","tbl","tblGrid","gridCol","tr","tc","sectPr","headerReference","footerReference","footnoteReference","endnoteReference","footnoteRef","endnoteRef","separator","continuationSeparator","lastRenderedPageBreak","proofErr","permStart","permEnd","txbxContent"]);
const PROPERTY_ROOTS=new Set(["pPr","rPr","tblPr","trPr","tcPr","sectPr"]);
const UNSUPPORTED:Record<string,string>={
  drawing:"A drawing or image without plain text-box words requires visual review.",pict:"A legacy drawing or image without plain text-box words requires visual review.",object:"Embedded objects are not interpreted.",altChunk:"Alternative-format content is not interpreted.",sdt:"Content controls and data bindings are not interpreted.",customXml:"Custom XML content may affect document meaning.",fldSimple:"Fields are not evaluated; cached values can be stale.",fldChar:"Complex fields are not evaluated; cached values can be stale.",instrText:"Field instructions are not evaluated.",delInstrText:"Deleted field instructions are not evaluated.",sym:"Font-dependent symbols are not decoded.",vanish:"Hidden text affects the displayed agreement.",webHidden:"Hidden text affects the displayed agreement.",bidi:"Bidirectional layout requires visual review.",rtl:"Right-to-left layout requires visual review.",moveFrom:"Tracked moves require validated move-pair interpretation.",moveTo:"Tracked moves require validated move-pair interpretation.",moveFromRangeStart:"Tracked move ranges require validated move-pair interpretation.",moveToRangeStart:"Tracked move ranges require validated move-pair interpretation.",subDoc:"Linked subdocuments are not loaded.",numPr:"Automatic numbering is preserved but labels are not resolved.",framePr:"Floating paragraph placement requires layout review."
};
const local=(node:XmlNode)=>node.name.split(":").at(-1)!;
const attr=(node:XmlNode,name:string,namespace=W)=>node.attributes.find(a=>a.namespace===namespace&&a.name.split(":").at(-1)===name)?.value??null;
const child=(node:XmlNode,name:string)=>node.children.find(n=>n.namespace===W&&local(n)===name)??null;
const descendants=(node:XmlNode,predicate:(n:XmlNode)=>boolean):XmlNode[]=>{const found:XmlNode[]=[];const visit=(n:XmlNode)=>{if(predicate(n))found.push(n);n.children.forEach(visit);};visit(node);return found;};
const IMAGE_PARTS=new Set(["blip","imagedata","object","oleObj","movie"]);
const XMLNS="http://www.w3.org/2000/xmlns/";
// mc:Choice Requires lists prefixes. A prefix counts only when that prefix is bound, in scope, to one of these shape namespaces.
const SUPPORTED_TEXT_BOX_NAMESPACE=new Set(["http://schemas.microsoft.com/office/word/2010/wordprocessingShape","http://schemas.microsoft.com/office/word/2010/wordprocessingGroup","http://schemas.microsoft.com/office/word/2010/wordprocessingCanvas"]);
const xmlParents=new WeakMap<XmlNode,XmlNode>();
const branchChildren=(node:XmlNode)=>node.children.filter(child=>child.text===null&&child.namespace===MC&&(local(child)==="Choice"||local(child)==="Fallback"));
function namespaceBindings(node:XmlNode){
  const chain:XmlNode[]=[];
  for(let current:XmlNode|undefined=node;current;current=xmlParents.get(current))chain.push(current);
  const bindings=new Map<string,string>();
  for(const item of chain.reverse())for(const attribute of item.attributes){
    if(attribute.namespace!==XMLNS&&!attribute.name.startsWith("xmlns:"))continue;
    if(attribute.name==="xmlns")continue;
    const prefix=attribute.name.startsWith("xmlns:")?attribute.name.slice("xmlns:".length):attribute.name.split(":").at(-1)!;
    if(prefix)bindings.set(prefix,attribute.value);
  }
  return bindings;
}
function choiceUsesSupportedShape(node:XmlNode){
  const tokens=(attr(node,"Requires","")??attr(node,"Requires",MC)??"").trim().split(/\s+/).filter(Boolean);
  if(!tokens.length)return false;
  const bindings=namespaceBindings(node);
  return tokens.every(token=>SUPPORTED_TEXT_BOX_NAMESPACE.has(bindings.get(token)??""));
}
function preferredTextBoxBranch(node:XmlNode){
  const branches=branchChildren(node);
  // The namespace decides the branch. A supported Choice stays selected even when
  // it is not a plain text box, so an image there blocks instead of publishing the Fallback.
  const supported=branches.find(child=>local(child)==="Choice"&&choiceUsesSupportedShape(child));
  if(supported)return supported;
  return branches.find(child=>local(child)==="Fallback"&&plainTextBox(child))??null;
}
function outsideTextBox(boxes:XmlNode[],item:XmlNode){
  return !boxes.some(box=>item.source.path===box.source.path||item.source.path.startsWith(`${box.source.path}/`));
}
function plainTextBox(node:XmlNode){
  const boxes=descendants(node,n=>n!==node&&n.namespace===W&&local(n)==="txbxContent");
  if(!boxes.length)return false;
  const words=descendants(node,n=>n.namespace===W&&["t","delText","tab","br","cr"].includes(local(n)));
  if(!words.length||!words.every(word=>boxes.some(box=>word.source.path.startsWith(`${box.source.path}/`))))return false;
  if(descendants(node,n=>IMAGE_PARTS.has(local(n))).length)return false;
  const wordArt=descendants(node,n=>outsideTextBox(boxes,n)&&local(n)==="textpath"&&(n.attributes.find(a=>a.name.split(":").at(-1)==="string")?.value??"").trim()!=="");
  return !wordArt.length;
}
// Same gate as w:vanish: words that are not on the page are not contract text.
const SHAPE_HIDDEN_FLAG=new Set(["docPr","cNvPr","shape","group","rect","roundrect","oval"]);
type ShapeVisibility="shown"|"hidden"|"unresolved";
function combineVisibility(state:ShapeVisibility|null,next:ShapeVisibility|null):ShapeVisibility|null{
  if(next===null)return state;
  if(state===null||state===next)return next;
  if(state==="shown")return next;
  return "unresolved";
}
function styleVisibility(style:string):ShapeVisibility|null{
  let found:string|null=null;
  for(const part of style.split(";")){
    const split=part.indexOf(":");
    if(split<0||part.slice(0,split).trim().toLowerCase()!=="visibility")continue;
    const value=part.slice(split+1).trim().toLowerCase();
    if(found!==null&&found!==value)return "unresolved";
    found=value;
  }
  if(found===null)return null;
  if(found==="visible")return "shown";
  if(found==="hidden")return "hidden";
  return "unresolved";
}
function hiddenFlag(value:string):ShapeVisibility{
  const flag=value.trim().toLowerCase();
  if(["1","true","on"].includes(flag))return "hidden";
  if(["0","false","off"].includes(flag))return "shown";
  return "unresolved";
}
function wrapperVisibility(node:XmlNode):ShapeVisibility{
  let state:ShapeVisibility|null=null;
  const visit=(item:XmlNode)=>{
    if(item.text!==null)return;
    state=combineVisibility(state,styleVisibility(item.attributes.find(a=>a.name.split(":").at(-1)==="style")?.value??""));
    if(SHAPE_HIDDEN_FLAG.has(local(item)))for(const attribute of item.attributes)if(attribute.name.split(":").at(-1)==="hidden")state=combineVisibility(state,hiddenFlag(attribute.value));
    item.children.forEach(visit);
  };
  visit(node);
  return state??"shown";
}
function ancestorName(name:string){return name.split(":").at(-1)??"";}
function eachVisible(node:XmlNode,visit:(item:XmlNode)=>void){
  if(node.text!==null)return;
  visit(node);
  const preferred=node.namespace===MC&&local(node)==="AlternateContent"?preferredTextBoxBranch(node):null;
  (preferred?[preferred]:node.children).forEach(child=>eachVisible(child,visit));
}
type FootnoteRestart="continuous"|"eachSect";
type FootnoteField<T>={kind:"unset"}|{kind:"set";value:T}|{kind:"unresolved"};
type FootnoteFields={fmt:FootnoteField<"decimal">;start:FootnoteField<number>;restart:FootnoteField<FootnoteRestart>};
const unsetFootnoteFields=():FootnoteFields=>({fmt:{kind:"unset"},start:{kind:"unset"},restart:{kind:"unset"}});
const unresolvedFootnoteFields=():FootnoteFields=>({fmt:{kind:"unresolved"},start:{kind:"unresolved"},restart:{kind:"unresolved"}});
function assignFootnoteField<T>(current:FootnoteField<T>,accepted:T|null):FootnoteField<T>{
  if(current.kind==="unresolved"||accepted===null)return {kind:"unresolved"};
  if(current.kind==="set")return current.value===accepted?current:{kind:"unresolved"};
  return {kind:"set",value:accepted};
}
function readFootnoteFields(props:XmlNode|null):FootnoteFields|"absent"{
  if(!props)return "absent";
  const fields=unsetFootnoteFields();
  for(const item of props.children){
    if(item.text!==null)continue;
    if(item.namespace!==W)return unresolvedFootnoteFields();
    const name=local(item),value=attr(item,"val");
    if(name==="pos")continue;
    // An unsupported or repeated value stays unresolved. A later supported value cannot clear it.
    if(name==="numFmt"){fields.fmt=assignFootnoteField(fields.fmt,value==="decimal"?"decimal":null);continue;}
    if(name==="numStart"){fields.start=assignFootnoteField(fields.start,value!==null&&/^[0-9]{1,9}$/.test(value)?Number(value):null);continue;}
    if(name==="numRestart"){fields.restart=assignFootnoteField(fields.restart,value==="continuous"||value==="eachSect"?value:null);continue;}
    return unresolvedFootnoteFields();
  }
  return fields;
}
function mergeFootnoteFields(base:FootnoteFields,overlay:FootnoteFields):FootnoteFields{
  const pick=<T>(current:FootnoteField<T>,next:FootnoteField<T>)=>next.kind==="unset"?current:next;
  return {fmt:pick(base.fmt,overlay.fmt),start:pick(base.start,overlay.start),restart:pick(base.restart,overlay.restart)};
}
function footnoteMode(fields:FootnoteFields,explicitStart:boolean):{start:number;restart:FootnoteRestart;explicitStart:boolean}|null{
  if(fields.fmt.kind!=="set"||fields.start.kind!=="set"||fields.restart.kind!=="set")return null;
  return {start:fields.start.value,restart:fields.restart.value,explicitStart};
}
// Document defaults live in word/settings.xml. A section w:footnotePr replaces
// only the properties it names. A format this reader cannot count stays unresolved.
function documentFootnoteDefaults(parts:DocxEvidence["parts"],relationships:DocxEvidence["relationships"],mainPart:string):FootnoteFields|null{
  const implicit:FootnoteFields={fmt:{kind:"set",value:"decimal"},start:{kind:"set",value:1},restart:{kind:"set",value:"continuous"}};
  const links=relationships.filter(item=>item.part===mainPart&&!item.external&&item.type===`${R}/settings`);
  if(!links.length)return implicit;
  if(links.length!==1||!links[0].resolvedTarget)return null;
  const tree=parts.find(part=>part.part===links[0].resolvedTarget)?.tree??null;
  if(!tree||tree.namespace!==W||local(tree)!=="settings")return null;
  const props=tree.children.filter(node=>node.text===null&&node.namespace===W&&local(node)==="footnotePr");
  if(props.length>1)return null;
  if(!props.length)return implicit;
  const fields=readFootnoteFields(props[0]);
  return fields==="absent"?implicit:mergeFootnoteFields(implicit,fields);
}
function sectionFootnoteMode(defaults:FootnoteFields,sectPr:XmlNode|null){
  const props=sectPr?sectPr.children.filter(node=>node.text===null&&node.namespace===W&&local(node)==="footnotePr"):[];
  if(props.length>1)return null;
  const sectionFields=readFootnoteFields(props[0]??null);
  if(sectionFields==="absent")return footnoteMode(defaults,false);
  return footnoteMode(mergeFootnoteFields(defaults,sectionFields),sectionFields.start.kind==="set");
}
function bodySections(body:XmlNode){
  const sections:Array<{nodes:XmlNode[];sectPr:XmlNode|null}>=[];
  let nodes:XmlNode[]=[];
  for(const node of body.children){
    if(node.text!==null)continue;
    if(node.namespace===W&&local(node)==="sectPr"){sections.push({nodes,sectPr:node});nodes=[];continue;}
    nodes.push(node);
    if(node.namespace===W&&local(node)==="p"){
      const properties=child(node,"pPr"),sectPr=properties?child(properties,"sectPr"):null;
      if(sectPr){sections.push({nodes,sectPr});nodes=[];}
    }
  }
  if(nodes.length)sections.push({nodes,sectPr:null});
  return sections;
}
function footnoteReferences(nodes:XmlNode[]){
  const found:XmlNode[]=[];
  for(const node of nodes)eachVisible(node,item=>{if(item.namespace===W&&local(item)==="footnoteReference")found.push(item);});
  return found;
}
// w:id locates the note in XML. It is not the number Word shows. Count the
// displayed number when settings and each section use decimal numbering this
// reader can follow. Otherwise say the XML id outright instead of sending a
// reader to the wrong footnote.
function displayedFootnoteLabels(main:XmlNode,stories:Array<{part:string;tree:XmlNode|null}>,defaults:FootnoteFields|null):Map<string,string>|null{
  if(!defaults)return null;
  for(const story of stories){
    if(!story.tree||story.part===main.source.part)continue;
    const kind=STORY_KINDS[local(story.tree)];
    if(kind!=="header"&&kind!=="footer"&&kind!=="comments")continue;
    let outside=false;
    eachVisible(story.tree,item=>{if(item.namespace===W&&local(item)==="footnoteReference")outside=true;});
    if(outside)return null;
  }
  const body=child(main,"body");
  if(!body)return null;
  const labels=new Map<string,string>(),used=new Set<string>();
  let next:number|null=null;
  for(const section of bodySections(body)){
    const mode=sectionFootnoteMode(defaults,section.sectPr);
    if(!mode)return null;
    if(next===null||mode.restart==="eachSect")next=mode.start;
    else if(mode.explicitStart&&mode.start!==next)return null;
    const ids:string[]=[];
    for(const reference of footnoteReferences(section.nodes)){
      const id=attr(reference,"id"),custom=attr(reference,"customMarkFollows");
      if(id===null||labels.has(id)||ids.includes(id)||(custom!==null&&!["0","false","off"].includes(custom)))return null;
      ids.push(id);
    }
    for(const id of ids){
      const label=`Footnote ${next}`;
      if(used.has(label))return null;
      used.add(label);labels.set(id,label);next!+=1;
    }
  }
  return labels;
}
function structuralLocator(paragraph:DocxParagraph,nodeIndex:Map<string,XmlNode>,sectionLabel:string,footnoteLabel:(id:string)=>string){
  const footnote=paragraph.ancestors.find(item=>ancestorName(item.name)==="footnote");
  if(footnote){
    const node=nodeIndex.get(footnote.source.path);
    if(!node)return null;
    const type=attr(node,"type");
    if(type&&["separator","continuationSeparator","continuationNotice"].includes(type))return null;
    const id=attr(node,"id");
    return id===null?null:footnoteLabel(id);
  }
  return paragraph.ancestors.some(item=>ancestorName(item.name)==="txbxContent")?`Text box in section ${sectionLabel}`:null;
}
function plainText(node:XmlNode):string{
  if(node.namespace===W&&["t","delText"].includes(local(node)))return node.children.map(n=>n.text??"").join("");
  if(node.namespace===W&&local(node)==="tab")return "\t";
  if(node.namespace===W&&["br","cr"].includes(local(node)))return "\n";
  return node.children.map(plainText).join("");
}

function decodeXml(bytes:Buffer){
  let encoding="utf-8",offset=0;
  if(bytes[0]===0xff&&bytes[1]===0xfe){encoding="utf-16le";offset=2;}
  else if(bytes[0]===0xfe&&bytes[1]===0xff){encoding="utf-16be";offset=2;}
  const value=new TextDecoder(encoding,{fatal:true}).decode(bytes.subarray(offset));
  const declaration=value.match(/^\s*<\?xml\s[^?]*encoding\s*=\s*['"]([^'"]+)['"]/i)?.[1]?.toLowerCase();
  if(declaration&&!((encoding==="utf-8"&&["utf-8","utf8"].includes(declaration))||(encoding.startsWith("utf-16")&&["utf-16",encoding].includes(declaration))))throw new Error("Unsupported or inconsistent XML encoding.");
  if(/<!DOCTYPE|<!ENTITY/i.test(value)||/[\u0000-\u0008\u000b\u000c\u000e-\u001f]/.test(value))throw new Error("DOCX XML DTDs, entities and invalid control characters are blocked.");
  // Bound depth before the DOM parser sees adversarial nested input. This is a
  // conservative lexical limit; the DOM then validates the actual XML tree.
  let depth=0,count=0;
  for(const tag of value.matchAll(/<!--[\s\S]*?-->|<!\[CDATA\[[\s\S]*?\]\]>|<\?[\s\S]*?\?>|<[^>]+>/g)){
    if(/^<\?|^<!/.test(tag[0]))continue;
    if(tag[0].startsWith("</"))depth--;else if(!tag[0].endsWith("/>"))depth++;
    if(++count>DOCX_LIMITS.xmlNodes||depth>DOCX_LIMITS.xmlDepth)throw new Error("DOCX XML node/depth limit exceeded.");
  }
  return value;
}

function parseXml(bytes:Buffer,part:string,budget:{nodes:number;treeBytes:number}):XmlNode{
  const diagnostics:string[]=[];
  const doc=new DOMParser({errorHandler:{warning:m=>diagnostics.push(String(m)),error:m=>diagnostics.push(String(m)),fatalError:m=>diagnostics.push(String(m))}}).parseFromString(decodeXml(bytes),"application/xml");
  if(diagnostics.length||!doc.documentElement||Array.from({length:doc.childNodes.length},(_,i)=>doc.childNodes.item(i)).filter(n=>n?.nodeType===1).length!==1)throw new Error(`Malformed XML in ${part}; parser recovery is forbidden.`);
  const convert=(node:Node,sourcePath:string,depth:number):XmlNode=>{
    if(++budget.nodes>DOCX_LIMITS.xmlNodes||depth>DOCX_LIMITS.xmlDepth)throw new Error("DOCX XML tree limit exceeded.");
    const element=node.nodeType===1?node as Element:null;
    if(node.nodeName.length>DOCX_LIMITS.xmlNameChars||sourcePath.length>DOCX_LIMITS.xmlPathChars||(element?.attributes.length??0)>DOCX_LIMITS.xmlAttributes)throw new Error("DOCX XML name/path/attribute limit exceeded.");
    const attributes=element?Array.from({length:element.attributes.length},(_,i)=>element.attributes.item(i)!).map(a=>({name:a.name,namespace:a.namespaceURI??"",value:a.value})):[];
    if(attributes.some(a=>a.name.length>DOCX_LIMITS.xmlNameChars))throw new Error("DOCX XML attribute-name limit exceeded.");
    budget.treeBytes+=Buffer.byteLength(sourcePath)+Buffer.byteLength(node.nodeValue??"")+Buffer.byteLength(JSON.stringify(attributes))+256;
    if(budget.treeBytes>DOCX_LIMITS.receiptBytes)throw new Error("DOCX structured XML tree exceeds its supported evidence budget.");
    const counters=new Map<string,number>();
    const children=Array.from({length:node.childNodes?.length??0},(_,i)=>node.childNodes.item(i)!).map(n=>{
      const name=n.nodeType===3?"text()":n.nodeName;
      const key=`${n.nodeType===1?(n as Element).namespaceURI??"":""}:${name}`,index=(counters.get(key)??0)+1;counters.set(key,index);
      return convert(n,`${sourcePath}/${name}[${index}]`,depth+1);
    });
    const converted:XmlNode={name:node.nodeName,namespace:element?.namespaceURI??"",attributes,source:{part,path:sourcePath},text:element?null:node.nodeValue,children};
    for(const item of children)if(item.text===null)xmlParents.set(item,converted);
    return converted;
  };
  return convert(doc.documentElement,`/${doc.documentElement.nodeName}[1]`,0);
}

function relationshipOwner(part:string){
  if(part==="_rels/.rels")return "";
  const match=part.match(/^(.*\/)?_rels\/([^/]+)\.rels$/);
  if(!match)throw new Error("Invalid DOCX relationships part path.");
  return `${match[1]??""}${match[2]}`;
}
function resolveTarget(owner:string,target:string){
  const decoded=decodeURIComponent(target);
  if(/[\\?#\u0000-\u001f]/.test(decoded)||/^[a-z][a-z0-9+.-]*:/i.test(decoded))throw new Error("Unsupported internal DOCX relationship target.");
  const result=path.posix.normalize(decoded.startsWith("/")?decoded.slice(1):path.posix.join(path.posix.dirname(owner),decoded));
  if(result.startsWith("../")||result===".."||!result||result===".")throw new Error("DOCX relationship escapes its package.");
  return result;
}

export function extractDocx(bytes:ArrayBuffer):{evidence:DocxEvidence;chunks:SourceChunk[]}{
  const evidence:DocxEvidence={version:1,extractorVersion:DOCX_EXTRACTOR_VERSION,sourceSha256:sha256(Buffer.from(bytes)),legalEvidenceReady:false,analysisEligible:false,issues:[],parts:[],relationships:[],stories:[],revisions:[],comments:[],references:[]};
  const issue=(code:string,message:string,source:XmlSource|null=null,blocking=true)=>evidence.issues.push({code,message,source,blocking});
  try{
    const packageParts=readDocxPackage(bytes),budget={nodes:0,treeBytes:0};
    for(const [part,data] of [...packageParts].sort(([a],[b])=>a.localeCompare(b))){
      const xml=part.endsWith(".xml")||part.endsWith(".rels");
      evidence.parts.push({part,sha256:sha256(data),sizeBytes:data.length,tree:xml?parseXml(data,part,budget):null});
      if(!xml&&!/^docProps\/thumbnail\.(?:jpeg|jpg|png)$/i.test(part))issue("UNSUPPORTED_BINARY_PART","Binary content (images, embedded objects or signatures) requires separate review.",{part,path:"/"});
    }
    const types=evidence.parts.find(p=>p.part==="[Content_Types].xml")?.tree;
    if(!types||types.namespace!==CT||local(types)!=="Types")throw new Error("DOCX content-types manifest is missing or invalid.");
    const overrides=new Map<string,string>(),defaults=new Map<string,string>();
    for(const node of types.children.filter(n=>n.text===null)){
      if(node.namespace!==CT)throw new Error("Invalid DOCX content-type namespace.");
      if(local(node)==="Override"){
        const raw=attr(node,"PartName",""),type=attr(node,"ContentType","");
        if(!raw?.startsWith("/")||!type)throw new Error("Invalid DOCX content-type override.");
        const part=resolveTarget("",raw);if(overrides.has(part)||!packageParts.has(part))throw new Error("Duplicate or dangling DOCX content-type override.");overrides.set(part,type);
      }else if(local(node)==="Default"){
        const ext=attr(node,"Extension",""),type=attr(node,"ContentType","");if(!ext||!type||defaults.has(ext.toLowerCase()))throw new Error("Invalid DOCX default content type.");defaults.set(ext.toLowerCase(),type);
      }else throw new Error("Unknown DOCX content-type entry.");
    }
    for(const part of evidence.parts){
      if(part.part!=="[Content_Types].xml"&&!overrides.has(part.part)&&!defaults.has(part.part.split(".").at(-1)!.toLowerCase()))issue("MISSING_CONTENT_TYPE","Package part lacks a content type.",{part:part.part,path:"/"});
      if(!part.part.endsWith(".rels"))continue;
      const tree=part.tree!,owner=relationshipOwner(part.part),ids=new Set<string>();
      if(tree.namespace!==REL||local(tree)!=="Relationships"||(owner&&!packageParts.has(owner)))throw new Error("Invalid DOCX relationship owner or namespace.");
      for(const node of tree.children.filter(n=>n.text===null)){
        const id=attr(node,"Id",""),type=attr(node,"Type",""),target=attr(node,"Target",""),mode=attr(node,"TargetMode","");
        if(node.namespace!==REL||local(node)!=="Relationship"||!id||!type||!target||ids.has(id)||(mode&&mode!=="External"&&mode!=="Internal"))throw new Error("Invalid or duplicate DOCX relationship.");ids.add(id);
        const external=mode==="External",resolvedTarget=external?null:resolveTarget(owner,target);
        evidence.relationships.push({part:owner,id,type,target,resolvedTarget,external});
        if(external)issue("EXTERNAL_RELATIONSHIP","External content is never fetched; this relationship is preserved.",node.source,!type.endsWith("/hyperlink"));
        else if(!packageParts.has(resolvedTarget!))issue("MISSING_RELATIONSHIP_TARGET","Relationship target is absent from the package.",node.source);
      }
    }
    const mains=evidence.relationships.filter(r=>r.part===""&&r.type===`${R}/officeDocument`&&!r.external);
    if(mains.length!==1)throw new Error("DOCX must have exactly one supported main-document relationship.");
    const main=evidence.parts.find(p=>p.part===mains[0].resolvedTarget)?.tree;
    if(!main||main.namespace!==W||local(main)!=="document")throw new Error("Unsupported main-document namespace/type (Strict OOXML is not yet supported).");
    if(main.children.filter(n=>n.namespace===W&&local(n)==="body").length!==1)throw new Error("DOCX main document must contain exactly one body.");
    if(overrides.get(main.source.part)!=="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml")throw new Error("DOCX main part is not an ordinary Word document (macros/templates are blocked).");
    const styles=evidence.parts.filter(p=>p.tree?.namespace===W&&local(p.tree)==="styles");
    // Style-defined numbering/hidden content can alter meaning even without a
    // direct paragraph property. Retain it, but block unresolved display rules.
    const revisionByPath=new Map<string,string>(),revisionIdentity=new Map<string,string|null>(),commentById=new Map<string,DocxEvidence["comments"][number]>(),noteById=new Map<string,XmlSource>();let revisionBytes=0;
    const sourceKey=(source:XmlSource)=>`${source.part}:${source.path}`;
    const skippedBranches:XmlSource[]=[];
    const underSkipped=(source:XmlSource)=>skippedBranches.some(item=>item.part===source.part&&(source.path===item.path||source.path.startsWith(`${item.path}/`)));
    const skipBranch=(node:XmlNode)=>{if(!underSkipped(node.source))skippedBranches.push(node.source);};
    const branchWording=(node:XmlNode)=>{
      let original="",proposed="";
      const walk=(item:XmlNode,revisions:string[])=>{
        if(item.text!==null)return;
        const itemName=local(item),itemKey=revisionByPath.get(sourceKey(item.source)),next=itemKey?[...revisions,itemKey]:revisions;
        if(item.namespace===W&&["t","delText","tab","br","cr"].includes(itemName)){
          const text=plainText(item),types=next.map(id=>evidence.revisions.find(revision=>revision.key===id)!.kind);
          if(!types.some(type=>["ins","moveTo"].includes(type)))original+=text;
          if(!types.some(type=>["del","moveFrom"].includes(type)))proposed+=text;
          return;
        }
        item.children.forEach(child=>walk(child,next));
      };
      walk(node,[]);
      return `${original}\u0000${proposed}`;
    };
    const storyParts=evidence.parts.filter(p=>p.tree?.namespace===W&&STORY_KINDS[local(p.tree)]);
    const footnoteLabels=displayedFootnoteLabels(main,storyParts,documentFootnoteDefaults(evidence.parts,evidence.relationships,main.source.part));
    const footnoteLabel=(id:string)=>footnoteLabels?.get(id)??`Footnote XML id ${id}`;
    for(const part of storyParts){
      const kind=STORY_KINDS[local(part.tree!)];if(kind==="body")continue;
      const expectedType=`application/vnd.openxmlformats-officedocument.wordprocessingml.${kind}+xml`;
      const incoming=evidence.relationships.filter(r=>r.resolvedTarget===part.part);
      if(overrides.get(part.part)!==expectedType||!incoming.length||incoming.some(r=>r.part!==main.source.part||r.type!==`${R}/${kind}`))issue("STORY_RELATIONSHIP_MISMATCH","Story root, content type and main-document relationship type must agree.",part.tree!.source);
    }
    const markSkippedBranches=(node:XmlNode)=>{
      if(node.text!==null||underSkipped(node.source))return;
      const name=local(node);
      const preferred=node.namespace===MC&&name==="AlternateContent"?preferredTextBoxBranch(node):null;
      if(preferred)for(const item of branchChildren(node))if(item!==preferred)skipBranch(item);
      node.children.forEach(markSkippedBranches);
    };
    for(const part of storyParts)if(part.tree)markSkippedBranches(part.tree);
    const usedStyles=new Set(storyParts.flatMap(p=>descendants(p.tree!,n=>n.namespace===W&&["pStyle","rStyle","tblStyle"].includes(local(n))&&!underSkipped(n.source)).map(n=>attr(n,"val")).filter((id):id is string=>id!==null)));
    const styleNodes=styles.flatMap(p=>descendants(p.tree!,n=>n.namespace===W&&local(n)==="style"));
    for(const n of styleNodes)if(attr(n,"default")==="1"||attr(n,"default")==="true")usedStyles.add(attr(n,"styleId")??"");
    const visitedStyles=new Set<string>();
    const resolveStyle=(id:string,chain:Set<string>)=>{
      if(chain.has(id)){issue("CYCLIC_STYLE","Style inheritance contains a cycle.");return;}
      if(visitedStyles.has(id))return;visitedStyles.add(id);
      const matches=styleNodes.filter(n=>attr(n,"styleId")===id);
      if(matches.length!==1){issue("MISSING_OR_DUPLICATE_STYLE","A used style is missing or ambiguous.");return;}
      const n=matches[0],base=child(n,"basedOn");
      if(base)resolveStyle(attr(base,"val")??"",new Set([...chain,id]));
      for(const property of descendants(n,n=>n.namespace===W&&["numPr","vanish","webHidden","bidi","rtl"].includes(local(n))))issue("STYLE_SEMANTICS_UNRESOLVED","Numbering or hidden/directional text in a used style requires a validated style resolver.",property.source);
    };
    usedStyles.forEach(id=>resolveStyle(id,new Set()));
    for(const stylePart of styles)for(const n of descendants(stylePart.tree!,n=>n.namespace===W&&local(n)==="docDefaults"))for(const property of descendants(n,n=>n.namespace===W&&["numPr","vanish","webHidden","bidi","rtl"].includes(local(n))))issue("STYLE_SEMANTICS_UNRESOLVED","Document-default numbering or hidden/directional text is not resolved.",property.source);
    for(const part of storyParts){
      if(part.part!==main.source.part&&!evidence.relationships.some(r=>r.resolvedTarget===part.part))issue("UNREFERENCED_STORY","Unreferenced Word story is preserved but package completeness is uncertain.",part.tree!.source);
      if(local(part.tree!)==="comments")for(const n of descendants(part.tree!,n=>n.namespace===W&&local(n)==="comment")){
        const id=attr(n,"id");if(id===null||commentById.has(id)){issue("DUPLICATE_OR_MISSING_COMMENT_ID","Comment identifiers must be unique.",n.source);continue;}
        const comment={id,author:attr(n,"author"),initials:attr(n,"initials"),date:attr(n,"date"),source:n.source,text:descendants(n,n=>n.namespace===W&&local(n)==="p").map(plainText).join("\n"),anchors:[]};
        evidence.comments.push(comment);commentById.set(id,comment);
      }
      for(const n of descendants(part.tree!,n=>n.namespace===W&&["footnote","endnote"].includes(local(n)))){
        const id=attr(n,"id"),key=`${local(n)}:${id}`;if(id===null||noteById.has(key))issue("DUPLICATE_OR_MISSING_NOTE_ID","Note identifiers must be unique.",n.source);else noteById.set(key,n.source);
      }
      const scan=(n:XmlNode,inProperties=false,inTextBox=false)=>{
        if(n.text!==null||underSkipped(n.source))return;
        const name=local(n),property=inProperties||(n.namespace===W&&PROPERTY_ROOTS.has(name));
        const preferred=n.namespace===MC&&name==="AlternateContent"?preferredTextBoxBranch(n):null;
        if(preferred)for(const child of branchChildren(n))if(child!==preferred)skipBranch(child);
        const directTextBox=!inTextBox&&n.namespace===W&&(name==="drawing"||name==="pict")&&plainTextBox(n);
        const textBoxRoot=directTextBox?n:!inTextBox&&preferred&&plainTextBox(preferred)?preferred:null;
        if(textBoxRoot&&wrapperVisibility(textBoxRoot)!=="shown")issue("UNSUPPORTED_VANISH",UNSUPPORTED.vanish,textBoxRoot.source);
        const textBoxHost=textBoxRoot!==null;
        const insideTextBox=inTextBox||textBoxHost;
        if(!insideTextBox&&(n.namespace===MC||n.attributes.some(a=>a.namespace===MC&&a.name.split(":").at(-1)!=="Ignorable")))issue("MARKUP_COMPATIBILITY","Alternate/extension semantics are not yet resolved.",n.source);
        if((!insideTextBox||n.namespace===W)&&n.attributes.some(a=>a.namespace&&!([W,R,MC,"http://www.w3.org/XML/1998/namespace","http://www.w3.org/2000/xmlns/"].includes(a.namespace))&&!(a.namespace==="http://schemas.microsoft.com/office/word/2010/wordml"&&["paraId","textId"].includes(a.name.split(":").at(-1)!))))issue("UNKNOWN_EXTENSION_ATTRIBUTE","Uninterpreted extension attributes can affect document meaning.",n.source);
        if(n.namespace===W){
          if(REVISION_NAMES.has(name)){
            const key=sourceKey(n.source),id=attr(n,"id"),author=attr(n,"author");
            const identity=`${n.source.part}:${id}`;
            if(revisionIdentity.has(identity)&&revisionIdentity.get(identity)!==author)issue("CONFLICTING_REVISION_IDENTITY","The same revision ID carries different author metadata.",n.source);revisionIdentity.set(identity,author);
            let properties=["ins","del","moveFrom","moveTo"].includes(name)?{...n,children:[]}:n;
            revisionBytes+=Buffer.byteLength(JSON.stringify(properties));
            if(revisionBytes>4*1024*1024){issue("REVISION_METADATA_LIMIT","Revision property evidence exceeds the supported receipt budget.",n.source);properties={...n,children:[]};}
            evidence.revisions.push({key,id,kind:name,author,date:attr(n,"date"),source:n.source,properties});revisionByPath.set(key,key);
            if(!id||!author)issue("MISSING_REVISION_METADATA","Revision identifier or authorship is missing; party attribution cannot be established.",n.source);
            if(local(part.tree!)==="comments")issue("UNSUPPORTED_COMMENT_REVISION","Tracked edits inside comment bodies are retained but their current rationale is not resolved.",n.source);
            if(!["ins","del"].includes(name)||inProperties)issue("UNSUPPORTED_STRUCTURAL_REVISION","Property, paragraph-mark, table and move revisions are retained but their before/after semantics are not resolved.",n.source);
          }
          const textBoxShape=insideTextBox&&(name==="drawing"||name==="pict");
          if(UNSUPPORTED[name]&&!textBoxShape)issue(`UNSUPPORTED_${name.toUpperCase()}`,UNSUPPORTED[name],n.source);
          else if(!textBoxShape&&!property&&!CONTENT_NAMES.has(name)&&!REVISION_NAMES.has(name))issue("UNKNOWN_WORD_ELEMENT",`Uninterpreted Word element: ${name}.`,n.source);
        }else if(!insideTextBox)issue("UNSUPPORTED_NAMESPACE","Non-Word story content requires another validated adapter.",n.source);
        // The exemption covers the shape wrapper only. Words inside w:txbxContent are checked like body text, so an equation cannot drop out of a published clause.
        n.children.forEach(c=>scan(c,property,insideTextBox&&!(n.namespace===W&&name==="txbxContent")));
      };scan(part.tree!);
    }
    for(const part of evidence.parts){
      if(!part.tree||storyParts.includes(part)||["[Content_Types].xml"].includes(part.part)||part.part.endsWith(".rels"))continue;
      const name=local(part.tree);
      if(part.tree.namespace===W&&["styles","numbering","settings","fonts","webSettings"].includes(name)){
        for(const revision of descendants(part.tree,n=>n.namespace===W&&REVISION_NAMES.has(local(n)))){
          const key=sourceKey(revision.source);
          evidence.revisions.push({key,id:attr(revision,"id"),kind:local(revision),author:attr(revision,"author"),date:attr(revision,"date"),source:revision.source,properties:{...revision,children:[]}});
          issue("UNSUPPORTED_AUXILIARY_REVISION","Revision semantics in styles/settings/numbering are retained but not resolved.",revision.source);
        }
        continue;
      }
      if(part.part.startsWith("docProps/")||part.part.startsWith("word/theme/"))continue;
      issue("UNSUPPORTED_XML_PART","Uninterpreted package XML is retained; no whole-document completeness claim is permitted.",part.tree.source);
    }
    let runMetadataBytes=0;
    for(const part of storyParts){
      const tree=part.tree!,kind=STORY_KINDS[local(tree)],paragraphs:DocxParagraph[]=[],activeComments=new Set<string>();let storyOffset=0,activeCommentBytes=0;
      const collect=(n:XmlNode,ancestors:Array<{name:string;source:XmlSource}>,inheritedRevisions:string[])=>{
        if(n.namespace===W&&local(n)==="p"){
          const pPr=child(n,"pPr"),paragraph:DocxParagraph={source:n.source,ancestors,style:pPr?attr(child(pPr,"pStyle")??pPr,"val"):null,numbering:pPr?child(pPr,"numPr"):null,tableContext:null,runs:[],originalText:"",proposedText:"",locator:null};let paragraphOffset=0;
          const nestedBoxes:Array<{item:XmlNode;revisions:string[];commentIds:string[]}>=[];
          const inline=(item:XmlNode,revisions:string[])=>{
            if(item.text!==null||underSkipped(item.source))return;
            const name=local(item),key=revisionByPath.get(sourceKey(item.source)),next=key?[...revisions,key]:revisions;
            if(item.namespace===MC&&name==="AlternateContent"){
              const preferred=preferredTextBoxBranch(item),branches=branchChildren(item);
              if(preferred){inline(preferred,next);return;}
              const choices=branches.filter(child=>local(child)==="Choice"),fallback=branches.find(child=>local(child)==="Fallback")??null;
              if(choices.length&&fallback){
                const different=choices.map(branchWording).join("\n")!==branchWording(fallback);
                if(different)issue("DIVERGENT_ALTERNATE_TEXT","The text box has two versions that do not say the same words, and neither version is a form this reader can choose as the contract. This file is not read as the contract.",item.source);
                else inline(choices[0],next);
                for(const child of branches)if(different||child!==choices[0])skipBranch(child);
                return;
              }
              item.children.forEach(child=>inline(child,next));
              return;
            }
            if(item.namespace===W&&["commentRangeStart","commentRangeEnd","commentReference"].includes(name)){
              const id=attr(item,"id"),comment=id===null?null:commentById.get(id),anchorKind=name==="commentRangeStart"?"start":name==="commentRangeEnd"?"end":"reference";
              if(!comment)issue("MISSING_COMMENT_BODY","Comment anchor has no comment body.",item.source);
              else{
                comment.anchors.push({kind:anchorKind,source:item.source,paragraphPath:n.source.path,storyOffset,paragraphOffset});
                if(anchorKind==="start"){if(activeComments.has(id!))issue("DUPLICATE_COMMENT_START","Comment range starts twice.",item.source);else activeCommentBytes+=Buffer.byteLength(id!)+8;activeComments.add(id!);}
                if(anchorKind==="end"){if(!activeComments.has(id!))issue("UNMATCHED_COMMENT_END","Comment range ends without a start in this story.",item.source);else activeCommentBytes-=Buffer.byteLength(id!)+8;activeComments.delete(id!);}
              }
              return;
            }
            if(item.namespace===W&&["footnoteReference","endnoteReference"].includes(name)){
              const id=attr(item,"id")??"",noteKind=name==="footnoteReference"?"footnote":"endnote",target=noteById.get(`${noteKind}:${id}`)??null;
              evidence.references.push({kind:noteKind,id,source:item.source,target});if(!target)issue("MISSING_NOTE_BODY","Note reference has no corresponding note.",item.source);
              if(next.length)issue("REVISED_NOTE_ACTIVATION","A note reference inside a tracked revision requires validated original/proposed story activation.",item.source);
            }
            if(item.namespace===W&&["t","delText","tab","br","cr"].includes(name)){
              const text=plainText(item),types=next.map(key=>evidence.revisions.find(r=>r.key===key)!.kind);
              if(types.includes("ins")&&types.includes("del"))issue("NESTED_CONFLICTING_REVISIONS","Nested insertion/deletion semantics are unresolved.",item.source);
              if(name==="delText"&&!types.some(type=>["del","moveFrom"].includes(type)))issue("UNBOUND_DELETED_TEXT","Deleted text has no revision envelope.",item.source);
              runMetadataBytes+=activeCommentBytes+next.reduce((total,key)=>total+Buffer.byteLength(key)+8,0);
              if(runMetadataBytes>DOCX_LIMITS.runMetadataBytes)throw new Error("DOCX run revision/comment metadata exceeds its supported allocation budget.");
              paragraph.runs.push({text,source:item.source,revisionKeys:next,commentIds:[...activeComments],kind:name});
              if(!types.some(type=>["ins","moveTo"].includes(type)))paragraph.originalText+=text;
              if(!types.some(type=>["del","moveFrom"].includes(type)))paragraph.proposedText+=text;
              paragraphOffset+=text.length;storyOffset+=text.length;return;
            }
            if(item.namespace===W&&name==="txbxContent"){nestedBoxes.push({item,revisions:next,commentIds:[...activeComments]});return;}
            item.children.forEach(child=>inline(child,next));
          };n.children.forEach(child=>inline(child,inheritedRevisions));paragraphs.push(paragraph);storyOffset++;
          const commentBytes=(ids:Iterable<string>)=>[...ids].reduce((total,id)=>total+Buffer.byteLength(id)+8,0);
          const afterParagraph=[...activeComments];
          const closedInside=new Set<string>(),openedInside=new Set<string>();
          // A point commentReference does not open a range, so it never enters
          // activeComments. The outer paragraph may also have no words of its
          // own once they move into the box. Keep that point comment on the box.
          // These ids are copied onto a text box only. A paragraph with no box does not scan every comment.
          const pointCommentIds=nestedBoxes.length===0?[]:[...commentById.values()].filter(comment=>{
            const onParagraph=comment.anchors.some(anchor=>anchor.kind==="reference"&&anchor.paragraphPath===n.source.path&&anchor.source.part===n.source.part);
            const ranged=comment.anchors.some(anchor=>anchor.kind==="start"||anchor.kind==="end");
            return onParagraph&&!ranged;
          }).map(comment=>comment.id);
          for(const box of nestedBoxes){
            activeComments.clear();
            box.commentIds.forEach(id=>activeComments.add(id));
            pointCommentIds.forEach(id=>activeComments.add(id));
            activeCommentBytes=commentBytes(activeComments);
            const boxAncestors=[...ancestors,{name:n.name,source:n.source},{name:box.item.name,source:box.item.source}];
            box.item.children.forEach(child=>collect(child,boxAncestors,box.revisions));
            const afterBox=new Set(activeComments);
            for(const id of box.commentIds)if(!afterBox.has(id))closedInside.add(id);
            for(const id of afterBox)if(!box.commentIds.includes(id)&&!pointCommentIds.includes(id))openedInside.add(id);
          }
          activeComments.clear();
          for(const id of afterParagraph)if(!closedInside.has(id))activeComments.add(id);
          for(const id of openedInside)activeComments.add(id);
          activeCommentBytes=commentBytes(activeComments);
          return;
        }
        const key=revisionByPath.get(sourceKey(n.source)),revisions=key?[...inheritedRevisions,key]:inheritedRevisions;
        n.children.forEach(c=>collect(c,n.text===null?[...ancestors,{name:n.name,source:n.source}]:ancestors,revisions));
      };collect(tree,[],[]);
      const elements=descendants(tree,n=>n.text===null),nodeIndex=new Map(elements.map(n=>[n.source.path,n])),paragraphsByCell=new Map<string,DocxParagraph[]>(),rowCache=new Map<string,ReturnType<typeof cellEvidence>>(),checkedTables=new Set<string>();let contextBytes=0;
      for(const paragraph of paragraphs){const cell=paragraph.ancestors.filter(a=>a.name.split(":").at(-1)==="tc").at(-1);if(cell)paragraphsByCell.set(cell.source.path,[...(paragraphsByCell.get(cell.source.path)??[]),paragraph]);}
      function cellEvidence(row:XmlNode):Array<{source:XmlSource;originalText:string;proposedText:string;properties:XmlNode|null}>{
        const cached=rowCache.get(row.source.path);if(cached)return cached;
        const result=row.children.filter(n=>n.namespace===W&&local(n)==="tc").map(cell=>{
        const values=paragraphsByCell.get(cell.source.path)??[];
        return {source:cell.source,originalText:values.map(p=>p.originalText).join("\n"),proposedText:values.map(p=>p.proposedText).join("\n"),properties:child(cell,"tcPr")};
        });rowCache.set(row.source.path,result);return result;
      }
      for(const paragraph of paragraphs){
        const tables=paragraph.ancestors.filter(a=>a.name.split(":").at(-1)==="tbl");
        if(!tables.length)continue;
        if(tables.length>1){issue("NESTED_TABLE","Nested-table layout requires another validated adapter.",paragraph.source);continue;}
        const table=nodeIndex.get(tables[0].source.path)!,rowAncestor=paragraph.ancestors.find(a=>a.name.split(":").at(-1)==="tr"),cellAncestor=paragraph.ancestors.find(a=>a.name.split(":").at(-1)==="tc");
        const rows=table.children.filter(n=>n.namespace===W&&local(n)==="tr"),row=rows.find(n=>n.source.path===rowAncestor?.source.path),rowIndex=rows.indexOf(row!);
        if(!checkedTables.has(table.source.path)){
          checkedTables.add(table.source.path);
          const grid=child(table,"tblGrid"),columns=grid?.children.filter(n=>n.namespace===W&&local(n)==="gridCol").length??0;let priorMerges=new Map<number,number>();
          if(!columns)issue("MISSING_TABLE_GRID","Table column grid is absent or empty.",table.source);
          for(const tableRow of rows){
            const props=child(tableRow,"trPr"),before=props?child(props,"gridBefore"):null,after=props?child(props,"gridAfter"):null;
            let column=before?Number(attr(before,"val")):0;const merges=new Map<number,number>();
            for(const tableCell of tableRow.children.filter(n=>n.namespace===W&&local(n)==="tc")){
              const properties=child(tableCell,"tcPr"),span=properties?child(properties,"gridSpan"):null,width=span?Number(attr(span,"val")):1,merge=properties?child(properties,"vMerge"):null,mode=merge?attr(merge,"val")??"continue":null;
              if(mode==="continue"&&priorMerges.get(column)!==width)issue("UNRESOLVED_VERTICAL_MERGE","Merged continuation cell has no matching prior-row merge.",tableCell.source);
              if(mode)merges.set(column,width);column+=width;
            }
            const trailing=after?Number(attr(after,"val")):0;
            if(!Number.isInteger(column)||!Number.isInteger(trailing)||trailing<0||column+trailing!==columns)issue("INCONSISTENT_TABLE_GRID","Row cells and omitted grid columns do not match the table grid.",tableRow.source);
            priorMerges=merges;
          }
        }
        if(!row||!cellAncestor){issue("UNRESOLVED_TABLE_CELL","Table paragraph lacks a direct row/cell.",paragraph.source);continue;}
        const cells=row.children.filter(n=>n.namespace===W&&local(n)==="tc"),cellIndex=cells.findIndex(n=>n.source.path===cellAncestor.source.path),cell=cells[cellIndex];
        if(!cell){issue("UNRESOLVED_TABLE_CELL","Table cell position is unresolved.",paragraph.source);continue;}
        const span=(cell:XmlNode)=>{const properties=child(cell,"tcPr"),value=properties?child(properties,"gridSpan"):null;return value?Number(attr(value,"val")):1;};
        const trPr=child(row,"trPr"),before=trPr?child(trPr,"gridBefore"):null,offset=before?Number(attr(before,"val")):0,spans=cells.map(span);
        if(!Number.isInteger(offset)||offset<0||spans.some(n=>!Number.isInteger(n)||n<=0||n>1024)){issue("INVALID_TABLE_GRID","Table grid position/span is invalid.",paragraph.source);continue;}
        const properties=child(cell,"tcPr"),merge=properties?child(properties,"vMerge"):null,verticalMerge=merge?attr(merge,"val")??"continue":null;
        if(verticalMerge&&!["restart","continue"].includes(verticalMerge))issue("INVALID_TABLE_MERGE","Vertical table merge is invalid.",paragraph.source);
        if(properties&&child(properties,"hMerge"))issue("LEGACY_TABLE_MERGE","Legacy horizontal merge semantics are not resolved.",paragraph.source);
        const context={source:table.source,rowIndex,cellIndex,gridColumn:offset+spans.slice(0,cellIndex).reduce((a,b)=>a+b,0),gridSpan:spans[cellIndex],verticalMerge,rowCells:cellEvidence(row),firstRow:rows.length?cellEvidence(rows[0]):[],headerRows:rows.filter(row=>{const properties=child(row,"trPr"),header=properties?child(properties,"tblHeader"):null;return header&&!["0","false","off"].includes(attr(header,"val")??"true");}).map(cellEvidence)};
        contextBytes+=Buffer.byteLength(JSON.stringify(context));
        if(contextBytes>4*1024*1024){issue("TABLE_CONTEXT_LIMIT","Table analysis context exceeds the supported evidence budget.",paragraph.source);break;}
        paragraph.tableContext=context;
      }
      let sectionLabel="1";
      const heading=/^(\d+(?:\.\d+)*)(?:\.|\s)\s*\S/;
      for(const paragraph of paragraphs){
        const structural=paragraph.ancestors.some(item=>["txbxContent","footnote","endnote"].includes(ancestorName(item.name)));
        const visible=paragraph.proposedText.replace(/\s+/g," ").trim();
        if(!structural){const match=visible.match(heading);if(match)sectionLabel=match[1];}
        paragraph.locator=structuralLocator(paragraph,nodeIndex,sectionLabel,footnoteLabel);
      }
      if(activeComments.size)issue("UNMATCHED_COMMENT_START","Comment range remains open at the end of its story.",tree.source);
      evidence.stories.push({part:part.part,kind,paragraphs});
      const covered=new Set(paragraphs.flatMap(p=>p.runs.map(r=>sourceKey(r.source))));
      for(const n of descendants(tree,n=>n.namespace===W&&["t","delText","tab","br","cr"].includes(local(n))))if(!covered.has(sourceKey(n.source))&&!underSkipped(n.source))issue("UNCOVERED_STORY_TEXT","Story text is outside the supported paragraph model.",n.source);
    }
    // Walk skipped branches once, and only when a comment still has no anchor.
    // An ordinary point comment that is already anchored does not rescan the story.
    const parkedCommentIds=new Set<string>();
    if(skippedBranches.length&&evidence.comments.some(comment=>comment.anchors.length===0)){
      for(const part of storyParts)for(const node of descendants(part.tree!,node=>node.namespace===W&&["commentRangeStart","commentRangeEnd","commentReference"].includes(local(node))&&underSkipped(node.source))){
        const id=attr(node,"id");if(id!==null)parkedCommentIds.add(id);
      }
    }
    for(const comment of evidence.comments){
      if(!comment.anchors.length&&!parkedCommentIds.has(comment.id))issue("ORPHAN_COMMENT","Comment body has no range or reference anchor.",comment.source);
      const starts=comment.anchors.filter(a=>a.kind==="start"),ends=comment.anchors.filter(a=>a.kind==="end"),refs=comment.anchors.filter(a=>a.kind==="reference");
      if(starts.length!==ends.length||starts.length>1||ends.length>1||refs.length>1||(starts.length&&starts[0].source.part!==ends[0]?.source.part))issue("AMBIGUOUS_COMMENT_ANCHORS","Comment range/reference association is inconsistent.",comment.source);
      if(new Set(comment.anchors.map(a=>a.source.part)).size>1)issue("CROSS_STORY_COMMENT_ANCHORS","Comment range and reference cross document stories; their association is unresolved.",comment.source);
    }
    const referencedNotes=new Set(evidence.references.flatMap(r=>r.target?[sourceKey(r.target)]:[]));
    for(const part of storyParts){
      const kind=STORY_KINDS[local(part.tree!)];
      if(kind==="footnotes"||kind==="endnotes")for(const note of descendants(part.tree!,n=>n.namespace===W&&["footnote","endnote"].includes(local(n)))){
        const type=attr(note,"type");
        if(!["separator","continuationSeparator","continuationNotice"].includes(type??"")&&!referencedNotes.has(sourceKey(note.source)))issue("ORPHAN_NOTE_BODY","A note body has no document reference; proposed story activation is unresolved.",note.source);
      }
      if(kind==="header"||kind==="footer"){
        const referenceName=kind==="header"?"headerReference":"footerReference";
        const sectionReferences=descendants(main,n=>n.namespace===W&&local(n)===referenceName&&n.source.path.split("/").some(segment=>segment.split(":").at(-1)?.startsWith("sectPr[")));
        if(!sectionReferences.some(n=>evidence.relationships.some(r=>r.part===main.source.part&&r.type===`${R}/${kind}`&&r.id===attr(n,"id",R)&&r.resolvedTarget===part.part)))issue("UNACTIVATED_HEADER_FOOTER","Header/footer has no supported section reference; its analysis context is unresolved.",part.tree!.source);
      }
    }
    // Non-paragraph anchors and dangling relationship IDs cannot be silently lost.
    for(const part of storyParts)for(const n of descendants(part.tree!,n=>n.text===null)){
      if(underSkipped(n.source))continue;
      for(const a of n.attributes.filter(a=>a.namespace===R))if(!evidence.relationships.some(r=>r.part===part.part&&r.id===a.value))issue("DANGLING_RELATIONSHIP_ID","Story references an absent relationship ID.",n.source);
      if(n.namespace===W&&["commentRangeStart","commentRangeEnd","commentReference"].includes(local(n))&&!evidence.comments.some(c=>c.anchors.some(a=>a.source.part===n.source.part&&a.source.path===n.source.path)))issue("UNRESOLVED_COMMENT_POSITION","Comment anchor is outside the supported paragraph model.",n.source);
    }
    if(!evidence.stories.some(s=>s.kind==="body"&&s.paragraphs.some(p=>p.runs.some(r=>r.text.trim()))))issue("EMPTY_MAIN_STORY","No main-story text was extracted; DOCX is not delegated to flattening OCR.");
  }catch(error){issue("INVALID_OR_UNSUPPORTED_PACKAGE",error instanceof Error?error.message:"DOCX package parsing failed.");}
  evidence.analysisEligible=!evidence.issues.some(i=>i.blocking);
  const chunks:SourceChunk[]=[];
  if(evidence.analysisEligible)for(const story of evidence.stories.filter(s=>s.kind!=="comments"))for(const paragraph of story.paragraphs){
    if(!paragraph.runs.some(r=>r.text.length))continue;
    const projection=projectDocxParagraph(evidence,paragraph);
    const text=DOCX_CHUNK_PREFIX+JSON.stringify(projection);
    // Never split a revision/comment envelope or truncate a long clause. A future
    // adapter may split it with explicit segment coverage; this one blocks it.
    if(text.length>100_000){issue("OVERSIZED_PARAGRAPH_PROJECTION","Paragraph and its anchored evidence exceed the supported analysis envelope.",paragraph.source);evidence.analysisEligible=false;break;}
    chunks.push({pageNumber:null,chunkIndex:chunks.length,text,sha256:sha256(text)});
  }
  if(Buffer.byteLength(JSON.stringify(evidence),"utf8")>DOCX_LIMITS.receiptBytes){
    // The immutable binary remains available. No partial model can claim coverage.
    evidence.parts=evidence.parts.map(p=>({...p,tree:null}));evidence.stories=[];evidence.revisions=[];evidence.comments=[];evidence.references=[];
    issue("OVERSIZED_EVIDENCE_RECEIPT","Structured evidence exceeds the supported receipt size; use another validated adapter.");evidence.analysisEligible=false;
  }
  return {evidence,chunks:evidence.analysisEligible?chunks:[]};
}
