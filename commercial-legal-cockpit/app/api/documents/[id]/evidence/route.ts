import { accessErrorResponse, requireResourceMatterAccess } from "@/lib/access";
import { databaseConfigured, query } from "@/lib/db";
import { internalErrorResponse } from "@/lib/safeErrors";

export async function GET(request:Request,context:{params:Promise<{id:string}>}){
  try{
    if(!databaseConfigured())return Response.json({ok:false,error:"Source evidence requires the governed database."},{status:503});
    const {id}=await context.params;
    const {matterId}=await requireResourceMatterAccess(request,"DOCUMENT",id,"VIEW");
    const doc=(await query<{extraction_job_id:string|null;security_scan_status:string;deletion_status:string}>("select extraction_job_id,security_scan_status,deletion_status from documents where id=$1 and matter_id=$2",[id,matterId])).rows[0];
    if(!doc||doc.deletion_status!=="ACTIVE"||doc.security_scan_status!=="CLEAN")return Response.json({ok:false,error:"Source evidence is unavailable under the current document controls."},{status:409});
    const job=(await query<{id:string;status:string;output:{docxEvidence?:unknown}}>("select id,status,output from processing_jobs where id=$1 and document_id=$2 and matter_id=$3 and job_type='EXTRACT'",[doc.extraction_job_id,id,matterId])).rows[0];
    if(!job?.output?.docxEvidence)return Response.json({ok:false,error:"No structured DOCX receipt exists. Reprocess the preserved source."},{status:409});
    return Response.json({ok:true,documentId:id,extractionJobId:job.id,status:job.status,receipt:job.output},{headers:{"Cache-Control":"no-store, max-age=0","Pragma":"no-cache","X-Content-Type-Options":"nosniff"}});
  }catch(error){const access=accessErrorResponse(error);if(access)return access;return internalErrorResponse(error,"Source evidence could not be retrieved.");}
}
