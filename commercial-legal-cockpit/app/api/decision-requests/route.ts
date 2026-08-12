import { accessErrorResponse, requireMatterAccess } from "@/lib/access";
import { databaseConfigured, withTransaction } from "@/lib/db";
import { DECISION_TYPES, requiredDecisionRole } from "@/lib/decisionPolicy";
import { enforceRateLimit, rateLimitResponse } from "@/lib/rateLimit";
import { internalErrorResponse } from "@/lib/safeErrors";

const UUID_PATTERN=/^[0-9a-f]{8}-(?:[0-9a-f]{4}-){3}[0-9a-f]{12}$/i;

class DecisionRequestError extends Error {
  constructor(message:string,public status=409){super(message);}
}

export async function POST(request:Request){
  try{
    if(!databaseConfigured())return Response.json({ok:false,error:"Decision requests require DATABASE_URL."},{status:503});
    const body=await request.json() as {
      matterId?:string;
      agreementVersionId?:string;
      findingId?:string|null;
      decisionType?:string;
      rationale?:string;
      conditions?:string|string[]|null;
      requiredApproverRole?:string;
    };
    const matterId=body.matterId?.trim();
    const agreementVersionId=body.agreementVersionId?.trim();
    const decisionType=body.decisionType?.trim().toUpperCase();
    const rationale=body.rationale?.trim();
    const requestedRole=(body.requiredApproverRole||"APPROVER").toUpperCase();
    if(!matterId||!agreementVersionId||!decisionType||!rationale){
      return Response.json({ok:false,error:"matterId, agreementVersionId, decisionType and rationale are required."},{status:400});
    }
    if(!UUID_PATTERN.test(agreementVersionId))return Response.json({ok:false,error:"agreementVersionId must be a valid UUID."},{status:400});
    if(!DECISION_TYPES.has(decisionType))return Response.json({ok:false,error:"decisionType is not supported."},{status:400});
    if(rationale.length<10||rationale.length>4000)return Response.json({ok:false,error:"Decision rationale must be between 10 and 4000 characters."},{status:400});
    const principal=await requireMatterAccess(request,matterId,true);
    if(principal.demo)return Response.json({ok:false,error:"Persisted decision requests are disabled in demo mode."},{status:503});
    await enforceRateLimit(principal,"decision-request",120,3600);
    const findingId=body.findingId?.trim()||null;
    if((decisionType==="ACCEPT"||decisionType==="APPROVE_EXCEPTION")&&!findingId){
      return Response.json({ok:false,error:`${decisionType} requires a linked, human-validated finding.`},{status:400});
    }
    if(findingId&&!UUID_PATTERN.test(findingId))return Response.json({ok:false,error:"findingId must be a valid UUID."},{status:400});
    const rawConditions=Array.isArray(body.conditions)?body.conditions:String(body.conditions??"").split(/\r?\n/);
    const conditions=rawConditions.map(value=>String(value).trim()).filter(Boolean);
    if(conditions.join("\n").length>4000||conditions.some(value=>value.length>1000)){
      return Response.json({ok:false,error:"Decision conditions cannot exceed 1000 characters each or 4000 characters total."},{status:400});
    }

    const result=await withTransaction(async client=>{
      const version=(await client.query<{status:string;evidence_protocol_version:number;authoritative_economics_run_id:string|null}>(
        "select status,evidence_protocol_version,authoritative_economics_run_id from agreement_versions where id=$1 and matter_id=$2 for share",
        [agreementVersionId,matterId]
      )).rows[0];
      if(!version||!new Set(["WORKING","APPROVED"]).has(version.status)){
        throw new DecisionRequestError("Decision requests must be bound to an available WORKING or APPROVED agreement version.");
      }
      if(version.status==="APPROVED"&&(version.evidence_protocol_version<1||!version.authoritative_economics_run_id)){
        throw new DecisionRequestError("Legacy package-lock versions cannot receive governed decision requests; create and lock a protocol-1 version with explicitly selected authoritative economics.");
      }

      let approvalRequired:string|null=null;
      if(findingId){
        const finding=(await client.query<{id:string;approval_required:string|null}>(`
          select f.id,f.approval_required
            from findings f
            join agreement_version_documents avd
              on avd.document_id=f.document_id and avd.agreement_version_id=$3
           where f.id=$1 and f.matter_id=$2 and f.review_status='VALIDATED'
             and f.analysis_run_id=(
               select ar.id from analysis_runs ar
                where ar.matter_id=$2 and ar.document_id=f.document_id
                  and ar.run_type='CLAUSE_RISK' and ar.status='SUCCEEDED'
                order by ar.started_at desc,ar.id desc limit 1
             )
           for share of f`,
          [findingId,matterId,agreementVersionId]
        )).rows[0];
        if(!finding){
          throw new DecisionRequestError("A linked finding must be lawyer-validated, current to the latest successful analysis, and included in the selected agreement version.");
        }
        approvalRequired=finding.approval_required;
      }

      let requiredApproverRole:"APPROVER"|"ADMIN";
      try{
        requiredApproverRole=requiredDecisionRole({decisionType,approvalRequired,requestedRole});
      }catch{
        throw new DecisionRequestError("Invalid approval role.",400);
      }
      const inserted=(await client.query<{id:string}>(`
        insert into decisions(
          matter_id,agreement_version_id,finding_id,decision_type,rationale,
          decision_status,required_approver_role,requested_by,evidence_protocol_version
        ) values($1,$2,$3,$4,$5,'PENDING',$6,$7,1)
        returning id`,
        [matterId,agreementVersionId,findingId,decisionType,rationale,requiredApproverRole,principal.userId]
      )).rows[0];
      for(let index=0;index<conditions.length;index++){
        await client.query(`
          insert into decision_conditions(
            matter_id,agreement_version_id,decision_id,sequence_number,condition_text,created_by
          ) values($1,$2,$3,$4,$5,$6)`,
          [matterId,agreementVersionId,inserted.id,index+1,conditions[index],principal.userId]
        );
      }
      await client.query(`
        insert into audit_events(
          actor_user_id,actor_name,action,matter_id,entity_type,entity_id,metadata
        ) values($1,$2,'DECISION_RECORDED',$3,'decision_request',$4,$5::jsonb)`,
        [principal.userId,principal.name,matterId,inserted.id,JSON.stringify({
          agreementVersionId,decisionType,requiredApproverRole,findingId,
          conditionCount:conditions.length,status:"PENDING",evidenceProtocolVersion:1
        })]
      );
      return {id:inserted.id,requiredApproverRole};
    });
    return Response.json({
      ok:true,decisionId:result.id,agreementVersionId,status:"PENDING",
      requiredApproverRole:result.requiredApproverRole
    },{status:201});
  }catch(error){
    const rate=rateLimitResponse(error);if(rate)return rate;
    const access=accessErrorResponse(error);if(access)return access;
    if(error instanceof DecisionRequestError)return Response.json({ok:false,error:error.message},{status:error.status});
    return internalErrorResponse(error,"Decision request could not be created.");
  }
}
