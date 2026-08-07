import { accessErrorResponse, requireMatterAccess, requireRole } from "@/lib/access";
import { writeAuditEvent } from "@/lib/audit";
import { databaseConfigured, query, withTransaction } from "@/lib/db";

const confidentiality=new Set(["INTERNAL","CONFIDENTIAL","PRIVILEGED","RESTRICTED"]);
const privilege=new Set(["NOT_ASSESSED","PRIVILEGED","WORK_PRODUCT","NON_PRIVILEGED","MIXED"]);

export async function GET(request:Request,context:{params:Promise<{id:string}>}){
  try{
    if(!databaseConfigured())return Response.json({ok:false,error:"Governance controls require DATABASE_URL."},{status:503});
    const {id}=await context.params;await requireMatterAccess(request,id,false);
    const result=await query<any>(`select id,confidentiality_level,privilege_status,legal_hold,legal_hold_reason,retention_category,retention_until from matters where id=$1 limit 1`,[id]);
    if(!result.rows[0])return Response.json({ok:false,error:"Matter not found."},{status:404});
    const holds=await query<any>(`select id,document_id,action,reason,actor_user_id,actor_name,event_time from legal_hold_events where matter_id=$1 order by event_time desc limit 100`,[id]);
    return Response.json({ok:true,governance:result.rows[0],holdEvents:holds.rows});
  }catch(error){const access=accessErrorResponse(error);if(access)return access;return Response.json({ok:false,error:error instanceof Error?error.message:"Unable to load governance controls."},{status:500});}
}

export async function PATCH(request:Request,context:{params:Promise<{id:string}>}){
  try{
    if(!databaseConfigured())return Response.json({ok:false,error:"Governance controls require DATABASE_URL."},{status:503});
    const {id}=await context.params;const principal=await requireMatterAccess(request,id,true);if(principal.demo)return Response.json({ok:false,error:"Persistent governance is disabled in demo mode."},{status:503});
    const body=await request.json() as {confidentialityLevel?:string;privilegeStatus?:string;retentionCategory?:string|null;retentionUntil?:string|null;legalHold?:boolean;legalHoldReason?:string};
    if(body.confidentialityLevel&&!confidentiality.has(body.confidentialityLevel))return Response.json({ok:false,error:"Invalid confidentialityLevel."},{status:400});
    if(body.privilegeStatus&&!privilege.has(body.privilegeStatus))return Response.json({ok:false,error:"Invalid privilegeStatus."},{status:400});
    const current=(await query<any>(`select confidentiality_level,privilege_status,legal_hold,legal_hold_reason,retention_category,retention_until from matters where id=$1 limit 1`,[id])).rows[0];if(!current)return Response.json({ok:false,error:"Matter not found."},{status:404});
    const holdChanging=typeof body.legalHold==="boolean"&&body.legalHold!==current.legal_hold;
    if(holdChanging&&!body.legalHold)await requireRole(request,"APPROVER");
    if(holdChanging&&!body.legalHoldReason?.trim())return Response.json({ok:false,error:"A reason is required to apply or release a legal hold."},{status:400});
    await withTransaction(async client=>{
      await client.query(`update matters set confidentiality_level=$2,privilege_status=$3,retention_category=$4,retention_until=$5,legal_hold=$6,legal_hold_reason=$7,updated_at=now() where id=$1`,[id,body.confidentialityLevel??current.confidentiality_level,body.privilegeStatus??current.privilege_status,body.retentionCategory===undefined?current.retention_category:body.retentionCategory||null,body.retentionUntil===undefined?current.retention_until:body.retentionUntil||null,body.legalHold===undefined?current.legal_hold:body.legalHold,holdChanging?body.legalHoldReason!.trim():current.legal_hold_reason]);
      if(holdChanging)await client.query(`insert into legal_hold_events(matter_id,action,reason,actor_user_id,actor_name) values($1,$2,$3,$4,$5)`,[id,body.legalHold?"HOLD_APPLIED":"HOLD_RELEASED",body.legalHoldReason!.trim(),principal.userId,principal.name]);
    });
    await writeAuditEvent({principal,action:"GOVERNANCE_CHANGED",matterId:id,entityType:"matter",entityId:id,metadata:{from:current,to:{confidentialityLevel:body.confidentialityLevel??current.confidentiality_level,privilegeStatus:body.privilegeStatus??current.privilege_status,retentionCategory:body.retentionCategory===undefined?current.retention_category:body.retentionCategory,retentionUntil:body.retentionUntil===undefined?current.retention_until:body.retentionUntil,legalHold:body.legalHold===undefined?current.legal_hold:body.legalHold},holdReason:holdChanging?body.legalHoldReason:null}});
    return Response.json({ok:true});
  }catch(error){const access=accessErrorResponse(error);if(access)return access;return Response.json({ok:false,error:error instanceof Error?error.message:"Unable to update governance controls."},{status:500});}
}
