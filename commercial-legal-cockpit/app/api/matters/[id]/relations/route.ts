import { accessErrorResponse, requireMatterAccess } from "@/lib/access";
import { databaseConfigured, query, withTransaction } from "@/lib/db";
import { internalErrorResponse } from "@/lib/safeErrors";

const allowed=new Set(["AMENDS","SUPERSEDES","INCORPORATES","CONTROLS","CONFLICTS_WITH","IMPLEMENTS","REFERENCES"]);

export async function POST(request:Request,context:{params:Promise<{id:string}>}){
  try{
    if(!databaseConfigured())return Response.json({ok:false,error:"Document relationship recording requires DATABASE_URL."},{status:503});
    const {id:matterId}=await context.params;const principal=await requireMatterAccess(request,matterId,true);
    if(principal.demo)return Response.json({ok:false,error:"Persisted relations are disabled in demo mode."},{status:503});
    const body=await request.json() as {sourceDocumentId?:string;targetDocumentId?:string;relationType?:string;sourceLocator?:string;rationale?:string};
    if(!body.sourceDocumentId||!body.targetDocumentId||!body.relationType||!allowed.has(body.relationType)||!body.rationale?.trim())return Response.json({ok:false,error:"Valid sourceDocumentId, targetDocumentId, relationType and rationale are required."},{status:400});
    const rationale=body.rationale.trim();
    if(rationale.length<12||rationale.length>4000)return Response.json({ok:false,error:"Counsel rationale must be between 12 and 4000 characters."},{status:400});
    if(body.sourceDocumentId===body.targetDocumentId)return Response.json({ok:false,error:"A document cannot relate to itself."},{status:400});
    const docs=await query<{id:string}>("select id from documents where matter_id=$1 and id=any($2::uuid[])",[matterId,[body.sourceDocumentId,body.targetDocumentId]]);
    if(docs.rowCount!==2)return Response.json({ok:false,error:"Both documents must belong to the selected matter."},{status:409});
    const result=await withTransaction(async client=>{const inserted=await client.query<{id:string}>(`insert into document_relations(matter_id,origin,source_document_id,target_document_id,relation_type,source_locator,rationale,confidence,review_status,created_by,reviewed_by,reviewed_at,review_note) values($1,'COUNSEL',$2,$3,$4,$5,$6,1,'VALIDATED',$7,$7,now(),$6) returning id`,[matterId,body.sourceDocumentId,body.targetDocumentId,body.relationType,body.sourceLocator?.trim()||null,rationale,principal.userId]);await client.query(`insert into audit_events(actor_user_id,actor_name,action,matter_id,entity_type,entity_id,metadata) values($1,$2,'DOCUMENT_RELATION_RECORDED',$3,'document_relation',$4,$5::jsonb)`,[principal.userId,principal.name,matterId,inserted.rows[0].id,JSON.stringify({sourceDocumentId:body.sourceDocumentId,targetDocumentId:body.targetDocumentId,relationType:body.relationType,origin:"COUNSEL"})]);return inserted;});
    return Response.json({ok:true,id:result.rows[0].id,reviewStatus:"VALIDATED"});
  }catch(error){const access=accessErrorResponse(error);if(access)return access;return internalErrorResponse(error,"The document relationship could not be recorded.");}
}
