import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { createTypeScriptLoader } from '../../../scripts/ts-test-loader.mjs';

// Acceptance assertions reuse the exact preserved source bytes, not fresh fixtures.
// Run from commercial-legal-cockpit. Any lost blocker or altered fixture is a failure.
const out=path.resolve('acceptance/docx/evidence');
const hash=value=>crypto.createHash('sha256').update(value).digest('hex');
const baseline=JSON.parse(fs.readFileSync(path.join(out,'legal-document-evidence-baseline-probe-results.json'),'utf8'));
const load=createTypeScriptLoader();
const {extractDocx}=load('lib/docxExtraction.ts');
const {readDocxProjection,proposedTextContainsExcerpt,DOCX_EXTRACTOR_VERSION}=load('lib/docxEvidence.ts');
const {sourceContainsExcerpt}=load('lib/analysisEngine.ts');
const codes={'deleted-note-reference':'REVISED_NOTE_ACTIVATION','orphan-note':'ORPHAN_NOTE_BODY','inactive-header':'UNACTIVATED_HEADER_FOOTER','cross-story-comment-reference':'CROSS_STORY_COMMENT_ANCHORS'};
const results=[];
for(const expected of baseline.results){
  const source=fs.readFileSync(path.join(out,`legal-document-evidence-${expected.name}.docx`));
  assert.equal(hash(source),expected.sourceSha256,`Preserved fixture changed: ${expected.name}`);
  const bytes=source.buffer.slice(source.byteOffset,source.byteOffset+source.byteLength);
  const result=extractDocx(bytes);
  assert.equal(result.evidence.sourceSha256,expected.sourceSha256);
  assert.equal(result.evidence.legalEvidenceReady,false);
  if(codes[expected.name]){
    assert.equal(result.evidence.analysisEligible,false,`Defect reopened: ${expected.name}`);
    assert.deepEqual(result.chunks,[],`Blocked source published chunks: ${expected.name}`);
    assert.ok(result.evidence.issues.some(i=>i.blocking&&i.code===codes[expected.name]),`Missing specific blocker ${codes[expected.name]}`);
  }else{
    assert.equal(result.evidence.analysisEligible,true,JSON.stringify(result.evidence.issues));
    const projection=readDocxProjection(result.chunks[0].text);
    if(expected.name==='comment-text-not-quotation'){
      assert.equal(sourceContainsExcerpt(result.chunks[0].text,'Customer shall accept all uncapped liability.'),false);
      assert.equal(sourceContainsExcerpt(result.chunks[0].text,'Synthetic Reviewer'),false);
      assert.deepEqual(result.evidence.comments[0].anchors.map(a=>a.kind),['start','end','reference']);
      assert.equal(proposedTextContainsExcerpt(result.chunks[0].text,'Price remains $10 per unit.'),true);
    }else{
      assert.equal(projection.paragraph.originalText,expected.originalText);
      assert.equal(projection.paragraph.proposedText,expected.proposedText);
      assert.deepEqual(result.evidence.revisions.map(r=>r.author),expected.authors);
      assert.equal(proposedTextContainsExcerpt(result.chunks[0].text,expected.originalText),false);
      assert.equal(proposedTextContainsExcerpt(result.chunks[0].text,expected.proposedText),true);
    }
  }
  results.push({name:expected.name,sourceSha256:expected.sourceSha256,result:'PASS',analysisEligible:result.evidence.analysisEligible,blockingCodes:result.evidence.issues.filter(i=>i.blocking).map(i=>i.code),legalEvidenceReady:false});
}
// Active header isolates the comment check from the separate inactive-header denial.
execFileSync(process.execPath,[path.join(out,'legal-document-evidence-isolated-anchors.mjs'),'--require-repaired','--current-only'],{stdio:'pipe'});
const isolated=JSON.parse(fs.readFileSync(path.join(out,'legal-document-evidence-isolated-anchors-results.json'),'utf8'));
assert.ok(isolated.current.blockingCodes.includes('CROSS_STORY_COMMENT_ANCHORS'));
results.push({name:'active-header-cross-story-comment',sourceSha256:isolated.sourceSha256,result:'PASS',analysisEligible:false,blockingCodes:isolated.current.blockingCodes,legalEvidenceReady:false});
const typed=JSON.parse(fs.readFileSync(path.join(out,'legal-document-evidence-wrong-story-relationship-results.json'),'utf8'));
assert.ok(typed.current.blockingCodes.includes('UNACTIVATED_HEADER_FOOTER'));
results.push({name:'wrong-header-relationship-type',sourceSha256:typed.sourceSha256,result:'PASS',analysisEligible:false,blockingCodes:typed.current.blockingCodes,legalEvidenceReady:false});
const tracked=['lib/docxExtraction.ts','lib/docxEvidence.ts','lib/docxReceipt.ts','lib/docxPackage.ts','lib/documentExtraction.ts','lib/jobProcessor.ts','lib/analysisEngine.ts','lib/termEngine.ts','lib/engineVersions.ts','scripts/docx-extraction-check.mjs','scripts/docx-pipeline-check.mjs','scripts/ts-test-loader.mjs','validation/docx/fixtures.mjs','package.json','package-lock.json'];
const sourceHashes=Object.fromEntries(tracked.map(name=>[name,hash(fs.readFileSync(name))]));
const diff=execFileSync('git',['diff','HEAD','--',...tracked],{encoding:'utf8'});
const report={baselineCommit:baseline.candidateCommit,head:execFileSync('git',['rev-parse','HEAD'],{encoding:'utf8'}).trim(),sourceSnapshotIsCommitted:!diff,trackedPatchSha256:hash(diff),sourceHashes,runnerSha256:hash(fs.readFileSync(import.meta.filename)),extractorVersion:DOCX_EXTRACTOR_VERSION,syntheticOnly:true,wordRendererExecuted:false,modelExecuted:false,runAtUtc:new Date().toISOString(),results};
fs.writeFileSync(path.join(out,'legal-document-evidence-repair-results.json'),JSON.stringify(report,null,2)+'\n');
console.log(JSON.stringify(report,null,2));
