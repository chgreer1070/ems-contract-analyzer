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
  ["legacy drawings",'<w:r><w:pict/></w:r>',"UNSUPPORTED_PICT"],
  ["content controls",'<w:sdt><w:sdtContent>'+p(text("Bound data"))+'</w:sdtContent></w:sdt>',"UNSUPPORTED_SDT"],
  ["custom XML",'<w:customXml>'+text("Dynamic data")+'</w:customXml>',"UNSUPPORTED_CUSTOMXML"],
  ["tracked moves",'<w:moveFrom w:id="5" w:author="Synthetic A">'+text("Moved obligation")+'</w:moveFrom>',"UNSUPPORTED_STRUCTURAL_REVISION"],
  ["hidden text",'<w:r><w:rPr><w:vanish/></w:rPr><w:t>Hidden obligation</w:t></w:r>',"UNSUPPORTED_VANISH"],
  ["numbering",'<w:pPr><w:numPr><w:numId w:val="1"/></w:numPr></w:pPr>'+text("Numbered obligation"),"UNSUPPORTED_NUMPR"],
  ["unknown content",'<w:futureObligation>'+text("Future schema")+'</w:futureObligation>',"UNKNOWN_WORD_ELEMENT"],
  ["alternate content",'<mc:AlternateContent xmlns:mc="http://schemas.openxmlformats.org/markup-compatibility/2006"><mc:Fallback>'+text("Alternative obligation")+'</mc:Fallback></mc:AlternateContent>',"MARKUP_COMPATIBILITY"]
])await check(`unsupported ${feature} blocks without publishing partial chunks`,async()=>blocked(extractDocx(await fixture({body:p(text("Supported text ")+xml)})),code));
await check("a hidden or unresolved text box is not contract-source text",async()=>{
  const sentence="This hidden sentence is not on the page.";
  const inner=`<w:txbxContent>${p(text(sentence))}</w:txbxContent>`;
  const hiddenVml=`<w:pict><v:shape xmlns:v="urn:schemas-microsoft-com:vml" style="position:absolute;visibility:hidden;width:100pt"><v:textbox>${inner}</v:textbox></v:shape></w:pict>`;
  const inheritVml=`<w:pict><v:shape xmlns:v="urn:schemas-microsoft-com:vml" style="visibility:inherit"><v:textbox>${inner}</v:textbox></v:shape></w:pict>`;
  const hiddenDrawing=`<w:drawing><wp:docPr xmlns:wp="http://schemas.openxmlformats.org/drawingml/2006/wordprocessingDrawing" id="1" name="Box" hidden="1"/>${inner}</w:drawing>`;
  for(const wrapper of [hiddenVml,inheritVml,hiddenDrawing]){
    const result=extractDocx(await fixture({body:p(`<w:r>${wrapper}</w:r>`)}));
    blocked(result,"UNSUPPORTED_VANISH");
    assert.equal(result.chunks.some(chunk=>chunk.text.includes(sentence)),false);
  }
  const visibleVml=`<w:pict><v:shape xmlns:v="urn:schemas-microsoft-com:vml" style="visibility:visible"><v:textbox>${inner}</v:textbox></v:shape></w:pict>`;
  const visibleDrawing=`<w:drawing><wp:docPr xmlns:wp="http://schemas.openxmlformats.org/drawingml/2006/wordprocessingDrawing" id="2" name="Box" hidden="0"/>${inner}</w:drawing>`;
  for(const wrapper of [visibleVml,visibleDrawing]){
    const result=extractDocx(await fixture({body:p(text("1.2 Fees. The body states the fee rule."))+p(`<w:r>${wrapper}</w:r>`)}));
    assert.equal(result.evidence.analysisEligible,true,JSON.stringify(result.evidence.issues));
    const matches=result.chunks.map(chunk=>readDocxProjection(chunk.text)).filter(item=>item.paragraph.proposedText===sentence);
    assert.equal(matches.length,1);
    assert.equal(matches[0].paragraph.locator,"Text box in section 1.2");
  }
});
await check("ordinary text-box wrappers keep one copy of the words",async()=>{
  const box="The text box states a late fee of one percent (1%) per month.";
  const inner=`<w:txbxContent>${p(text(box))}</w:txbxContent>`;
  const vml=`<w:pict><v:shape xmlns:v="urn:schemas-microsoft-com:vml" style="width:100pt"><v:textbox>${inner}</v:textbox></v:shape></w:pict>`;
  const alternate=`<mc:AlternateContent xmlns:mc="http://schemas.openxmlformats.org/markup-compatibility/2006" xmlns:wps="http://schemas.microsoft.com/office/word/2010/wordprocessingShape"><mc:Choice Requires="wps"><w:drawing><wp:anchor xmlns:wp="http://schemas.openxmlformats.org/drawingml/2006/wordprocessingDrawing"><a:graphic xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main"><a:graphicData uri="urn:synthetic"><wps:wsp xmlns:wps="http://schemas.microsoft.com/office/word/2010/wordprocessingShape"><wps:txbx>${inner}</wps:txbx></wps:wsp></a:graphicData></a:graphic></wp:anchor></w:drawing></mc:Choice><mc:Fallback>${vml}</mc:Fallback></mc:AlternateContent>`;
  for(const wrapper of [`<w:r>${vml}</w:r>`,`<w:r>${alternate}</w:r>`]){
    const result=extractDocx(await fixture({body:p(text("1.2 Fees. The body states the fee rule."))+p(wrapper)}));
    assert.equal(result.evidence.analysisEligible,true,JSON.stringify(result.evidence.issues));
    const matches=result.chunks.map(chunk=>readDocxProjection(chunk.text)).filter(item=>item.paragraph.proposedText===box);
    assert.equal(matches.length,1);
    assert.equal(matches[0].paragraph.locator,"Text box in section 1.2");
    assert.equal(matches[0].paragraph.proposedText,box);
    assert.equal(matches[0].paragraph.source.part,"word/document.xml");
  }
});
await check("an equation inside a text box blocks the same way it does in the body",async()=>{
  const gap="Cancellation fee is  USD.";
  const math='<m:oMath xmlns:m="http://schemas.openxmlformats.org/officeDocument/2006/math"><m:r><m:t>50000</m:t></m:r></m:oMath>';
  const clause=p(text("Cancellation fee is ")+math+text(" USD."));
  const inner=`<w:txbxContent>${clause}</w:txbxContent>`;
  const drawing=p(`<w:r><w:drawing><wp:anchor xmlns:wp="http://schemas.openxmlformats.org/drawingml/2006/wordprocessingDrawing"><a:graphic xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main"><a:graphicData uri="urn:synthetic"><wps:wsp xmlns:wps="http://schemas.microsoft.com/office/word/2010/wordprocessingShape"><wps:txbx>${inner}</wps:txbx></wps:wsp></a:graphicData></a:graphic></wp:anchor></w:drawing></w:r>`);
  const vml=p(`<w:r><w:pict><v:shape xmlns:v="urn:schemas-microsoft-com:vml"><v:textbox>${inner}</v:textbox></v:shape></w:pict></w:r>`);
  for(const body of [drawing,vml,clause]){
    const result=extractDocx(await fixture({body}));
    blocked(result,"UNSUPPORTED_NAMESPACE");
    const mathIssue=result.evidence.issues.find(issue=>issue.blocking&&issue.code==="UNSUPPORTED_NAMESPACE"&&issue.source?.path.includes("oMath"));
    assert.ok(mathIssue,JSON.stringify(result.evidence.issues.map(issue=>[issue.code,issue.source?.path])));
    assert.equal(result.chunks.some(chunk=>chunk.text.includes(gap)||chunk.text.includes("50000")),false);
  }
});
await check("a supported choice is the only published text when fallback payment days differ",async()=>{
  const branch=words=>`<w:txbxContent>${p(text(words))}</w:txbxContent>`;
  const choiceWords="Customer shall pay within thirty (30) days of invoice.";
  const fallbackWords="Customer shall pay within sixty (60) days of invoice.";
  const alternate=`<mc:AlternateContent xmlns:mc="http://schemas.openxmlformats.org/markup-compatibility/2006" xmlns:wps="http://schemas.microsoft.com/office/word/2010/wordprocessingShape"><mc:Choice Requires="wps"><w:drawing>${branch(choiceWords)}</w:drawing></mc:Choice><mc:Fallback><w:pict>${branch(fallbackWords)}</w:pict></mc:Fallback></mc:AlternateContent>`;
  const result=extractDocx(await fixture({body:p(text("1.3 Payment. See the box."))+p(`<w:r>${alternate}</w:r>`)}));
  assert.equal(result.evidence.analysisEligible,true,JSON.stringify(result.evidence.issues));
  const boxChunks=result.chunks.filter(chunk=>readDocxProjection(chunk.text).paragraph.proposedText===choiceWords);
  assert.equal(boxChunks.length,1);
  assert.equal(result.chunks.some(chunk=>chunk.text.includes("sixty")),false);
  assert.equal(result.evidence.issues.some(issue=>issue.code==="DIVERGENT_ALTERNATE_TEXT"),false);
});
await check("an unsupported choice uses the fallback text box alone",async()=>{
  const fallbackWords="Customer shall pay within thirty (30) days of invoice.";
  const branch=words=>`<w:txbxContent>${p(text(words))}</w:txbxContent>`;
  const alternate=`<mc:AlternateContent xmlns:mc="http://schemas.openxmlformats.org/markup-compatibility/2006"><mc:Choice Requires="futureShape"><w:drawing>${branch("Customer shall pay within sixty (60) days of invoice.")}</w:drawing></mc:Choice><mc:Fallback><w:pict>${branch(fallbackWords)}</w:pict></mc:Fallback></mc:AlternateContent>`;
  const result=extractDocx(await fixture({body:p(`<w:r>${alternate}</w:r>`)}));
  assert.equal(result.evidence.analysisEligible,true,JSON.stringify(result.evidence.issues));
  assert.equal(result.chunks.length,1);
  assert.equal(readDocxProjection(result.chunks[0].text).paragraph.proposedText,fallbackWords);
  assert.equal(result.chunks.some(chunk=>chunk.text.includes("sixty")),false);
});
await check("identical choice and fallback text boxes yield a single chunk",async()=>{
  const words="Customer shall pay within thirty (30) days of invoice.";
  const branch=`<w:txbxContent>${p(text(words))}</w:txbxContent>`;
  const alternate=`<mc:AlternateContent xmlns:mc="http://schemas.openxmlformats.org/markup-compatibility/2006" xmlns:wps="http://schemas.microsoft.com/office/word/2010/wordprocessingShape"><mc:Choice Requires="wps"><w:drawing>${branch}</w:drawing></mc:Choice><mc:Fallback><w:pict>${branch}</w:pict></mc:Fallback></mc:AlternateContent>`;
  const result=extractDocx(await fixture({body:p(`<w:r>${alternate}</w:r>`)}));
  assert.equal(result.evidence.analysisEligible,true,JSON.stringify(result.evidence.issues));
  assert.equal(result.chunks.length,1);
  assert.equal(readDocxProjection(result.chunks[0].text).paragraph.proposedText,words);
  assert.equal(readDocxProjection(result.chunks[0].text).paragraph.runs.filter(run=>run.text===words).length,1);
});
await check("a picture in the supported choice blocks instead of publishing the fallback",async()=>{
  const choiceWords="Customer shall pay within thirty (30) days of invoice.";
  const fallbackWords="Customer shall pay within sixty (60) days of invoice.";
  const alternate=`<mc:AlternateContent xmlns:mc="http://schemas.openxmlformats.org/markup-compatibility/2006" xmlns:wps="http://schemas.microsoft.com/office/word/2010/wordprocessingShape"><mc:Choice Requires="wps"><w:drawing><a:blip xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main"/><w:txbxContent>${p(text(choiceWords))}</w:txbxContent></w:drawing></mc:Choice><mc:Fallback><w:pict><w:txbxContent>${p(text(fallbackWords))}</w:txbxContent></w:pict></mc:Fallback></mc:AlternateContent>`;
  const result=extractDocx(await fixture({body:p(`<w:r>${alternate}</w:r>`)}));
  blocked(result,"UNSUPPORTED_DRAWING");
  assert.equal(result.chunks.some(chunk=>chunk.text.includes("thirty")||chunk.text.includes("sixty")),false);
  const kept=result.evidence.stories.flatMap(story=>story.paragraphs.map(paragraph=>`${paragraph.originalText}\n${paragraph.proposedText}`)).join("\n");
  assert.equal(kept.includes("sixty"),false);
});
await check("a picture in the older copy does not block the supported text box",async()=>{
  const choiceWords="Customer shall pay within thirty (30) days of invoice.";
  const alternate=`<mc:AlternateContent xmlns:mc="http://schemas.openxmlformats.org/markup-compatibility/2006" xmlns:wps="http://schemas.microsoft.com/office/word/2010/wordprocessingShape"><mc:Choice Requires="wps"><w:drawing><w:txbxContent>${p(text(choiceWords))}</w:txbxContent></w:drawing></mc:Choice><mc:Fallback><w:pict><a:blip xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main"/><w:txbxContent>${p(text("Customer shall pay within sixty (60) days of invoice."))}</w:txbxContent></w:pict></mc:Fallback></mc:AlternateContent>`;
  const result=extractDocx(await fixture({body:p(`<w:r>${alternate}</w:r>`)}));
  assert.equal(result.evidence.analysisEligible,true,JSON.stringify(result.evidence.issues));
  assert.equal(result.chunks.length,1);
  assert.equal(readDocxProjection(result.chunks[0].text).paragraph.proposedText,choiceWords);
  assert.equal(result.chunks.some(chunk=>chunk.text.includes("sixty")),false);
});
await check("a comment on the unread text-box copy does not block the chosen words",async()=>{
  const choiceWords="Customer shall pay within thirty (30) days of invoice.";
  const note="This comment is on the older text box and is not contract text.";
  const marked=words=>p('<w:commentRangeStart w:id="0"/>'+text(words)+'<w:commentRangeEnd w:id="0"/>');
  const alternate=`<mc:AlternateContent xmlns:mc="http://schemas.openxmlformats.org/markup-compatibility/2006" xmlns:wps="http://schemas.microsoft.com/office/word/2010/wordprocessingShape"><mc:Choice Requires="wps"><w:drawing><w:txbxContent>${marked(choiceWords)}</w:txbxContent></w:drawing></mc:Choice><mc:Fallback><w:pict><w:txbxContent>${marked("Customer shall pay within sixty (60) days of invoice.")}</w:txbxContent></w:pict></mc:Fallback></mc:AlternateContent>`;
  const result=extractDocx(await fixture({body:p(`<w:r>${alternate}</w:r>`),parts:{"word/comments.xml":{kind:"comments",xml:story("comments",comment("0",note))}}}));
  assert.equal(result.evidence.analysisEligible,true,JSON.stringify(result.evidence.issues));
  const chosen=result.chunks.filter(chunk=>readDocxProjection(chunk.text).paragraph.proposedText===choiceWords);
  assert.equal(chosen.length,1);
  assert.equal(result.chunks.some(chunk=>chunk.text.includes("sixty")),false);
  assert.equal(sourceContainsExcerpt(result.chunks.map(chunk=>chunk.text).join("\n\n"),note),false);
});
await check("divergent text boxes with no safe branch are not read as the contract",async()=>{
  const branch=words=>`<a:blip xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main"/><w:txbxContent>${p(text(words))}</w:txbxContent>`;
  const alternate=`<mc:AlternateContent xmlns:mc="http://schemas.openxmlformats.org/markup-compatibility/2006"><mc:Choice Requires="futureShape"><w:drawing>${branch("Customer shall pay within thirty (30) days of invoice.")}</w:drawing></mc:Choice><mc:Fallback><w:pict>${branch("Customer shall pay within sixty (60) days of invoice.")}</w:pict></mc:Fallback></mc:AlternateContent>`;
  const result=extractDocx(await fixture({body:p(`<w:r>${alternate}</w:r>`)}));
  blocked(result,"DIVERGENT_ALTERNATE_TEXT");
  assert.equal(result.chunks.some(chunk=>chunk.text.includes("thirty")||chunk.text.includes("sixty")),false);
});
await check("a separate text box keeps current words when an earlier box only deletes them",async()=>{
  const sentence="Customer shall pay a late fee of one percent (1%) per month.";
  const deleted=`<w:r><w:drawing><w:txbxContent>${p(revision("del","30","Synthetic Flex Counsel",sentence))}</w:txbxContent></w:drawing></w:r>`;
  const current=`<w:r><w:drawing><w:txbxContent>${p(text(sentence))}</w:txbxContent></w:drawing></w:r>`;
  const duplicate=`<w:r><w:drawing><w:txbxContent>${p(text(sentence))}</w:txbxContent></w:drawing></w:r>`;
  const result=extractDocx(await fixture({body:p(text("1.4 Fees. ")+deleted+current+duplicate)}));
  assert.equal(result.evidence.analysisEligible,true,JSON.stringify(result.evidence.issues));
  const proposed=result.chunks.map(chunk=>readDocxProjection(chunk.text)).filter(item=>item.paragraph.proposedText===sentence);
  assert.equal(proposed.length,2);
  assert.equal(proposedTextContainsExcerpt(result.chunks.find(chunk=>readDocxProjection(chunk.text).paragraph.proposedText===sentence).text,sentence),true);
});
await check("a comment wrapped around a text box stays with the box words",async()=>{
  const box="The text box states a late fee of one percent (1%) per month.";
  const note="This comment explains the text box and is not contract text.";
  const body=p('<w:commentRangeStart w:id="0"/>'+`<w:r><w:drawing><w:txbxContent>${p(text(box))}</w:txbxContent></w:drawing></w:r>`+'<w:commentRangeEnd w:id="0"/><w:r><w:commentReference w:id="0"/></w:r>');
  const result=extractDocx(await fixture({body,parts:{"word/comments.xml":{kind:"comments",xml:story("comments",comment("0",note))}}}));
  assert.equal(result.evidence.analysisEligible,true,JSON.stringify(result.evidence.issues));
  const projection=readDocxProjection(result.chunks.find(chunk=>readDocxProjection(chunk.text).paragraph.proposedText===box).text);
  assert.equal(projection.paragraph.proposedText,box);
  assert.ok(projection.paragraph.runs.some(run=>run.commentIds.includes("0")));
  assert.equal(projection.comments.length,1);
  assert.equal(projection.comments[0].text,note);
  assert.equal(sourceContainsExcerpt(result.chunks.map(chunk=>chunk.text).join("\n\n"),note),false);
});
await check("a drawing that also contains an image still blocks for visual review",async()=>{
  const body=p(text("1.1 Price. See the note.")+'<w:r><w:drawing><a:blip xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main"/><w:txbxContent>'+p(text("The text box states a late fee of one percent (1%) per month."))+'</w:txbxContent></w:drawing></w:r>');
  blocked(extractDocx(await fixture({body})),"UNSUPPORTED_DRAWING");
});
await check("footnote words and plain text boxes are contract-source text with a locator and a verbatim quote",async()=>{
  const footnote="The unit price in the footnote is USD 9.50 per unit.";
  const box="The text box states a late fee of one percent (1%) per month.";
  const deleted="Customer shall pay the deleted-only penalty within forty-five (45) days.";
  const commentText="This comment is not contract text.";
  const body=p(text("1.1 Price. See the footnote.")+'<w:r><w:footnoteReference w:id="1"/></w:r><w:r><w:commentReference w:id="0"/></w:r>')
    +p('<w:r><w:drawing><w:txbxContent>'+p(text(box))+'</w:txbxContent></w:drawing></w:r>')
    +p(revision("del","12","Synthetic Flex Counsel",deleted));
  const result=extractDocx(await fixture({body,parts:{
    "word/footnotes.xml":{kind:"footnotes",xml:story("footnotes",'<w:footnote w:type="separator" w:id="-1">'+p(text(" "))+'</w:footnote><w:footnote w:id="1">'+p(text(footnote))+'</w:footnote>')},
    "word/comments.xml":{kind:"comments",xml:story("comments",comment("0",commentText))}
  }}));
  assert.equal(result.evidence.analysisEligible,true,JSON.stringify(result.evidence.issues));
  assert.equal(result.evidence.legalEvidenceReady,false);
  const projections=result.chunks.map(chunk=>readDocxProjection(chunk.text));
  const footnoteChunk=result.chunks.find(chunk=>readDocxProjection(chunk.text).paragraph.proposedText===footnote);
  const boxChunk=result.chunks.find(chunk=>readDocxProjection(chunk.text).paragraph.proposedText===box);
  const footnoteProjection=readDocxProjection(footnoteChunk.text);
  const boxProjection=readDocxProjection(boxChunk.text);
  assert.equal(footnoteProjection.paragraph.source.part,"word/footnotes.xml");
  assert.equal(footnoteProjection.paragraph.locator,"Footnote 1");
  assert.equal(footnoteProjection.paragraph.proposedText,footnote);
  assert.equal(footnoteProjection.context,"UNAPPROVED_NEGOTIATION_EVIDENCE");
  assert.equal(sourceContainsExcerpt(footnoteChunk.text,footnote),true);
  assert.equal(proposedTextContainsExcerpt(footnoteChunk.text,footnote),true);
  assert.equal(boxProjection.paragraph.source.part,"word/document.xml");
  assert.equal(boxProjection.paragraph.locator,"Text box in section 1.1");
  assert.equal(boxProjection.paragraph.proposedText,box);
  assert.equal(sourceContainsExcerpt(boxChunk.text,box),true);
  assert.equal(proposedTextContainsExcerpt(boxChunk.text,box),true);
  assert.equal(result.chunks.every(chunk=>sourceContainsExcerpt(chunk.text,commentText)===false),true);
  assert.equal(result.chunks.every(chunk=>proposedTextContainsExcerpt(chunk.text,deleted)===false),true);
  assert.equal(projections.some(item=>item.paragraph.proposedText.includes(deleted)),false);
  assert.deepEqual(
    {document:footnoteProjection.paragraph.source.part,section:footnoteProjection.paragraph.locator,quote:footnoteProjection.paragraph.proposedText},
    {document:"word/footnotes.xml",section:"Footnote 1",quote:footnote}
  );
  assert.deepEqual(
    {document:boxProjection.paragraph.source.part,section:boxProjection.paragraph.locator,quote:boxProjection.paragraph.proposedText},
    {document:"word/document.xml",section:"Text box in section 1.1",quote:box}
  );
});
await check("a footnote label uses the displayed number when the XML id differs",async()=>{
  const first="The first displayed footnote states net thirty (30) days.";
  const second="The second displayed footnote states a late fee.";
  const body=p(text("1.1 Price. See the notes.")+'<w:r><w:footnoteReference w:id="42"/></w:r>')+p('<w:r><w:footnoteReference w:id="7"/></w:r>');
  const notes='<w:footnote w:type="separator" w:id="-1">'+p(text(" "))+'</w:footnote>'
    +'<w:footnote w:id="7">'+p(text(second))+'</w:footnote>'
    +'<w:footnote w:id="42">'+p(text(first))+'</w:footnote>';
  const result=extractDocx(await fixture({body,parts:{"word/footnotes.xml":{kind:"footnotes",xml:story("footnotes",notes)}}}));
  assert.equal(result.evidence.analysisEligible,true,JSON.stringify(result.evidence.issues));
  const label=words=>readDocxProjection(result.chunks.find(chunk=>readDocxProjection(chunk.text).paragraph.proposedText===words).text).paragraph.locator;
  assert.equal(label(first),"Footnote 1");
  assert.equal(label(second),"Footnote 2");
  assert.equal(proposedTextContainsExcerpt(result.chunks.find(chunk=>readDocxProjection(chunk.text).paragraph.proposedText===first).text,first),true);
});
await check("a footnote whose displayed number starts at five is not cited by its XML id",async()=>{
  const note="The unit price in the footnote is USD 9.50 per unit.";
  const body=p(text("1.1 Price. See the footnote.")+'<w:r><w:footnoteReference w:id="42"/></w:r>')+'<w:sectPr><w:footnotePr><w:numFmt w:val="decimal"/><w:numStart w:val="5"/><w:numRestart w:val="continuous"/></w:footnotePr></w:sectPr>';
  const result=extractDocx(await fixture({body,parts:{"word/footnotes.xml":{kind:"footnotes",xml:story("footnotes",'<w:footnote w:id="42">'+p(text(note))+'</w:footnote>')}}}));
  assert.equal(result.evidence.analysisEligible,true,JSON.stringify(result.evidence.issues));
  const projection=readDocxProjection(result.chunks.find(chunk=>readDocxProjection(chunk.text).paragraph.proposedText===note).text);
  assert.equal(projection.paragraph.locator,"Footnote 5");
  assert.equal(projection.paragraph.proposedText,note);
});
await check("a footnote number that depends on page layout is labeled as an XML id",async()=>{
  const note="The unit price in the footnote is USD 9.50 per unit.";
  const noteXml=story("footnotes",'<w:footnote w:id="42">'+p(text(note))+'</w:footnote>');
  for(const properties of ['<w:numRestart w:val="eachPage"/>','<w:numFmt w:val="lowerRoman"/>']){
    const body=p(text("1.1 Price. See the footnote.")+'<w:r><w:footnoteReference w:id="42"/></w:r>')+`<w:sectPr><w:footnotePr>${properties}</w:footnotePr></w:sectPr>`;
    const result=extractDocx(await fixture({body,parts:{"word/footnotes.xml":{kind:"footnotes",xml:noteXml}}}));
    assert.equal(result.evidence.analysisEligible,true,JSON.stringify(result.evidence.issues));
    const projection=readDocxProjection(result.chunks.find(chunk=>readDocxProjection(chunk.text).paragraph.proposedText===note).text);
    assert.equal(projection.paragraph.locator,"Footnote XML id 42");
    assert.equal(projection.paragraph.proposedText,note);
    assert.equal(result.chunks.some(chunk=>readDocxProjection(chunk.text).paragraph.locator==="Footnote 42"),false);
  }
  const custom=p(text("1.1 Price. See the footnote.")+'<w:r><w:footnoteReference w:id="42" w:customMarkFollows="1"/>'+text("*")+'</w:r>');
  const customResult=extractDocx(await fixture({body:custom,parts:{"word/footnotes.xml":{kind:"footnotes",xml:noteXml}}}));
  assert.equal(customResult.evidence.analysisEligible,true,JSON.stringify(customResult.evidence.issues));
  assert.equal(readDocxProjection(customResult.chunks.find(chunk=>readDocxProjection(chunk.text).paragraph.proposedText===note).text).paragraph.locator,"Footnote XML id 42");
});
await check("document-wide footnote numbering is read before a section override",async()=>{
  const note="The unit price in the footnote is USD 9.50 per unit.";
  const notes=story("footnotes",'<w:footnote w:id="42">'+p(text(note))+'</w:footnote>');
  const body=p(text("1.1 Price. See the footnote.")+'<w:r><w:footnoteReference w:id="42"/></w:r>');
  const settings=(fmt,start)=>story("settings",`<w:footnotePr><w:numFmt w:val="${fmt}"/><w:numStart w:val="${start}"/></w:footnotePr>`);
  const label=result=>readDocxProjection(result.chunks.find(chunk=>readDocxProjection(chunk.text).paragraph.proposedText===note).text).paragraph.locator;
  const roman=extractDocx(await fixture({body,parts:{"word/footnotes.xml":{kind:"footnotes",xml:notes},"word/settings.xml":{kind:"settings",xml:settings("lowerRoman","5")}}}));
  assert.equal(roman.evidence.analysisEligible,true,JSON.stringify(roman.evidence.issues));
  assert.equal(label(roman),"Footnote XML id 42");
  assert.equal(roman.chunks.some(chunk=>readDocxProjection(chunk.text).paragraph.locator==="Footnote 1"),false);
  const decimal=extractDocx(await fixture({body,parts:{"word/footnotes.xml":{kind:"footnotes",xml:notes},"word/settings.xml":{kind:"settings",xml:settings("decimal","5")}}}));
  assert.equal(decimal.evidence.analysisEligible,true,JSON.stringify(decimal.evidence.issues));
  assert.equal(label(decimal),"Footnote 5");
  const override=document(body).replace("<w:sectPr/>",'<w:sectPr><w:footnotePr><w:numFmt w:val="decimal"/><w:numStart w:val="8"/></w:footnotePr></w:sectPr>');
  const overridden=extractDocx(await fixture({main:override,parts:{"word/footnotes.xml":{kind:"footnotes",xml:notes},"word/settings.xml":{kind:"settings",xml:settings("lowerRoman","5")}}}));
  assert.equal(overridden.evidence.analysisEligible,true,JSON.stringify(overridden.evidence.issues));
  assert.equal(label(overridden),"Footnote 8");
  const contradictory=[
    '<w:footnotePr><w:numFmt w:val="lowerRoman"/><w:numFmt w:val="decimal"/></w:footnotePr>',
    '<w:footnotePr><w:numRestart w:val="eachPage"/><w:numRestart w:val="continuous"/></w:footnotePr>',
    '<w:footnotePr><w:numFmt w:val="decimal"/><w:numStart w:val="1"/></w:footnotePr><w:footnotePr><w:numFmt w:val="lowerRoman"/></w:footnotePr>'
  ];
  for(const properties of contradictory){
    const marked=document(body).replace("<w:sectPr/>",`<w:sectPr>${properties}</w:sectPr>`);
    const result=extractDocx(await fixture({main:marked,parts:{"word/footnotes.xml":{kind:"footnotes",xml:notes}}}));
    assert.equal(result.evidence.analysisEligible,true,JSON.stringify(result.evidence.issues));
    assert.equal(label(result),"Footnote XML id 42");
  }
});
await check("a text box keeps each amendment instruction at the start of its own words",async()=>{
  const instructions=[
    "A. Section 1 of the Agreement is deleted and replaced in its entirety with the following:",
    "1. Delivery. Supplier shall deliver the goods within ten days.",
    "B. Section 2 of the Agreement is deleted and replaced in its entirety with the following:",
    "2. Delivery. Supplier shall deliver the spare parts within twenty days."
  ];
  const body=p(text("1.1 Price. See the box."))+p(`<w:r><w:drawing><w:txbxContent>${instructions.map(line=>p(text(line))).join("")}</w:txbxContent></w:drawing></w:r>`);
  const result=extractDocx(await fixture({body}));
  assert.equal(result.evidence.analysisEligible,true,JSON.stringify(result.evidence.issues));
  const boxed=instructions.map(line=>readDocxProjection(result.chunks.find(chunk=>readDocxProjection(chunk.text).paragraph.proposedText===line).text));
  assert.equal(boxed.length,instructions.length);
  for(const [index,projection] of boxed.entries()){
    assert.equal(projection.paragraph.proposedText,instructions[index]);
    assert.equal(projection.paragraph.proposedText.startsWith("[text box]"),false);
    assert.equal(projection.paragraph.locator,"Text box in section 1.1");
    assert.equal(proposedTextContainsExcerpt(result.chunks.find(chunk=>readDocxProjection(chunk.text).paragraph.proposedText===instructions[index]).text,instructions[index]),true);
  }
  const joined=boxed.map(item=>item.paragraph.proposedText).join("\n");
  assert.match(joined,/\nB\. Section 2 /);
  assert.equal(joined.includes("\n[text box] B. Section 2"),false);
});
await check("a point comment after a text box stays with the box words",async()=>{
  const box="The text box states a late fee of one percent (1%) per month.";
  const note="This point comment explains the text box and is not contract text.";
  const following="Customer shall deliver goods.";
  const body=p(`<w:r><w:drawing><w:txbxContent>${p(text(box))}</w:txbxContent></w:drawing></w:r>`+'<w:r><w:commentReference w:id="0"/></w:r>')+p(text(following));
  const result=extractDocx(await fixture({body,parts:{"word/comments.xml":{kind:"comments",xml:story("comments",comment("0",note))}}}));
  assert.equal(result.evidence.analysisEligible,true,JSON.stringify(result.evidence.issues));
  const projection=readDocxProjection(result.chunks.find(chunk=>readDocxProjection(chunk.text).paragraph.proposedText===box).text);
  assert.equal(projection.paragraph.proposedText,box);
  assert.ok(projection.paragraph.runs.some(run=>run.commentIds.includes("0")));
  assert.equal(projection.comments.length,1);
  assert.equal(projection.comments[0].text,note);
  const nextParagraph=readDocxProjection(result.chunks.find(chunk=>readDocxProjection(chunk.text).paragraph.proposedText===following).text);
  assert.equal(nextParagraph.comments.length,0);
  assert.ok(nextParagraph.paragraph.runs.every(run=>!run.commentIds.includes("0")));
  assert.equal(sourceContainsExcerpt(result.chunks.map(chunk=>chunk.text).join("\n\n"),note),false);
});
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

await check("a supported shape feature is recognized by its namespace, not the prefix spelling",async()=>{
  const choiceWords="Customer shall pay within thirty (30) days of invoice.";
  const fallbackWords="Customer shall pay within sixty (60) days of invoice.";
  const branch=words=>`<w:txbxContent>${p(text(words))}</w:txbxContent>`;
  const features=[
    ["shape","http://schemas.microsoft.com/office/word/2010/wordprocessingShape"],
    ["group","http://schemas.microsoft.com/office/word/2010/wordprocessingGroup"],
    ["canvas","http://schemas.microsoft.com/office/word/2010/wordprocessingCanvas"]
  ];
  for(const [prefix,uri] of features){
    const alternate=`<mc:AlternateContent xmlns:mc="http://schemas.openxmlformats.org/markup-compatibility/2006" xmlns:${prefix}="${uri}"><mc:Choice Requires="${prefix}"><w:drawing>${branch(choiceWords)}</w:drawing></mc:Choice><mc:Fallback><w:pict>${branch(fallbackWords)}</w:pict></mc:Fallback></mc:AlternateContent>`;
    const result=extractDocx(await fixture({body:p(`<w:r>${alternate}</w:r>`)}));
    assert.equal(result.evidence.analysisEligible,true,JSON.stringify(result.evidence.issues));
    assert.equal(result.chunks.some(chunk=>chunk.text.includes("thirty")),true,prefix);
    assert.equal(result.chunks.some(chunk=>chunk.text.includes("sixty")),false,prefix);
  }
  const other=`<mc:AlternateContent xmlns:mc="http://schemas.openxmlformats.org/markup-compatibility/2006" xmlns:shape="urn:not-a-shape"><mc:Choice Requires="shape"><w:drawing>${branch(choiceWords)}</w:drawing></mc:Choice><mc:Fallback><w:pict>${branch(fallbackWords)}</w:pict></mc:Fallback></mc:AlternateContent>`;
  const fallbackOnly=extractDocx(await fixture({body:p(`<w:r>${other}</w:r>`)}));
  assert.equal(fallbackOnly.evidence.analysisEligible,true,JSON.stringify(fallbackOnly.evidence.issues));
  assert.equal(fallbackOnly.chunks.some(chunk=>chunk.text.includes("sixty")),true);
  assert.equal(fallbackOnly.chunks.some(chunk=>chunk.text.includes("thirty")),false);
});
await check("a text box grouped with WordArt is not read as plain contract text",async()=>{
  const clause="Customer shall pay within thirty (30) days of invoice.";
  const wordArt="DRAFT - NOT BINDING";
  const body=p(`<w:r><w:pict><v:group xmlns:v="urn:schemas-microsoft-com:vml"><v:shape><v:textbox><w:txbxContent>${p(text(clause))}</w:txbxContent></v:textbox></v:shape><v:shape><v:textpath on="t" string="${wordArt}"/></v:shape></v:group></w:pict></w:r>`);
  const result=extractDocx(await fixture({body}));
  blocked(result,"UNSUPPORTED_NAMESPACE");
  assert.equal(result.chunks.some(chunk=>chunk.text.includes(clause)||chunk.text.includes(wordArt)),false);
});
await check("a style used only by the unread text-box copy does not block the chosen words",async()=>{
  const choiceWords="Customer shall pay within thirty (30) days of invoice.";
  const fallbackWords="Customer shall pay within sixty (60) days of invoice.";
  const parts={"word/styles.xml":{kind:"styles",xml:story("styles",'<w:style w:styleId="Hidden"><w:rPr><w:vanish/></w:rPr></w:style>')}};
  const hidden=words=>`<w:p><w:pPr><w:pStyle w:val="Hidden"/></w:pPr>${text(words)}</w:p>`;
  const wps='xmlns:wps="http://schemas.microsoft.com/office/word/2010/wordprocessingShape"';
  const alternate=`<mc:AlternateContent xmlns:mc="http://schemas.openxmlformats.org/markup-compatibility/2006" ${wps}><mc:Choice Requires="wps"><w:drawing><w:txbxContent>${p(text(choiceWords))}</w:txbxContent></w:drawing></mc:Choice><mc:Fallback><w:pict><w:txbxContent>${hidden(fallbackWords)}</w:txbxContent></w:pict></mc:Fallback></mc:AlternateContent>`;
  const result=extractDocx(await fixture({body:p(`<w:r>${alternate}</w:r>`),parts}));
  assert.equal(result.evidence.analysisEligible,true,JSON.stringify(result.evidence.issues));
  assert.equal(result.evidence.issues.some(issue=>issue.code==="STYLE_SEMANTICS_UNRESOLVED"),false);
  assert.equal(result.chunks.some(chunk=>chunk.text.includes("thirty")),true);
  assert.equal(result.chunks.some(chunk=>chunk.text.includes("sixty")),false);
  const chosenHidden=`<mc:AlternateContent xmlns:mc="http://schemas.openxmlformats.org/markup-compatibility/2006" ${wps}><mc:Choice Requires="wps"><w:drawing><w:txbxContent>${hidden(choiceWords)}</w:txbxContent></w:drawing></mc:Choice><mc:Fallback><w:pict><w:txbxContent>${p(text(fallbackWords))}</w:txbxContent></w:pict></mc:Fallback></mc:AlternateContent>`;
  blocked(extractDocx(await fixture({body:p(`<w:r>${chosenHidden}</w:r>`),parts})),"STYLE_SEMANTICS_UNRESOLVED");
});

await check("a comment that exists only on a skipped text-box copy is not treated as missing",async()=>{
  const choiceWords="Customer shall pay within thirty (30) days of invoice.";
  const fallbackWords="Customer shall pay within sixty (60) days of invoice.";
  const branch=(words,commentId)=>`<w:txbxContent>${p(text(words)+`<w:r><w:commentReference w:id="${commentId}"/></w:r>`)}</w:txbxContent>`;
  const rangedFallback=`<w:txbxContent>${p('<w:commentRangeStart w:id="3"/>'+text(fallbackWords)+'<w:commentRangeEnd w:id="3"/>')}</w:txbxContent>`;
  const alternate=`<mc:AlternateContent xmlns:mc="http://schemas.openxmlformats.org/markup-compatibility/2006" xmlns:wps="http://schemas.microsoft.com/office/word/2010/wordprocessingShape"><mc:Choice Requires="wps"><w:drawing>${branch(choiceWords,"1")}</w:drawing></mc:Choice><mc:Fallback><w:pict>${branch(fallbackWords,"2")}${rangedFallback}</w:pict></mc:Fallback></mc:AlternateContent>`;
  const comments=comment("1","Synthetic note on the current text box.")+comment("2","Synthetic note on the unread copy.")+comment("3","Synthetic range that exists only on the unread copy.");
  const kept=extractDocx(await fixture({body:p(`<w:r>${alternate}</w:r>`),parts:{"word/comments.xml":{kind:"comments",xml:story("comments",comments)}}}));
  assert.equal(kept.evidence.analysisEligible,true,JSON.stringify(kept.evidence.issues));
  assert.equal(kept.evidence.issues.some(issue=>issue.code==="ORPHAN_COMMENT"),false);
  assert.equal(kept.chunks.some(chunk=>chunk.text.includes("thirty")),true);
  assert.equal(kept.chunks.some(chunk=>chunk.text.includes("sixty")),false);
  const anchored=kept.evidence.comments.find(item=>item.id==="1");
  const parked=kept.evidence.comments.find(item=>item.id==="2");
  const parkedRange=kept.evidence.comments.find(item=>item.id==="3");
  assert.equal(anchored.anchors.length,1);
  assert.equal(anchored.anchors[0].kind,"reference");
  assert.equal(parked.anchors.length,0);
  assert.equal(parkedRange.anchors.length,0);
  const missing=comment("8","Synthetic note with no anchor anywhere.");
  const blockedCopy=extractDocx(await fixture({body:p(`<w:r>${alternate}</w:r>`),parts:{"word/comments.xml":{kind:"comments",xml:story("comments",comments+missing)}}}));
  const orphans=blockedCopy.evidence.issues.filter(issue=>issue.code==="ORPHAN_COMMENT");
  assert.equal(blockedCopy.evidence.analysisEligible,false);
  assert.equal(orphans.length,1);
  assert.match(orphans[0].source.path,/w:comment\[4\]/);
  assert.equal(blockedCopy.evidence.comments.find(item=>item.id==="2").anchors.length,0);
});
await check("thousands of ordinary point comments stay near the plain extractor time",async()=>{
  const count=3000;
  let body="";
  let notes="";
  for(let index=0;index<count;index++){
    body+=p(text(`Synthetic clause ${index} is due.`)+`<w:r><w:commentReference w:id="${index}"/></w:r>`);
    notes+=comment(String(index),`Synthetic note ${index}.`);
  }
  const started=performance.now();
  const result=extractDocx(await fixture({body,parts:{"word/comments.xml":{kind:"comments",xml:story("comments",notes)}}}));
  const elapsed=performance.now()-started;
  assert.equal(result.evidence.analysisEligible,true,JSON.stringify(result.evidence.issues.slice(0,5)));
  assert.equal(result.evidence.comments.length,count);
  assert.equal(result.evidence.issues.some(issue=>issue.code==="ORPHAN_COMMENT"),false);
  assert.ok(result.evidence.comments.every(item=>item.anchors.length===1&&item.anchors[0].kind==="reference"));
  assert.equal(result.chunks.length,count);
  // The old per-comment story walk took about 22 seconds on this shape.
  // The plain extractor, with no text boxes, took about 2 seconds. Stay under 6.
  console.log(`ordinary point comments: ${count} extracted in ${Math.round(elapsed)}ms`);
  assert.ok(elapsed<6000,`extraction took ${Math.round(elapsed)}ms`);
});

console.log(`DOCX evidence regression checks passed: ${cases} synthetic scenarios. No external AI, customer source, database or deployment was used.`);
