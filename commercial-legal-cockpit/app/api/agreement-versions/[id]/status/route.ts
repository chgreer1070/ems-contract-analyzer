import { AccessError, accessErrorResponse, requireResourceMatterAccess } from "@/lib/access";
import { createHash } from "node:crypto";
import { databaseConfigured, withTransaction } from "@/lib/db";
import { assertLegalRelianceReady } from "@/lib/readiness";
import { canonicalStateHash } from "@/lib/stateHash";
import { currentEngineManifest } from "@/lib/engineManifest";
import { internalErrorResponse } from "@/lib/safeErrors";

const TRANSITIONS:Record<string,Set<string>>={
  WORKING:new Set(["APPROVED"]),
  APPROVED:new Set(["EXECUTED","SUPERSEDED"]),
  EXECUTED:new Set(["SUPERSEDED"]),
  SUPERSEDED:new Set()
};
const UUID_PATTERN=/^[0-9a-f]{8}-(?:[0-9a-f]{4}-){3}[0-9a-f]{12}$/i;

class VersionStateError extends Error{
  constructor(message:string,public status=409){super(message);}
}

export async function POST(request:Request,context:{params:Promise<{id:string}>}){
  try{
    if(!databaseConfigured())return Response.json({ok:false,error:"Agreement version status requires DATABASE_URL."},{status:503});
    const {id}=await context.params;
    const body=await request.json() as {status?:string;authoritativeEconomicsRunId?:string|null};
    const nextStatus=String(body.status??"").toUpperCase();
    if(!new Set(["APPROVED","EXECUTED","SUPERSEDED"]).has(nextStatus)){
      return Response.json({ok:false,error:"status must be APPROVED, EXECUTED, or SUPERSEDED."},{status:400});
    }
    const requestedAuthoritativeEconomicsRunId=String(body.authoritativeEconomicsRunId??"").trim()||null;
    if(nextStatus==="APPROVED"&&!requestedAuthoritativeEconomicsRunId){
      return Response.json({ok:false,error:"authoritativeEconomicsRunId is required when locking an agreement version."},{status:400});
    }
    if(requestedAuthoritativeEconomicsRunId&&!UUID_PATTERN.test(requestedAuthoritativeEconomicsRunId)){
      return Response.json({ok:false,error:"authoritativeEconomicsRunId must be a valid UUID."},{status:400});
    }
    if(nextStatus!=="APPROVED"&&requestedAuthoritativeEconomicsRunId){
      return Response.json({ok:false,error:"authoritativeEconomicsRunId may be selected only during the WORKING to APPROVED transition."},{status:400});
    }
    const {principal,matterId}=await requireResourceMatterAccess(request,"AGREEMENT_VERSION",id,"APPROVE");
    if(nextStatus==="APPROVED"||nextStatus==="EXECUTED")await assertLegalRelianceReady({requireEnabled:true});

    const result=await withTransaction(async client=>{
      const activeRole=(await client.query<{role:string}>(
        "select role from app_user_roles where user_id=$1 and active=true for share",
        [principal.userId]
      )).rows[0]?.role;
      if(activeRole!=="APPROVER"&&activeRole!=="ADMIN"){
        throw new AccessError("Active Approver authority is required at agreement-version disposition time.",403);
      }
      const matter=(await client.query<{owner_user_id:string;member_access:string|null}>(`
        select m.owner_user_id,
               (select mm.access_level from matter_members mm
                 where mm.matter_id=m.id and mm.user_id=$2 for share) member_access
          from matters m where m.id=$1 for update`,
        [matterId,principal.userId]
      )).rows[0];
      if(!matter)throw new AccessError("Resource not found or access denied.",404);
      if(activeRole!=="ADMIN"&&matter.owner_user_id!==principal.userId&&matter.member_access!=="APPROVE"){
        throw new AccessError("Resource not found or access denied.",404);
      }

      const current=(await client.query<{
        matter_id:string;status:string;authoritative_economics_run_id:string|null;
        authoritative_economics_selected_by:string|null;authoritative_economics_selected_at:string|null;
        evidence_protocol_version:number;
      }>(
        "select matter_id,status,authoritative_economics_run_id,authoritative_economics_selected_by,authoritative_economics_selected_at,evidence_protocol_version from agreement_versions where id=$1 and matter_id=$2 for update",
        [id,matterId]
      )).rows[0];
      if(!current)throw new VersionStateError("Agreement version is no longer available.",404);
      if(!TRANSITIONS[current.status]?.has(nextStatus)){
        throw new VersionStateError(`Agreement version cannot transition from ${current.status} to ${nextStatus}.`);
      }

      if(nextStatus==="APPROVED"||nextStatus==="EXECUTED"){
        const sources=(await client.query<{
          document_count:number;
          invalid_count:number;
          executed_count:number;
        }>(`
          select count(*)::int document_count,
                 count(*) filter(where d.deletion_status<>'ACTIVE'
                   or d.security_scan_status<>'CLEAN'
                   or d.integrity_status<>'SERVER_VERIFIED'
                   or d.extraction_status<>'EXTRACTED'
                   or d.sha256 is null or d.server_sha256 is null
                   or lower(d.sha256)<>lower(d.server_sha256))::int invalid_count,
                 count(*) filter(where d.source_status='EXECUTED')::int executed_count
            from agreement_version_documents avd
            join documents d on d.id=avd.document_id
           where avd.agreement_version_id=$1`,
          [id]
        )).rows[0];
        if(!sources?.document_count)throw new VersionStateError("An agreement version must contain at least one source document.");
        if(sources.invalid_count)throw new VersionStateError(`${sources.invalid_count} source document(s) are not clean, extracted, hash-verified, and active.`);
        if(nextStatus==="EXECUTED"&&!sources.executed_count){
          throw new VersionStateError("Execution requires at least one included source document whose source status is EXECUTED.");
        }
      }

      if(nextStatus==="APPROVED"){
        const competing=(await client.query<{id:string}>(
          "select id from agreement_versions where matter_id=$1 and id<>$2 and status='APPROVED' limit 1",
          [current.matter_id,id]
        )).rows[0];
        if(competing){
          throw new VersionStateError("Only one successor may be APPROVED at a time; supersede the other approved successor first.");
        }
        const formulaVersion=currentEngineManifest().economicsFormulaVersion;
        const authoritativeEconomics=(await client.query<{id:string}>(`
          select id from economics_runs
           where id=$1::uuid and matter_id=$2 and agreement_version_id=$3
             and formula_version=$4 and review_status='VALIDATED'
           for share`,
          [requestedAuthoritativeEconomicsRunId,current.matter_id,id,formulaVersion]
        )).rows[0];
        if(!authoritativeEconomics){
          throw new VersionStateError("The explicitly selected authoritative economics run must be validated, current-formula, and bound to this exact agreement version.");
        }
      }

      let supersededExecutedVersionIds:string[]=[];
      if(nextStatus==="EXECUTED"){
        const engine=currentEngineManifest();
        const versionDocuments=(await client.query<any>(`select d.id,d.filename,d.document_type,d.sha256,d.uploaded_at from agreement_version_documents avd join documents d on d.id=avd.document_id where avd.agreement_version_id=$1 and d.matter_id=$2 order by d.uploaded_at,d.id`,[id,current.matter_id])).rows;
        const documentIds=versionDocuments.map((document:any)=>String(document.id)).sort();
        const runs=(await client.query<any>(`select distinct on(document_id,run_type) id,document_id,run_type,status,model_name,prompt_version,schema_version,input_sha256,source_chunk_count,output_count,rejected_ungrounded_count from analysis_runs where matter_id=$1 and document_id=any($2::uuid[]) and run_type in ('CLAUSE_RISK','TERM_EXTRACTION') order by document_id,run_type,started_at desc,id desc`,[current.matter_id,documentIds])).rows;
        if(runs.length!==documentIds.length*2)throw new VersionStateError("Every agreement source requires current clause-risk and term-extraction runs before execution.");
        for(const documentId of documentIds){
          const chunks=(await client.query<{content_sha256:string}>("select content_sha256 from document_chunks where document_id=$1 order by coalesce(page_number,0),chunk_index,id",[documentId])).rows;
          const inputHash=createHash("sha256").update(chunks.map(chunk=>chunk.content_sha256.toLowerCase()).join(":"),"utf8").digest("hex");
          for(const runType of ["CLAUSE_RISK","TERM_EXTRACTION"]){const run=runs.find((candidate:any)=>candidate.document_id===documentId&&candidate.run_type===runType);const expected=runType==="CLAUSE_RISK"?engine.clauseRisk:engine.termExtraction;if(!run||run.status!=="SUCCEEDED"||run.model_name!==engine.modelName||run.prompt_version!==expected.promptVersion||run.schema_version!==expected.schemaVersion||run.input_sha256.toLowerCase()!==inputHash||Number(run.source_chunk_count)!==chunks.length||Number(run.rejected_ungrounded_count)!==0)throw new VersionStateError(`The current ${runType.toLowerCase().replaceAll("_"," ")} run is stale, unsuccessful, or outside the approved engine manifest.`);}
        }
        const runIds=runs.map((run:any)=>String(run.id));
        const attestedRunCount=(await client.query<{count:number}>("select count(*)::int count from analysis_review_attestations where matter_id=$1 and analysis_run_id=any($2::uuid[])",[current.matter_id,runIds])).rows[0]?.count??0;
        if(attestedRunCount!==runIds.length)throw new VersionStateError(`${runIds.length-attestedRunCount} current document-analysis run(s) lack immutable counsel-completion attestations.`);
        const termRunIds=runs.filter((run:any)=>run.run_type==="TERM_EXTRACTION").map((run:any)=>String(run.id)).sort();
        const dependencyTerms=(await client.query<any>(`select t.id,t.analysis_run_id,t.clause_family,t.term_type,t.normalized_statement,t.trigger_event from contract_terms t where t.matter_id=$1 and t.document_id=any($2::uuid[]) and t.analysis_run_id=any($3::uuid[]) and t.review_status<>'SUPERSEDED' order by t.created_at,t.id limit 251`,[current.matter_id,documentIds,termRunIds])).rows;
        if(dependencyTerms.length>250)throw new VersionStateError("Dependency evidence exceeds the governed 250-term execution limit.");
        const dependencyHash=canonicalStateHash({sourceDocumentIds:documentIds,sourceRunIds:termRunIds,terms:dependencyTerms});
        const dependencyReceipt=(await client.query<{id:string}>(`select pj.id from processing_jobs pj join analysis_review_attestations ara on ara.processing_job_id=pj.id and ara.scope_type='DEPENDENCY' where pj.matter_id=$1 and pj.job_type='DEPENDENCY' and pj.status='SUCCEEDED' and pj.input->>'agreementVersionId'=$2 and pj.input->>'graphVersion'=$3 and pj.output->'sourceDocumentIds'=$4::jsonb and pj.output->'sourceRunIds'=$5::jsonb and pj.output->>'modelName'=$6 and pj.output->>'promptVersion'=$7 and pj.output->>'schemaVersion'=$8 and pj.output->>'inputHash'=$9 and pj.output->>'rejectedCandidateCount'='0' order by pj.finished_at desc,pj.id desc limit 1`,[current.matter_id,id,engine.agreementGraphVersion,JSON.stringify(documentIds),JSON.stringify(termRunIds),engine.modelName,engine.dependency.promptVersion,engine.dependency.schemaVersion,dependencyHash])).rows[0];
        if(!dependencyReceipt)throw new VersionStateError("Execution requires an exact, rejection-free, counsel-attested dependency receipt for this agreement version.");
        const precedenceInputs=[] as Array<{id:string;filename:string;documentType:string;sourceChunks:Array<{id:string;content_sha256:string}>;sha256:string}>;
        for(const document of versionDocuments){const chunks=(await client.query<{id:string;content_sha256:string}>(`select id,content_sha256 from document_chunks where document_id=$1 order by case when content ~* '(preced|conflict|amend|supersed|control|incorporat|govern|order of precedence)' then 0 else 1 end,coalesce(page_number,0),chunk_index,id limit 12`,[document.id])).rows;precedenceInputs.push({id:document.id,filename:document.filename,documentType:document.document_type,sourceChunks:chunks,sha256:String(document.sha256).toLowerCase()});}
        const precedenceHash=canonicalStateHash(precedenceInputs);
        const precedenceReceipt=(await client.query<{id:string}>(`select pj.id from processing_jobs pj join analysis_review_attestations ara on ara.processing_job_id=pj.id and ara.scope_type='PRECEDENCE' where pj.matter_id=$1 and pj.job_type='PRECEDENCE' and pj.status='SUCCEEDED' and pj.input->>'agreementVersionId'=$2 and pj.input->>'graphVersion'=$3 and pj.output->'sourceDocumentIds'=$4::jsonb and pj.output->>'modelName'=$5 and pj.output->>'promptVersion'=$6 and pj.output->>'schemaVersion'=$7 and pj.output->>'inputHash'=$8 and pj.output->>'rejectedCandidateCount'='0' order by pj.finished_at desc,pj.id desc limit 1`,[current.matter_id,id,engine.agreementGraphVersion,JSON.stringify(documentIds),engine.modelName,engine.precedence.promptVersion,engine.precedence.schemaVersion,precedenceHash])).rows[0];
        if(!precedenceReceipt)throw new VersionStateError("Execution requires an exact, rejection-free, counsel-attested precedence receipt for this agreement version.");
        if(current.evidence_protocol_version<1||!current.authoritative_economics_run_id){
          throw new VersionStateError("Execution requires a protocol-1 locked agreement version with explicitly selected authoritative economics.");
        }
        const validatedEconomics=(await client.query<{id:string}>(`
          select id from economics_runs
           where id=$4::uuid and matter_id=$2 and agreement_version_id=$1
             and formula_version=$3 and review_status='VALIDATED'`,
          [id,current.matter_id,engine.economicsFormulaVersion,current.authoritative_economics_run_id]
        )).rows[0];
        if(!validatedEconomics){
          throw new VersionStateError("The agreement version's authoritative economics selection is no longer valid for the current formula.");
        }

        const pendingDecisions=(await client.query<{count:number}>(`
          select count(*)::int count from decisions
           where agreement_version_id=$1 and decision_status='PENDING'`,[id]
        )).rows[0]?.count??0;
        if(pendingDecisions){
          throw new VersionStateError(`${pendingDecisions} pending decision(s) for this agreement version must be resolved before execution.`);
        }
        const blockingDispositions=(await client.query<{count:number}>(`
          select count(*)::int count from decisions
           where agreement_version_id=$1 and decision_status='APPROVED'
             and evidence_protocol_version>=1 and economics_run_id=$2::uuid
             and decision_type in ('NEGOTIATE','ESCALATE','REJECT')
             and char_length(btrim(coalesce(disposition_note,''))) between 12 and 4000`,
          [id,validatedEconomics.id]
        )).rows[0]?.count??0;
        if(blockingDispositions){
          throw new VersionStateError(`${blockingDispositions} effective NEGOTIATE, ESCALATE, or REJECT disposition(s) block execution.`);
        }
        const pendingConditions=(await client.query<{count:number}>(`
          select count(*)::int count
            from decision_conditions dc
            join decisions d on d.id=dc.decision_id
           where d.agreement_version_id=$1 and d.decision_status='APPROVED'
             and d.evidence_protocol_version>=1
             and d.economics_run_id=$2::uuid
             and char_length(btrim(coalesce(d.disposition_note,''))) between 12 and 4000
             and dc.condition_status='PENDING'`,[id,validatedEconomics.id]
        )).rows[0]?.count??0;
        if(pendingConditions){
          throw new VersionStateError(`${pendingConditions} approved-decision condition(s) must be satisfied or waived before execution.`);
        }

        const authority=(await client.query<{
          current_unreviewed_count:number;
          required_count:number;
          unauthorized_count:number;
        }>(`
          with latest_runs as (
            select distinct on (ar.document_id) ar.id,ar.document_id
              from analysis_runs ar
              join agreement_version_documents avd on avd.document_id=ar.document_id
             where avd.agreement_version_id=$1 and ar.matter_id=$2
               and ar.run_type='CLAUSE_RISK' and ar.status='SUCCEEDED'
             order by ar.document_id,ar.started_at desc,ar.id desc
          ), current_findings as (
            select f.id,f.review_status,f.approval_required
              from latest_runs lr join findings f on f.analysis_run_id=lr.id
          ), required_findings as (
            select id from current_findings
             where review_status='VALIDATED'
               and nullif(btrim(approval_required),'') is not null
          ), authorized_findings as (
            select distinct d.finding_id
              from decisions d
             where d.agreement_version_id=$1 and d.finding_id is not null
                and d.decision_status='APPROVED'
                and d.evidence_protocol_version>=1
                and d.decision_type in ('ACCEPT','APPROVE_EXCEPTION')
                and d.economics_run_id=$3::uuid
                and char_length(btrim(coalesce(d.disposition_note,''))) between 12 and 4000
          )
          select (select count(*)::int from current_findings where review_status='UNREVIEWED') current_unreviewed_count,
                 count(*)::int required_count,
                 count(*) filter(where a.finding_id is null)::int unauthorized_count
            from required_findings r
            left join authorized_findings a on a.finding_id=r.id`,
          [id,current.matter_id,validatedEconomics.id]
        )).rows[0];
        if(authority?.current_unreviewed_count){
          throw new VersionStateError(`${authority.current_unreviewed_count} current finding(s) still require a human disposition before execution.`);
        }
        if(authority?.unauthorized_count){
          throw new VersionStateError(`${authority.unauthorized_count} current approval-required finding(s) lack an approved, version-scoped ACCEPT or APPROVE_EXCEPTION decision.`);
        }

        const superseded=await client.query<{id:string}>(`
          update agreement_versions set status='SUPERSEDED'
           where matter_id=$1 and id<>$2 and status='EXECUTED'
           returning id`,[current.matter_id,id]
        );
        supersededExecutedVersionIds=superseded.rows.map(row=>row.id);
        for(const prior of superseded.rows){
          await client.query(`
            insert into audit_events(
              actor_user_id,actor_name,action,matter_id,entity_type,entity_id,metadata
            ) values($1,$2,'AGREEMENT_VERSION_STATUS_CHANGED',$3,'agreement_version_status',$4,$5::jsonb)`,
            [principal.userId,principal.name,current.matter_id,prior.id,JSON.stringify({
              from:"EXECUTED",to:"SUPERSEDED",supersededByAgreementVersionId:id
            })]
          );
        }
      }

      const updated=(await client.query<{
        id:string;status:string;authoritative_economics_run_id:string|null;
        authoritative_economics_selected_by:string|null;authoritative_economics_selected_at:string|null;
        evidence_protocol_version:number;
      }>(`
        update agreement_versions
           set status=$3,
               authoritative_economics_run_id=case when $3='APPROVED' then $4::uuid else authoritative_economics_run_id end,
               authoritative_economics_selected_by=case when $3='APPROVED' then $5 else authoritative_economics_selected_by end,
               authoritative_economics_selected_at=case when $3='APPROVED' then clock_timestamp() else authoritative_economics_selected_at end,
               evidence_protocol_version=case when $3='APPROVED' then 1 else evidence_protocol_version end
         where id=$1 and matter_id=$2
         returning id,status,authoritative_economics_run_id,authoritative_economics_selected_by,authoritative_economics_selected_at,evidence_protocol_version`,
        [id,matterId,nextStatus,requestedAuthoritativeEconomicsRunId,principal.userId]
      )).rows[0];
      await client.query(`
        insert into audit_events(
          actor_user_id,actor_name,action,matter_id,entity_type,entity_id,metadata
        ) values($1,$2,'AGREEMENT_VERSION_STATUS_CHANGED',$3,'agreement_version_status',$4,$5::jsonb)`,
        [principal.userId,principal.name,current.matter_id,id,JSON.stringify({
          from:current.status,to:nextStatus,supersededExecutedVersionIds,
          authoritativeEconomicsRunId:updated.authoritative_economics_run_id,
          authoritativeEconomicsSelectedBy:updated.authoritative_economics_selected_by,
          authoritativeEconomicsSelectedAt:updated.authoritative_economics_selected_at,
          evidenceProtocolVersion:updated.evidence_protocol_version
        })]
      );
      return updated;
    });
    return Response.json({ok:true,...result});
  }catch(error){
    const access=accessErrorResponse(error);if(access)return access;
    if(error instanceof VersionStateError)return Response.json({ok:false,error:error.message},{status:error.status});
    return internalErrorResponse(error,"Agreement version status could not be changed.");
  }
}
