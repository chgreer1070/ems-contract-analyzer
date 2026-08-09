import { AccessError, accessErrorResponse, requireResourceMatterAccess } from "@/lib/access";
import { databaseConfigured, withTransaction } from "@/lib/db";
import { ECONOMICS_FORMULA_VERSION } from "@/lib/economics";
import { internalErrorResponse } from "@/lib/safeErrors";

export async function PATCH(request:Request,context:{params:Promise<{id:string}>}){
  try{
    if(!databaseConfigured())return Response.json({ok:false,error:"Decision workflow requires DATABASE_URL."},{status:503});
    const {id}=await context.params;
    const {principal,matterId}=await requireResourceMatterAccess(request,"DECISION",id,"APPROVE");
    const body=await request.json() as {status?:string;conditions?:string|string[]|null;dispositionNote?:string};
    const status=String(body.status??"").toUpperCase();
    if(!new Set(["APPROVED","REJECTED"]).has(status)){
      return Response.json({ok:false,error:"Status must be APPROVED or REJECTED."},{status:400});
    }
    const dispositionNote=String(body.dispositionNote??"").trim();
    if(dispositionNote.length<12||dispositionNote.length>4000){
      return Response.json({ok:false,error:"A substantive disposition note between 12 and 4000 characters is required."},{status:400});
    }
    const rawConditions=Array.isArray(body.conditions)?body.conditions:String(body.conditions??"").split(/\r?\n/);
    const conditions=rawConditions.map(value=>String(value).trim()).filter(Boolean);
    if(status==="REJECTED"&&conditions.length){
      return Response.json({ok:false,error:"Conditions can be added only to an approved decision."},{status:400});
    }
    if(conditions.join("\n").length>4000||conditions.some(value=>value.length>1000)){
      return Response.json({ok:false,error:"Decision conditions cannot exceed 1000 characters each or 4000 characters total."},{status:400});
    }

    const result=await withTransaction(async client=>{
      const activeRole=(await client.query<{role:string}>(
        "select role from app_user_roles where user_id=$1 and active=true for share",
        [principal.userId]
      )).rows[0]?.role;
      if(activeRole!=="APPROVER"&&activeRole!=="ADMIN"){
        throw new AccessError("Active Approver authority is required at disposition time.",403);
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
        decision_status:string;
        required_approver_role:string;
        requested_by:string;
        agreement_version_id:string|null;
      }>(`
        select decision_status,required_approver_role,requested_by,agreement_version_id
          from decisions where id=$1 and matter_id=$2 for update`,
        [id,matterId]
      )).rows[0];
      if(!current||current.decision_status!=="PENDING")return null;
      if(!current.agreement_version_id){
        throw new AccessError("Legacy unbound decisions cannot authorize an agreement version; create a new version-scoped request.",409);
      }
      const version=(await client.query<{
        status:string;
        authoritative_economics_run_id:string|null;
        evidence_protocol_version:number;
      }>(
        "select status,authoritative_economics_run_id,evidence_protocol_version from agreement_versions where id=$1 and matter_id=$2 for share",
        [current.agreement_version_id,matterId]
      )).rows[0];
      if(!version||!new Set(["WORKING","APPROVED"]).has(version.status)){
        throw new AccessError("The bound agreement version is no longer available for disposition.",409);
      }
      if(status==="APPROVED"&&(version.status!=="APPROVED"||version.evidence_protocol_version<1||!version.authoritative_economics_run_id)){
        throw new AccessError("Approval requires a protocol-1 locked agreement version with explicitly selected authoritative economics.",409);
      }
      const economicsRun=(await client.query<{id:string}>(`
        select id
          from economics_runs
         where id=$4::uuid and matter_id=$1 and agreement_version_id=$2
           and formula_version=$3 and review_status='VALIDATED'
         for share`,
        [matterId,current.agreement_version_id,ECONOMICS_FORMULA_VERSION,version.authoritative_economics_run_id]
      )).rows[0]??null;
      if(status==="APPROVED"&&!economicsRun){
        throw new AccessError("Approval requires the exact authoritative economics selection to remain validated and on the current formula.",409);
      }
      const requiredApproverRole=current.required_approver_role;
      if(requiredApproverRole!=="APPROVER"&&requiredApproverRole!=="ADMIN"){
        throw new AccessError("Decision approval authority is invalid; correct the request before disposition.",409);
      }
      if(requiredApproverRole==="ADMIN"&&activeRole!=="ADMIN"){
        throw new AccessError("Active Admin authority is required for this decision.",403);
      }
      if(current.requested_by===principal.userId){
        throw new AccessError("The requester cannot disposition their own decision request.",409);
      }

      if(status==="APPROVED"&&conditions.length){
        const start=(await client.query<{next_sequence:number}>(`
          select coalesce(max(sequence_number),0)::int+1 next_sequence
            from decision_conditions where decision_id=$1`,[id]
        )).rows[0].next_sequence;
        for(let index=0;index<conditions.length;index++){
          await client.query(`
            insert into decision_conditions(
              matter_id,agreement_version_id,decision_id,sequence_number,condition_text,created_by
            ) values($1,$2,$3,$4,$5,$6)`,
            [matterId,current.agreement_version_id,id,start+index,conditions[index],principal.userId]
          );
        }
      }
      const updated=(await client.query<{id:string;decision_status:string;decided_at:string;disposition_note:string;economics_run_id:string|null;evidence_protocol_version:number}>(`
        update decisions
           set decision_status=$3,decided_by=$4,decided_at=now(),disposition_note=$5,
               economics_run_id=$6,evidence_protocol_version=1
         where id=$1 and matter_id=$2
         returning id,decision_status,decided_at,disposition_note,economics_run_id,evidence_protocol_version`,
        [id,matterId,status,principal.userId,dispositionNote,economicsRun?.id??null]
      )).rows[0];
      await client.query(`
        insert into audit_events(
          actor_user_id,actor_name,action,matter_id,entity_type,entity_id,metadata
        ) values($1,$2,'DECISION_RECORDED',$3,'decision',$4,$5::jsonb)`,
        [principal.userId,principal.name,matterId,id,JSON.stringify({
          agreementVersionId:current.agreement_version_id,from:"PENDING",to:status,
          addedConditionCount:conditions.length,requiredApproverRole,
          economicsRunId:updated.economics_run_id,dispositionNoteRecorded:true,
          evidenceProtocolVersion:updated.evidence_protocol_version
        })]
      );
      return {...updated,economicsRunId:updated.economics_run_id,evidenceProtocolVersion:updated.evidence_protocol_version};
    });
    if(!result)return Response.json({ok:false,error:"Decision state changed; reload and retry."},{status:409});
    return Response.json({ok:true,decision:result});
  }catch(error){
    const access=accessErrorResponse(error);if(access)return access;
    return internalErrorResponse(error,"The decision could not be completed.");
  }
}
