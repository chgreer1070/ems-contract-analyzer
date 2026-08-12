import { accessErrorResponse, getPrincipal, requireMatterAccess } from "@/lib/access";
import { databaseConfigured, query } from "@/lib/db";
import { internalErrorResponse } from "@/lib/safeErrors";


export async function GET(request: Request) {
  try {
    const principal = await getPrincipal(request);
    if (principal.demo || !databaseConfigured()) return Response.json({ ok: true, mode: "demo", decisions: [] });

    const result = await query<{
      id: string; matter_id: string; matter_number: string; customer: string; decision_type: string; rationale: string;
      conditions: string | null; decision_status: string; required_approver_role: string | null; requested_at: string;
      agreement_version_id:string|null;version_number:number|null;version_label:string|null;condition_count:number;pending_condition_count:number;
    }>(
      `select d.id, d.matter_id, m.matter_number, c.name as customer, d.decision_type, d.rationale,
              d.conditions, d.decision_status, d.required_approver_role, d.requested_at,
              d.agreement_version_id,av.version_number,av.label version_label,
              (select count(*)::int from decision_conditions dc where dc.decision_id=d.id) condition_count,
              (select count(*)::int from decision_conditions dc where dc.decision_id=d.id and dc.condition_status='PENDING') pending_condition_count
         from decisions d
         join matters m on m.id = d.matter_id
         join customers c on c.id = m.customer_id
         left join agreement_versions av on av.id=d.agreement_version_id
        where $1 = 'ADMIN'
           or m.owner_user_id = $2
           or exists (select 1 from matter_members mm where mm.matter_id = m.id and mm.user_id = $2)
           or (m.restricted = false and $1 in ('LAWYER','APPROVER'))
        order by case when d.decision_status = 'PENDING' then 0 else 1 end, d.requested_at desc
        limit 250`,
      [principal.role, principal.userId]
    );
    return Response.json({ ok: true, mode: "database", decisions: result.rows.map(row=>principal.role==="VIEWER"?{...row,conditions:null}:row) });
  } catch (error) {
    const access = accessErrorResponse(error);
    if (access) return access;
    return internalErrorResponse(error,"Decisions could not be loaded.");
  }
}

export async function POST(request: Request) {
  try {
    if (!databaseConfigured()) return Response.json({ ok: false, error: "Decision workflow requires DATABASE_URL." }, { status: 503 });
    const body = await request.json() as { matterId?: string };
    if (!body.matterId) return Response.json({ ok: false, error: "matterId is required." }, { status: 400 });
    await requireMatterAccess(request, body.matterId, true);
    return Response.json({ok:false,error:"Decision creation uses the governed /api/decision-requests endpoint so finding validation and approval authority are derived atomically."},{status:409});
  } catch (error) {
    const access = accessErrorResponse(error);
    if (access) return access;
    return internalErrorResponse(error,"Decision request authorization could not be completed.");
  }
}
