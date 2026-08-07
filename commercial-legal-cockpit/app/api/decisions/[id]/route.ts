import { accessErrorResponse, requireMatterAccess, requireRole } from "@/lib/access";
import { writeAuditEvent } from "@/lib/audit";
import { databaseConfigured, query } from "@/lib/db";

export async function PATCH(request: Request, context: { params: Promise<{ id: string }> }) {
  try {
    if (!databaseConfigured()) return Response.json({ ok: false, error: "Decision workflow requires DATABASE_URL." }, { status: 503 });
    const { id } = await context.params;
    const decision = await query<{ matter_id: string; decision_status: string; requested_by: string }>(
      "select matter_id, decision_status, requested_by from decisions where id = $1 limit 1",
      [id]
    );
    if (!decision.rows[0]) return Response.json({ ok: false, error: "Decision not found." }, { status: 404 });

    const principal = await requireRole(request, "APPROVER");
    await requireMatterAccess(request, decision.rows[0].matter_id, false);
    if (principal.demo) return Response.json({ ok: false, error: "Decision persistence is disabled in demo mode." }, { status: 503 });

    const body = await request.json() as { status?: string; conditions?: string };
    const status = String(body.status ?? "").toUpperCase();
    if (!new Set(["APPROVED", "REJECTED"]).has(status)) {
      return Response.json({ ok: false, error: "Status must be APPROVED or REJECTED." }, { status: 400 });
    }
    if (decision.rows[0].decision_status !== "PENDING") {
      return Response.json({ ok: false, error: "Only pending decisions can be disposed." }, { status: 409 });
    }

    const result = await query<{ id: string; decision_status: string; decided_at: string }>(
      `update decisions
          set decision_status = $2,
              conditions = coalesce(nullif($3,''), conditions),
              decided_by = $4,
              decided_at = now()
        where id = $1 and decision_status = 'PENDING'
        returning id, decision_status, decided_at`,
      [id, status, String(body.conditions ?? "").trim(), principal.userId]
    );
    if (!result.rows[0]) return Response.json({ ok: false, error: "Decision state changed; reload and retry." }, { status: 409 });

    await writeAuditEvent({
      principal,
      action: "DECISION_RECORDED",
      matterId: decision.rows[0].matter_id,
      entityType: "decision",
      entityId: id,
      metadata: { from: "PENDING", to: status, conditions: body.conditions ?? null }
    });

    return Response.json({ ok: true, decision: result.rows[0] });
  } catch (error) {
    const access = accessErrorResponse(error);
    if (access) return access;
    return Response.json({ ok: false, error: "Unable to dispose decision." }, { status: 500 });
  }
}
