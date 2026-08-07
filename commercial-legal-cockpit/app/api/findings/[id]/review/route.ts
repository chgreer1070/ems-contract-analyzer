import { accessErrorResponse, requireMatterAccess } from "@/lib/access";
import { writeAuditEvent } from "@/lib/audit";
import { databaseConfigured, query } from "@/lib/db";

const ALLOWED = new Set(["VALIDATED", "REJECTED", "SUPERSEDED"]);

export async function PATCH(request: Request, context: { params: Promise<{ id: string }> }) {
  try {
    if (!databaseConfigured()) {
      return Response.json({ ok: false, error: "Finding review requires DATABASE_URL." }, { status: 503 });
    }
    const { id } = await context.params;
    const finding = await query<{ matter_id: string; review_status: string }>(
      "select matter_id, review_status from findings where id = $1 limit 1",
      [id]
    );
    if (!finding.rows[0]) return Response.json({ ok: false, error: "Finding not found." }, { status: 404 });

    const principal = await requireMatterAccess(request, finding.rows[0].matter_id, true);
    if (principal.demo) return Response.json({ ok: false, error: "Review persistence is disabled in demo mode." }, { status: 503 });

    const body = await request.json() as { status?: string; note?: string };
    const status = String(body.status ?? "").toUpperCase();
    if (!ALLOWED.has(status)) {
      return Response.json({ ok: false, error: "Status must be VALIDATED, REJECTED, or SUPERSEDED." }, { status: 400 });
    }

    const updated = await query<{ id: string; review_status: string; reviewed_at: string }>(
      `update findings
          set review_status = $2, reviewed_by = $3, reviewed_at = now(), review_note = $4
        where id = $1
        returning id, review_status, reviewed_at`,
      [id, status, principal.userId, String(body.note ?? "").trim() || null]
    );

    await writeAuditEvent({
      principal,
      action: "FINDING_REVIEWED",
      matterId: finding.rows[0].matter_id,
      entityType: "finding",
      entityId: id,
      metadata: { from: finding.rows[0].review_status, to: status, note: body.note ?? null }
    });

    return Response.json({ ok: true, finding: updated.rows[0] });
  } catch (error) {
    const access = accessErrorResponse(error);
    if (access) return access;
    return Response.json({ ok: false, error: "Unable to review finding." }, { status: 500 });
  }
}
