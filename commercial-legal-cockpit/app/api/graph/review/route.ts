import { accessErrorResponse, requireMatterAccess } from "@/lib/access";
import { writeAuditEvent } from "@/lib/audit";
import { databaseConfigured, query } from "@/lib/db";

type EntityType="TERM"|"DEPENDENCY"|"DOCUMENT_RELATION";
const tableByType:Record<EntityType,string>={TERM:"contract_terms",DEPENDENCY:"term_dependencies",DOCUMENT_RELATION:"document_relations"};

export async function POST(request:Request){
  try{
    if(!databaseConfigured())return Response.json({ok:false,error:"Graph review requires DATABASE_URL."},{status:503});
    const body=await request.json() as {entityType?:EntityType;id?:string;action?:"VALIDATE"|"REJECT";note?:string};
    if(!body.entityType||!tableByType[body.entityType]||!body.id||!body.action)return Response.json({ok:false,error:"entityType, id and action are required."},{status:400});
    const table=tableByType[body.entityType];
    const row=await query<{matter_id:string}>(`select matter_id from ${table} where id=$1 limit 1`,[body.id]);
    if(!row.rows[0])return Response.json({ok:false,error:"Graph object not found."},{status:404});
    const principal=await requireMatterAccess(request,row.rows[0].matter_id,true);
    if(principal.demo)return Response.json({ok:false,error:"Persisted graph review is disabled in demo mode."},{status:503});
    const status=body.action==="VALIDATE"?"VALIDATED":"REJECTED";
    if(body.entityType==="TERM")await query(`update contract_terms set review_status=$2,reviewed_by=$3,reviewed_at=now(),review_note=$4 where id=$1`,[body.id,status,principal.userId,body.note?.trim()||null]);
    else await query(`update ${table} set review_status=$2,reviewed_by=$3,reviewed_at=now() where id=$1`,[body.id,status,principal.userId]);
    await writeAuditEvent({principal,action:"GRAPH_REVIEWED",matterId:row.rows[0].matter_id,entityType:body.entityType.toLowerCase(),entityId:body.id,metadata:{status,note:body.note?.trim()||null}});
    return Response.json({ok:true,id:body.id,entityType:body.entityType,reviewStatus:status});
  }catch(error){const access=accessErrorResponse(error);if(access)return access;return Response.json({ok:false,error:error instanceof Error?error.message:"Graph review failed."},{status:500});}
}
