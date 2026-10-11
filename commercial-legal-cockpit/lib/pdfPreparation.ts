import { createHash } from "node:crypto";
import { PDFDocument, PDFDict, PDFName, PDFArray } from "pdf-lib";

export const PDF_PREPARATION_MAX_BYTES = 25 * 1024 * 1024;
export const PDF_PREPARATION_MAX_PAGES = 200;
const UUID = /^[0-9a-f]{8}-(?:[0-9a-f]{4}-){3}[0-9a-f]{12}$/i;
export class PdfPreparationError extends Error {
  constructor(message: string, public status = 400) { super(message); }
}
export type PdfPreparationRequest =
  | { operation: "SPLIT"; documentIds: string[]; firstPage: number; lastPage: number }
  | { operation: "MERGE"; documentIds: string[] };

export function parsePdfPreparationRequest(value: unknown): PdfPreparationRequest {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new PdfPreparationError("Expected a PDF preparation request.");
  const input = value as Record<string, unknown>;
  if (!Array.isArray(input.documentIds) || !input.documentIds.length || input.documentIds.length > 20 ||
      input.documentIds.some(id => typeof id !== "string" || !UUID.test(id))) {
    throw new PdfPreparationError("Provide 1 to 20 document UUIDs.");
  }
  const documentIds = input.documentIds.map(id => String(id).toLowerCase());
  if (new Set(documentIds).size !== documentIds.length) throw new PdfPreparationError("Duplicate source documents are not allowed.");
  if (input.operation === "MERGE") return { operation: "MERGE", documentIds };
  if (input.operation === "SPLIT" && documentIds.length === 1 && Number.isSafeInteger(input.firstPage) &&
      Number.isSafeInteger(input.lastPage) && Number(input.firstPage) >= 1 && Number(input.lastPage) >= Number(input.firstPage)) {
    return { operation: "SPLIT", documentIds, firstPage: Number(input.firstPage), lastPage: Number(input.lastPage) };
  }
  throw new PdfPreparationError("Use MERGE or SPLIT with one source and a valid inclusive page range.");
}

export function pdfBytesHash(bytes: Uint8Array) {
  return createHash("sha256").update(bytes).digest("hex");
}

async function openSupportedPdf(bytes: Uint8Array) {
  if (!bytes.length || bytes.length > PDF_PREPARATION_MAX_BYTES || Buffer.from(bytes.subarray(0, 5)).toString() !== "%PDF-") {
    throw new PdfPreparationError("PDF input is invalid or exceeds 25 MiB.");
  }
  let pdf: PDFDocument;
  try { pdf = await PDFDocument.load(bytes, { updateMetadata: false, throwOnInvalidObject: true }); }
  catch { throw new PdfPreparationError("Encrypted or invalid PDFs are not supported."); }
  if (pdf.getPageCount() < 1 || pdf.getPageCount() > PDF_PREPARATION_MAX_PAGES) throw new PdfPreparationError("PDFs must contain 1 to 200 pages.");
  // Page copying cannot promise preservation of these document-level structures.
  for (const key of ["AcroForm", "Outlines", "Names", "OpenAction", "AA", "Collection", "Perms", "StructTreeRoot", "OCProperties"]) {
    if (pdf.catalog.has(PDFName.of(key))) throw new PdfPreparationError(`PDF contains unsupported ${key} structure; preserve it through a separate fidelity-reviewed workflow.`, 409);
  }
  for (const [, object] of pdf.context.enumerateIndirectObjects()) {
    if (object instanceof PDFDict && (object.has(PDFName.of("ByteRange")) || object.get(PDFName.of("Type")) === PDFName.of("Sig") || object.get(PDFName.of("FT")) === PDFName.of("Sig"))) {
      throw new PdfPreparationError("Signed or signature-field PDFs require separate handling.", 409);
    }
  }
  for (const page of pdf.getPages()) {
    const annotations = page.node.lookup(PDFName.of("Annots"));
    if ((annotations && (!(annotations instanceof PDFArray) || annotations.size() > 0)) || page.node.has(PDFName.of("AA"))) throw new PdfPreparationError("PDF annotations or page actions require separate handling.", 409);
  }
  return pdf;
}

/** No source mutation, signatures, network access, or contract-authority changes. */
export async function preparePdf(request: PdfPreparationRequest, inputs: Uint8Array[]) {
  if (inputs.length !== request.documentIds.length) throw new PdfPreparationError("Missing source bytes.");
  if (inputs.reduce((size, bytes) => size + bytes.length, 0) > PDF_PREPARATION_MAX_BYTES) throw new PdfPreparationError("Combined source bytes exceed 25 MiB.");
  const sources: PDFDocument[] = [];
  for (const bytes of inputs) sources.push(await openSupportedPdf(bytes));
  const out = await PDFDocument.create();
  const pageMap: Array<{ outputPage: number; sourceDocumentId: string; sourcePage: number }> = [];
  for (let sourceIndex = 0; sourceIndex < sources.length; sourceIndex++) {
    const source = sources[sourceIndex];
    if (request.operation === "SPLIT" && request.lastPage > source.getPageCount()) throw new PdfPreparationError("Requested range exceeds the source page count.");
    const indices = request.operation === "SPLIT"
      ? Array.from({ length: request.lastPage - request.firstPage + 1 }, (_, index) => request.firstPage - 1 + index)
      : source.getPageIndices();
    if (out.getPageCount() + indices.length > PDF_PREPARATION_MAX_PAGES) throw new PdfPreparationError("Prepared output exceeds 200 pages.");
    const pages = await out.copyPages(source, indices);
    pages.forEach((page, index) => {
      out.addPage(page);
      pageMap.push({ outputPage: out.getPageCount(), sourceDocumentId: request.documentIds[sourceIndex], sourcePage: indices[index] + 1 });
    });
  }
  const bytes = await out.save();
  if (bytes.length > PDF_PREPARATION_MAX_BYTES) throw new PdfPreparationError("Prepared output exceeds 25 MiB.");
  return { bytes, sha256: pdfBytesHash(bytes), pageCount: out.getPageCount(), pageMap };
}
