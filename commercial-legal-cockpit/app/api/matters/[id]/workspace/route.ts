import { accessErrorResponse, requireMatterAccess } from "@/lib/access";
import { databaseConfigured, query } from "@/lib/db";
import { ECONOMICS_FORMULA_VERSION } from "@/lib/economics";
import { internalErrorResponse, safePersistedFailureForDisplay } from "@/lib/safeErrors";

function recordValue(value:unknown):Record<string,unknown>{if(value&&typeof value==="object"&&!Array.isArray(value))return value as Record<string,unknown>;if(typeof value==="string")try{const parsed=JSON.parse(value);if(parsed&&typeof parsed==="object"&&!Array.isArray(parsed))return parsed;}catch{}return {};}

const ROLE_RANK:Record<string,number>={VIEWER:10,LAWYER:20,APPROVER:30,ADMIN:40};
const ACCESS_RANK:Record<string,number>={VIEW:10,EDIT:20,APPROVE:30};

export async function GET(request:Request,context:{params:Promise<{id:string}>}){
  try{
    if(!databaseConfigured())return Response.json({ok:false,error:"Matter workspace requires DATABASE_URL."},{status:503});
    const {id}=await context.params;const principal=await requireMatterAccess(request,id,false);
    if(principal.demo)return Response.json({ok:false,error:"Persistent matter workspace is disabled in demo mode."},{status:503});
    const requestedSnapshotId=new URL(request.url).searchParams.get("snapshot");
    if(requestedSnapshotId&&!/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(requestedSnapshotId))return Response.json({ok:false,error:"snapshot must be a valid UUID."},{status:400});
    const [matter,documents,terms,dependencies,relations,versions,findings,economics,decisions,snapshots,jobs,audit,holds,purges,analysisRuns,attestations,capabilities]=await Promise.all([
      query<any>(`select m.id,m.matter_number,c.name customer,m.agreement_title,m.region,m.annual_revenue,m.stage,m.risk_level,m.next_action,m.owner_user_id,m.restricted,m.status,m.confidentiality_level,m.privilege_status,m.legal_hold,m.legal_hold_reason,m.retention_category,m.retention_until,m.created_at,m.updated_at,(select mm.access_level from matter_members mm where mm.matter_id=m.id and mm.user_id=$2 limit 1) member_access from matters m join customers c on c.id=m.customer_id where m.id=$1 limit 1`,[id,principal.userId]),
      query<any>(`select id,filename,document_type,version_label,mime_type,size_bytes,integrity_status,extraction_status,extraction_method,page_count,source_status,sha256,server_sha256,security_scan_status,security_scanned_at,legal_hold,retention_until,deletion_status,purged_at,uploaded_at from documents where matter_id=$1 order by uploaded_at desc`,[id]),
      query<any>(`select t.id,t.document_id,t.analysis_run_id,d.filename,t.clause_family,t.section_label,t.term_type,t.party,t.counterparty,t.normalized_statement,t.trigger_event,t.operational_owner,t.confidence,t.review_status,t.review_note,t.exact_text,dc.page_number,dc.chunk_index from contract_terms t join documents d on d.id=t.document_id left join document_chunks dc on dc.id=t.chunk_id where t.matter_id=$1 and t.review_status<>'SUPERSEDED' order by d.uploaded_at,coalesce(dc.page_number,0),dc.chunk_index,t.created_at`,[id]),
      query<any>(`select id,processing_job_id,origin,source_term_id,target_term_id,dependency_type,rationale,confidence,review_status,review_note from term_dependencies where matter_id=$1 and review_status<>'SUPERSEDED' order by created_at`,[id]),
      query<any>(`select r.id,r.processing_job_id,r.origin,r.source_document_id,sd.filename source_document,r.target_document_id,td.filename target_document,r.relation_type,r.source_locator,r.rationale,r.confidence,r.review_status,r.review_note from document_relations r join documents sd on sd.id=r.source_document_id join documents td on td.id=r.target_document_id where r.matter_id=$1 and r.review_status<>'SUPERSEDED' order by r.created_at`,[id]),
      query<any>(`select av.id,av.version_number,av.label,av.status,av.effective_date,av.created_at,av.authoritative_economics_run_id,av.authoritative_economics_selected_by,av.authoritative_economics_selected_at,av.evidence_protocol_version,json_agg(json_build_object('documentId',d.id,'filename',d.filename,'documentType',d.document_type,'displayOrder',avd.display_order) order by avd.display_order) filter(where d.id is not null) documents from agreement_versions av left join agreement_version_documents avd on avd.agreement_version_id=av.id left join documents d on d.id=avd.document_id where av.matter_id=$1 group by av.id order by av.version_number desc`,[id]),
      query<any>(`select id,document_id,analysis_run_id,clause_family,issue,risk_level,rationale,operational_consequence,source_excerpt,source_locator,primary_position,fallback_position,no_go_position,approval_required,financial_variables,uncertainty,review_status,model_name,prompt_version,standard_status,standard_version,created_at,reviewed_at,review_note from findings where matter_id=$1 and review_status<>'SUPERSEDED' order by case risk_level when 'Critical' then 4 when 'High' then 3 when 'Medium' then 2 else 1 end desc,created_at desc`,[id]),
      query<any>(`select er.id,er.agreement_version_id,av.version_number,av.label version_label,av.status version_status,(er.id=av.authoritative_economics_run_id) is_authoritative,er.inputs,er.outputs,er.formula_version,er.review_status,er.reviewed_by,er.reviewed_at,er.review_note,er.created_at from economics_runs er left join agreement_versions av on av.id=er.agreement_version_id where er.matter_id=$1 order by er.created_at desc limit 20`,[id]),
      query<any>(`select d.id,d.agreement_version_id,av.version_number,av.label version_label,av.status version_status,av.authoritative_economics_run_id,av.evidence_protocol_version version_evidence_protocol_version,d.finding_id,d.decision_type,d.rationale,d.conditions,d.decision_status,d.required_approver_role,d.economics_run_id,d.evidence_protocol_version,d.disposition_note,d.requested_by,requester.name requested_by_name,requester.email requested_by_email,d.decided_by,decider.name decided_by_name,decider.email decided_by_email,d.requested_at,d.decided_at,(select json_build_object('id',er.id,'agreement_version_id',er.agreement_version_id,'inputs',er.inputs,'outputs',er.outputs,'formula_version',er.formula_version,'review_status',er.review_status,'reviewed_by',er.reviewed_by,'reviewed_at',er.reviewed_at,'review_note',er.review_note,'created_at',er.created_at) from economics_runs er where er.id=case when d.decision_status='PENDING' then av.authoritative_economics_run_id else d.economics_run_id end and (d.decision_status<>'PENDING' or (av.status='APPROVED' and av.evidence_protocol_version>=1 and er.formula_version=$2 and er.review_status='VALIDATED')) limit 1) validated_economics,coalesce((select json_agg(json_build_object('id',dc.id,'sequence_number',dc.sequence_number,'condition_text',dc.condition_text,'condition_status',dc.condition_status,'evidence',dc.evidence,'created_by',dc.created_by,'created_at',dc.created_at,'resolved_by',dc.resolved_by,'resolved_at',dc.resolved_at) order by dc.sequence_number) from decision_conditions dc where dc.decision_id=d.id),'[]'::json) condition_records from decisions d left join agreement_versions av on av.id=d.agreement_version_id left join "user" requester on requester.id=d.requested_by left join "user" decider on decider.id=d.decided_by where d.matter_id=$1 order by d.requested_at desc`,[id,ECONOMICS_FORMULA_VERSION]),
      requestedSnapshotId?query<any>(`select es.id,es.agreement_version_id,av.evidence_protocol_version,av.authoritative_economics_run_id,es.processing_job_id,es.snapshot_version,es.matter_context,es.source_manifest->'relianceEvidence' reliance_evidence,es.top_risks,es.quantified_exposure,es.dependencies,es.negotiation_actions,es.executive_decisions,es.next_steps,es.source_state_hash,es.generated_at,(es.source_manifest_canonical is not null and es.source_manifest is not null and es.source_manifest=es.source_manifest_canonical::jsonb and lower(es.source_state_hash)=encode(digest(convert_to(es.source_manifest_canonical,'UTF8'),'sha256'),'hex')) frozen_integrity_verified,executive_snapshot_receipt_verified(es.id) receipt_integrity_verified from executive_snapshots es join agreement_versions av on av.id=es.agreement_version_id where es.matter_id=$1 and es.id=$2 limit 1`,[id,requestedSnapshotId]):query<any>(`select es.id,es.agreement_version_id,av.evidence_protocol_version,av.authoritative_economics_run_id,es.processing_job_id,es.snapshot_version,es.matter_context,es.source_manifest->'relianceEvidence' reliance_evidence,es.top_risks,es.quantified_exposure,es.dependencies,es.negotiation_actions,es.executive_decisions,es.next_steps,es.source_state_hash,es.generated_at,(es.source_manifest_canonical is not null and es.source_manifest is not null and es.source_manifest=es.source_manifest_canonical::jsonb and lower(es.source_state_hash)=encode(digest(convert_to(es.source_manifest_canonical,'UTF8'),'sha256'),'hex')) frozen_integrity_verified,executive_snapshot_receipt_verified(es.id) receipt_integrity_verified from executive_snapshots es join agreement_versions av on av.id=es.agreement_version_id where es.matter_id=$1 order by es.snapshot_version desc limit 20`,[id]),
      query<any>(`select id,document_id,job_type,status,attempts,max_attempts,error_message,input,output,created_at,started_at,finished_at from processing_jobs where matter_id=$1 order by created_at desc limit 100`,[id]),
      query<any>(`select id,event_time,actor_user_id,actor_name,action,entity_type,entity_id,metadata from audit_events where matter_id=$1 order by event_time desc limit 200`,[id]),
      query<any>(`select id,document_id,action,reason,actor_user_id,actor_name,event_time from legal_hold_events where matter_id=$1 order by event_time desc limit 100`,[id]),
      query<any>(`select pr.id,pr.document_id,d.filename,pr.requested_by,pr.requested_at,pr.reason,pr.status,pr.approved_by,pr.approved_at,pr.executed_by,pr.executed_at from purge_requests pr join documents d on d.id=pr.document_id where pr.matter_id=$1 order by pr.requested_at desc limit 100`,[id]),
      query<any>(`select ar.id,ar.document_id,d.filename,ar.run_type,ar.status,ar.model_name,ar.prompt_version,ar.schema_version,ar.input_sha256,ar.source_chunk_count,ar.output_count,ar.rejected_ungrounded_count,ar.started_at,ar.finished_at,(ar.id=(select latest.id from analysis_runs latest where latest.matter_id=ar.matter_id and latest.document_id=ar.document_id and latest.run_type=ar.run_type order by latest.started_at desc,latest.id desc limit 1)) is_current from analysis_runs ar join documents d on d.id=ar.document_id where ar.matter_id=$1 and ar.run_type in ('CLAUSE_RISK','TERM_EXTRACTION') order by ar.started_at desc,ar.id desc limit 100`,[id]),
      query<any>(`select id,scope_type,analysis_run_id,processing_job_id,input_sha256,output_count,disposition_counts,manifest_hash,attestation_note,attested_by,attested_at from analysis_review_attestations where matter_id=$1 order by attested_at desc,id desc limit 200`,[id]),
      query<any>(`select capability from app_user_capabilities where user_id=$1 and active=true order by capability`,[principal.userId])
    ]);
    if(!matter.rows[0])return Response.json({ok:false,error:"Matter not found."},{status:404});
    const matterState=matter.rows[0];
    const viewer=principal.role==="VIEWER";const recordsAdmin=principal.role==="APPROVER"||principal.role==="ADMIN";
    const roleRank=ROLE_RANK[principal.role]??0;const memberRank=ACCESS_RANK[String(matterState.member_access??"")]??0;
    const isAdmin=principal.role==="ADMIN";const isOwner=matterState.owner_user_id===principal.userId;
    const canEdit=roleRank>=ROLE_RANK.LAWYER&&(isAdmin||isOwner||memberRank>=ACCESS_RANK.EDIT||(!matterState.restricted&&roleRank>=ROLE_RANK.LAWYER));
    const canApprove=roleRank>=ROLE_RANK.APPROVER&&(isAdmin||isOwner||memberRank>=ACCESS_RANK.APPROVE);
    const attestationRoleEligible=["LAWYER","APPROVER","ADMIN"].includes(principal.role);
    const capabilityNames=capabilities.rows.map((row:any)=>String(row.capability)).filter((capability:string)=>attestationRoleEligible||capability!=="LEGAL_COUNSEL_ATTEST");
    const canAttest=canEdit&&capabilityNames.includes("LEGAL_COUNSEL_ATTEST");
    const permissions={
      canEdit,
      canRunPipeline:canEdit,
      canReviewLegal:canAttest,
      canRecordRelation:canAttest,
      canCreateVersion:canEdit,
      canRequestDecision:canEdit,
      canReviewEconomics:canApprove,
      canApprove,
      canResolveCondition:canApprove,
      canManageMembers:isAdmin||(isOwner&&canEdit),
      canManageGovernance:canEdit,
      canReleaseHold:canApprove,
      canRequestPurge:canEdit,
      canGenerateSnapshot:canApprove,
      canWaiveCondition:isAdmin
    };
    const graphReviewScopes=jobs.rows.filter((row:any)=>["DEPENDENCY","PRECEDENCE"].includes(row.job_type)&&row.status==="SUCCEEDED").map((row:any)=>{const input=recordValue(row.input);const output=recordValue(row.output);return {id:row.id,scopeType:row.job_type,agreementVersionId:typeof input.agreementVersionId==="string"?input.agreementVersionId:null,sourceDocumentIds:Array.isArray(output.sourceDocumentIds)?output.sourceDocumentIds:[],sourceRunIds:Array.isArray(output.sourceRunIds)?output.sourceRunIds:[],inputSha256:typeof output.inputHash==="string"?output.inputHash:null,outputCount:Number(row.job_type==="DEPENDENCY"?output.dependencyCount:output.relationCount),modelName:output.modelName,promptVersion:output.promptVersion,schemaVersion:output.schemaVersion,createdAt:row.created_at,finishedAt:row.finished_at};});
    const decisionRows=decisions.rows.map((row:any)=>{
      const pending=row.decision_status==="PENDING";
      const versionAvailable=Boolean(row.agreement_version_id)&&["WORKING","APPROVED"].includes(row.version_status);
      const governedLock=row.version_status==="APPROVED"&&Number(row.version_evidence_protocol_version)>=1&&Boolean(row.authoritative_economics_run_id);
      const validAuthority=["APPROVER","ADMIN"].includes(row.required_approver_role);
      const requiredRoleSatisfied=row.required_approver_role!=="ADMIN"||isAdmin;
      const independent=row.requested_by!==principal.userId;
      const authorityGate=canApprove&&pending&&versionAvailable&&validAuthority&&requiredRoleSatisfied&&independent;
      const hasAuthoritativeEconomics=governedLock&&Boolean(row.validated_economics)&&row.validated_economics.id===row.authoritative_economics_run_id;
      let capabilityReason:string|null=null;
      if(!pending)capabilityReason="Only pending decisions can be dispositioned.";
      else if(!row.agreement_version_id)capabilityReason="Legacy unbound decisions cannot authorize an agreement version.";
      else if(!versionAvailable)capabilityReason="The bound agreement version is no longer available for disposition.";
      else if(!canApprove)capabilityReason="Effective Approver matter access is required.";
      else if(!validAuthority)capabilityReason="The request has an invalid required-approver role.";
      else if(!requiredRoleSatisfied)capabilityReason="Active Admin authority is required for this decision.";
      else if(!independent)capabilityReason="The requester cannot disposition their own request.";
      else if(!governedLock)capabilityReason="Approval requires a protocol-1 locked version with explicitly selected authoritative economics; an authorized independent approver may still reject the request.";
      else if(!hasAuthoritativeEconomics)capabilityReason="The version's authoritative economics selection is not validated on the current formula; an authorized independent approver may still reject the request.";
      const canReject=authorityGate;
      const canApproveDecision=authorityGate&&hasAuthoritativeEconomics;
      return {...row,can_approve:canApproveDecision,can_reject:canReject,can_disposition:canApproveDecision||canReject,capability_reason:capabilityReason};
    });
    return Response.json({ok:true,principal:{name:principal.name,role:principal.role,capabilities:capabilityNames,canAttest},permissions:{...permissions,canAttest},requestedSnapshotId,matter:viewer?{...matterState,legal_hold_reason:null}:matterState,documents:documents.rows.map((d:any)=>({...d,size_bytes:Number(d.size_bytes)})),terms:viewer?terms.rows.map((row:any)=>({...row,review_note:null})):terms.rows,dependencies:viewer?dependencies.rows.map((row:any)=>({...row,review_note:null})):dependencies.rows,documentRelations:viewer?relations.rows.map((row:any)=>({...row,review_note:null})):relations.rows,agreementVersions:versions.rows,findings:viewer?findings.rows.map((row:any)=>({...row,review_note:null})):findings.rows,economicsRuns:viewer?economics.rows.map((row:any)=>({...row,review_note:null})):economics.rows,decisions:viewer?decisionRows.map((row:any)=>({...row,conditions:null,condition_records:[],validated_economics:row.validated_economics?{...row.validated_economics,review_note:null}:null,disposition_note:null,requested_by_email:null,decided_by:null,decided_by_name:null,decided_by_email:null})):decisionRows,snapshots:snapshots.rows,jobs:jobs.rows.map((row:any)=>({...row,error_message:row.error_message?safePersistedFailureForDisplay(row.error_message):null,input:null,output:null})),analysisRuns:analysisRuns.rows,graphReviewScopes,analysisAttestations:viewer?attestations.rows.map((row:any)=>({...row,attestation_note:null})):attestations.rows,audit:viewer?audit.rows.map((row:any)=>({...row,metadata:{redacted:true}})):audit.rows,holdEvents:viewer?holds.rows.map((row:any)=>({...row,reason:null})):holds.rows,purgeRequests:recordsAdmin?purges.rows:purges.rows.map((row:any)=>({...row,reason:null}))});
  }catch(error){const access=accessErrorResponse(error);if(access)return access;return internalErrorResponse(error,"The matter workspace could not be loaded.");}
}
