import { accessErrorResponse, getPrincipal, requireRole } from "@/lib/access";
import { databaseConfigured, query, withTransaction } from "@/lib/db";
import { standardGovernanceIssues, standardIsRelianceEligible, type GovernedStandard } from "@/lib/standards";
import { internalErrorResponse } from "@/lib/safeErrors";

export async function GET(request: Request) {
  try {
    const principal = await getPrincipal(request);
    if (principal.demo || !databaseConfigured()) return Response.json({ ok:true,mode:"demo",standards:[],warning:"No approved company standards are loaded in demo mode." });
    await requireRole(request,"LAWYER");
    const result = await query<GovernedStandard&{id:string;active:boolean;created_at:string|Date}>(
      `select id,clause_family,title,standard_position,fallback_position,no_go_position,approval_authority,business_rationale,provenance_source,approval_role,active,version,effective_date,created_by,created_at
         from negotiation_standards
        where active=true or $1='ADMIN'
        order by clause_family,active desc,effective_date desc`,[principal.role]
    );
    const standards=result.rows
      .filter(row=>principal.role==="ADMIN"||standardIsRelianceEligible(row))
      .map(row=>({...row,governanceIssues:standardGovernanceIssues(row)}));
    return Response.json({ok:true,mode:"database",standards,adminView:principal.role==="ADMIN"});
  } catch (error) {
    const access=accessErrorResponse(error);if(access)return access;
    return internalErrorResponse(error,"Negotiation standards could not be loaded.");
  }
}

export async function POST(request: Request) {
  try {
    const principal=await requireRole(request,"ADMIN");
    if(principal.demo||!databaseConfigured())return Response.json({ok:false,error:"Standard administration requires production identity and DATABASE_URL."},{status:503});
    const body=await request.json() as Record<string,unknown>;
    const value=(field:string)=>String(body[field]??"").trim();
    const candidate:GovernedStandard={
      clause_family:value("clauseFamily"),title:value("title"),standard_position:value("standardPosition"),
      fallback_position:value("fallbackPosition"),no_go_position:value("noGoPosition"),approval_authority:value("approvalAuthority"),
      business_rationale:value("businessRationale"),provenance_source:value("provenanceSource"),approval_role:value("approvalRole").toUpperCase(),
      version:value("version"),effective_date:value("effectiveDate"),created_by:principal.userId
    };
    const issues=standardGovernanceIssues(candidate);
    if(issues.length)return Response.json({ok:false,error:"The negotiation standard is incomplete or ineligible for legal reliance.",issues},{status:400});
    const result=await withTransaction(async client=>{const inserted=await client.query<{id:string}>(`insert into negotiation_standards(clause_family,title,standard_position,fallback_position,no_go_position,approval_authority,business_rationale,provenance_source,approval_role,active,version,effective_date,created_by) values($1,$2,$3,$4,$5,$6,$7,$8,$9,false,$10,$11,$12) returning id`,[candidate.clause_family,candidate.title,candidate.standard_position,candidate.fallback_position,candidate.no_go_position,candidate.approval_authority,candidate.business_rationale,candidate.provenance_source,candidate.approval_role,candidate.version,candidate.effective_date,candidate.created_by]);await client.query(`insert into audit_events(actor_user_id,actor_name,action,entity_type,entity_id,metadata) values($1,$2,'STANDARD_CREATED','negotiation_standard',$3,$4::jsonb)`,[principal.userId,principal.name,inserted.rows[0].id,JSON.stringify({clauseFamily:candidate.clause_family,version:candidate.version,approvalRole:candidate.approval_role,active:false})]);return inserted;});
    return Response.json({ok:true,standardId:result.rows[0].id,active:false,provenanceSource:candidate.provenance_source,approvalRole:candidate.approval_role,message:"Standard created inactive; activate only after formal approval."},{status:201});
  } catch (error) {
    const access=accessErrorResponse(error);if(access)return access;
    return internalErrorResponse(error,"The negotiation standard could not be created.");
  }
}
