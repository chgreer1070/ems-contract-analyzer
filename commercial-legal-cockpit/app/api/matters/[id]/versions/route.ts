import { accessErrorResponse, requireMatterAccess } from "@/lib/access";
import { databaseConfigured, query, withTransaction } from "@/lib/db";
import { internalErrorResponse } from "@/lib/safeErrors";

export async function GET(request:Request,context:{params:Promise<{id:string}>}){
  try{
    if(!databaseConfigured())return Response.json({ok:true,mode:"demo",versions:[]});
    const {id:matterId}=await context.params;
    const principal=await requireMatterAccess(request,matterId,false);
    if(principal.demo)return Response.json({ok:true,mode:"demo",versions:[]});
    const versions=await query(`
      select av.id,av.version_number,av.label,av.status,av.effective_date,av.created_at,
             coalesce(json_agg(json_build_object(
               'documentId',d.id,'filename',d.filename,'documentType',d.document_type,
               'displayOrder',avd.display_order
             ) order by avd.display_order) filter(where d.id is not null),'[]'::json) documents
        from agreement_versions av
        left join agreement_version_documents avd on avd.agreement_version_id=av.id
        left join documents d on d.id=avd.document_id
       where av.matter_id=$1
       group by av.id
       order by av.version_number desc`,[matterId]);
    return Response.json({ok:true,mode:"database",versions:versions.rows});
  }catch(error){
    const access=accessErrorResponse(error);if(access)return access;
    return internalErrorResponse(error,"Agreement versions could not be loaded.");
  }
}

export async function POST(request:Request,context:{params:Promise<{id:string}>}){
  try{
    if(!databaseConfigured())return Response.json({ok:false,error:"Agreement versioning requires DATABASE_URL."},{status:503});
    const {id:matterId}=await context.params;const principal=await requireMatterAccess(request,matterId,true);
    if(principal.demo)return Response.json({ok:false,error:"Agreement versioning is disabled in demo mode."},{status:503});
    const body=await request.json() as {label?:string;documentIds?:string[];effectiveDate?:string|null};
    const label=body.label?.trim()??"";
    const effectiveDate=body.effectiveDate||null;
    const documentIds=[...new Set((body.documentIds??[]).filter(Boolean))];
    if(!label||!documentIds.length)return Response.json({ok:false,error:"label and at least one documentId are required."},{status:400});
    const docs=await query<{id:string}>("select id from documents where matter_id=$1 and id=any($2::uuid[])",[matterId,documentIds]);
    if(docs.rowCount!==documentIds.length)return Response.json({ok:false,error:"Every version document must belong to the selected matter."},{status:409});
    const version=await withTransaction(async client=>{
      await client.query("select pg_advisory_xact_lock(hashtext($1))",[`agreement-version:${matterId}`]);
      const next=await client.query<{n:number}>("select coalesce(max(version_number),0)::int+1 n from agreement_versions where matter_id=$1",[matterId]);
      const created=await client.query<{id:string}>(`insert into agreement_versions(matter_id,version_number,label,status,effective_date,created_by) values($1,$2,$3,'WORKING',$4,$5) returning id`,[matterId,next.rows[0].n,label,effectiveDate,principal.userId]);
      for(let i=0;i<documentIds.length;i++)await client.query(`insert into agreement_version_documents(agreement_version_id,document_id,display_order,included_by) values($1,$2,$3,$4)`,[created.rows[0].id,documentIds[i],i,principal.userId]);
      await client.query(`insert into audit_events(actor_user_id,actor_name,action,matter_id,entity_type,entity_id,metadata) values($1,$2,'AGREEMENT_VERSION_CREATED',$3,'agreement_version',$4,$5::jsonb)`,[principal.userId,principal.name,matterId,created.rows[0].id,JSON.stringify({versionNumber:next.rows[0].n,label,documentIds})]);
      return {id:created.rows[0].id,versionNumber:next.rows[0].n};
    });
    return Response.json({ok:true,...version,status:"WORKING"});
  }catch(error){const access=accessErrorResponse(error);if(access)return access;return internalErrorResponse(error,"The agreement version could not be created.");}
}
