import assert from "node:assert/strict";
import { fixture, W, R, p, text, revision, replacement, comment, relationship, document, story } from "../validation/docx/fixtures.mjs";
import { createTypeScriptLoader } from "./ts-test-loader.mjs";

const load=createTypeScriptLoader();
const {extractDocx}=load("lib/docxExtraction.ts");
const {readDocxProjection,sourceTextViews,proposedTextContainsExcerpt}=load("lib/docxEvidence.ts");
const {createDocxReceipt,assertDocxReceipt,sha256}=load("lib/docxReceipt.ts");
const {sourceContainsExcerpt}=load("lib/analysisEngine.ts");
const {extractDocument}=load("lib/documentExtraction.ts");
let cases=0;
async function check(name,run){await run();cases++;console.log(`PASS ${name}`);}
const blocked=(result,code)=>{assert.equal(result.evidence.analysisEligible,false);assert.deepEqual(result.chunks,[]);assert.ok(result.evidence.issues.some(i=>i.blocking&&(i.code===code||i.message.includes(code))),JSON.stringify(result.evidence.issues));};
const rows=chunks=>chunks.map(c=>({chunk_index:c.chunkIndex,content:c.text,content_sha256:c.sha256}));
const view=result=>{assert.equal(result.evidence.analysisEligible,true,JSON.stringify(result.evidence.issues));return readDocxProjection(result.chunks[0].text);};

await check("replacement retains both wordings, authors, dates and source hashes",async()=>{
  const bytes=await fixture(),result=extractDocx(bytes),projection=view(result);
  assert.equal(result.evidence.analysisEligible,true);assert.equal(result.evidence.legalEvidenceReady,false);
  assert.equal(projection.paragraph.originalText,"Customer shall pay within 30 days of invoice.");
  assert.equal(projection.paragraph.proposedText,"Customer shall pay within 60 days of invoice.");
  assert.deepEqual(result.evidence.revisions.map(r=>[r.id,r.kind,r.author,r.date]),[["10","del","Synthetic Flex Counsel","2026-10-08T12:00:00Z"],["11","ins","Synthetic Customer Counsel","2026-10-08T12:00:00Z"]]);
  assert.equal(result.evidence.sourceSha256,sha256(Buffer.from(bytes)));
  assert.ok(projection.paragraph.runs.every(r=>r.source.part==="word/document.xml"&&r.source.path.includes("w:p[1]")));
  assert.ok(result.evidence.parts.every(p=>/^[0-9a-f]{64}$/.test(p.sha256)));
  assertDocxReceipt(createDocxReceipt(result.evidence,result.chunks),result.evidence.sourceSha256,rows(result.chunks));
});
await check("overlapping and cross-paragraph comments retain exact range/reference anchors",async()=>{
  const body=p(text("😀 Start ")+'<w:commentRangeStart w:id="0"/>'+text("first ")+'<w:commentRangeStart w:id="1"/>'+text("overlap"))+p(text(" second")+'<w:commentRangeEnd w:id="0"/><w:r><w:commentReference w:id="0"/></w:r>'+text(" tail")+'<w:commentRangeEnd w:id="1"/><w:r><w:commentReference w:id="1"/></w:r>');
  const result=extractDocx(await fixture({body,parts:{"word/comments.xml":{kind:"comments",xml:story("comments",comment("0","Comment A: cash cost.")+comment("1","Comment B: not an agreed obligation."))}}}));
  assert.equal(result.evidence.analysisEligible,true);
  assert.deepEqual(result.evidence.comments[0].anchors.map(a=>a.kind),["start","end","reference"]);
  assert.equal(result.evidence.comments[0].anchors[0].paragraphOffset,9,"offset uses exact UTF-16 code units including emoji");
  assert.notEqual(result.evidence.comments[0].anchors[0].paragraphPath,result.evidence.comments[0].anchors[1].paragraphPath);
  assert.ok(view(result).comments.length===2);
  assert.ok(readDocxProjection(result.chunks[1].text).paragraph.runs.some(r=>r.commentIds.length===2));
  assert.equal(sourceContainsExcerpt(result.chunks[0].text,"Comment A: cash cost."),false);
});
await check("point comments, empty comments and author metadata are preserved",async()=>{
  const result=extractDocx(await fixture({body:p(text("Invoice is due.")+'<w:r><w:commentReference w:id="4"/></w:r>'),parts:{"word/comments.xml":{kind:"comments",xml:story("comments",comment("4",""))}}}));
  assert.equal(result.evidence.analysisEligible,true);assert.equal(result.evidence.comments[0].text,"");assert.equal(view(result).comments[0].anchors[0].kind,"reference");
});
await check("headers, footers, notes and note targets are retained",async()=>{
  const body=p(text("The inventory rule applies.")+'<w:r><w:footnoteReference w:id="2"/><w:endnoteReference w:id="3"/></w:r>')+'<w:sectPr><w:headerReference w:type="default" r:id="h"/><w:footerReference w:type="default" r:id="f"/></w:sectPr>';
  const result=extractDocx(await fixture({body,rels:[relationship("h","header","header1.xml"),relationship("f","footer","footer1.xml")],parts:{
    "word/header1.xml":{kind:"header",xml:story("hdr",p(text("Synthetic DRAFT header")))},"word/footer1.xml":{kind:"footer",xml:story("ftr",p(text("Confidential synthetic footer")))},
    "word/footnotes.xml":{kind:"footnotes",xml:story("footnotes",'<w:footnote w:id="2">'+p(text("NCNR requires authorization."))+"</w:footnote>")},
    "word/endnotes.xml":{kind:"endnotes",xml:story("endnotes",'<w:endnote w:id="3">'+p(text("Recovery is capped."))+"</w:endnote>")}
  }}));
  assert.equal(result.evidence.analysisEligible,true);assert.deepEqual(result.evidence.stories.map(s=>s.kind).sort(),["body","endnotes","footer","footnotes","header"]);
  assert.equal(result.evidence.references.length,2);assert.ok(result.evidence.references.every(r=>r.target));assert.equal(result.chunks.length,5);
});
await check("tables preserve cell ancestry, grid spans, merges and row/header context",async()=>{
  const cell=(value,properties="")=>`<w:tc>${properties?`<w:tcPr>${properties}</w:tcPr>`:""}${p(text(value))}</w:tc>`;
  const body='<w:tbl><w:tblGrid><w:gridCol w:w="1000"/><w:gridCol w:w="1000"/><w:gridCol w:w="1000"/></w:tblGrid><w:tr><w:trPr><w:tblHeader/></w:trPr>'+cell("Inventory category")+cell("Recovery price",'<w:gridSpan w:val="2"/>')+'</w:tr><w:tr>'+cell("NCNR components")+cell("$100 per unit",'<w:gridSpan w:val="2"/><w:vMerge w:val="restart"/>')+'</w:tr></w:tbl>';
  const result=extractDocx(await fixture({body}));assert.equal(result.evidence.analysisEligible,true);
  const projection=readDocxProjection(result.chunks.at(-1).text);
  assert.equal(projection.paragraph.tableContext.rowIndex,1);assert.equal(projection.paragraph.tableContext.cellIndex,1);assert.equal(projection.paragraph.tableContext.gridColumn,1);assert.equal(projection.paragraph.tableContext.gridSpan,2);assert.equal(projection.paragraph.tableContext.verticalMerge,"restart");
  assert.equal(projection.paragraph.tableContext.headerRows[0][1].originalText,"Recovery price");assert.ok(projection.paragraph.ancestors.some(a=>a.name==="w:tc"));
});
await check("namespace aliases, literal whitespace and UTF-16 XML are supported",async()=>{
  const body=p(text('Café  "quote" & <tag> ')+revision("del","1","Synthetic A","old ")+revision("ins","2","Synthetic B","new ")+'<w:r><w:tab/><w:t>tail</w:t><w:br/></w:r>');
  const aliased=document(body).replaceAll("w:","x:").replaceAll("xmlns:w=","xmlns:x=");
  const result=extractDocx(await fixture({main:aliased}));assert.equal(result.evidence.analysisEligible,true);assert.equal(view(result).paragraph.originalText,'Café  "quote" & <tag> old \ttail\n');
  const xml=document(body).replace('encoding="UTF-8"','encoding="UTF-16"');
  const encoded=Buffer.concat([Buffer.from([0xff,0xfe]),Buffer.from(xml,"utf16le")]);
  assert.equal(extractDocx(await fixture({main:encoded})).evidence.analysisEligible,true);
});
await check("metadata cannot ground a contract quote; deleted text cannot become a current candidate term",async()=>{
  const result=extractDocx(await fixture()),chunk=result.chunks[0].text;
  assert.equal(sourceContainsExcerpt(chunk,"Customer shall pay within 30 days of invoice."),true);
  assert.equal(proposedTextContainsExcerpt(chunk,"Customer shall pay within 30 days of invoice."),false);
  assert.equal(proposedTextContainsExcerpt(chunk,"Customer shall pay within 60 days of invoice."),true);
  assert.equal(sourceContainsExcerpt(chunk,"Synthetic Customer Counsel"),false);
  assert.equal(sourceContainsExcerpt(chunk,"UNAPPROVED_NEGOTIATION_EVIDENCE"),false);
  assert.equal(sourceContainsExcerpt(chunk,""),false);
  assert.equal(sourceTextViews(chunk).length,2);
});
await check("receipt rejects missing, stale, tampered, omitted, duplicate and reordered evidence",async()=>{
  const result=extractDocx(await fixture({body:replacement+p(text("A separate termination obligation."))})),receipt=createDocxReceipt(result.evidence,result.chunks),chunks=rows(result.chunks),hash=result.evidence.sourceSha256;
  for(const changed of [null,{}, {...receipt,docxEvidenceSha256:"0".repeat(64)}, {...receipt,docxEvidence:{...receipt.docxEvidence,analysisEligible:false}}, {...receipt,docxEvidence:{...receipt.docxEvidence,extractorVersion:"old"}}, {...receipt,docxEvidence:{...receipt.docxEvidence,legalEvidenceReady:true}}])assert.throws(()=>assertDocxReceipt(changed,hash,chunks));
  assert.throws(()=>assertDocxReceipt(receipt,"0".repeat(64),chunks));assert.throws(()=>assertDocxReceipt(receipt,hash,chunks.slice(1)));assert.throws(()=>assertDocxReceipt(receipt,hash,[chunks[1],chunks[0]]));assert.throws(()=>assertDocxReceipt(receipt,hash,[chunks[0],chunks[0]]));
  assert.throws(()=>assertDocxReceipt(receipt,hash,[{...chunks[0],content:chunks[0].content+"tampered"},chunks[1]]));
  const omitted=createDocxReceipt(result.evidence,result.chunks.slice(0,1));
  assert.throws(()=>assertDocxReceipt(omitted,hash,chunks.slice(0,1)),/paragraph coverage/);
  const changed=structuredClone(result.evidence);changed.stories[0].paragraphs[0].originalText="Different source.";
  assert.throws(()=>assertDocxReceipt(createDocxReceipt(changed,result.chunks),hash,chunks),/provenance/);
  assert.equal(sourceContainsExcerpt(result.chunks.map(c=>c.text).join("\n\n"),"A separate termination obligation."),true);
});
await check("conflicting revision identity and inconsistent table merges block",async()=>{
  blocked(extractDocx(await fixture({body:p(revision("ins","8","Synthetic A","One clause")+revision("ins","8","Synthetic B","Another clause"))})),"CONFLICTING_REVISION_IDENTITY");
  const cell=props=>'<w:tc><w:tcPr>'+props+'</w:tcPr>'+p(text("Recovery"))+'</w:tc>';
  blocked(extractDocx(await fixture({body:'<w:tbl><w:tblGrid><w:gridCol/></w:tblGrid><w:tr>'+cell('<w:vMerge/>')+'</w:tr></w:tbl>'})),"UNRESOLVED_VERTICAL_MERGE");
  blocked(extractDocx(await fixture({body:'<w:tbl><w:tblGrid><w:gridCol/></w:tblGrid><w:tr>'+cell('<w:gridSpan w:val="2"/>')+'</w:tr></w:tbl>'})),"INCONSISTENT_TABLE_GRID");
});
await check("broken, missing, duplicate and orphan comment anchors block extraction",async()=>{
  for(const body of [p('<w:commentRangeStart w:id="0"/>'+text("Clause")),p(text("Clause")+'<w:commentRangeEnd w:id="0"/>'),p('<w:commentRangeStart w:id="0"/><w:commentRangeStart w:id="0"/>'+text("Clause")+'<w:commentRangeEnd w:id="0"/>'),p(text("Clause"))]){
    const result=extractDocx(await fixture({body,parts:{"word/comments.xml":{kind:"comments",xml:story("comments",comment("0","Synthetic context"))}}}));assert.equal(result.evidence.analysisEligible,false);assert.deepEqual(result.chunks,[]);
  }
  blocked(extractDocx(await fixture({body:p(text("Clause")+'<w:r><w:commentReference w:id="9"/></w:r>')})),"MISSING_COMMENT_BODY");
  blocked(extractDocx(await fixture({body:p(text("Clause")+'<w:r><w:commentReference w:id="0"/></w:r>'),parts:{"word/comments.xml":{kind:"comments",xml:story("comments",comment("0","A")+comment("0","B"))}}})),"DUPLICATE_OR_MISSING_COMMENT_ID");
});
await check("revision metadata gaps and structural/property revisions are preserved and blocked",async()=>{
  blocked(extractDocx(await fixture({body:p('<w:ins w:id="3">'+text("Changed obligation")+'</w:ins>')})),"MISSING_REVISION_METADATA");
  const result=extractDocx(await fixture({body:p('<w:pPr><w:pPrChange w:id="3" w:author="Synthetic A"><w:pPr><w:keepNext/></w:pPr></w:pPrChange></w:pPr>'+text("Changed paragraph formatting."))}));
  blocked(result,"UNSUPPORTED_STRUCTURAL_REVISION");assert.equal(result.evidence.revisions[0].kind,"pPrChange");assert.ok(result.evidence.revisions[0].properties.children.length);
  const styles=extractDocx(await fixture({parts:{"word/styles.xml":{kind:"styles",xml:story("styles",'<w:style w:styleId="Unused"><w:rPr><w:rPrChange w:id="9" w:author="Synthetic A"><w:rPr/></w:rPrChange></w:rPr></w:style>')}}}));
  blocked(styles,"UNSUPPORTED_AUXILIARY_REVISION");assert.equal(styles.evidence.revisions.find(r=>r.source.part==="word/styles.xml").author,"Synthetic A");
  blocked(extractDocx(await fixture({body:p(text("Clause")+'<w:r><w:commentReference w:id="0"/></w:r>'),parts:{"word/comments.xml":{kind:"comments",xml:story("comments",'<w:comment w:id="0" w:author="Synthetic A">'+p(revision("ins","20","Synthetic B","Edited rationale"))+'</w:comment>')}}})),"UNSUPPORTED_COMMENT_REVISION");
});
for(const [feature,xml,code] of [
  ["fields",'<w:fldSimple w:instr="DATE">'+text("October 8, 2026")+'</w:fldSimple>',"UNSUPPORTED_FLDSIMPLE"],
  ["complex fields",'<w:r><w:fldChar w:fldCharType="begin"/><w:instrText>DATE</w:instrText></w:r>',"UNSUPPORTED_FLDCHAR"],
  ["drawings",'<w:r><w:drawing/></w:r>',"UNSUPPORTED_DRAWING"],
  ["content controls",'<w:sdt><w:sdtContent>'+p(text("Bound data"))+'</w:sdtContent></w:sdt>',"UNSUPPORTED_SDT"],
  ["custom XML",'<w:customXml>'+text("Dynamic data")+'</w:customXml>',"UNSUPPORTED_CUSTOMXML"],
  ["tracked moves",'<w:moveFrom w:id="5" w:author="Synthetic A">'+text("Moved obligation")+'</w:moveFrom>',"UNSUPPORTED_STRUCTURAL_REVISION"],
  ["hidden text",'<w:r><w:rPr><w:vanish/></w:rPr><w:t>Hidden obligation</w:t></w:r>',"UNSUPPORTED_VANISH"],
  ["numbering",'<w:pPr><w:numPr><w:numId w:val="1"/></w:numPr></w:pPr>'+text("Numbered obligation"),"UNSUPPORTED_NUMPR"],
  ["unknown content",'<w:futureObligation>'+text("Future schema")+'</w:futureObligation>',"UNKNOWN_WORD_ELEMENT"],
  ["alternate content",'<mc:AlternateContent xmlns:mc="http://schemas.openxmlformats.org/markup-compatibility/2006"><mc:Fallback>'+text("Alternative obligation")+'</mc:Fallback></mc:AlternateContent>',"MARKUP_COMPATIBILITY"]
])await check(`unsupported ${feature} blocks without publishing partial chunks`,async()=>blocked(extractDocx(await fixture({body:p(text("Supported text ")+xml)})),code));
await check("unused styles are retained; used inherited numbering and style cycles block",async()=>{
  const styleXml='<w:style w:styleId="Unused"><w:pPr><w:numPr><w:numId w:val="1"/></w:numPr></w:pPr></w:style><w:style w:styleId="Base"><w:pPr><w:numPr><w:numId w:val="1"/></w:numPr></w:pPr></w:style><w:style w:styleId="Child"><w:basedOn w:val="Base"/></w:style>';
  const parts={"word/styles.xml":{kind:"styles",xml:story("styles",styleXml)}};
  assert.equal(extractDocx(await fixture({parts})).evidence.analysisEligible,true);
  blocked(extractDocx(await fixture({body:p('<w:pPr><w:pStyle w:val="Child"/></w:pPr>'+text("Styled clause")),parts})),"STYLE_SEMANTICS_UNRESOLVED");
  const cyclic={"word/styles.xml":{kind:"styles",xml:story("styles",'<w:style w:styleId="Loop"><w:basedOn w:val="Loop"/></w:style>')}};
  blocked(extractDocx(await fixture({body:p('<w:pPr><w:pStyle w:val="Loop"/></w:pPr>'+text("Styled clause")),parts:cyclic})),"CYCLIC_STYLE");
});
await check("ignorable declarations alone do not hide content; unknown extensions block",async()=>{
  const attributes='xmlns:mc="http://schemas.openxmlformats.org/markup-compatibility/2006" xmlns:w14="http://schemas.microsoft.com/office/word/2010/wordml" mc:Ignorable="w14"';
  assert.equal(extractDocx(await fixture({main:document(replacement,attributes)})).evidence.analysisEligible,true);
  blocked(extractDocx(await fixture({main:document(p('<w14:novelRule/>')+replacement,attributes)})),"UNSUPPORTED_NAMESPACE");
});
await check("missing parts, external content, embeddings and unsupported XML block",async()=>{
  blocked(extractDocx(await fixture({rels:[relationship("missing","header","absent.xml")]})),"MISSING_RELATIONSHIP_TARGET");
  blocked(extractDocx(await fixture({rels:[relationship("remote","attachedTemplate","https://example.invalid/template",true)]})),"EXTERNAL_RELATIONSHIP");
  blocked(extractDocx(await fixture({parts:{"word/embeddings/object.bin":{xml:Buffer.from("synthetic"),type:"application/octet-stream"}}})),"UNSUPPORTED_BINARY_PART");
  blocked(extractDocx(await fixture({parts:{"word/commentsExtended.xml":"<future:comments xmlns:future=\"urn:synthetic\"/>"}})),"UNSUPPORTED_XML_PART");
  blocked(extractDocx(await fixture({body:p(text("Clause")+'<w:r><w:footnoteReference w:id="8"/></w:r>')})),"MISSING_NOTE_BODY");
  blocked(extractDocx(await fixture({body:p('<w:hyperlink r:id="missing">'+text("Link")+'</w:hyperlink>')})),"DANGLING_RELATIONSHIP_ID");
});
await check("external hyperlinks preserve targets, without fetching them",async()=>{
  const result=extractDocx(await fixture({body:p('<w:hyperlink r:id="link">'+text("Supporting source link")+'</w:hyperlink>'),rels:[relationship("link","hyperlink","https://example.invalid",true)]}));
  assert.equal(result.evidence.analysisEligible,true);assert.ok(result.evidence.issues.some(i=>i.code==="EXTERNAL_RELATIONSHIP"&&!i.blocking));assert.equal(result.evidence.relationships.at(-1).target,"https://example.invalid");
});
await check("malformed XML, DTD/entity expansion, strict namespace and uncovered text block",async()=>{
  blocked(extractDocx(await fixture({main:document(replacement).replace('</w:body>','</w:broken>')})),"INVALID_OR_UNSUPPORTED_PACKAGE");
  blocked(extractDocx(await fixture({main:'<!DOCTYPE document [<!ENTITY external SYSTEM "file:///etc/passwd">]>'+document(replacement)})),"INVALID_OR_UNSUPPORTED_PACKAGE");
  blocked(extractDocx(await fixture({main:document(replacement).replaceAll(W,"http://purl.oclc.org/ooxml/wordprocessingml/main")})),"INVALID_OR_UNSUPPORTED_PACKAGE");
  blocked(extractDocx(await fixture({body:replacement+'<w:r><w:t>Uncovered obligation</w:t></w:r>'})),"UNCOVERED_STORY_TEXT");
  blocked(extractDocx(await fixture({body:""})),"EMPTY_MAIN_STORY");
});
await check("ZIP corruption, duplicate/unsafe names, encryption and expansion bounds fail closed",async()=>{
  blocked(extractDocx(new Uint8Array([1,2,3]).buffer),"INVALID_OR_UNSUPPORTED_PACKAGE");
  const bytes=Buffer.from(await fixture({compression:"STORE"})),tampered=Buffer.from(bytes),position=tampered.indexOf(Buffer.from("Customer shall pay"));tampered[position]^=1;
  blocked(extractDocx(tampered.buffer.slice(tampered.byteOffset,tampered.byteOffset+tampered.byteLength)),"INVALID_OR_UNSUPPORTED_PACKAGE");
  const duplicate=Buffer.from(await fixture({parts:{"word/zzzzzzzz.xml":"<synthetic/>"},compression:"STORE"}));
  const old=Buffer.from("word/zzzzzzzz.xml"),replacementName=Buffer.from("word/document.xml");assert.equal(old.length,replacementName.length);
  let offset=0;while((offset=duplicate.indexOf(old,offset))>=0){replacementName.copy(duplicate,offset);offset+=old.length;}
  blocked(extractDocx(duplicate.buffer.slice(duplicate.byteOffset,duplicate.byteOffset+duplicate.byteLength)),"INVALID_OR_UNSUPPORTED_PACKAGE");
  blocked(extractDocx(await fixture({parts:{"../escape.xml":"<synthetic/>"}})),"INVALID_OR_UNSUPPORTED_PACKAGE");
  const encrypted=Buffer.from(bytes),central=encrypted.indexOf(Buffer.from([0x50,0x4b,0x01,0x02]));encrypted.writeUInt16LE(encrypted.readUInt16LE(central+8)|1,central+8);
  blocked(extractDocx(encrypted.buffer.slice(encrypted.byteOffset,encrypted.byteOffset+encrypted.byteLength)),"INVALID_OR_UNSUPPORTED_PACKAGE");
  blocked(extractDocx(await fixture({main:document(p(text("x".repeat(8*1024*1024))))})),"INVALID_OR_UNSUPPORTED_PACKAGE");
});
await check("oversized clause and extreme XML nesting block rather than truncate",async()=>{
  blocked(extractDocx(await fixture({body:p(text("x".repeat(100_001)))})),"OVERSIZED_PARAGRAPH_PROJECTION");
  blocked(extractDocx(await fixture({body:"<w:p>"+"<w:r>".repeat(150)+"<w:t>Text</w:t>"+"</w:r>".repeat(150)+"</w:p>"})),"INVALID_OR_UNSUPPORTED_PACKAGE");
  const name="x".repeat(257);
  blocked(extractDocx(await fixture({body:replacement+`<w:${name}/>`})),"INVALID_OR_UNSUPPORTED_PACKAGE");
});
await check("extractDocument routes DOCX to evidence, keeps TXT behavior and never flattens invalid DOCX",async()=>{
  const type="application/vnd.openxmlformats-officedocument.wordprocessingml.document",result=await extractDocument(await fixture(),type);
  assert.equal(result.method,"DOCX_OOXML_EVIDENCE");assert.equal(result.docxEvidence.analysisEligible,true);assert.equal(result.pageCount,null);
  const bad=await extractDocument(new Uint8Array([1,2,3]).buffer,type);assert.equal(bad.docxEvidence.analysisEligible,false);assert.deepEqual(bad.chunks,[]);
  const plain=await extractDocument(new TextEncoder().encode("Ordinary plain source.").buffer,"text/plain");assert.equal(plain.method,"PLAIN_TEXT");assert.equal(plain.chunks[0].text,"Ordinary plain source.");
});

console.log(`DOCX evidence regression checks passed: ${cases} synthetic scenarios. No external AI, customer source, database or deployment was used.`);
