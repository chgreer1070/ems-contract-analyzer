import { accessErrorResponse, getPrincipal, requireMatterAccess } from "@/lib/access";
import { writeAuditEvent } from "@/lib/audit";
import { databaseConfigured, query } from "@/lib/db";

const TYPES = new Set(["ACCEPT", "NEGOTIATE", "ESCALATE", "REJECT", "APPROVE_EXCEPTION"]);

export async function GET(request: Request) {
  try {
    const principal = await getPrincipal(request);
    if (principal.demo || !databaseConfigured()) return Response.json({ ok: true, mode: "demo", decisions: [] });

    const result = await query<{
      id: string; matter_id: string; matter_number: string; customer: string; decision_type: string; rationale: string;
      conditions: string | null; decision_status: string; required_approver_role: string | null; requested_at: string;
    }>(
      `select d.id, d.matter_id, m.matter_number, c.name as customer, d.decision_type, d.rationale,
              d.conditions, d.decision_status, d.required_approver_role, d.requested_at
         from decisions d
         join matters m on m.id = d.matter_id
         join customers c on c.id = m.customer_id
        where $1 = 'ADMIN'
           or m.owner_user_id = $2
           or exists (select 1 from matter_members mm where mm.matter_id = m.id and mm.user_id = $2)
           or (m.restricted = false and $1 in ('LAWYER','APPROVER'))
        order by case when d.decision_status = 'PENDING' then 0 else 1 end, d.requested_at desc
        limit 250`,
      [principal.role, principal.userId]
    );
    return Response.json({ ok: true, mode: "database", decisions: result.rows });
  } catch (error) {
    const access = accessErrorResponse(error);
    if (access) return access;
    return Response.json({ ok: false, error: "Unable to load decisions." }, { status: 500 });
  }
}

export async function POST(request: Request) {
  try {
    if (!databaseConfigured()) return Response.json({ ok: false, error: "Decision workflow requires DATABASE_URL." }, { status: 503 });
    const body = await request.json() as {
      matterId?: string; findingId?: string; decisionType?: string; rationale?: string; conditions?: string; requiredApproverRole?: string;
    };
    if (!body.matterId) return Response.json({ ok: false, error: "matterId is required." }, { status: 400 });
    const principal = await requireMatterAccess(request, body.matterId, true);
    if (principal.demo) return Response.json({ ok: false, error: "Decision persistence is disabled in demo mode." }, { status: 503 });

    const decisionType = String(body.decisionType ?? "").toUpperCase();
    if (!TYPES.has(decisionType)) return Response.json({ ok: false, error: "Invalid decision type." }, { status: 400 });
    const rationale = String(body.rationale ?? "").trim();
    if (rationale.length < 10) return Response.json({ ok: false, error: "Decision rationale is required." }, { status: 400 });

    if (body.findingId) {
      const finding = await query<{ id: string }>("select id from findings where id = $1 and matter_id = $2", [body.findingId, body.matterId]);
      if (!finding.rows[0]) return Response.json({ ok: false, error: "Finding does not belong to this matter." }, { status: 400 });
    }

    const result = await query<{ id: string }>(
      `insert into decisions
        (matter_id,finding_id,decision_type,rationale,conditions,requested_by,required_approver_role)
       values ($1,$2,$3,$4,$5,$6,$7)
       returning id`,
      [
        body.matterId,
        body.findingId ?? null,
        decisionType,
        rationale,
        String(body.conditions ?? "").trim() || null,
        principal.userId,
        String(body.requiredApproverRole ?? "APPROVER").trim() || "APPROVER"
      ]
    );

    await writeAuditEvent({
      principal,
      action: "DECISION_RECORDED",
      matterId: body.matterId,
      entityType: "decision",
      entityId: result.rows[0].id,
      metadata: { decisionType, status: "PENDING", findingId: body.findingId ?? null }
    });

    return Response.json({ ok: true, decisionId: result.rows[0].id }, { status: 201 });
  } catch (error) {
    const access = accessErrorResponse(error);
    if (access) return access;
    return Response.json({ ok: false, error: "Unable to create decision request." }, { status: 500 });
  }
}
