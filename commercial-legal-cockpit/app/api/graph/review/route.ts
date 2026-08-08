import { accessErrorResponse, requireResourceMatterAccess, type MatterBoundResource } from "@/lib/access";
import { databaseConfigured, withTransaction } from "@/lib/db";
import { internalErrorResponse } from "@/lib/safeErrors";

type EntityType="TERM"|"DEPENDENCY"|"DOCUMENT_RELATION";
const tableByType:Record<EntityType,string>={TERM:"contract_terms",DEPENDENCY:"term_dependencies",DOCUMENT_RELATION:"document_relations"};
const resourceByType:Record<EntityType,MatterBoundResource>={TERM:"TERM",DEPENDENCY:"DEPENDENCY",DOCUMENT_RELATION:"DOCUMENT_RELATION"};

export async function POST(request:Request){
  try{
    if(!databaseConfigured())return Response.json({ok:false,error:"Graph review requires DATABASE_URL."},{status:503});
    const body=await request.json() as {entityType?:EntityType;id?:string;action?:"VALIDATE"|"REJECT";note?:string};
    if(!body.entityType||!tableByType[body.entityType]||!body.id||!body.action)return Response.json({ok:false,error:"entityType, id and action are required."},{status:400});
    const entityType=body.entityType;const table=tableByType[entityType];
    const {principal,matterId}=await requireResourceMatterAccess(request,resourceByType[entityType],body.id,"EDIT");
    const status=body.action==="VALIDATE"?"VALIDATED":"REJECTED";
    const note=body.note?.trim();if(!note||note.length<12)return Response.json({ok:false,error:"A substantive human-review note of at least 12 characters is required."},{status:400});
    const reviewed=await withTransaction(async client=>{const locked=await client.query<{review_status:string}>(`select review_status from ${table} where id=$1 and matter_id=$2 for update`,[body.id,matterId]);if(!locked.rows[0])throw new Error("Graph object disappeared during review.");if(locked.rows[0].review_status!=="UNREVIEWED")return false;await client.query(`update ${table} set review_status=$2,reviewed_by=$3,reviewed_at=now(),review_note=$4 where id=$1 and matter_id=$5`,[body.id,status,principal.userId,note,matterId]);await client.query(`insert into audit_events(actor_user_id,actor_name,action,matter_id,entity_type,entity_id,metadata) values($1,$2,'GRAPH_REVIEWED',$3,$4,$5,$6::jsonb)`,[principal.userId,principal.name,matterId,entityType.toLowerCase(),body.id,JSON.stringify({from:locked.rows[0].review_status,to:status,noteRecorded:true})]);return true;});
    if(!reviewed)return Response.json({ok:false,error:"Only an UNREVIEWED graph object can receive a human disposition."},{status:409});
    return Response.json({ok:true,id:body.id,entityType,reviewStatus:status});
  }catch(error){const access=accessErrorResponse(error);if(access)return access;return internalErrorResponse(error,"Graph review could not be completed.");}
}
