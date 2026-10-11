import { accessErrorResponse, requireMatterAccess } from "@/lib/access";
import { databaseConfigured, query } from "@/lib/db";
import { PdfPreparationError, pdfBytesHash, PDF_PREPARATION_MAX_BYTES } from "@/lib/pdfPreparation";
import { assertReadyPdfSource, type PdfSource, type PreparationReceipt } from "@/lib/pdfPreparationService";
import { pdfPreparationEnabled, readPrivatePdfBytes } from "@/lib/pdfPreparationStorage";
import { internalErrorResponse } from "@/lib/safeErrors";

export const runtime = "nodejs";
const UUID = /^[0-9a-f]{8}-(?:[0-9a-f]{4}-){3}[0-9a-f]{12}$/i;

export async function GET(request: Request, context: { params: Promise<{ id: string; preparationId: string }> }) {
  try {
    if (!pdfPreparationEnabled() || !databaseConfigured() || !process.env.BLOB_READ_WRITE_TOKEN) return Response.json({ ok: false, error: "PDF preparation retrieval is unavailable." }, { status: 503 });
    const { id: matterId, preparationId } = await context.params;
    await requireMatterAccess(request, matterId, "VIEW");
    if (!UUID.test(preparationId)) throw new PdfPreparationError("Preparation not found.", 404);
    const receipt = (await query<{ metadata: PreparationReceipt }>(`select metadata from audit_events where matter_id=$1 and entity_id=$2 and entity_type='pdf_preparation' and action='PDF_PREPARATION_COMPLETED' order by id desc limit 1`, [matterId, preparationId])).rows[0]?.metadata;
    if (!receipt) throw new PdfPreparationError("Preparation not found.", 404);
    if (receipt.version !== 1 || receipt.sourceAuthority !== "PREPARATION_COPY_ONLY" || receipt.output.blobPathname !== `contracts/${matterId}/prepared/${preparationId}.pdf`) throw new PdfPreparationError("Preparation receipt is invalid.", 409);
    const parents = (await query<PdfSource>("select id,matter_id,mime_type,blob_pathname,sha256,server_sha256,size_bytes,integrity_status,security_scan_status,deletion_status from documents where matter_id=$1 and id=any($2::uuid[])", [matterId, receipt.parents.map(parent => parent.documentId)])).rows;
    if (parents.length !== receipt.parents.length) throw new PdfPreparationError("Preparation sources are no longer available.", 409);
    for (const parent of parents) {
      assertReadyPdfSource(parent, matterId);
      const recorded = receipt.parents.find(item => item.documentId === parent.id)!;
      if (parent.server_sha256!.toLowerCase() !== recorded.sha256 || parent.blob_pathname !== recorded.blobPathname) throw new PdfPreparationError("Preparation source identity changed.", 409);
    }
    const bytes = await readPrivatePdfBytes(receipt.output.blobPathname, PDF_PREPARATION_MAX_BYTES);
    if (bytes.length !== receipt.output.sizeBytes || pdfBytesHash(bytes) !== receipt.output.sha256) throw new PdfPreparationError("Prepared output failed integrity verification.", 409);
    return new Response(bytes, { headers: { "Content-Type": "application/pdf", "Content-Disposition": `attachment; filename="prepared-${preparationId}.pdf"`, "X-Content-Type-Options": "nosniff", "Cache-Control": "private, no-store" } });
  } catch (error) {
    const access = accessErrorResponse(error); if (access) return access;
    if (error instanceof PdfPreparationError) return Response.json({ ok: false, error: error.message }, { status: error.status });
    return internalErrorResponse(error, "Prepared PDF retrieval could not be completed.");
  }
}
