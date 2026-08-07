import { accessErrorResponse, requireMatterAccess } from "@/lib/access";
import { writeAuditEvent } from "@/lib/audit";
import { databaseConfigured, query } from "@/lib/db";

export async function POST(request:Request,context:{params:Promise<{id:string}>}){
  try{
    if(!databaseConfigured())return Response.json({ok:false,error:"Purge requests require DATABASE_URL."},{status:503});
    const {id}=await context.params;
    const doc=(await query<{matter_id:string;filename:string;legal_hold:boolean;deletion_status:string}>("select matter_id,filename,legal_hold,deletion_status from documents where id=$1 limit 1",[id])).rows[0];
    if(!doc)return Response.json({ok:false,error:"Document not found."},{status:404});
    const principal=await requireMatterAccess(request,doc.matter_id,true);if(principal.demo)return Response.json({ok:false,error:"Purge requests are disabled in demo mode."},{status:503});
    const matter=(await query<{legal_hold:boolean}>("select legal_hold from matters where id=$1",[doc.matter_id])).rows[0];
    if(doc.legal_hold||matter?.legal_hold)return Response.json({ok:false,error:"A purge request cannot be opened while a legal hold is active."},{status:409});
    if(doc.deletion_status!=="ACTIVE")return Response.json({ok:false,error:`Document deletion state is ${doc.deletion_status}.`},{status:409});
    const body=await request.json() as {reason?:string};if(!body.reason?.trim())return Response.json({ok:false,error:"A records-management reason is required."},{status:400});
    const result=await query<{id:string}>(`insert into purge_requests(matter_id,document_id,requested_by,reason) values($1,$2,$3,$4) returning id`,[doc.matter_id,id,principal.userId,body.reason.trim()]);
    await writeAuditEvent({principal,action:"PURGE_REQUESTED",matterId:doc.matter_id,entityType:"purge_request",entityId:result.rows[0].id,metadata:{documentId:id,filename:doc.filename,reason:body.reason.trim()}});
    return Response.json({ok:true,purgeRequestId:result.rows[0].id,status:"PENDING",message:"An independent Admin must approve this request before any source object can be destroyed."},{status:201});
  }catch(error){const access=accessErrorResponse(error);if(access)return access;const message=error instanceof Error?error.message:"Unable to create purge request.";return Response.json({ok:false,error:message.includes("duplicate")?"An open purge request already exists for this document.":message},{status:message.includes("duplicate")?409:500});}
}
