import { start } from "workflow/api";
import { accessErrorResponse, requireMatterAccess } from "@/lib/access";
import { databaseConfigured, query } from "@/lib/db";
import { assertLegalRelianceReady } from "@/lib/readiness";
import { fullContractPipeline, PIPELINE_VERSION } from "@/workflows/full-contract-pipeline";

export async function POST(request:Request,context:{params:Promise<{id:string}>}){
  try{
    if(!databaseConfigured())return Response.json({ok:false,error:"Contract processing requires DATABASE_URL."},{status:503});
    const {id}=await context.params;
    const result=await query<{id:string;matter_id:string;filename:string;sha256:string|null;server_sha256:string|null}>("select id,matter_id,filename,sha256,server_sha256 from documents where id=$1 limit 1",[id]);
    const doc=result.rows[0];if(!doc)return Response.json({ok:false,error:"Document not found."},{status:404});
    const principal=await requireMatterAccess(request,doc.matter_id,true);
    if(principal.demo)return Response.json({ok:false,error:"Durable source-document pipelines are disabled in demo mode."},{status:503});
    await assertLegalRelianceReady();
    const fingerprint=(doc.server_sha256||doc.sha256||id).toLowerCase();
    const run=await start(fullContractPipeline,[{documentId:id,matterId:doc.matter_id,sourceFingerprint:fingerprint,requestedBy:principal.userId,requestedByName:principal.name}]);
    return Response.json({ok:true,runId:run.runId,pipelineVersion:PIPELINE_VERSION,documentId:id,matterId:doc.matter_id,humanReviewRequired:true,legalRelianceEnabled:process.env.LEGAL_RELIANCE_ENABLED==="true"});
  }catch(error){const access=accessErrorResponse(error);if(access)return access;return Response.json({ok:false,error:error instanceof Error?error.message:"Unable to start contract pipeline."},{status:500});}
}
