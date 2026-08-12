import { AccessError, accessErrorResponse, requireResourceMatterAccess } from "@/lib/access";
import { databaseConfigured, withTransaction } from "@/lib/db";
import { internalErrorResponse } from "@/lib/safeErrors";

export async function PATCH(request:Request,context:{params:Promise<{id:string}>}){
  try{
    if(!databaseConfigured())return Response.json({ok:false,error:"Decision-condition workflow requires DATABASE_URL."},{status:503});
    const {id}=await context.params;
    const {principal,matterId}=await requireResourceMatterAccess(request,"DECISION_CONDITION",id,"APPROVE");
    const body=await request.json() as {status?:string;evidence?:string};
    const status=String(body.status??"").toUpperCase();
    const evidence=String(body.evidence??"").trim();
    if(!new Set(["SATISFIED","WAIVED"]).has(status)){
      return Response.json({ok:false,error:"Status must be SATISFIED or WAIVED."},{status:400});
    }
    if(evidence.length<12||evidence.length>4000){
      return Response.json({ok:false,error:"Condition resolution evidence must be between 12 and 4000 characters."},{status:400});
    }

    const resolved=await withTransaction(async client=>{
      const activeRole=(await client.query<{role:string}>(
        "select role from app_user_roles where user_id=$1 and active=true for share",
        [principal.userId]
      )).rows[0]?.role;
      if(activeRole!=="APPROVER"&&activeRole!=="ADMIN"){
        throw new AccessError("Active Approver authority is required to resolve a decision condition.",403);
      }
      if(status==="WAIVED"&&activeRole!=="ADMIN"){
        throw new AccessError("Active Admin authority is required to waive a decision condition.",403);
      }
      const matter=(await client.query<{owner_user_id:string;member_access:string|null}>(`
        select m.owner_user_id,
               (select mm.access_level from matter_members mm
                 where mm.matter_id=m.id and mm.user_id=$2 for share) member_access
          from matters m where m.id=$1 for share`,
        [matterId,principal.userId]
      )).rows[0];
      if(!matter)throw new AccessError("Resource not found or access denied.",404);
      if(activeRole!=="ADMIN"&&matter.owner_user_id!==principal.userId&&matter.member_access!=="APPROVE"){
        throw new AccessError("Resource not found or access denied.",404);
      }
      const current=(await client.query<{
        condition_status:string;
        decision_id:string;
        agreement_version_id:string;
        decision_status:string;
        required_approver_role:string;
      }>(`
        select dc.condition_status,dc.decision_id,dc.agreement_version_id,
               d.decision_status,d.required_approver_role
          from decision_conditions dc
          join decisions d on d.id=dc.decision_id
         where dc.id=$1 and dc.matter_id=$2
         for update of dc,d`,
        [id,matterId]
      )).rows[0];
      if(!current||current.condition_status!=="PENDING")return null;
      if(current.decision_status!=="APPROVED"){
        throw new AccessError("Only conditions on an approved decision can be resolved.",409);
      }
      if(current.required_approver_role==="ADMIN"&&activeRole!=="ADMIN"){
        throw new AccessError("Active Admin authority is required for this decision's conditions.",403);
      }
      const version=(await client.query<{status:string}>(
        "select status from agreement_versions where id=$1 and matter_id=$2 for share",
        [current.agreement_version_id,matterId]
      )).rows[0];
      if(!version||!new Set(["WORKING","APPROVED"]).has(version.status)){
        throw new AccessError("The bound agreement version is no longer available for condition resolution.",409);
      }
      const updated=(await client.query<{id:string;condition_status:string;resolved_at:string}>(`
        update decision_conditions
           set condition_status=$3,evidence=$4,resolved_by=$5,resolved_at=now()
         where id=$1 and matter_id=$2
         returning id,condition_status,resolved_at`,
        [id,matterId,status,evidence,principal.userId]
      )).rows[0];
      await client.query(`
        insert into audit_events(
          actor_user_id,actor_name,action,matter_id,entity_type,entity_id,metadata
        ) values($1,$2,'DECISION_CONDITION_RESOLVED',$3,'decision_condition',$4,$5::jsonb)`,
        [principal.userId,principal.name,matterId,id,JSON.stringify({
          agreementVersionId:current.agreement_version_id,decisionId:current.decision_id,
          from:"PENDING",to:status,evidenceRecorded:true
        })]
      );
      return updated;
    });
    if(!resolved)return Response.json({ok:false,error:"Condition state changed; reload and retry."},{status:409});
    return Response.json({ok:true,condition:resolved});
  }catch(error){
    const access=accessErrorResponse(error);if(access)return access;
    return internalErrorResponse(error,"The decision condition could not be resolved.");
  }
}
