import { AccessError, accessErrorResponse, requireResourceMatterAccess } from "@/lib/access";
import { databaseConfigured, withTransaction } from "@/lib/db";
import { canonicalStateHash, canonicalStateJson } from "@/lib/stateHash";
import { internalErrorResponse, safeErrorCode } from "@/lib/safeErrors";

const ANALYSIS_SCOPES=new Set(["CLAUSE_RISK","TERM_EXTRACTION"]);
const JOB_SCOPES=new Set(["DEPENDENCY","PRECEDENCE"]);

class AttestationError extends Error{
  constructor(message:string,public status=409){super(message);}
}

function recordValue(value:unknown):Record<string,unknown>{
  if(value&&typeof value==="object"&&!Array.isArray(value))return value as Record<string,unknown>;
  if(typeof value==="string")try{const parsed=JSON.parse(value);if(parsed&&typeof parsed==="object"&&!Array.isArray(parsed))return parsed;}catch{}
  return {};
}

function exactSortedIds(value:unknown){
  if(!Array.isArray(value))return null;
  const ids=value.map(String).sort();
  return ids.every(id=>/^[0-9a-f]{8}-(?:[0-9a-f]{4}-){3}[0-9a-f]{12}$/i.test(id))?ids:null;
}

export async function POST(request:Request){
  try{
    if(!databaseConfigured())return Response.json({ok:false,error:"Analysis review attestation requires DATABASE_URL."},{status:503});
    const body=await request.json() as {scopeType?:string;scopeId?:string;note?:string;confirmComplete?:boolean};
    const scopeType=String(body.scopeType??"").toUpperCase();
    const scopeId=String(body.scopeId??"").trim();
    const note=String(body.note??"").trim();
    if(!ANALYSIS_SCOPES.has(scopeType)&&!JOB_SCOPES.has(scopeType))return Response.json({ok:false,error:"scopeType must be CLAUSE_RISK, TERM_EXTRACTION, DEPENDENCY, or PRECEDENCE."},{status:400});
    if(body.confirmComplete!==true)return Response.json({ok:false,error:"Explicit counsel confirmation of complete review is required."},{status:400});
    if(note.length<12||note.length>4000)return Response.json({ok:false,error:"Counsel completion note must be between 12 and 4000 characters."},{status:400});
    const resourceType=ANALYSIS_SCOPES.has(scopeType)?"ANALYSIS_RUN":"PROCESSING_JOB";
    const {principal,matterId}=await requireResourceMatterAccess(request,resourceType,scopeId,"EDIT");

    const attestation=await withTransaction(async client=>{
      const activeRole=(await client.query<{role:string}>("select role from app_user_roles where user_id=$1 and active=true for share",[principal.userId])).rows[0]?.role;
      if(!["LAWYER","APPROVER","ADMIN"].includes(String(activeRole||"")))throw new AccessError("Active Lawyer authority is required for counsel completion.",403);
      const counselAuthorized=(await client.query("select 1 from app_user_capabilities where user_id=$1 and capability='LEGAL_COUNSEL_ATTEST' and active=true for share",[principal.userId])).rowCount===1;
      if(!counselAuthorized)throw new AccessError("Active LEGAL_COUNSEL_ATTEST authority is required for counsel completion.",403);
      const matter=(await client.query<{owner_user_id:string;restricted:boolean;member_access:string|null}>(`select m.owner_user_id,m.restricted,(select mm.access_level from matter_members mm where mm.matter_id=m.id and mm.user_id=$2 for share) member_access from matters m where m.id=$1 for share`,[matterId,principal.userId])).rows[0];
      const memberCanEdit=matter?.member_access==="EDIT"||matter?.member_access==="APPROVE";
      if(!matter||(activeRole!=="ADMIN"&&matter.owner_user_id!==principal.userId&&!memberCanEdit&&(matter.restricted||activeRole==="VIEWER")))throw new AccessError("Resource not found or access denied.",404);

      let inputSha256="";let outputCount=0;let objects:any[]=[];let scopeManifest:Record<string,unknown>={};
      if(ANALYSIS_SCOPES.has(scopeType)){
        const run=(await client.query<any>(`select id,matter_id,document_id,run_type,status,model_name,prompt_version,schema_version,input_sha256,source_chunk_count,output_count,rejected_ungrounded_count,metrics,created_by,started_at,finished_at from analysis_runs where id=$1 and matter_id=$2 and run_type=$3 for share`,[scopeId,matterId,scopeType])).rows[0];
        if(!run||run.status!=="SUCCEEDED")throw new AttestationError("Only a successful matching analysis run can receive counsel completion.");
        inputSha256=String(run.input_sha256).toLowerCase();outputCount=Number(run.output_count);
        if(scopeType==="CLAUSE_RISK")objects=(await client.query<any>(`select id,review_status,reviewed_by,reviewed_at::text reviewed_at,review_note from findings where analysis_run_id=$1 order by id`,[scopeId])).rows;
        else objects=(await client.query<any>(`select id,review_status,reviewed_by,reviewed_at::text reviewed_at,review_note from contract_terms where analysis_run_id=$1 order by id`,[scopeId])).rows;
        scopeManifest=run;
      }else{
        const job=(await client.query<any>(`select id,matter_id,job_type,status,input,output,created_by,created_at,started_at,finished_at from processing_jobs where id=$1 and matter_id=$2 and job_type=$3 for share`,[scopeId,matterId,scopeType])).rows[0];
        if(!job||job.status!=="SUCCEEDED")throw new AttestationError("Only a successful matching graph-analysis job can receive counsel completion.");
        const output=recordValue(job.output);inputSha256=String(output.inputHash||"").toLowerCase();
        outputCount=Number(scopeType==="DEPENDENCY"?output.dependencyCount:output.relationCount);
        if(!/^[0-9a-f]{64}$/.test(inputSha256)||!Number.isInteger(outputCount)||outputCount<0)throw new AttestationError("The graph-analysis receipt is incomplete or invalid.");
        if(Number(output.rejectedCandidateCount)!==0||Number(output.rawCandidateCount)!==outputCount)throw new AttestationError("Counsel completion is blocked because the graph model emitted rejected or unreviewable candidate output.");
        if(scopeType==="DEPENDENCY")objects=(await client.query<any>(`select id,processing_job_id,origin,review_status,reviewed_by,reviewed_at::text reviewed_at,review_note from term_dependencies where processing_job_id=$1 order by id`,[scopeId])).rows;
        else objects=(await client.query<any>(`select id,processing_job_id,origin,review_status,reviewed_by,reviewed_at::text reviewed_at,review_note from document_relations where processing_job_id=$1 order by id`,[scopeId])).rows;
        const receiptObjectIds=exactSortedIds(output.objectIds);const actualObjectIds=objects.map(row=>String(row.id)).sort();
        if(!receiptObjectIds||receiptObjectIds.length!==actualObjectIds.length||receiptObjectIds.some((id,index)=>id!==actualObjectIds[index])||objects.some(row=>row.origin!=="MODEL"))throw new AttestationError("The graph-analysis receipt does not exactly identify its published model objects.");
        scopeManifest={...job,input:recordValue(job.input),output};
      }
      const dispositionCounts={validated:objects.filter(row=>row.review_status==="VALIDATED").length,rejected:objects.filter(row=>row.review_status==="REJECTED").length,unreviewed:objects.filter(row=>row.review_status==="UNREVIEWED").length,other:objects.filter(row=>!["VALIDATED","REJECTED","UNREVIEWED"].includes(row.review_status)).length};
      if(objects.length!==outputCount||dispositionCounts.unreviewed||dispositionCounts.other||dispositionCounts.validated+dispositionCounts.rejected!==outputCount)throw new AttestationError(`Counsel completion requires a documented disposition for all ${outputCount} published output object(s).`);
      if(objects.some(row=>!row.reviewed_by||!row.reviewed_at||String(row.review_note||"").trim().length<12))throw new AttestationError("Every published output requires a substantive recorded human-review note before run completion.");
      const manifest={scope:scopeManifest,dispositionCounts,objects,authority:{capability:"LEGAL_COUNSEL_ATTEST",attestedBy:principal.userId,confirmComplete:true}};
      const manifestCanonical=canonicalStateJson(manifest);const manifestHash=canonicalStateHash(manifest);
      const inserted=(await client.query<{id:string}>(`insert into analysis_review_attestations(matter_id,scope_type,analysis_run_id,processing_job_id,input_sha256,output_count,disposition_counts,manifest,manifest_canonical,manifest_hash,attestation_note,authority_capability,attested_by) values($1,$2,$3,$4,$5,$6,$7::jsonb,$8::jsonb,$9,$10,$11,'LEGAL_COUNSEL_ATTEST',$12) returning id`,[matterId,scopeType,ANALYSIS_SCOPES.has(scopeType)?scopeId:null,JOB_SCOPES.has(scopeType)?scopeId:null,inputSha256,outputCount,JSON.stringify(dispositionCounts),manifestCanonical,manifestCanonical,manifestHash,note,principal.userId])).rows[0];
      await client.query(`insert into audit_events(actor_user_id,actor_name,action,matter_id,entity_type,entity_id,metadata) values($1,$2,'ANALYSIS_REVIEW_ATTESTED',$3,'analysis_review_attestation',$4,$5::jsonb)`,[principal.userId,principal.name,matterId,inserted.id,JSON.stringify({scopeType,scopeId,inputSha256,outputCount,dispositionCounts,manifestHash})]);
      return {id:inserted.id,scopeType,scopeId,manifestHash,outputCount,dispositionCounts};
    });
    return Response.json({ok:true,attestation},{status:201});
  }catch(error){
    const access=accessErrorResponse(error);if(access)return access;
    if(error instanceof AttestationError)return Response.json({ok:false,error:error.message},{status:error.status});
    if(safeErrorCode(error)==="23505")return Response.json({ok:false,error:"This analysis run already has an immutable counsel-completion attestation."},{status:409});
    return internalErrorResponse(error,"Analysis review completion could not be attested.");
  }
}
