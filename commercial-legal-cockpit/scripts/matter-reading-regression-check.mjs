import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { createRequire } from 'node:module';
import ts from 'typescript';
import * as helpers from '../lib/matterDocumentReading.mjs';
const require = createRequire(import.meta.url);
function load(path, mocks) {
  const code = ts.transpileModule(readFileSync(path, 'utf8'), { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } }).outputText;
  const module = { exports: {} };
  new Function('require', 'module', 'exports', code)(name => name in mocks ? mocks[name] : require(name), module, module.exports);
  return module.exports;
}
const { chunkText } = load('lib/chunking.ts', {});
let pdfPages = [];
const { extractDocument } = load('lib/documentExtraction.ts', {
  '@/lib/chunking': { chunkText },
  '@/lib/docxExtraction': { extractDocx: () => { throw Error('Word must not be read'); } },
  unpdf: { getDocumentProxy: async () => ({}), extractText: async () => ({ text: pdfPages, totalPages: pdfPages.length }) },
});
const baseId = '00000000-0000-4000-8000-000000000001';
const aId = '00000000-0000-4000-8000-000000000002';
const bId = '00000000-0000-4000-8000-000000000003';
const base = 'Manufacturing Agreement\n\n1.1 Payment. Customer shall pay each undisputed invoice within ten (10) days after the invoice date (Net 10).\n\n1.2 Unit Prices. The unit price for product NW-100 is USD 12.40 per unit.\n';
const amend = (days, stated) => `AMENDMENT\n\nThis Amendment is entered into as of ${stated} (the "Amendment Effective Date").\n\nA. Section 1.1 of the Agreement is deleted and replaced in its entirety with the following:\n\n1.1 Payment. Customer shall pay each undisputed invoice within ${days} days after the invoice date.\n`;
const hash = text => createHash('sha256').update(text).digest('hex');
let texts, documents, sent, serviceCalls = 0, tamper = false, changeDuringAnalysis = false;
function fixture(extra = {}) {
  texts = { [baseId]: base, [aId]: amend('twenty (20)', 'March 1, 2025'), [bId]: amend('thirty (30)', 'June 1, 2025') };
  documents = Object.entries(texts).map(([id, text]) => ({ id, filename: 'x'.repeat(251) + '.txt', document_type: id === baseId ? 'MSA' : 'AMENDMENT', extraction_method: 'PLAIN_TEXT', extraction_status: 'EXTRACTED', integrity_status: 'SERVER_VERIFIED', security_scan_status: 'CLEAN', deletion_status: 'ACTIVE', source_status: 'EXECUTED', blob_pathname: id, mime_type: 'text/plain', server_sha256: hash(text), ...extra }));
}
class ContractTwinRequestError extends Error {
  constructor(message, status) {
    super(message);
    this.name = 'ContractTwinRequestError';
    this.status = status;
  }
}
const { POST } = load('app/api/matters/[id]/reading/route.ts', {
  '@/lib/access': { accessErrorResponse: () => null, requireMatterAccess: async () => {} },
  '@/lib/db': { databaseConfigured: () => true, query: async (_sql, [_matter, ids]) => ({ rows: structuredClone(documents.filter(d => ids.includes(d.id))) }) },
  '@/lib/matterDocumentReading.mjs': helpers,
  '@/lib/documentExtraction': { extractDocument },
  '@/lib/safeErrors': { internalErrorResponse: error => { throw error; } },
  '@vercel/blob': { get: async path => ({ statusCode: 200, stream: new Response(texts[path] + (tamper ? 'tampered' : '')).body }) },
  '@/lib/contracttwinCoreClient': { ContractTwinRequestError, analyzeAgreementText: async (_url, body) => {
    sent = body; serviceCalls++;
    if (changeDuringAnalysis) documents[0].security_scan_status = "QUARANTINED";
    const raw = execFileSync('python', ['-c', `import json,sys
from contracttwin.models import AgreementInput
from contracttwin.pipeline import AnalysisRequest,analyze
x=AgreementInput.model_validate(json.load(sys.stdin))
try:
    r=analyze(AnalysisRequest(base_name=x.base.name,base_text=x.base.text,base_filename=x.base.filename,amendments=[(a.name,a.text,a.effective_date) for a in x.amendments],amendment_filenames=[a.filename for a in x.amendments]))
except ValueError as exc:
    print('REFUSAL:' + str(exc))
else:
    print(r.model_dump_json())`], { input: JSON.stringify(body), encoding: 'utf8' });
    if (raw.startsWith('REFUSAL:')) throw new ContractTwinRequestError(raw.slice('REFUSAL:'.length).trim(), 400);
    return JSON.parse(raw);
  } },
});
process.env.CONTRACTTWIN_CORE_URL = 'http://unused.test';
process.env.CONTRACTTWIN_API_KEY = 'synthetic-test';
async function read(ids = []) {
  const response = await POST(new Request('http://local/reading', { method: 'POST', body: JSON.stringify({ baseDocumentId: baseId, amendmentDocumentIds: ids }) }), { params: Promise.resolve({ id: 'synthetic-matter' }) });
  return { status: response.status, body: await response.json() };
}
function operativeDays(body) {
  return body.facts.filter(fact => fact.operative && fact.attributes.net_days !== undefined).map(fact => fact.attributes.net_days);
}
fixture();
let result = await read([aId, bId]);
assert.equal(result.status, 200);
assert.equal(result.body.relianceRecord, false);
assert.equal(result.body.approval, false);
assert.deepEqual(operativeDays(result.body), [30]);
assert.ok(result.body.facts.some(f => !f.operative && f.attributes.net_days === 20));
assert.equal(result.body.operativeStatusUncertain, true);
const selectedFirst = sent.amendments.map(item => item.name);
let reversed = await read([bId, aId]);
assert.equal(reversed.status, 200);
assert.deepEqual(operativeDays(reversed.body), [30]);
assert.deepEqual(sent.amendments.map(item => item.name), [...selectedFirst].reverse());
assert.equal(reversed.body.relianceRecord, false);
assert.equal(reversed.body.approval, false);
console.log('SAMPLE_API_JSON ' + JSON.stringify({ ok: reversed.body.ok, relianceRecord: reversed.body.relianceRecord, approval: reversed.body.approval, operativeStatusUncertain: reversed.body.operativeStatusUncertain, operativeNetDays: operativeDays(reversed.body) }));
assert.equal(sent.base.filename.length, 255);
for (const document of [sent.base, ...sent.amendments]) assert.ok(document.name.length <= 200);
assert.notEqual(sent.amendments[0].name, sent.amendments[1].name);
for (const fact of result.body.facts) for (const citation of fact.citations) {
  assert.ok(citation.sourceDocumentId);
  assert.equal(citation.originalFilename.length, 255);
  assert.ok(texts[citation.sourceDocumentId].includes(citation.quote));
}
fixture();
texts[aId] = 'AMENDMENT\n\nA. Section 1.1 of the Agreement is deleted and replaced in its entirety with the following:\n\n1.1 Payment. Customer shall pay each undisputed invoice within twenty (20) days after the invoice date.\n';
documents[1].server_sha256 = hash(texts[aId]);
result = await read([aId]);
assert.equal(result.status, 400);
assert.equal(result.body.ok, false);
assert.match(result.body.error, /no stated effective date/);
console.log('UNDATED_REFUSAL ' + JSON.stringify({ ok: result.body.ok, error: result.body.error }));
fixture();
texts[aId] = amend('twenty (20)', 'March 1, 2025');
texts[bId] = amend('thirty (30)', 'March 1, 2025');
documents[1].server_sha256 = hash(texts[aId]);
documents[2].server_sha256 = hash(texts[bId]);
result = await read([bId, aId]);
assert.equal(result.status, 400);
assert.match(result.body.error, /ambiguous/);
assert.match(result.body.error, /2025-03-01/);
console.log('TIED_DATE_REFUSAL ' + JSON.stringify({ ok: result.body.ok, error: result.body.error }));
fixture(); texts[aId] = 'This Amendment is entered into as of March 1, 2025 (the "Amendment Effective Date").\nSection 1.1 is deleted and replaced with language to be agreed.';
documents[1].server_sha256 = hash(texts[aId]);
result = await read([aId]);
assert.ok(result.body.warnings.some(w => w.includes('could not be read')));
assert.equal(result.body.operativeStatusUncertain, true);
fixture();
texts[baseId] = base + '\n2. Manufacturing. ' + 'Manufacturer shall build assemblies to Customer specifications. '.repeat(140) + '\n\n3. Inventory. Customer shall buy obsolete inventory.';
documents[0].server_sha256 = hash(texts[baseId]);
assert.ok(chunkText(texts[baseId]).length > 1);
result = await read();
assert.equal(result.status, 200);
assert.equal(sent.base.text, texts[baseId]);
assert.equal(sent.base.text.split('3. Inventory.').length, 2);
pdfPages = [texts[baseId], '4. Delivery. Delivery is EXW.\n4.1 Repetition. Delivery is EXW.'];
const extracted = await extractDocument(new ArrayBuffer(0), 'application/pdf');
assert.equal(extracted.canonicalText, pdfPages.join('\n\n'));
assert.ok(extracted.chunks.length > 2);
fixture(); tamper = true;
assert.equal((await read()).status, 409);
tamper = false;
fixture({ security_scan_status: 'QUARANTINED' });
assert.equal((await read()).status, 409);
const projected = helpers.projectReadingFacts({ facts: ['fact', 'inference', 'assumption'].map((kind, i) => ({ id: String(i), kind, operative: true, statement: kind, citations: i === 2 ? [] : [{ document_name: 'source-a', quote: base }, { document_name: 'source-b', quote: amend('30') }] })) }, [{ id: 'a', serviceName: 'source-a', filename: 'base.txt' }, { id: 'b', serviceName: 'source-b', filename: 'amendment.txt' }]);
assert.deepEqual(projected.map(f => f.kind), ['fact', 'inference', 'assumption']);
assert.equal(projected[0].citations.length, 2);
assert.equal(projected[2].citations.length, 0);
assert.match(helpers.readingFactLabel(projected[1], false), /^Calculated inference/);
assert.match(helpers.readingFactLabel(projected[2], true), /^Assumption — current in this conditional reading; operative status requires review/);
console.log('Matter reading regressions passed: stated-date order, undated refusal, tied-date refusal, warnings, canonical text, filenames, provenance, kinds, integrity guards. DB/blob/access/PDF extraction mocked.');
fixture();
texts[baseId] = `LEAP MANUFACTURING AGREEMENT

This Agreement is entered into as of February 29, 2024 (the "Effective Date"), by and between Northwind Devices, Inc. and Harborline Manufacturing, LLC.

The initial term begins on the Effective Date and continues until March 1, 2025.

1. Pricing

1.1 Price Notice. Manufacturer shall give written notice at least sixty (60) days before each anniversary of the Effective Date before an annual price adjustment may take effect.
`;
documents[0].server_sha256 = hash(texts[baseId]);
result = await read();
assert.equal(result.status, 200);
assert.ok(result.body.facts.some(f => f.kind === 'assumption' && f.statement.includes('February 28')));
assert.ok(result.body.facts.some(f => f.kind === 'inference'));
assert.ok(result.body.facts.some(f => f.kind === 'fact'));
assert.ok(result.body.facts.filter(f => f.kind !== 'fact').every(f => f.citations.length));
// Reject legacy multi-chunk reconstruction, even when repeated prose looks identical.
assert.throws(() => helpers.textFromChunks({ filename: 'legacy', deletionStatus: 'ACTIVE', securityScanStatus: 'CLEAN', integrityStatus: 'SERVER_VERIFIED', extractionStatus: 'EXTRACTED', extractionMethod: 'PLAIN_TEXT' }, ['same sentence', 'same sentence']), /canonical/);
console.log('Actual leap-day manufacturing agreement preserves facts, inferences, assumptions and their citations.');
// Conditional chronology must still distinguish current and superseded versions.
assert.match(helpers.readingFactLabel({ kind: 'fact', operative: false }, true), /superseded in this conditional reading/);
assert.match(helpers.readingFactLabel({ kind: 'fact', operative: true }, true), /current in this conditional reading/);
fixture();
texts[baseId] = '1. Inventory\n\n1.1 Liability. Customer shall pay an Excess and Obsolete exposure of USD 10000.00 for the named program.\n';
documents[0].server_sha256 = hash(texts[baseId]);
result = await read();
const citedImpacts = result.body.impacts.filter(impact => impact.citations.length);
assert.ok(citedImpacts.length, 'Explicit E&O amount should produce a cited impact');
for (const impact of citedImpacts) for (const citation of impact.citations) {
 assert.ok(citation.sourceDocumentId, 'Impact citation must map to stored document');
 assert.equal(citation.originalFilename.length,255);
}
// Minimal synthetic two-page PDF: real unpdf decoding, long pages, repeated prose kept.
function syntheticPdf() {
 const objects = ['<< /Type /Catalog /Pages 2 0 R >>','<< /Type /Pages /Kids [3 0 R 4 0 R] /Count 2 >>',
 '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 5 0 R >> >> /Contents 6 0 R >>',
 '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 5 0 R >> >> /Contents 7 0 R >>',
 '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>'];
 for (let page=0;page<2;page++) {
  const lines=Array.from({length:65},(_,i)=>`Section ${page+1}.${i+1}. Manufacturer shall build assemblies to approved specifications.`);
  const stream='BT /F1 7 Tf 30 760 Td 10 TL '+lines.map(line=>`(${line}) Tj T*`).join('\n')+' ET';
  objects.push(`<< /Length ${Buffer.byteLength(stream)} >>\nstream\n${stream}\nendstream`);
 }
 let pdf='%PDF-1.4\n'; const offsets=[0];
 for (const [i,object] of objects.entries()) { offsets.push(Buffer.byteLength(pdf));pdf+=`${i+1} 0 obj\n${object}\nendobj\n`; }
 const xref=Buffer.byteLength(pdf);
 pdf+=`xref\n0 ${objects.length+1}\n0000000000 65535 f \n`+offsets.slice(1).map(n=>`${String(n).padStart(10,'0')} 00000 n \n`).join('')+`trailer\n<< /Size ${objects.length+1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF`;
 return Uint8Array.from(Buffer.from(pdf)).buffer;
}
const realExtraction=load('lib/documentExtraction.ts', { '@/lib/chunking':{chunkText}, '@/lib/docxExtraction':{extractDocx:()=>{throw Error('Unexpected Word path');}}, unpdf:await import('unpdf') });
const pdfResult=await realExtraction.extractDocument(syntheticPdf(),'application/pdf');
assert.equal(pdfResult.pageCount,2);
assert.ok(pdfResult.chunks.length>2);
assert.equal(pdfResult.canonicalText.split('Manufacturer shall build assemblies to approved specifications.').length-1,130);
for (let page=1;page<=2;page++) for(let section=1;section<=65;section++) assert.equal(pdfResult.canonicalText.split(`Section ${page}.${section}. `).length-1,1);
console.log('PASS actual PDF decoder: two long pages, 130 unique numbered clauses, genuine repeated language preserved once per source occurrence.');

fixture(); changeDuringAnalysis=true;
assert.equal((await read()).status,409,'A source quarantined while analysis runs must not publish a reading');
changeDuringAnalysis=false;
