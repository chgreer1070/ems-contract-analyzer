import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { createTypeScriptLoader } from '../../../scripts/ts-test-loader.mjs';
import { fixture, p, text, comment, story, relationship } from '../../../validation/docx/fixtures.mjs';

// Independent acceptance probes. Generated OOXML is synthetic, not Word-produced.
// Execute from commercial-legal-cockpit. No source bytes are rewritten or accepted.
const output = path.resolve('acceptance/docx/evidence');
fs.mkdirSync(output, { recursive: true });
const hash = value => crypto.createHash('sha256').update(value).digest('hex');
const load = createTypeScriptLoader();
const { extractDocx } = load('lib/docxExtraction.ts');
const { readDocxProjection, proposedTextContainsExcerpt } = load('lib/docxEvidence.ts');
const { sourceContainsExcerpt } = load('lib/analysisEngine.ts');
const cases = [];
async function probe(name, options, assess) {
  const bytes = await fixture(options);
  const source = Buffer.from(bytes);
  fs.writeFileSync(path.join(output, `legal-document-evidence-${name}.docx`), source);
  const result = extractDocx(bytes);
  const views = result.chunks.map(chunk => readDocxProjection(chunk.text));
  const observation = assess(result, views);
  cases.push({ name, sourceSha256: hash(source), analysisEligible: result.evidence.analysisEligible, legalEvidenceReady: result.evidence.legalEvidenceReady, blockingCodes: result.evidence.issues.filter(i=>i.blocking).map(i=>i.code), chunkCount: result.chunks.length, ...observation });
}

const noteText = 'Customer shall reimburse all NCNR commitments within 5 days.';
const notes = { 'word/footnotes.xml': { kind: 'footnotes', xml: story('footnotes', `<w:footnote w:id="2">${p(text(noteText))}</w:footnote>`) } };
await probe('deleted-note-reference', {
  body: p(text('The revised agreement removes the note.')+'<w:del w:id="41" w:author="Synthetic Author A" w:date="2026-10-09T12:00:00Z"><w:r><w:footnoteReference w:id="2"/></w:r></w:del>'), parts: notes
}, (result, views) => {
  const note = views.find(v=>v.storyKind==='footnotes');
  assert.equal(result.evidence.analysisEligible, true);
  assert.equal(proposedTextContainsExcerpt(result.chunks.find(c=>readDocxProjection(c.text).storyKind==='footnotes').text, noteText), true);
  assert.equal(result.evidence.revisions.find(r=>r.id==='41').kind,'del');
  assert.equal(result.evidence.references[0].target.part,'word/footnotes.xml');
  return { defect:'LDE-001', deletedReferenceRevisionPreserved:true, referencedNoteProjectedAsProposedText:note.paragraph.proposedText, noteProjectionRevisionKinds:note.revisions.map(r=>r.kind), referenceProjectionHasRevisionState:Object.hasOwn(result.evidence.references[0],'revisionKeys'), deterministicProposedTermGateAcceptsDeletedOnlyNote:true };
});
await probe('orphan-note', { body:p(text('No note appears in this agreement.')), parts:notes }, (result, views)=>{
  assert.equal(result.evidence.analysisEligible,true);
  assert.equal(result.evidence.references.length,0);
  const note=views.find(v=>v.storyKind==='footnotes');
  assert.equal(note.paragraph.proposedText,noteText);
  return { defect:'LDE-001', noSourceNoteReference:true, unreferencedNoteProjectedAsProposedText:note.paragraph.proposedText };
});

const headerText='Customer must pay a minimum annual manufacturing fee of $2,000,000.';
await probe('inactive-header', {
  body:p(text('There is no headerReference in the main document.')),
  parts:{'word/header1.xml':{kind:'header',xml:story('hdr',p(text(headerText)))}}
}, (result, views)=>{
  assert.equal(result.evidence.analysisEligible,true);
  const header=views.find(v=>v.storyKind==='header');
  assert.equal(header.paragraph.proposedText,headerText);
  return { defect:'LDE-002', headerRelationshipPresent:true, sectionHeaderReferenceAbsent:true, inactiveHeaderProjectedAsProposedText:header.paragraph.proposedText };
});

const body=p('<w:commentRangeStart w:id="0"/>'+text('Payment is due in 30 days.')+'<w:commentRangeEnd w:id="0"/>');
await probe('cross-story-comment-reference',{
  body,
  parts:{'word/comments.xml':{kind:'comments',xml:story('comments',comment('0','Synthetic rationale: preserve cash timing.'))},'word/header1.xml':{kind:'header',xml:story('hdr',p(text('Unrelated header.')+'<w:r><w:commentReference w:id="0"/></w:r>'))}}
},(result)=>{
  assert.equal(result.evidence.analysisEligible,true);
  const anchors=result.evidence.comments[0].anchors;
  assert.equal(anchors.find(a=>a.kind==='start').source.part,'word/document.xml');
  assert.equal(anchors.find(a=>a.kind==='reference').source.part,'word/header1.xml');
  return {defect:'LDE-003',rangePart:'word/document.xml',referencePart:'word/header1.xml',crossStoryReferenceAccepted:true};
});

await probe('comment-text-not-quotation',{
  body:p('<w:commentRangeStart w:id="0"/>'+text('Price remains $10 per unit.')+'<w:commentRangeEnd w:id="0"/><w:r><w:commentReference w:id="0"/></w:r>'),
  parts:{'word/comments.xml':{kind:'comments',xml:story('comments',comment('0','Customer shall accept all uncapped liability.'))}}
},(result)=>{
  assert.equal(result.evidence.analysisEligible,true);
  assert.equal(sourceContainsExcerpt(result.chunks[0].text,'Customer shall accept all uncapped liability.'),false);
  assert.equal(sourceContainsExcerpt(result.chunks[0].text,'Synthetic Reviewer'),false);
  return {check:'PASS',commentAndAuthorCannotGroundQuotation:true,commentAnchorKinds:result.evidence.comments[0].anchors.map(a=>a.kind)};
});

await probe('different-author-replacement',{},(result,views)=>{
  assert.equal(result.evidence.analysisEligible,true);
  assert.equal(views[0].paragraph.originalText,'Customer shall pay within 30 days of invoice.');
  assert.equal(views[0].paragraph.proposedText,'Customer shall pay within 60 days of invoice.');
  assert.deepEqual(result.evidence.revisions.map(r=>r.author),['Synthetic Flex Counsel','Synthetic Customer Counsel']);
  return {check:'PASS',originalText:views[0].paragraph.originalText,proposedText:views[0].paragraph.proposedText,authors:result.evidence.revisions.map(r=>r.author),partyIdentityEstablished:false,acceptanceEstablished:false};
});

const report={candidateCommit:'0d446203d670e086aa50ef8d65755cbc653ae6be',runDate:'2026-10-09',probesSourceSha256:hash(fs.readFileSync(import.meta.filename)),syntheticOnly:true,wordRendererExecuted:false,modelExecuted:false,results:cases};
fs.writeFileSync(path.join(output,'legal-document-evidence-probe-results.json'),JSON.stringify(report,null,2)+'\n');
console.log(JSON.stringify(report,null,2));
