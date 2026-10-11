import { randomUUID } from "node:crypto";
import { put } from "@vercel/blob";
import { accessErrorResponse, requireMatterAccess } from "@/lib/access";
import { databaseConfigured, query, withTransaction } from "@/lib/db";
import { malwareScannerConfigured, scanBuffer } from "@/lib/malwareScan";
import { PdfPreparationError } from "@/lib/pdfPreparation";
import { assertReadyPdfSource, executePdfPreparation, type PdfSource } from "@/lib/pdfPreparationService";
import { pdfPreparationEnabled, readPrivatePdfBytes, readPreparationJson } from "@/lib/pdfPreparationStorage";
import { enforceRateLimit, rateLimitResponse } from "@/lib/rateLimit";
import { internalErrorResponse } from "@/lib/safeErrors";

export const runtime = "nodejs";
const projection = "id,matter_id,mime_type,blob_pathname,sha256,server_sha256,size_bytes,integrity_status,security_scan_status,deletion_status";

/** Read-only reconciliation view; incomplete intent is not proof of worker failure. */
export async function GET(request: Request, context: { params: Promise<{ id: string }> }) {
  try {
    if (!pdfPreparationEnabled() || !databaseConfigured()) return Response.json({ ok: false, error: "PDF preparation reconciliation is unavailable." }, { status: 503 });
    const { id: matterId } = await context.params;
    await requireMatterAccess(request, matterId, "EDIT");
    const result = await query(`
      select started.entity_id as preparation_id, started.event_time as started_at,
             completed.event_time as completed_at,
             case when completed.id is null then 'PENDING_OR_INTERRUPTED' else 'COMPLETED' end as status,
             started.metadata->'operation' as operation,
             started.metadata->'output'->>'sha256' as output_sha256,
             started.metadata->'output'->>'sizeBytes' as size_bytes,
             started.metadata->'output'->>'pageCount' as page_count
        from audit_events started
        left join lateral (
          select id,event_time from audit_events done
           where done.matter_id=started.matter_id and done.entity_id=started.entity_id
             and done.entity_type='pdf_preparation' and done.action='PDF_PREPARATION_COMPLETED'
           order by done.id desc limit 1
        ) completed on true
       where started.matter_id=$1 and started.entity_type='pdf_preparation'
         and started.action='PDF_PREPARATION_STARTED'
       order by started.id desc limit 100`, [matterId]);
    return Response.json({ ok: true, preparations: result.rows, limit: 100, automaticRecovery: false }, { headers: { "Cache-Control": "private, no-store" } });
  } catch (error) {
    const access = accessErrorResponse(error); if (access) return access;
    return internalErrorResponse(error, "Preparation reconciliation could not be loaded.");
  }
}

export async function POST(request: Request, context: { params: Promise<{ id: string }> }) {
  try {
    if (!pdfPreparationEnabled()) return Response.json({ ok: false, error: "PDF preparation is not enabled for this deployment." }, { status: 503 });
    if (!databaseConfigured() || !process.env.BLOB_READ_WRITE_TOKEN || !malwareScannerConfigured()) return Response.json({ ok: false, error: "PDF preparation requires the governed database, private storage, and malware scanner." }, { status: 503 });
    const { id: matterId } = await context.params;
    // Reject unauthorized callers before even parsing a potentially large body.
    await requireMatterAccess(request, matterId, "EDIT");
    const value = await readPreparationJson(request);
    const preparationId = randomUUID();
    const result = await executePdfPreparation(request, matterId, value, preparationId, {
      authorize: requireMatterAccess,
      rateLimit: principal => enforceRateLimit(principal, "pdf-preparation", 20, 3600),
      loadSources: async (matter, ids) => (await query<PdfSource>(`select ${projection} from documents where matter_id=$1 and id=any($2::uuid[])`, [matter, ids])).rows,
      readPrivateBytes: readPrivatePdfBytes,
      scanOutput: async bytes => (await scanBuffer(Buffer.from(bytes))).clean,
      persist: async (matter, principal, bytes, receipt) => {
        const pathname = `contracts/${matter}/prepared/${preparationId}.pdf`;
        const completeReceipt = { ...receipt, output: { ...receipt.output, blobPathname: pathname } };
        const checkSources = async (client: Parameters<Parameters<typeof withTransaction>[0]>[0]) => {
          const rows = (await client.query<PdfSource>(`select ${projection} from documents where matter_id=$1 and id=any($2::uuid[]) order by id for share`, [matter, receipt.parents.map(parent => parent.documentId)])).rows;
          if (rows.length !== receipt.parents.length) throw new PdfPreparationError("A source became unavailable before preparation completed.", 409);
          for (const source of rows) {
            assertReadyPdfSource(source, matter);
            const parent = receipt.parents.find(candidate => candidate.documentId === source.id)!;
            if (source.server_sha256!.toLowerCase() !== parent.sha256 || source.blob_pathname !== parent.blobPathname) throw new PdfPreparationError("Source identity changed during preparation.", 409);
          }
        };
        await requireMatterAccess(request, matter, "EDIT");
        // Retain intent before the object write so interrupted writes can be reconciled.
        await withTransaction(async client => {
          await checkSources(client);
          await client.query(`insert into audit_events(actor_user_id,actor_name,action,matter_id,entity_type,entity_id,metadata) values($1,$2,'PDF_PREPARATION_STARTED',$3,'pdf_preparation',$4,$5::jsonb)`, [principal.userId, principal.name, matter, preparationId, JSON.stringify(completeReceipt)]);
        });
        await put(pathname, Buffer.from(bytes), { access: "private", token: process.env.BLOB_READ_WRITE_TOKEN, addRandomSuffix: false, allowOverwrite: false, contentType: "application/pdf" });
        await requireMatterAccess(request, matter, "EDIT");
        await withTransaction(async client => {
          await checkSources(client);
          await client.query(`insert into audit_events(actor_user_id,actor_name,action,matter_id,entity_type,entity_id,metadata) values($1,$2,'PDF_PREPARATION_COMPLETED',$3,'pdf_preparation',$4,$5::jsonb)`, [principal.userId, principal.name, matter, preparationId, JSON.stringify(completeReceipt)]);
        });
        // Prepared copies are deliberately absent from documents/agreement_versions.
      }
    });
    return Response.json({ ok: true, ...result, contentUrl: `/api/matters/${matterId}/pdf-preparations/${preparationId}/content` }, { status: 201, headers: { "Cache-Control": "no-store" } });
  } catch (error) {
    const access = accessErrorResponse(error); if (access) return access;
    const rate = rateLimitResponse(error); if (rate) return rate;
    if (error instanceof PdfPreparationError) return Response.json({ ok: false, error: error.message }, { status: error.status });
    return internalErrorResponse(error, "PDF preparation could not be completed.");
  }
}
