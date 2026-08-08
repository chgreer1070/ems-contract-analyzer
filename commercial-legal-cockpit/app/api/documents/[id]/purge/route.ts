import { accessErrorResponse, requireResourceMatterAccess } from "@/lib/access";
import { databaseConfigured, withTransaction } from "@/lib/db";
import { internalErrorResponse, safeErrorCode } from "@/lib/safeErrors";

class PurgeRequestError extends Error{constructor(message:string,public status:number){super(message);}}

export async function POST(request:Request,context:{params:Promise<{id:string}>}){
  try{
    if(!databaseConfigured())return Response.json({ok:false,error:"Purge requests require DATABASE_URL."},{status:503});
    const {id}=await context.params;
    const {principal,matterId}=await requireResourceMatterAccess(request,"DOCUMENT",id,"EDIT");
    const body=await request.json() as {reason?:string};const reason=body.reason?.trim();if(!reason)return Response.json({ok:false,error:"A records-management reason is required."},{status:400});

    const purgeRequestId=await withTransaction(async client=>{
      await client.query("select id from matters where id=$1 for update",[matterId]);
      const doc=(await client.query<{matter_id:string;filename:string;legal_hold:boolean;deletion_status:string}>("select matter_id,filename,legal_hold,deletion_status from documents where id=$1 and matter_id=$2 for update",[id,matterId])).rows[0];
      if(!doc)throw new PurgeRequestError("Document not found.",404);
      const matter=(await client.query<{legal_hold:boolean}>("select legal_hold from matters where id=$1",[doc.matter_id])).rows[0];
      if(doc.legal_hold||matter?.legal_hold)throw new PurgeRequestError("A purge request cannot be opened while a legal hold is active.",409);
      if(doc.deletion_status!=="ACTIVE")throw new PurgeRequestError(`Document deletion state is ${doc.deletion_status}.`,409);
      const result=await client.query<{id:string}>(`insert into purge_requests(matter_id,document_id,requested_by,reason) values($1,$2,$3,$4) returning id`,[doc.matter_id,id,principal.userId,reason]);
      await client.query(`insert into audit_events(actor_user_id,actor_name,action,matter_id,entity_type,entity_id,metadata) values($1,$2,'PURGE_REQUESTED',$3,'purge_request',$4,$5::jsonb)`,[principal.userId,principal.name,doc.matter_id,result.rows[0].id,JSON.stringify({documentId:id,reasonRecorded:true})]);
      return result.rows[0].id;
    });
    return Response.json({ok:true,purgeRequestId,status:"PENDING",message:"An independent Admin must approve this request before any source object can be destroyed."},{status:201});
  }catch(error){
    const access=accessErrorResponse(error);if(access)return access;
    if(error instanceof PurgeRequestError)return Response.json({ok:false,error:error.message},{status:error.status});
    if(safeErrorCode(error)==="23505")return Response.json({ok:false,error:"An open purge request already exists for this document."},{status:409});
    return internalErrorResponse(error,"The purge request could not be created.");
  }
}
