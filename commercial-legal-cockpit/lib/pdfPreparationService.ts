import type { Principal } from "@/lib/access";
import { PdfPreparationError, parsePdfPreparationRequest, pdfBytesHash, PDF_PREPARATION_MAX_BYTES, type PdfPreparationRequest } from "@/lib/pdfPreparation";
import { preparePdfInWorker } from "@/lib/pdfPreparationWorker";

export type PdfSource = {
  id: string; matter_id: string; mime_type: string; blob_pathname: string;
  sha256: string | null; server_sha256: string | null; size_bytes: string | number;
  integrity_status: string; security_scan_status: string; deletion_status: string;
};
export type PreparationReceipt = {
  version: 1; preparationId: string; operation: PdfPreparationRequest;
  parents: Array<{ documentId: string; sha256: string; blobPathname: string }>;
  output: { blobPathname: string; sha256: string; sizeBytes: number; pageCount: number };
  pageMap: Array<{ outputPage: number; sourceDocumentId: string; sourcePage: number }>;
  sourceAuthority: "PREPARATION_COPY_ONLY";
};
export type PreparationDependencies = {
  authorize: (request: Request, matterId: string, level: "EDIT") => Promise<Principal>;
  rateLimit: (principal: Principal) => Promise<void>;
  loadSources: (matterId: string, ids: string[]) => Promise<PdfSource[]>;
  readPrivateBytes: (pathname: string, maxBytes: number) => Promise<Uint8Array>;
  scanOutput: (bytes: Uint8Array) => Promise<boolean>;
  persist: (matterId: string, principal: Principal, bytes: Uint8Array, receipt: Omit<PreparationReceipt, "output"> & { output: Omit<PreparationReceipt["output"], "blobPathname"> }) => Promise<void>;
};

export function assertReadyPdfSource(source: PdfSource, matterId: string) {
  if (source.matter_id !== matterId || source.mime_type !== "application/pdf" || source.deletion_status !== "ACTIVE" ||
      source.security_scan_status !== "CLEAN" || source.integrity_status !== "SERVER_VERIFIED" ||
      !source.sha256 || !source.server_sha256 || !/^[a-f0-9]{64}$/i.test(source.sha256) ||
      source.sha256.toLowerCase() !== source.server_sha256.toLowerCase()) {
    throw new PdfPreparationError("Every source must be an active, scanned, server-verified PDF in the authorized matter.", 409);
  }
  if (!Number.isSafeInteger(Number(source.size_bytes)) || Number(source.size_bytes) <= 0 || Number(source.size_bytes) > PDF_PREPARATION_MAX_BYTES) {
    throw new PdfPreparationError("Source exceeds the PDF preparation size limit.", 409);
  }
  if (!source.blob_pathname.startsWith(`contracts/${matterId}/`) || source.blob_pathname.includes("..")) {
    throw new PdfPreparationError("Source storage identity does not match its matter.", 409);
  }
}

export async function executePdfPreparation(request: Request, matterId: string, value: unknown, preparationId: string, deps: PreparationDependencies) {
  // Authorization comes before source metadata or bytes are accessed.
  const principal = await deps.authorize(request, matterId, "EDIT");
  if (principal.demo) throw new PdfPreparationError("PDF preparation is disabled in demo mode.", 503);
  const operation = parsePdfPreparationRequest(value);
  await deps.rateLimit(principal);
  const loaded = await deps.loadSources(matterId, operation.documentIds);
  const sources = operation.documentIds.map(id => loaded.find(source => source.id === id));
  if (sources.some(source => !source)) throw new PdfPreparationError("Source not found or unavailable in the authorized matter.", 404);
  const ready = sources as PdfSource[];
  ready.forEach(source => assertReadyPdfSource(source, matterId));
  if (ready.reduce((size, source) => size + Number(source.size_bytes), 0) > PDF_PREPARATION_MAX_BYTES) throw new PdfPreparationError("Combined sources exceed 25 MiB.");
  const inputs: Uint8Array[] = [];
  for (const source of ready) {
    const bytes = await deps.readPrivateBytes(source.blob_pathname, PDF_PREPARATION_MAX_BYTES);
    if (bytes.length !== Number(source.size_bytes) || pdfBytesHash(bytes) !== source.server_sha256!.toLowerCase()) throw new PdfPreparationError("Source bytes failed integrity verification.", 409);
    inputs.push(bytes);
  }
  const output = await preparePdfInWorker(operation, inputs);
  if (!await deps.scanOutput(output.bytes)) throw new PdfPreparationError("Prepared PDF failed malware scanning.", 423);
  const receipt = {
    version: 1 as const, preparationId, operation,
    parents: ready.map(source => ({ documentId: source.id, sha256: source.server_sha256!.toLowerCase(), blobPathname: source.blob_pathname })),
    output: { sha256: output.sha256, sizeBytes: output.bytes.length, pageCount: output.pageCount },
    pageMap: output.pageMap, sourceAuthority: "PREPARATION_COPY_ONLY" as const
  };
  await deps.persist(matterId, principal, output.bytes, receipt);
  return { preparationId, pageCount: output.pageCount, sha256: output.sha256, pageMap: output.pageMap, sourceAuthority: receipt.sourceAuthority };
}
