import { accessErrorResponse, requireMatterAccess } from "@/lib/access";
import { databaseConfigured, withTransaction } from "@/lib/db";
import { internalErrorResponse } from "@/lib/safeErrors";
import { PlaybookError, runPlaybookOperation } from "@/lib/playbooks/service.mjs";

export const runtime = "nodejs";

export async function POST(request: Request, context: { params: Promise<{ id: string }> }) {
  try {
    if (!databaseConfigured()) return Response.json({ ok: false, error: "Playbooks require a configured database." }, { status: 503 });
    const { id } = await context.params;
    // Rechecked transactionally by the service at the operation-specific level.
    const principal = await requireMatterAccess(request, id, "VIEW");
    const reader = request.body?.getReader();
    if (!reader) return Response.json({ ok: false, error: "JSON body required." }, { status: 400 });
    const chunks: Uint8Array[] = [];
    let size = 0;
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > 131072) { await reader.cancel(); return Response.json({ ok: false, error: "Request exceeds 128 KiB." }, { status: 413 }); }
      chunks.push(value);
    }
    let input: unknown;
    try { input = JSON.parse(Buffer.concat(chunks).toString("utf8")); }
    catch { return Response.json({ ok: false, error: "Valid JSON required." }, { status: 400 }); }
    const result = await withTransaction(client => runPlaybookOperation(client, principal, id, input));
    return Response.json({ ok: true, result });
  } catch (error) {
    const access = accessErrorResponse(error);
    if (access) return access;
    if (error instanceof PlaybookError) return Response.json({ ok: false, error: error.message }, { status: error.status });
    return internalErrorResponse(error, "The playbook operation could not be completed.");
  }
}
