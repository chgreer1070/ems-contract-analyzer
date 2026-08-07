import { accessErrorResponse, requireMatterAccess, requireRole } from "@/lib/access";
import { writeAuditEvent } from "@/lib/audit";
import { databaseConfigured, query } from "@/lib/db";

export async function POST(request:Request,context:{params:Promise<{id:string}>}){
  try{
    if(!databaseConfigured())return Response.json({ok:false,error:"Agreement version status requires DATABASE_URL."},{status:503});
    const {id}=await context.params;const row=await query<{matter_id:string;status:string}>("select matter_id,status from agreement_versions where id=$1 limit 1",[id]);
    if(!row.rows[0])return Response.json({ok:false,error:"Agreement version not found."},{status:404});
    const principal=await requireMatterAccess(request,row.rows[0].matter_id,true);if(principal.demo)return Response.json({ok:false,error:"Agreement version status is disabled in demo mode."},{status:503});
    const body=await request.json() as {status?:"APPROVED"|"EXECUTED"|"SUPERSEDED"};if(!body.status)return Response.json({ok:false,error:"status is required."},{status:400});
    if(body.status==="APPROVED"||body.status==="EXECUTED")await requireRole(request,"APPROVER");
    if(body.status==="EXECUTED"&&row.rows[0].status!=="APPROVED")return Response.json({ok:false,error:"An agreement version must be APPROVED before it can be marked EXECUTED."},{status:409});
    if(row.rows[0].status==="EXECUTED"&&body.status!=="SUPERSEDED")return Response.json({ok:false,error:"An executed agreement version may only transition to SUPERSEDED."},{status:409});
    await query("update agreement_versions set status=$2 where id=$1",[id,body.status]);
    await writeAuditEvent({principal,action:"AGREEMENT_VERSION_STATUS_CHANGED",matterId:row.rows[0].matter_id,entityType:"agreement_version_status",entityId:id,metadata:{from:row.rows[0].status,to:body.status}});
    return Response.json({ok:true,id,status:body.status});
  }catch(error){const access=accessErrorResponse(error);if(access)return access;return Response.json({ok:false,error:error instanceof Error?error.message:"Agreement version status change failed."},{status:500});}
}
