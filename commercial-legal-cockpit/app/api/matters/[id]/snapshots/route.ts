import { start } from "workflow/api";
import { accessErrorResponse, requireMatterAccess } from "@/lib/access";
import { databaseConfigured, query } from "@/lib/db";
import { enqueueJob } from "@/lib/jobs";
import { contractProcessingWorkflow } from "@/workflows/contract-processing";

export async function POST(request:Request,context:{params:Promise<{id:string}>}){
  try{
    if(!databaseConfigured())return Response.json({ok:false,error:"Executive snapshots require DATABASE_URL."},{status:503});
    const {id:matterId}=await context.params;const principal=await requireMatterAccess(request,matterId,true);
    if(principal.demo)return Response.json({ok:false,error:"Executive snapshots are disabled in demo mode."},{status:503});
    const state=await query<{audit_id:string;econ_id:string|null}>(`select coalesce((select max(id)::text from audit_events where matter_id=$1),'0') audit_id,(select id::text from economics_runs where matter_id=$1 order by created_at desc limit 1) econ_id`,[matterId]);
    const sourceKey=`${state.rows[0].audit_id}:${state.rows[0].econ_id??"none"}`;
    const job=await enqueueJob({matterId,jobType:"EXECUTIVE_SUMMARY",idempotencyKey:`snapshot:${matterId}:${sourceKey}`,createdBy:principal.userId,input:{requestedBy:principal.userId,requestedByName:principal.name},priority:20,maxAttempts:3});
    const run=await start(contractProcessingWorkflow,[job.id]);
    return Response.json({ok:true,jobId:job.id,runId:run.runId,status:job.status});
  }catch(error){const access=accessErrorResponse(error);if(access)return access;return Response.json({ok:false,error:error instanceof Error?error.message:"Unable to generate executive snapshot."},{status:500});}
}
