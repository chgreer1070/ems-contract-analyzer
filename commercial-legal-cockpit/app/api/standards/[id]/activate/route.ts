import { accessErrorResponse, requireRole } from "@/lib/access";
import { databaseConfigured, withTransaction } from "@/lib/db";
import { standardGovernanceIssues, type GovernedStandard } from "@/lib/standards";
import { internalErrorResponse } from "@/lib/safeErrors";

export async function PATCH(request: Request, context: { params: Promise<{ id: string }> }) {
  try {
    const principal = await requireRole(request, "ADMIN");
    if (principal.demo || !databaseConfigured()) return Response.json({ ok:false, error:"Standard activation requires production identity and DATABASE_URL." }, { status:503 });
    const { id } = await context.params;
    const body = await request.json().catch(() => ({})) as { confirm?:boolean };
    if (body.confirm !== true) return Response.json({ ok:false, error:"Explicit confirm=true is required to activate a negotiation standard." }, { status:400 });
    const activated = await withTransaction(async (client) => {
      const target = await client.query<GovernedStandard>("select clause_family,title,standard_position,fallback_position,no_go_position,approval_authority,business_rationale,provenance_source,approval_role,version,effective_date,created_by from negotiation_standards where id=$1 for update",[id]);
      if (!target.rows[0]) return {status:"missing" as const};
      const issues=standardGovernanceIssues(target.rows[0]);
      if(issues.length)return {status:"invalid" as const,issues};
      await client.query("update negotiation_standards set active=false where clause_family=$1",[target.rows[0].clause_family]);
      await client.query("update negotiation_standards set active=true where id=$1",[id]);
      await client.query(`insert into audit_events(actor_user_id,actor_name,action,entity_type,entity_id,metadata) values($1,$2,'STANDARD_ACTIVATED','negotiation_standard',$3,$4::jsonb)`,[principal.userId,principal.name,id,JSON.stringify({clauseFamily:target.rows[0].clause_family,version:target.rows[0].version,approvalRole:target.rows[0].approval_role})]);
      return {status:"activated" as const,standard:target.rows[0]};
    });
    if (activated.status==="missing") return Response.json({ ok:false, error:"Standard not found." }, { status:404 });
    if(activated.status==="invalid")return Response.json({ok:false,error:"The negotiation standard is incomplete or ineligible for legal reliance.",issues:activated.issues},{status:409});
    return Response.json({ ok:true, active:true, clauseFamily:activated.standard.clause_family, version:activated.standard.version, provenanceSource:activated.standard.provenance_source, approvalRole:activated.standard.approval_role });
  } catch (error) {
    const access=accessErrorResponse(error); if(access)return access;
    return internalErrorResponse(error,"The negotiation standard could not be activated.");
  }
}
