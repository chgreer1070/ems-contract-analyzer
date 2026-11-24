import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { MatterReadingError, buildMatterReadingRequest } from "../lib/matterDocumentReading.mjs";

const ready = (overrides = {}) => ({
  id: "00000000-0000-4000-8000-0000000000a1",
  filename: "sample-msa.txt",
  documentType: "MSA",
  extractionMethod: "PLAIN_TEXT",
  extractionStatus: "EXTRACTED",
  integrityStatus: "SERVER_VERIFIED",
  securityScanStatus: "CLEAN",
  deletionStatus: "ACTIVE",
  sourceStatus: "CURRENT",
  ...overrides,
});

const amendment = ready({
  id: "00000000-0000-4000-8000-0000000000a2",
  filename: "amendment-1.txt",
  documentType: "AMENDMENT",
  sourceStatus: "DRAFT",
});

function request(documents, chunks, baseDocumentId, amendmentDocumentIds = []) {
  return buildMatterReadingRequest({
    documents,
    chunksByDocumentId: new Map(chunks),
    baseDocumentId,
    amendmentDocumentIds,
  });
}

const reading = request(
  [ready(), amendment],
  [
    [ready().id, ["Payment is thirty (30) days."]],
    [amendment.id, ["Payment is forty-five (45) days."]],
  ],
  ready().id,
  [amendment.id],
);
assert.equal(reading.base.role, "base");
assert.equal(reading.base.text, "Payment is thirty (30) days.");
assert.equal(reading.amendments[0].text, "Payment is forty-five (45) days.");
assert.deepEqual(reading.notes, ["amendment-1.txt is still a draft."]);
assert.doesNotMatch(reading.notes.join("\n"), /confirmed earliest-to-latest|amendmentOrderConfirmed/);

const pdf = request(
  [ready({ extractionMethod: "PDF_TEXT", filename: "scan.pdf" })],
  [[ready().id, ["Page one.\n\nPage two."]]],
  ready().id,
);
assert.equal(pdf.base.text, "Page one.\n\nPage two.");
assert.match(pdf.notes[0], /does not prove layout, tables, or signatures/);

assert.throws(
  () => request(
    [ready({ extractionMethod: "DOCX_OOXML_EVIDENCE", filename: "redline.docx" })],
    [[ready().id, ["ignored"]]],
    ready().id,
  ),
  (error) => error instanceof MatterReadingError && /stay evidence/.test(error.message) && error.status === 409,
);

assert.throws(
  () => request([ready({ securityScanStatus: "QUARANTINED" })], [[ready().id, ["text"]]], ready().id),
  (error) => error instanceof MatterReadingError && /security scan/.test(error.message),
);

assert.throws(
  () => request([ready()], [[ready().id, ["CONTRACTTWIN_DOCX_EVIDENCE_V1\n{}"]]], ready().id),
  (error) => error instanceof MatterReadingError && /Word evidence was found/.test(error.message),
);

assert.throws(
  () => request([amendment], [[amendment.id, ["text"]]], amendment.id),
  (error) => error instanceof MatterReadingError && /base document must be the agreement/.test(error.message),
);

assert.throws(
  () => request([ready(), ready({ id: amendment.id, filename: "notes.txt", documentType: "OTHER" })], [[ready().id, ["a"]], [amendment.id, ["b"]]], ready().id, [amendment.id]),
  (error) => error instanceof MatterReadingError && /not an amendment/.test(error.message),
);

assert.throws(
  () => request([ready({ sourceStatus: "MYSTERY" })], [[ready().id, ["text"]]], ready().id),
  (error) => error instanceof MatterReadingError && /unknown source status/.test(error.message),
);

assert.throws(
  () => request([ready()], [[ready().id, ["text"]]], ready().id, [ready().id]),
  (error) => error instanceof MatterReadingError && /more than once/.test(error.message),
);

assert.throws(
  () => request([ready()], [[ready().id, ["text"]]], "missing"),
  (error) => error instanceof MatterReadingError && error.status === 404,
);

const route = readFileSync("app/api/matters/[id]/reading/route.ts", "utf8");
const page = readFileSync("app/matters/[id]/page.tsx", "utf8");
const panel = readFileSync("components/MatterDocumentReading.tsx", "utf8");
assert.match(route, /requireMatterAccess/);
assert.match(route, /relianceRecord: false/);
assert.match(route, /approval: false/);
assert.match(route, /internalErrorResponse/);
assert.match(route, /The reading service is not configured/);
assert.doesNotMatch(route, /insert into|analysis_runs|decision_requests|LEGAL_RELIANCE_ENABLED/i);
assert.match(page, /MatterDocumentReading/);
assert.doesNotMatch(page, /contracttwinCoreClient/);
assert.match(panel, /not an approval/);
assert.match(panel, /does not save this as a decision/);
assert.match(panel, /Kept as evidence, not read as the agreement/);
assert.match(panel, /effective date written in each amendment/);
assert.match(panel, /order is ambiguous/);
assert.doesNotMatch(route, /amendmentOrderConfirmed/);
assert.doesNotMatch(panel, /amendmentOrderConfirmed|Move earlier|explicitly confirmed|I have reviewed and confirm/);
assert.doesNotMatch(panel, /contracttwinCoreClient|LEGAL_RELIANCE_ENABLED|\/api\/decisions/);

console.log("Matter document reading checks passed.");
