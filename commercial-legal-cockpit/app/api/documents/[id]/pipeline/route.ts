import { start } from "workflow/api";
import { accessErrorResponse, requireResourceMatterAccess } from "@/lib/access";
import { databaseConfigured, query } from "@/lib/db";
import { assertLegalRelianceReady } from "@/lib/readiness";
import { enforceRateLimit, rateLimitResponse } from "@/lib/rateLimit";
import { fullContractPipeline, PIPELINE_VERSION } from "@/workflows/full-contract-pipeline";
import { internalErrorResponse } from "@/lib/safeErrors";

export async function POST(request:Request,context:{params:Promise<{id:string}>}){
  try{
    if(!databaseConfigured())return Response.json({ok:false,error:"Contract processing requires DATABASE_URL."},{status:503});
    const {id}=await context.params;
    const {principal,matterId}=await requireResourceMatterAccess(request,"DOCUMENT",id,"EDIT");
    const result=await query<{id:string;matter_id:string;filename:string;sha256:string|null;server_sha256:string|null;deletion_status:string;security_scan_status:string}>("select id,matter_id,filename,sha256,server_sha256,deletion_status,security_scan_status from documents where id=$1 and matter_id=$2 limit 1",[id,matterId]);
    const doc=result.rows[0];if(!doc)return Response.json({ok:false,error:"Document is no longer available."},{status:404});
    if(doc.deletion_status!=="ACTIVE")return Response.json({ok:false,error:`Source processing is blocked while deletion state is ${doc.deletion_status}.`},{status:409});
    if(doc.security_scan_status==="QUARANTINED")return Response.json({ok:false,error:"Source processing is blocked because the document is quarantined."},{status:423});
    await enforceRateLimit(principal,"contract-pipeline",20,3600);
    await assertLegalRelianceReady();
    const fingerprint=(doc.server_sha256||doc.sha256||id).toLowerCase();
    const run=await start(fullContractPipeline,[{documentId:id,matterId:doc.matter_id,sourceFingerprint:fingerprint,requestedBy:principal.userId,requestedByName:principal.name}]);
    return Response.json({ok:true,runId:run.runId,pipelineVersion:PIPELINE_VERSION,documentId:id,matterId:doc.matter_id,humanReviewRequired:true,legalRelianceEnabled:process.env.LEGAL_RELIANCE_ENABLED==="true"});
  }catch(error){const rate=rateLimitResponse(error);if(rate)return rate;const access=accessErrorResponse(error);if(access)return access;return internalErrorResponse(error,"The governed contract pipeline could not be started.");}
}
