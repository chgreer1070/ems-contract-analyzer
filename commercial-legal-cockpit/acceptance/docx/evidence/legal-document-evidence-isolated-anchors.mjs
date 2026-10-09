import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { createRequire } from 'node:module';
import ts from 'typescript';
import { fixture, p, text, comment, story, document, relationship } from '../../../validation/docx/fixtures.mjs';
import { createTypeScriptLoader } from '../../../scripts/ts-test-loader.mjs';

const candidate='0d446203d670e086aa50ef8d65755cbc653ae6be';
const currentOnly=process.argv.includes('--current-only');
const out=path.resolve('acceptance/docx/evidence');
const file=path.join(out,'legal-document-evidence-active-header-cross-story-comment.docx');
const hash=value=>crypto.createHash('sha256').update(value).digest('hex');
const require=createRequire(import.meta.url);
const cache=new Map();
function baselineLoad(relative){
  if(cache.has(relative))return cache.get(relative).exports;
  const source=execFileSync('git',['show',`${candidate}:commercial-legal-cockpit/${relative}`],{encoding:'utf8'});
  const module={exports:{}};cache.set(relative,module);
  const js=ts.transpileModule(source,{compilerOptions:{module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2022,esModuleInterop:true},fileName:relative}).outputText;
  new Function('require','module','exports',js)(specifier=>specifier.startsWith('.')?baselineLoad(path.posix.normalize(path.posix.join(path.posix.dirname(relative),`${specifier}.ts`))):require(specifier),module,module.exports);
  return module.exports;
}
if(!fs.existsSync(file)){
  const body=p('<w:commentRangeStart w:id="0"/>'+text('Payment is due in 30 days.')+'<w:commentRangeEnd w:id="0"/>');
  const main=document(body).replace('<w:sectPr/>','<w:sectPr><w:headerReference w:type="default" r:id="part-1"/></w:sectPr>');
  const source=await fixture({main,parts:{'word/comments.xml':{kind:'comments',xml:story('comments',comment('0','Synthetic rationale: preserve cash timing.'))},'word/header1.xml':{kind:'header',xml:story('hdr',p(text('Active header.')+'<w:r><w:commentReference w:id="0"/></w:r>'))}}});
  fs.writeFileSync(file,Buffer.from(source));
}
const source=fs.readFileSync(file);
const bytes=source.buffer.slice(source.byteOffset,source.byteOffset+source.byteLength);
let baselineState;
if(currentOnly){
  const archived=JSON.parse(fs.readFileSync(path.join(out,'legal-document-evidence-isolated-anchors-baseline-results.json'),'utf8'));
  assert.equal(archived.sourceSha256,hash(source));
  assert.equal(archived.baseline.analysisEligible,true);
  baselineState={...archived.baseline,reexecuted:false,evidence:'legal-document-evidence-isolated-anchors-baseline-results.json'};
}else{
  const baseline=baselineLoad('lib/docxExtraction.ts').extractDocx(bytes);
  assert.equal(baseline.evidence.analysisEligible,true);
  assert.equal(baseline.evidence.comments[0].anchors.find(a=>a.kind==='start').source.part,'word/document.xml');
  assert.equal(baseline.evidence.comments[0].anchors.find(a=>a.kind==='reference').source.part,'word/header1.xml');
  baselineState={analysisEligible:baseline.evidence.analysisEligible,blockingCodes:baseline.evidence.issues.filter(i=>i.blocking).map(i=>i.code),reexecuted:true};
}
const current=createTypeScriptLoader()('lib/docxExtraction.ts').extractDocx(bytes);
const report={baselineCommit:candidate,sourceSha256:hash(source),syntheticOnly:true,wordRendererExecuted:false,baseline:baselineState,current:{head:execFileSync('git',['rev-parse','HEAD'],{encoding:'utf8'}).trim(),extractorFileSha256:hash(fs.readFileSync('lib/docxExtraction.ts')),analysisEligible:current.evidence.analysisEligible,blockingCodes:current.evidence.issues.filter(i=>i.blocking).map(i=>i.code)}};
if(process.argv.includes('--require-repaired')){
  assert.equal(current.evidence.analysisEligible,false);
  assert.deepEqual(current.chunks,[]);
  assert.ok(current.evidence.issues.some(i=>i.blocking&&/COMMENT/.test(i.code)), 'The isolated fixture must be denied by a comment-specific issue.');
}
fs.writeFileSync(path.join(out,'legal-document-evidence-isolated-anchors-results.json'),JSON.stringify(report,null,2)+'\n');
console.log(JSON.stringify(report,null,2));

// A package relationship must establish the relevant story kind, not just target.
const typedFile=path.join(out,'legal-document-evidence-wrong-header-relationship-type.docx');
if(!fs.existsSync(typedFile)){
  const main=document(p(text('Main body contract.'))).replace('<w:sectPr/>','<w:sectPr><w:headerReference w:type="default" r:id="wrong"/></w:sectPr>');
  const fixtureBytes=await fixture({main,parts:{'word/header1.xml':{xml:story('hdr',p(text('Customer pays $2 million.'))),type:'application/vnd.openxmlformats-officedocument.wordprocessingml.header+xml'}},rels:[relationship('wrong','comments','header1.xml')]});
  fs.writeFileSync(typedFile,Buffer.from(fixtureBytes));
}
const typedSource=fs.readFileSync(typedFile),typedBytes=typedSource.buffer.slice(typedSource.byteOffset,typedSource.byteOffset+typedSource.byteLength);
let typedBaselineState;
if(currentOnly){
  const archived=JSON.parse(fs.readFileSync(path.join(out,'legal-document-evidence-second-cycle-wrong-story-baseline.json'),'utf8'));
  assert.equal(archived.sourceSha256,hash(typedSource));
  assert.equal(archived.baseline.analysisEligible,true);
  typedBaselineState={...archived.baseline,reexecuted:false,evidence:'legal-document-evidence-second-cycle-wrong-story-baseline.json'};
}else{
  const typedBaseline=baselineLoad('lib/docxExtraction.ts').extractDocx(typedBytes);
  assert.equal(typedBaseline.evidence.analysisEligible,true);
  typedBaselineState={analysisEligible:typedBaseline.evidence.analysisEligible,reexecuted:true};
}
const typedCurrent=createTypeScriptLoader()('lib/docxExtraction.ts').extractDocx(typedBytes);
const typedReport={baselineCommit:candidate,sourceSha256:hash(typedSource),syntheticOnly:true,wordRendererExecuted:false,relationshipType:'comments',sectionReferenceType:'headerReference',baseline:typedBaselineState,current:{head:report.current.head,extractorFileSha256:hash(fs.readFileSync('lib/docxExtraction.ts')),analysisEligible:typedCurrent.evidence.analysisEligible,blockingCodes:typedCurrent.evidence.issues.filter(i=>i.blocking).map(i=>i.code)}};
if(process.argv.includes('--require-repaired')){
  assert.equal(typedCurrent.evidence.analysisEligible,false,'A wrong-type story relationship cannot establish an active header.');
  assert.deepEqual(typedCurrent.chunks,[]);
  assert.ok(typedCurrent.evidence.issues.some(i=>i.blocking&&i.code==='UNACTIVATED_HEADER_FOOTER'));
}
fs.writeFileSync(path.join(out,'legal-document-evidence-wrong-story-relationship-results.json'),JSON.stringify(typedReport,null,2)+'\n');
console.log(JSON.stringify(typedReport,null,2));
