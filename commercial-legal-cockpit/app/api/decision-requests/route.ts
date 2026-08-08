import { accessErrorResponse, requireMatterAccess } from "@/lib/access";
import { writeAuditEvent } from "@/lib/audit";
import { databaseConfigured, query } from "@/lib/db";
import { enforceRateLimit, rateLimitResponse } from "@/lib/rateLimit";

const ROLES=new Set(["APPROVER","ADMIN"]);

export async function POST(request:Request){
  try{
    if(!databaseConfigured())return Response.json({ok:false,error:"Decision requests require DATABASE_URL."},{status:503});
    const body=await request.json() as {matterId?:string;findingId?:string|null;decisionType?:string;rationale?:string;conditions?:string|string[]|null;requiredApproverRole?:string};
    const matterId=body.matterId?.trim();const decisionType=body.decisionType?.trim();const rationale=body.rationale?.trim();const requiredApproverRole=(body.requiredApproverRole||"APPROVER").toUpperCase();
    if(!matterId||!decisionType||!rationale)return Response.json({ok:false,error:"matterId, decisionType and rationale are required."},{status:400});
    if(!ROLES.has(requiredApproverRole))return Response.json({ok:false,error:"requiredApproverRole must be APPROVER or ADMIN."},{status:400});
    const principal=await requireMatterAccess(request,matterId,true);if(principal.demo)return Response.json({ok:false,error:"Persisted decision requests are disabled in demo mode."},{status:503});
    await enforceRateLimit(principal,"decision-request",120,3600);
    const findingId=body.findingId?.trim()||null;
    if(findingId){const finding=await query<{id:string}>("select id from findings where id=$1 and matter_id=$2 and review_status<>'SUPERSEDED'",[findingId,matterId]);if(!finding.rows[0])return Response.json({ok:false,error:"findingId does not belong to the selected matter."},{status:409});}
    const conditions=Array.isArray(body.conditions)?body.conditions:body.conditions?.trim()?[body.conditions.trim()]:[];
    const result=await query<{id:string}>(`insert into decisions(matter_id,finding_id,decision_type,rationale,conditions,decision_status,required_approver_role,requested_by) values($1,$2,$3,$4,$5::jsonb,'PENDING',$6,$7) returning id`,[matterId,findingId,decisionType,rationale,JSON.stringify(conditions),requiredApproverRole,principal.userId]);
    await writeAuditEvent({principal,action:"DECISION_RECORDED",matterId,entityType:"decision_request",entityId:result.rows[0].id,metadata:{decisionType,requiredApproverRole,findingId,conditions,status:"PENDING"}});
    return Response.json({ok:true,decisionId:result.rows[0].id,status:"PENDING",requiredApproverRole},{status:201});
  }catch(error){const rate=rateLimitResponse(error);if(rate)return rate;const access=accessErrorResponse(error);if(access)return access;return Response.json({ok:false,error:error instanceof Error?error.message:"Unable to create decision request."},{status:500});}
}
