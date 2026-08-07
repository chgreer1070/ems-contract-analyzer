import { accessErrorResponse, requireMatterAccess } from "@/lib/access";
import { databaseConfigured, query } from "@/lib/db";

export async function GET(request:Request,context:{params:Promise<{id:string}>}){
  try{
    if(!databaseConfigured())return Response.json({ok:false,error:"Graph workspace requires DATABASE_URL."},{status:503});
    const {id}=await context.params;await requireMatterAccess(request,id,false);
    const [terms,deps,relations,versions]=await Promise.all([
      query<any>(`select t.id,t.document_id,d.filename,t.clause_family,t.section_label,t.term_type,t.party,t.counterparty,t.normalized_statement,t.trigger_event,t.operational_owner,t.confidence,t.review_status,t.exact_text,dc.page_number,dc.chunk_index from contract_terms t join documents d on d.id=t.document_id left join document_chunks dc on dc.id=t.chunk_id where t.matter_id=$1 and t.review_status<>'SUPERSEDED' order by d.uploaded_at,coalesce(dc.page_number,0),dc.chunk_index,t.created_at`,[id]),
      query<any>(`select td.id,td.source_term_id,td.target_term_id,td.dependency_type,td.rationale,td.confidence,td.review_status from term_dependencies td where td.matter_id=$1 order by td.created_at`,[id]),
      query<any>(`select r.id,r.source_document_id,sd.filename source_document,r.target_document_id,td.filename target_document,r.relation_type,r.source_locator,r.rationale,r.confidence,r.review_status from document_relations r join documents sd on sd.id=r.source_document_id join documents td on td.id=r.target_document_id where r.matter_id=$1 order by r.created_at`,[id]),
      query<any>(`select av.id,av.version_number,av.label,av.status,av.effective_date,av.created_at,json_agg(json_build_object('documentId',d.id,'filename',d.filename,'documentType',d.document_type,'displayOrder',avd.display_order) order by avd.display_order) filter(where d.id is not null) documents from agreement_versions av left join agreement_version_documents avd on avd.agreement_version_id=av.id left join documents d on d.id=avd.document_id where av.matter_id=$1 group by av.id order by av.version_number desc`,[id])
    ]);
    return Response.json({ok:true,matterId:id,terms:terms.rows,dependencies:deps.rows,documentRelations:relations.rows,agreementVersions:versions.rows,humanReviewRequired:true});
  }catch(error){const access=accessErrorResponse(error);if(access)return access;return Response.json({ok:false,error:error instanceof Error?error.message:"Unable to load graph."},{status:500});}
}
