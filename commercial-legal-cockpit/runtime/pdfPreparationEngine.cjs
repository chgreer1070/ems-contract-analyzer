// Generated from lib/pdfPreparation.ts. Run node scripts/build-pdf-preparation-worker.mjs.
"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.PdfPreparationError = exports.PDF_PREPARATION_MAX_PAGES = exports.PDF_PREPARATION_MAX_BYTES = void 0;
exports.parsePdfPreparationRequest = parsePdfPreparationRequest;
exports.pdfBytesHash = pdfBytesHash;
exports.preparePdf = preparePdf;
const node_crypto_1 = require("node:crypto");
const pdf_lib_1 = require("pdf-lib");
exports.PDF_PREPARATION_MAX_BYTES = 25 * 1024 * 1024;
exports.PDF_PREPARATION_MAX_PAGES = 200;
const UUID = /^[0-9a-f]{8}-(?:[0-9a-f]{4}-){3}[0-9a-f]{12}$/i;
class PdfPreparationError extends Error {
    status;
    constructor(message, status = 400) {
        super(message);
        this.status = status;
    }
}
exports.PdfPreparationError = PdfPreparationError;
function parsePdfPreparationRequest(value) {
    if (!value || typeof value !== "object" || Array.isArray(value))
        throw new PdfPreparationError("Expected a PDF preparation request.");
    const input = value;
    if (!Array.isArray(input.documentIds) || !input.documentIds.length || input.documentIds.length > 20 ||
        input.documentIds.some(id => typeof id !== "string" || !UUID.test(id))) {
        throw new PdfPreparationError("Provide 1 to 20 document UUIDs.");
    }
    const documentIds = input.documentIds.map(id => String(id).toLowerCase());
    if (new Set(documentIds).size !== documentIds.length)
        throw new PdfPreparationError("Duplicate source documents are not allowed.");
    if (input.operation === "MERGE")
        return { operation: "MERGE", documentIds };
    if (input.operation === "SPLIT" && documentIds.length === 1 && Number.isSafeInteger(input.firstPage) &&
        Number.isSafeInteger(input.lastPage) && Number(input.firstPage) >= 1 && Number(input.lastPage) >= Number(input.firstPage)) {
        return { operation: "SPLIT", documentIds, firstPage: Number(input.firstPage), lastPage: Number(input.lastPage) };
    }
    throw new PdfPreparationError("Use MERGE or SPLIT with one source and a valid inclusive page range.");
}
function pdfBytesHash(bytes) {
    return (0, node_crypto_1.createHash)("sha256").update(bytes).digest("hex");
}
async function openSupportedPdf(bytes) {
    if (!bytes.length || bytes.length > exports.PDF_PREPARATION_MAX_BYTES || Buffer.from(bytes.subarray(0, 5)).toString() !== "%PDF-") {
        throw new PdfPreparationError("PDF input is invalid or exceeds 25 MiB.");
    }
    let pdf;
    try {
        pdf = await pdf_lib_1.PDFDocument.load(bytes, { updateMetadata: false, throwOnInvalidObject: true });
    }
    catch {
        throw new PdfPreparationError("Encrypted or invalid PDFs are not supported.");
    }
    if (pdf.getPageCount() < 1 || pdf.getPageCount() > exports.PDF_PREPARATION_MAX_PAGES)
        throw new PdfPreparationError("PDFs must contain 1 to 200 pages.");
    // Page copying cannot promise preservation of these document-level structures.
    for (const key of ["AcroForm", "Outlines", "Names", "OpenAction", "AA", "Collection", "Perms", "StructTreeRoot", "OCProperties"]) {
        if (pdf.catalog.has(pdf_lib_1.PDFName.of(key)))
            throw new PdfPreparationError(`PDF contains unsupported ${key} structure; preserve it through a separate fidelity-reviewed workflow.`, 409);
    }
    for (const [, object] of pdf.context.enumerateIndirectObjects()) {
        if (object instanceof pdf_lib_1.PDFDict && (object.has(pdf_lib_1.PDFName.of("ByteRange")) || object.get(pdf_lib_1.PDFName.of("Type")) === pdf_lib_1.PDFName.of("Sig") || object.get(pdf_lib_1.PDFName.of("FT")) === pdf_lib_1.PDFName.of("Sig"))) {
            throw new PdfPreparationError("Signed or signature-field PDFs require separate handling.", 409);
        }
    }
    for (const page of pdf.getPages()) {
        const annotations = page.node.lookup(pdf_lib_1.PDFName.of("Annots"));
        if ((annotations && (!(annotations instanceof pdf_lib_1.PDFArray) || annotations.size() > 0)) || page.node.has(pdf_lib_1.PDFName.of("AA")))
            throw new PdfPreparationError("PDF annotations or page actions require separate handling.", 409);
    }
    return pdf;
}
/** No source mutation, signatures, network access, or contract-authority changes. */
async function preparePdf(request, inputs) {
    if (inputs.length !== request.documentIds.length)
        throw new PdfPreparationError("Missing source bytes.");
    if (inputs.reduce((size, bytes) => size + bytes.length, 0) > exports.PDF_PREPARATION_MAX_BYTES)
        throw new PdfPreparationError("Combined source bytes exceed 25 MiB.");
    const sources = [];
    for (const bytes of inputs)
        sources.push(await openSupportedPdf(bytes));
    const out = await pdf_lib_1.PDFDocument.create();
    const pageMap = [];
    for (let sourceIndex = 0; sourceIndex < sources.length; sourceIndex++) {
        const source = sources[sourceIndex];
        if (request.operation === "SPLIT" && request.lastPage > source.getPageCount())
            throw new PdfPreparationError("Requested range exceeds the source page count.");
        const indices = request.operation === "SPLIT"
            ? Array.from({ length: request.lastPage - request.firstPage + 1 }, (_, index) => request.firstPage - 1 + index)
            : source.getPageIndices();
        if (out.getPageCount() + indices.length > exports.PDF_PREPARATION_MAX_PAGES)
            throw new PdfPreparationError("Prepared output exceeds 200 pages.");
        const pages = await out.copyPages(source, indices);
        pages.forEach((page, index) => {
            out.addPage(page);
            pageMap.push({ outputPage: out.getPageCount(), sourceDocumentId: request.documentIds[sourceIndex], sourcePage: indices[index] + 1 });
        });
    }
    const bytes = await out.save();
    if (bytes.length > exports.PDF_PREPARATION_MAX_BYTES)
        throw new PdfPreparationError("Prepared output exceeds 25 MiB.");
    return { bytes, sha256: pdfBytesHash(bytes), pageCount: out.getPageCount(), pageMap };
}
