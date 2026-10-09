import JSZip from "jszip";

// Synthetic-only source fixtures. Bytes are generated in memory, never customer
// documents, and include actual OOXML revisions/anchors rather than text mocks.
export const W="http://schemas.openxmlformats.org/wordprocessingml/2006/main";
export const R="http://schemas.openxmlformats.org/officeDocument/2006/relationships";
export const REL="http://schemas.openxmlformats.org/package/2006/relationships";
export const escapeXml=value=>String(value).replaceAll("&","&amp;").replaceAll("<","&lt;").replaceAll('"',"&quot;");
export const text=value=>`<w:r><w:t xml:space="preserve">${escapeXml(value)}</w:t></w:r>`;
export const p=value=>`<w:p>${value}</w:p>`;
export const revision=(kind,id,author,value)=>`<w:${kind} w:id="${id}" w:author="${escapeXml(author)}" w:date="2026-10-08T12:00:00Z"><w:r><w:${kind==="del"?"delText":"t"} xml:space="preserve">${escapeXml(value)}</w:${kind==="del"?"delText":"t"}></w:r></w:${kind}>`;
export const replacement=p(text("Customer shall pay within ")+revision("del","10","Synthetic Flex Counsel","30 days")+revision("ins","11","Synthetic Customer Counsel","60 days")+text(" of invoice."));
export const comment=(id,value)=>`<w:comment w:id="${id}" w:author="Synthetic Reviewer" w:initials="SR" w:date="2026-10-08T12:30:00Z">${p(text(value))}</w:comment>`;
export const relationship=(id,type,target,external=false)=>`<Relationship Id="${id}" Type="${R}/${type}" Target="${escapeXml(target)}"${external?' TargetMode="External"':''}/>`;
export const document=(body,attributes="")=>`<?xml version="1.0" encoding="UTF-8"?><w:document xmlns:w="${W}" xmlns:r="${R}" ${attributes}><w:body>${body}<w:sectPr/></w:body></w:document>`;
const mainType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml";
const types={comments:"application/vnd.openxmlformats-officedocument.wordprocessingml.comments+xml",header:"application/vnd.openxmlformats-officedocument.wordprocessingml.header+xml",footer:"application/vnd.openxmlformats-officedocument.wordprocessingml.footer+xml",footnotes:"application/vnd.openxmlformats-officedocument.wordprocessingml.footnotes+xml",endnotes:"application/vnd.openxmlformats-officedocument.wordprocessingml.endnotes+xml",styles:"application/vnd.openxmlformats-officedocument.wordprocessingml.styles+xml",numbering:"application/vnd.openxmlformats-officedocument.wordprocessingml.numbering+xml"};
export async function fixture({body=replacement,main=document(body),parts={},rels=[],rootRels=relationship("main","officeDocument","word/document.xml"),contentTypes=null,compression="DEFLATE"}={}){
  const zip=new JSZip();zip.file("word/document.xml",main);
  const overrides=[`<Override PartName="/word/document.xml" ContentType="${mainType}"/>`];
  for(const [name,part] of Object.entries(parts)){
    const value=typeof part==="string"?{xml:part}:part;
    zip.file(name,value.xml);
    const type=value.type??types[value.kind]??"application/xml";
    overrides.push(`<Override PartName="/${name}" ContentType="${type}"/>`);
    if(value.kind)rels=[...rels,relationship(`part-${rels.length}`,value.kind,name.replace(/^word\//,""))];
  }
  zip.file("[Content_Types].xml",contentTypes??`<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/>${overrides.join("")}</Types>`);
  zip.file("_rels/.rels",`<Relationships xmlns="${REL}">${rootRels}</Relationships>`);
  if(rels.length)zip.file("word/_rels/document.xml.rels",`<Relationships xmlns="${REL}">${rels.join("")}</Relationships>`);
  const buffer=await zip.generateAsync({type:"nodebuffer",compression});
  return buffer.buffer.slice(buffer.byteOffset,buffer.byteOffset+buffer.byteLength);
}
export const story=(name,body)=>`<w:${name} xmlns:w="${W}" xmlns:r="${R}">${body}</w:${name}>`;
