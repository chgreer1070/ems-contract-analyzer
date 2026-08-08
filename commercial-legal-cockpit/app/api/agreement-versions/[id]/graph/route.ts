import { start } from "workflow/api";
import { createHash } from "node:crypto";
import { accessErrorResponse, requireResourceMatterAccess } from "@/lib/access";
import { databaseConfigured, query } from "@/lib/db";
import { enqueueJob } from "@/lib/jobs";
import { enforceRateLimit, rateLimitResponse } from "@/lib/rateLimit";
import { canonicalStateHash } from "@/lib/stateHash";
import { contractProcessingWorkflow } from "@/workflows/contract-processing";
import { TERM_PROMPT_VERSION, TERM_SCHEMA_VERSION } from "@/lib/termEngine";
import { AGREEMENT_GRAPH_VERSION } from "@/lib/pipelineVersions";
import { internalErrorResponse } from "@/lib/safeErrors";

export async function POST(request:Request,context:{params:Promise<{id:string}>}){
  try{
    if(!databaseConfigured())return Response.json({ok:false,error:"Agreement graph analysis requires DATABASE_URL."},{status:503});
    const {id}=await context.params;
    const {principal,matterId}=await requireResourceMatterAccess(request,"AGREEMENT_VERSION",id,"EDIT");
    await enforceRateLimit(principal,"agreement-graph",20,3600);
    const version=(await query<{status:string}>("select status from agreement_versions where id=$1 and matter_id=$2",[id,matterId])).rows[0];
    if(!version||!["WORKING","APPROVED"].includes(version.status))return Response.json({ok:false,error:"Agreement graph analysis requires a WORKING or APPROVED agreement version."},{status:409});
    const documents=(await query<{id:string;security_scan_status:string;integrity_status:string;extraction_status:string;deletion_status:string;sha256:string|null;server_sha256:string|null}>(`select d.id,d.security_scan_status,d.integrity_status,d.extraction_status,d.deletion_status,d.sha256,d.server_sha256 from agreement_version_documents avd join documents d on d.id=avd.document_id where avd.agreement_version_id=$1 and d.matter_id=$2 order by avd.display_order,d.id`,[id,matterId])).rows;
    if(!documents.length)return Response.json({ok:false,error:"The agreement version has no source documents."},{status:409});
    const invalid=documents.filter(doc=>doc.security_scan_status!=="CLEAN"||doc.integrity_status!=="SERVER_VERIFIED"||doc.extraction_status!=="EXTRACTED"||doc.deletion_status!=="ACTIVE"||!doc.sha256||!doc.server_sha256||doc.sha256.toLowerCase()!==doc.server_sha256.toLowerCase());
    if(invalid.length)return Response.json({ok:false,error:`${invalid.length} agreement source document(s) are not clean, extracted, hash-verified, and active.`},{status:409});
    const sourceDocumentIds=documents.map(doc=>doc.id).sort();
    const termRuns=(await query<{id:string;document_id:string;status:string;prompt_version:string;schema_version:string;input_sha256:string;source_chunk_count:number}>(`select distinct on(ar.document_id) ar.id,ar.document_id,ar.status,ar.prompt_version,ar.schema_version,ar.input_sha256,ar.source_chunk_count from analysis_runs ar where ar.matter_id=$1 and ar.document_id=any($2::uuid[]) and ar.run_type='TERM_EXTRACTION' order by ar.document_id,ar.started_at desc,ar.id desc`,[matterId,sourceDocumentIds])).rows;
    if(termRuns.length!==sourceDocumentIds.length||termRuns.some(run=>run.status!=="SUCCEEDED"||run.prompt_version!==TERM_PROMPT_VERSION||run.schema_version!==TERM_SCHEMA_VERSION))return Response.json({ok:false,error:"Every agreement source requires a successful current-version term-extraction run before agreement graph analysis."},{status:409});
    for(const run of termRuns){
      const chunks=(await query<{content_sha256:string}>("select content_sha256 from document_chunks where document_id=$1 order by coalesce(page_number,0),chunk_index,id",[run.document_id])).rows;
      const inputHash=createHash("sha256").update(chunks.map(chunk=>chunk.content_sha256.toLowerCase()).join(":"),"utf8").digest("hex");
      if(!chunks.length||chunks.length!==Number(run.source_chunk_count)||inputHash!==run.input_sha256.toLowerCase())return Response.json({ok:false,error:"A term-extraction run is stale relative to the current source chunks."},{status:409});
    }
    const sourceTermAnalysisRunIds=termRuns.map(run=>run.id).sort();
    const scopeHash=canonicalStateHash({agreementVersionId:id,sourceDocumentIds,sourceTermAnalysisRunIds,graphVersion:AGREEMENT_GRAPH_VERSION});
    const commonInput={requestedBy:principal.userId,requestedByName:principal.name,agreementVersionId:id,sourceDocumentIds,sourceTermAnalysisRunIds,graphVersion:AGREEMENT_GRAPH_VERSION};
    const dependency=await enqueueJob({matterId,jobType:"DEPENDENCY",idempotencyKey:`${AGREEMENT_GRAPH_VERSION}:dependency:${matterId}:${scopeHash}`,createdBy:principal.userId,input:{...commonInput,termAnalysisRunId:sourceTermAnalysisRunIds[0]},priority:45,maxAttempts:3});
    const precedence=await enqueueJob({matterId,jobType:"PRECEDENCE",idempotencyKey:`${AGREEMENT_GRAPH_VERSION}:precedence:${matterId}:${scopeHash}`,createdBy:principal.userId,input:commonInput,priority:46,maxAttempts:3});
    const [dependencyWorkflow,precedenceWorkflow]=await Promise.all([start(contractProcessingWorkflow,[dependency.id]),start(contractProcessingWorkflow,[precedence.id])]);
    return Response.json({ok:true,agreementVersionId:id,scopeHash,dependency:{jobId:dependency.id,runId:dependencyWorkflow.runId,status:dependency.status},precedence:{jobId:precedence.id,runId:precedenceWorkflow.runId,status:precedence.status}});
  }catch(error){const rate=rateLimitResponse(error);if(rate)return rate;const access=accessErrorResponse(error);if(access)return access;return internalErrorResponse(error,"Agreement graph analysis could not be started.");}
}
