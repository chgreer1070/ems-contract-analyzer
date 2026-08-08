import { start } from "workflow/api";
import { accessErrorResponse, requireMatterAccess } from "@/lib/access";
import { databaseConfigured, query } from "@/lib/db";
import { enqueueJob } from "@/lib/jobs";
import { contractProcessingWorkflow } from "@/workflows/contract-processing";
import { assertLegalRelianceReady, legalRelianceEvidence } from "@/lib/readiness";
import { enforceRateLimit, rateLimitResponse } from "@/lib/rateLimit";
import { canonicalStateHash } from "@/lib/stateHash";
import { ECONOMICS_FORMULA_VERSION } from "@/lib/economics";
import { internalErrorResponse } from "@/lib/safeErrors";

export async function POST(request:Request,context:{params:Promise<{id:string}>}){
  try{
    if(!databaseConfigured())return Response.json({ok:false,error:"Executive snapshots require DATABASE_URL."},{status:503});
    const {id:matterId}=await context.params;const principal=await requireMatterAccess(request,matterId,"APPROVE");
    if(principal.demo)return Response.json({ok:false,error:"Executive snapshots are disabled in demo mode."},{status:503});
    await enforceRateLimit(principal,"executive-snapshot",30,3600);
    const readiness=await assertLegalRelianceReady({requireEnabled:true});
    if(!readiness)throw new Error("Legal-reliance evidence is unavailable.");
    const requestedRelianceEvidence=legalRelianceEvidence(readiness);
    const requestedRelianceHash=canonicalStateHash(requestedRelianceEvidence);
    const agreement=(await query<{id:string}>(`select id from agreement_versions where matter_id=$1 and status in ('APPROVED','EXECUTED') order by case status when 'EXECUTED' then 0 else 1 end,version_number desc limit 1`,[matterId])).rows[0];
    if(!agreement)return Response.json({ok:false,error:"Approve an agreement version before generating an executive snapshot."},{status:409});
    const sourceCheck=(await query<{document_count:number;invalid_count:number}>(`select count(*)::int document_count,count(*) filter(where d.deletion_status<>'ACTIVE' or d.security_scan_status<>'CLEAN' or d.integrity_status<>'SERVER_VERIFIED' or d.extraction_status<>'EXTRACTED' or d.sha256 is null or d.server_sha256 is null or lower(d.sha256)<>lower(d.server_sha256))::int invalid_count from agreement_version_documents avd join documents d on d.id=avd.document_id where avd.agreement_version_id=$1`,[agreement.id])).rows[0];
    if(!sourceCheck?.document_count)return Response.json({ok:false,error:"The approved agreement version has no source documents."},{status:409});
    if(sourceCheck.invalid_count)return Response.json({ok:false,error:`${sourceCheck.invalid_count} agreement source document(s) are not clean, extracted, hash-verified, and active.`},{status:409});
    const economics=(await query<{id:string}>("select id from economics_runs where matter_id=$1 and agreement_version_id=$2 and formula_version=$3 and review_status='VALIDATED' order by created_at desc,id desc limit 1",[matterId,agreement.id,ECONOMICS_FORMULA_VERSION])).rows[0];
    if(!economics)return Response.json({ok:false,error:"Validate a version-scoped economics scenario for the selected agreement version before generating an executive snapshot."},{status:409});
    const state=await query<{audit_id:string}>(`select coalesce((select max(id)::text from audit_events where matter_id=$1),'0') audit_id`,[matterId]);
    const requestedAuditId=state.rows[0].audit_id;
    const sourceKey=`${agreement.id}:${economics.id}:${requestedAuditId}`;
    const job=await enqueueJob({matterId,jobType:"EXECUTIVE_SUMMARY",idempotencyKey:`snapshot:${matterId}:${sourceKey}:${requestedRelianceHash}`,createdBy:principal.userId,input:{requestedBy:principal.userId,requestedByName:principal.name,requestedAgreementVersionId:agreement.id,requestedEconomicsRunId:economics.id,requestedAuditId,requestedRelianceEvidence,requestedRelianceHash},priority:20,maxAttempts:3});
    const run=await start(contractProcessingWorkflow,[job.id]);
    return Response.json({ok:true,jobId:job.id,runId:run.runId,status:job.status});
  }catch(error){const rate=rateLimitResponse(error);if(rate)return rate;const access=accessErrorResponse(error);if(access)return access;return internalErrorResponse(error,"The executive snapshot could not be generated.");}
}
