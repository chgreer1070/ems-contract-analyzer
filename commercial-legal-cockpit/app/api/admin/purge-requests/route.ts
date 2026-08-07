import { accessErrorResponse, requireRole } from "@/lib/access";
import { databaseConfigured, query } from "@/lib/db";

export async function GET(request:Request){
  try{
    const principal=await requireRole(request,"ADMIN");if(principal.demo||!databaseConfigured())return Response.json({ok:true,mode:"demo",requests:[]});
    const result=await query<any>(`select pr.id,pr.matter_id,m.matter_number,c.name customer,pr.document_id,d.filename,pr.requested_by,ru.email requested_by_email,pr.requested_at,pr.reason,pr.status,pr.approved_by,au.email approved_by_email,pr.approved_at,pr.executed_by,pr.executed_at,d.legal_hold document_hold,m.legal_hold matter_hold,d.retention_until document_retention,m.retention_until matter_retention,d.deletion_status from purge_requests pr join documents d on d.id=pr.document_id join matters m on m.id=pr.matter_id join customers c on c.id=m.customer_id left join "user" ru on ru.id=pr.requested_by left join "user" au on au.id=pr.approved_by order by case pr.status when 'PENDING' then 1 when 'APPROVED' then 2 else 3 end,pr.requested_at desc limit 250`);
    return Response.json({ok:true,mode:"database",requests:result.rows});
  }catch(error){const access=accessErrorResponse(error);if(access)return access;return Response.json({ok:false,error:"Unable to load purge requests."},{status:500});}
}
