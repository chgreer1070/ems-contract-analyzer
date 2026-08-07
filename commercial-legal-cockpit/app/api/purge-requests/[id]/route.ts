import { del } from "@vercel/blob";
import { accessErrorResponse, requireRole } from "@/lib/access";
import { writeAuditEvent } from "@/lib/audit";
import { databaseConfigured, query, withTransaction } from "@/lib/db";

type Action="APPROVE"|"REJECT"|"EXECUTE"|"CANCEL";

export async function PATCH(request:Request,context:{params:Promise<{id:string}>}){
  try{
    if(!databaseConfigured())return Response.json({ok:false,error:"Purge administration requires DATABASE_URL."},{status:503});
    const principal=await requireRole(request,"ADMIN");if(principal.demo)return Response.json({ok:false,error:"Purge administration is disabled in demo mode."},{status:503});
    const {id}=await context.params;const body=await request.json() as {action?:Action;reason?:string};if(!body.action)return Response.json({ok:false,error:"action is required."},{status:400});
    const row=(await query<any>(`select pr.*,d.blob_pathname,d.filename,d.legal_hold document_hold,d.retention_until document_retention,d.deletion_status,m.legal_hold matter_hold,m.retention_until matter_retention from purge_requests pr join documents d on d.id=pr.document_id join matters m on m.id=pr.matter_id where pr.id=$1 limit 1`,[id])).rows[0];
    if(!row)return Response.json({ok:false,error:"Purge request not found."},{status:404});
    if(body.action==="CANCEL"){
      if(!["PENDING","APPROVED"].includes(row.status))return Response.json({ok:false,error:`Cannot cancel a ${row.status} request.`},{status:409});
      await query("update purge_requests set status='CANCELLED' where id=$1",[id]);return Response.json({ok:true,status:"CANCELLED"});
    }
    if(body.action==="APPROVE"){
      if(row.status!=="PENDING")return Response.json({ok:false,error:"Only PENDING requests can be approved."},{status:409});
      if(row.requested_by===principal.userId)return Response.json({ok:false,error:"The requester cannot approve their own purge request."},{status:409});
      if(row.document_hold||row.matter_hold)return Response.json({ok:false,error:"Purge approval is blocked by an active legal hold."},{status:409});
      await query("update purge_requests set status='APPROVED',approved_by=$2,approved_at=now() where id=$1",[id,principal.userId]);
      await writeAuditEvent({principal,action:"PURGE_APPROVED",matterId:row.matter_id,entityType:"purge_request",entityId:id,metadata:{documentId:row.document_id,filename:row.filename}});
      return Response.json({ok:true,status:"APPROVED"});
    }
    if(body.action==="REJECT"){
      if(row.status!=="PENDING")return Response.json({ok:false,error:"Only PENDING requests can be rejected."},{status:409});
      if(!body.reason?.trim())return Response.json({ok:false,error:"Rejection reason is required."},{status:400});
      await query("update purge_requests set status='REJECTED',approved_by=$2,approved_at=now() where id=$1",[id,principal.userId]);
      await writeAuditEvent({principal,action:"PURGE_REJECTED",matterId:row.matter_id,entityType:"purge_request",entityId:id,metadata:{documentId:row.document_id,reason:body.reason.trim()}});
      return Response.json({ok:true,status:"REJECTED"});
    }
    if(body.action!=="EXECUTE")return Response.json({ok:false,error:"Unsupported action."},{status:400});
    if(process.env.ALLOW_SOURCE_PURGE!=="true")return Response.json({ok:false,error:"Source purge execution is disabled. Set ALLOW_SOURCE_PURGE=true only after records-management approval."},{status:503});
    if(row.status!=="APPROVED")return Response.json({ok:false,error:"Only APPROVED purge requests can execute."},{status:409});
    if(row.approved_by===row.requested_by)return Response.json({ok:false,error:"Independent purge approval is required."},{status:409});
    if(row.document_hold||row.matter_hold)return Response.json({ok:false,error:"Source purge is blocked by an active legal hold."},{status:409});
    const retentionRaw=row.document_retention||row.matter_retention;
    if(!retentionRaw)return Response.json({ok:false,error:"No retention end date is recorded; purge execution is blocked."},{status:409});
    const retentionEnd=new Date(`${String(retentionRaw).slice(0,10)}T23:59:59.999Z`);
    if(Number.isNaN(retentionEnd.getTime())||retentionEnd.getTime()>Date.now())return Response.json({ok:false,error:"The applicable retention period has not expired."},{status:409});
    if(!process.env.BLOB_READ_WRITE_TOKEN)return Response.json({ok:false,error:"BLOB_READ_WRITE_TOKEN is not configured."},{status:503});
    await del(row.blob_pathname,{token:process.env.BLOB_READ_WRITE_TOKEN});
    await withTransaction(async client=>{
      await client.query("update documents set deletion_status='PURGED',purged_at=now(),purged_by=$2 where id=$1",[row.document_id,principal.userId]);
      await client.query("update purge_requests set status='EXECUTED',executed_by=$2,executed_at=now() where id=$1",[id,principal.userId]);
    });
    await writeAuditEvent({principal,action:"DOCUMENT_PURGED",matterId:row.matter_id,entityType:"document",entityId:row.document_id,metadata:{purgeRequestId:id,filename:row.filename,retentionEnd:String(retentionRaw)}});
    return Response.json({ok:true,status:"EXECUTED",documentStatus:"PURGED"});
  }catch(error){const access=accessErrorResponse(error);if(access)return access;return Response.json({ok:false,error:error instanceof Error?error.message:"Purge action failed."},{status:500});}
}
