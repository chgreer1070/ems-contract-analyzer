import { accessErrorResponse, requireMatterAccess, requireRole } from "@/lib/access";
import { databaseConfigured, query, withTransaction } from "@/lib/db";
import { internalErrorResponse } from "@/lib/safeErrors";

const confidentiality=new Set(["INTERNAL","CONFIDENTIAL","PRIVILEGED","RESTRICTED"]);
const privilege=new Set(["NOT_ASSESSED","PRIVILEGED","WORK_PRODUCT","NON_PRIVILEGED","MIXED"]);
class GovernanceError extends Error{constructor(message:string,public status=409){super(message);}}

export async function GET(request:Request,context:{params:Promise<{id:string}>}){
  try{
    if(!databaseConfigured())return Response.json({ok:false,error:"Governance controls require DATABASE_URL."},{status:503});
    const {id}=await context.params;const principal=await requireMatterAccess(request,id,false);
    const result=await query<any>(`select id,confidentiality_level,privilege_status,legal_hold,legal_hold_reason,retention_category,retention_until from matters where id=$1 limit 1`,[id]);
    if(!result.rows[0])return Response.json({ok:false,error:"Matter not found."},{status:404});
    const holds=await query<any>(`select id,document_id,action,reason,actor_user_id,actor_name,event_time from legal_hold_events where matter_id=$1 order by event_time desc limit 100`,[id]);
    const viewer=principal.role==="VIEWER";
    return Response.json({ok:true,governance:viewer?{...result.rows[0],legal_hold_reason:null}:result.rows[0],holdEvents:viewer?holds.rows.map((row:any)=>({...row,reason:null})):holds.rows});
  }catch(error){const access=accessErrorResponse(error);if(access)return access;return internalErrorResponse(error,"Governance controls could not be loaded.");}
}

export async function PATCH(request:Request,context:{params:Promise<{id:string}>}){
  try{
    if(!databaseConfigured())return Response.json({ok:false,error:"Governance controls require DATABASE_URL."},{status:503});
    const {id}=await context.params;const principal=await requireMatterAccess(request,id,true);if(principal.demo)return Response.json({ok:false,error:"Persistent governance is disabled in demo mode."},{status:503});
    const body=await request.json() as {confidentialityLevel?:string;privilegeStatus?:string;retentionCategory?:string|null;retentionUntil?:string|null;legalHold?:boolean;legalHoldReason?:string};
    if(body.confidentialityLevel&&!confidentiality.has(body.confidentialityLevel))return Response.json({ok:false,error:"Invalid confidentialityLevel."},{status:400});
    if(body.privilegeStatus&&!privilege.has(body.privilegeStatus))return Response.json({ok:false,error:"Invalid privilegeStatus."},{status:400});
    if(body.retentionUntil!==undefined&&body.retentionUntil!==null&&!/^\d{4}-\d{2}-\d{2}$/.test(body.retentionUntil))return Response.json({ok:false,error:"retentionUntil must be an ISO date or null."},{status:400});
    if(body.legalHold===false){await requireRole(request,"APPROVER");await requireMatterAccess(request,id,"APPROVE");}
    const result=await withTransaction(async client=>{
      const current=(await client.query<any>(`select confidentiality_level,privilege_status,legal_hold,retention_category,retention_until from matters where id=$1 for update`,[id])).rows[0];if(!current)throw new GovernanceError("Matter not found.",404);
      const holdChanging=typeof body.legalHold==="boolean"&&body.legalHold!==current.legal_hold;
      const holdReason=body.legalHoldReason?.trim();if(holdChanging&&!holdReason)throw new GovernanceError("A reason is required to apply or release a legal hold.",400);
      const next={confidentialityLevel:body.confidentialityLevel??current.confidentiality_level,privilegeStatus:body.privilegeStatus??current.privilege_status,retentionCategory:body.retentionCategory===undefined?current.retention_category:body.retentionCategory||null,retentionUntil:body.retentionUntil===undefined?current.retention_until:body.retentionUntil||null,legalHold:body.legalHold===undefined?current.legal_hold:body.legalHold};
      await client.query(`update matters set confidentiality_level=$2,privilege_status=$3,retention_category=$4,retention_until=$5,legal_hold=$6,legal_hold_reason=case when $7::boolean then $8 else legal_hold_reason end,updated_at=now() where id=$1`,[id,next.confidentialityLevel,next.privilegeStatus,next.retentionCategory,next.retentionUntil,next.legalHold,holdChanging,holdReason||null]);
      if(holdChanging)await client.query(`insert into legal_hold_events(matter_id,action,reason,actor_user_id,actor_name) values($1,$2,$3,$4,$5)`,[id,next.legalHold?"HOLD_APPLIED":"HOLD_RELEASED",holdReason,principal.userId,principal.name]);
      await client.query(`insert into audit_events(actor_user_id,actor_name,action,matter_id,entity_type,entity_id,metadata) values($1,$2,'GOVERNANCE_CHANGED',$3,'matter',$3,$4::jsonb)`,[principal.userId,principal.name,id,JSON.stringify({from:{confidentialityLevel:current.confidentiality_level,privilegeStatus:current.privilege_status,retentionCategory:current.retention_category,retentionUntil:current.retention_until,legalHold:current.legal_hold},to:next,holdReasonRecorded:holdChanging})]);
      return next;
    });
    return Response.json({ok:true,governance:result});
  }catch(error){const access=accessErrorResponse(error);if(access)return access;if(error instanceof GovernanceError)return Response.json({ok:false,error:error.message},{status:error.status});return internalErrorResponse(error,"Governance controls could not be updated.");}
}
