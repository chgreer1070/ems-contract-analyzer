import { BlobNotFoundError, del, head } from "@vercel/blob";
import { accessErrorResponse, requireRole } from "@/lib/access";
import { databaseConfigured, withTransaction } from "@/lib/db";
import type { PoolClient } from "pg";
import { internalErrorResponse } from "@/lib/safeErrors";

type Action="APPROVE"|"REJECT"|"EXECUTE"|"CANCEL";
type PurgeRow={
  id:string;matter_id:string;document_id:string;requested_by:string;status:string;approved_by:string|null;
  blob_pathname:string;filename:string;document_hold:boolean;document_retention:string|null;deletion_status:string;
  matter_hold:boolean;matter_retention:string|null;
};

class PurgeActionError extends Error{constructor(message:string,public status:number){super(message);}}

async function lockPurgeState(client:PoolClient,id:string):Promise<PurgeRow>{
  const identity=await client.query<{matter_id:string;document_id:string}>("select matter_id,document_id from purge_requests where id=$1",[id]);
  if(!identity.rows[0])throw new PurgeActionError("Purge request not found.",404);
  await client.query("select id from matters where id=$1 for update",[identity.rows[0].matter_id]);
  await client.query("select id from documents where id=$1 for update",[identity.rows[0].document_id]);
  const row=await client.query<PurgeRow>(`select pr.id,pr.matter_id,pr.document_id,pr.requested_by,pr.status,pr.approved_by,d.blob_pathname,d.filename,d.legal_hold document_hold,d.retention_until::text document_retention,d.deletion_status,m.legal_hold matter_hold,m.retention_until::text matter_retention from purge_requests pr join documents d on d.id=pr.document_id join matters m on m.id=pr.matter_id where pr.id=$1 for update of pr`,[id]);
  if(!row.rows[0])throw new PurgeActionError("Purge request not found.",404);
  return row.rows[0];
}

function applicableRetentionEnd(row:PurgeRow){
  const dates=[row.document_retention,row.matter_retention].filter(Boolean).map(value=>new Date(`${String(value).slice(0,10)}T23:59:59.999Z`));
  if(!dates.length)throw new PurgeActionError("No retention end date is recorded; purge execution is blocked.",409);
  if(dates.some(value=>Number.isNaN(value.getTime())))throw new PurgeActionError("The recorded retention end date is invalid.",409);
  const latest=new Date(Math.max(...dates.map(value=>value.getTime())));
  if(latest.getTime()>Date.now())throw new PurgeActionError("The applicable retention period has not expired.",409);
  return latest.toISOString();
}

function assertExecutable(row:PurgeRow){
  if(row.status!=="APPROVED")throw new PurgeActionError("Only APPROVED purge requests can execute.",409);
  if(row.approved_by===row.requested_by)throw new PurgeActionError("Independent purge approval is required.",409);
  if(row.document_hold||row.matter_hold)throw new PurgeActionError("Source purge is blocked by an active legal hold.",409);
  if(!["ACTIVE","PENDING_PURGE"].includes(row.deletion_status))throw new PurgeActionError(`Document deletion state is ${row.deletion_status}.`,409);
  return applicableRetentionEnd(row);
}

export async function PATCH(request:Request,context:{params:Promise<{id:string}>}){
  try{
    if(!databaseConfigured())return Response.json({ok:false,error:"Purge administration requires DATABASE_URL."},{status:503});
    const principal=await requireRole(request,"ADMIN");if(principal.demo)return Response.json({ok:false,error:"Purge administration is disabled in demo mode."},{status:503});
    const {id}=await context.params;const body=await request.json() as {action?:Action;reason?:string};if(!body.action)return Response.json({ok:false,error:"action is required."},{status:400});

    if(body.action==="APPROVE"){
      await withTransaction(async client=>{const row=await lockPurgeState(client,id);if(row.status!=="PENDING")throw new PurgeActionError("Only PENDING requests can be approved.",409);if(row.requested_by===principal.userId)throw new PurgeActionError("The requester cannot approve their own purge request.",409);if(row.document_hold||row.matter_hold)throw new PurgeActionError("Purge approval is blocked by an active legal hold.",409);await client.query("update purge_requests set status='APPROVED',approved_by=$2,approved_at=now() where id=$1",[id,principal.userId]);await client.query(`insert into audit_events(actor_user_id,actor_name,action,matter_id,entity_type,entity_id,metadata) values($1,$2,'PURGE_APPROVED',$3,'purge_request',$4,$5::jsonb)`,[principal.userId,principal.name,row.matter_id,id,JSON.stringify({documentId:row.document_id})]);});
      return Response.json({ok:true,status:"APPROVED"});
    }

    if(body.action==="REJECT"){
      const reason=body.reason?.trim();if(!reason)return Response.json({ok:false,error:"Rejection reason is required."},{status:400});
      await withTransaction(async client=>{const row=await lockPurgeState(client,id);if(row.status!=="PENDING")throw new PurgeActionError("Only PENDING requests can be rejected.",409);await client.query("update purge_requests set status='REJECTED',approved_by=$2,approved_at=now(),disposition_reason=$3 where id=$1",[id,principal.userId,reason]);await client.query(`insert into audit_events(actor_user_id,actor_name,action,matter_id,entity_type,entity_id,metadata) values($1,$2,'PURGE_REJECTED',$3,'purge_request',$4,$5::jsonb)`,[principal.userId,principal.name,row.matter_id,id,JSON.stringify({documentId:row.document_id,reasonRecorded:true})]);});
      return Response.json({ok:true,status:"REJECTED"});
    }

    if(body.action==="CANCEL"){
      await withTransaction(async client=>{const row=await lockPurgeState(client,id);if(!["PENDING","APPROVED"].includes(row.status))throw new PurgeActionError(`Cannot cancel a ${row.status} request.`,409);if(row.deletion_status==="PENDING_PURGE")throw new PurgeActionError("Cancellation is blocked after purge execution begins because external deletion may already have succeeded. Retry EXECUTE to reconcile the source state.",409);await client.query("update purge_requests set status='CANCELLED',disposition_reason=$2 where id=$1",[id,body.reason?.trim()||"Cancelled by administrator"]);await client.query(`insert into audit_events(actor_user_id,actor_name,action,matter_id,entity_type,entity_id,metadata) values($1,$2,'PURGE_CANCELLED',$3,'purge_request',$4,$5::jsonb)`,[principal.userId,principal.name,row.matter_id,id,JSON.stringify({documentId:row.document_id})]);});
      return Response.json({ok:true,status:"CANCELLED"});
    }

    if(body.action!=="EXECUTE")return Response.json({ok:false,error:"Unsupported action."},{status:400});
    if(process.env.ALLOW_SOURCE_PURGE!=="true")return Response.json({ok:false,error:"Source purge execution is disabled. Set ALLOW_SOURCE_PURGE=true only after records-management approval."},{status:503});
    if(!process.env.BLOB_READ_WRITE_TOKEN)return Response.json({ok:false,error:"BLOB_READ_WRITE_TOKEN is not configured."},{status:503});

    const prepared=await withTransaction(async client=>{const row=await lockPurgeState(client,id);const retentionEnd=assertExecutable(row);if(row.deletion_status==="ACTIVE"){await client.query("update documents set deletion_status='PENDING_PURGE' where id=$1",[row.document_id]);await client.query(`insert into audit_events(actor_user_id,actor_name,action,matter_id,entity_type,entity_id,metadata) values($1,$2,'PURGE_EXECUTION_STARTED',$3,'purge_request',$4,$5::jsonb)`,[principal.userId,principal.name,row.matter_id,id,JSON.stringify({documentId:row.document_id,retentionEnd})]);}return {...row,retentionEnd};});

    await withTransaction(async client=>{
      const row=await lockPurgeState(client,id);const retentionEnd=assertExecutable(row);
      try{
        const metadata=await head(row.blob_pathname,{token:process.env.BLOB_READ_WRITE_TOKEN});
        if(!metadata.etag)throw new PurgeActionError("Blob storage did not return an ETag; conditional purge is blocked.",503);
        await del(row.blob_pathname,{token:process.env.BLOB_READ_WRITE_TOKEN,ifMatch:metadata.etag});
      }catch(error){if(!(error instanceof BlobNotFoundError))throw error;}
      await client.query("update documents set deletion_status='PURGED',purged_at=now(),purged_by=$2 where id=$1",[row.document_id,principal.userId]);
      await client.query("update purge_requests set status='EXECUTED',executed_by=$2,executed_at=now() where id=$1",[id,principal.userId]);
      await client.query(`insert into audit_events(actor_user_id,actor_name,action,matter_id,entity_type,entity_id,metadata) values($1,$2,'DOCUMENT_PURGED',$3,'document',$4,$5::jsonb)`,[principal.userId,principal.name,row.matter_id,row.document_id,JSON.stringify({purgeRequestId:id,retentionEnd})]);
    });
    return Response.json({ok:true,status:"EXECUTED",documentStatus:"PURGED",retentionEnd:prepared.retentionEnd});
  }catch(error){
    const access=accessErrorResponse(error);if(access)return access;
    if(error instanceof PurgeActionError)return Response.json({ok:false,error:error.message},{status:error.status});
    return internalErrorResponse(error,"The purge action could not be completed.");
  }
}
