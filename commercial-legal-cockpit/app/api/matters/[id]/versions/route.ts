import { accessErrorResponse, requireMatterAccess } from "@/lib/access";
import { writeAuditEvent } from "@/lib/audit";
import { databaseConfigured, query, withTransaction } from "@/lib/db";

export async function POST(request:Request,context:{params:Promise<{id:string}>}){
  try{
    if(!databaseConfigured())return Response.json({ok:false,error:"Agreement versioning requires DATABASE_URL."},{status:503});
    const {id:matterId}=await context.params;const principal=await requireMatterAccess(request,matterId,true);
    if(principal.demo)return Response.json({ok:false,error:"Agreement versioning is disabled in demo mode."},{status:503});
    const body=await request.json() as {label?:string;documentIds?:string[];effectiveDate?:string|null};
    const documentIds=[...new Set((body.documentIds??[]).filter(Boolean))];
    if(!body.label?.trim()||!documentIds.length)return Response.json({ok:false,error:"label and at least one documentId are required."},{status:400});
    const docs=await query<{id:string}>("select id from documents where matter_id=$1 and id=any($2::uuid[])",[matterId,documentIds]);
    if(docs.rowCount!==documentIds.length)return Response.json({ok:false,error:"Every version document must belong to the selected matter."},{status:409});
    const version=await withTransaction(async client=>{
      const next=await client.query<{n:number}>("select coalesce(max(version_number),0)::int+1 n from agreement_versions where matter_id=$1 for update",[matterId]);
      const created=await client.query<{id:string}>(`insert into agreement_versions(matter_id,version_number,label,status,effective_date,created_by) values($1,$2,$3,'WORKING',$4,$5) returning id`,[matterId,next.rows[0].n,body.label.trim(),body.effectiveDate||null,principal.userId]);
      for(let i=0;i<documentIds.length;i++)await client.query(`insert into agreement_version_documents(agreement_version_id,document_id,display_order,included_by) values($1,$2,$3,$4)`,[created.rows[0].id,documentIds[i],i,principal.userId]);
      return {id:created.rows[0].id,versionNumber:next.rows[0].n};
    });
    await writeAuditEvent({principal,action:"AGREEMENT_VERSION_CREATED",matterId,entityType:"agreement_version",entityId:version.id,metadata:{versionNumber:version.versionNumber,label:body.label.trim(),documentIds}});
    return Response.json({ok:true,...version,status:"WORKING"});
  }catch(error){const access=accessErrorResponse(error);if(access)return access;return Response.json({ok:false,error:error instanceof Error?error.message:"Agreement version creation failed."},{status:500});}
}
