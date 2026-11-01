export class MatterReadingError extends Error {
  constructor(message, status = 400) {
    super(message);
    this.name = "MatterReadingError";
    this.status = status;
  }
}

export const MATTER_READING_LIMITS = { documents: 12, characters: 1_500_000 };

const BASE_TYPES = new Set(["MSA", "SOW", "EXHIBIT", "QUALITY", "PRICING", "PURCHASE_ORDER", "OTHER"]);

function fail(message, status = 409) {
  throw new MatterReadingError(message, status);
}

function assertReadable(document) {
  if (document.deletionStatus !== "ACTIVE") fail(`${document.filename} is not an active source file.`);
  if (document.securityScanStatus !== "CLEAN") fail(`${document.filename} has not passed the security scan.`);
  if (document.integrityStatus !== "SERVER_VERIFIED") fail(`${document.filename} has not been verified against the stored source.`);
  if (document.extractionStatus !== "EXTRACTED") fail(`${document.filename} does not have extracted text yet.`);
  switch (document.extractionMethod) {
    case "PLAIN_TEXT":
    case "PDF_TEXT":
      return;
    case "DOCX_OOXML_EVIDENCE":
      fail(`${document.filename} is a negotiated Word file. Comments, revisions, headers, and proposed wording stay evidence and are not read as the agreement.`);
      return;
    case "EXTERNAL_LAYOUT_REQUIRED":
      fail(`${document.filename} needs a layout review before it can be read.`);
      return;
    default:
      fail(`${document.filename} cannot be read from its extracted text yet.`);
  }
}

function noteForSourceStatus(document, notes) {
  switch (document.sourceStatus) {
    case "CURRENT":
    case "EXECUTED":
      return;
    case "DRAFT":
      notes.push(`${document.filename} is still a draft.`);
      return;
    case "SUPERSEDED":
      notes.push(`${document.filename} is marked superseded.`);
      return;
    case "REFERENCE":
      notes.push(`${document.filename} is reference material, not the signed agreement.`);
      return;
    default:
      fail(`${document.filename} has an unknown source status.`);
  }
}

export function textFromChunks(document, chunks) {
  assertReadable(document);
  if (!Array.isArray(chunks) || chunks.length === 0 || chunks.some((chunk) => typeof chunk !== "string")) {
    fail(`${document.filename} has no extracted text.`);
  }
  const text = chunks.join("\n\n");
  if (!text.trim()) fail(`${document.filename} has no extracted text.`);
  if (text.includes("CONTRACTTWIN_DOCX_EVIDENCE_V1")) {
    fail(`Word evidence was found inside ${document.filename}. The reading stopped.`);
  }
  return text;
}

export function buildMatterReadingRequest({ documents, chunksByDocumentId, baseDocumentId, amendmentDocumentIds }) {
  if (!Array.isArray(documents)) fail("Documents are required.", 400);
  if (typeof baseDocumentId !== "string" || baseDocumentId.length === 0) fail("Choose the base agreement.", 400);
  if (!Array.isArray(amendmentDocumentIds)) fail("Amendments must be a list.", 400);
  const ids = [baseDocumentId, ...amendmentDocumentIds];
  if (new Set(ids).size !== ids.length) fail("A document was selected more than once.", 400);
  if (ids.length > MATTER_READING_LIMITS.documents) fail("A reading can include at most 12 documents.", 400);
  const byId = new Map(documents.map((document) => [document.id, document]));
  const selected = ids.map((id) => {
    const document = byId.get(id);
    if (!document) fail("A selected document is not in this matter.", 404);
    return document;
  });
  const base = selected[0];
  const amendments = selected.slice(1);
  if (!BASE_TYPES.has(base.documentType)) fail("The base document must be the agreement, not an amendment.", 400);
  for (const amendment of amendments) {
    if (amendment.documentType !== "AMENDMENT") fail(`${amendment.filename} is not an amendment.`, 400);
  }
  const notes = [];
  const toPayload = (document, role) => {
    const text = textFromChunks(document, chunksByDocumentId.get(document.id) ?? []);
    if (document.extractionMethod === "PDF_TEXT") {
      notes.push(`${document.filename} uses the extracted text layer. This reading does not prove layout, tables, or signatures.`);
    }
    noteForSourceStatus(document, notes);
    return { name: document.filename, role, text };
  };
  const basePayload = toPayload(base, "base");
  const amendmentPayloads = amendments.map((document) => toPayload(document, "amendment"));
  const size = [basePayload, ...amendmentPayloads].reduce((sum, item) => sum + item.text.length, 0);
  if (size > MATTER_READING_LIMITS.characters) fail("The extracted text is too large to read in one request.", 413);
  return {
    base: basePayload,
    amendments: amendmentPayloads,
    notes,
    documents: selected.map((document) => ({
      id: document.id,
      filename: document.filename,
      documentType: document.documentType,
      sourceStatus: document.sourceStatus,
      extractionMethod: document.extractionMethod,
    })),
  };
}
