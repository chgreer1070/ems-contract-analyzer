import { accessErrorResponse, requireMatterAccess } from "@/lib/access";
import { databaseConfigured, query } from "@/lib/db";

export async function GET(request:Request, context:{ params:Promise<{ id:string }> }) {
  try {
    if (!databaseConfigured()) return Response.json({ ok:true, mode:"demo", documents:[] });
    const { id } = await context.params;
    const principal = await requireMatterAccess(request, id, false);
    if (principal.demo) return Response.json({ ok:true, mode:"demo", documents:[] });

    const result = await query<{
      id:string; filename:string; document_type:string; version_label:string|null; mime_type:string; size_bytes:string;
      sha256:string|null; integrity_status:string; extraction_status:string; extraction_method:string|null; page_count:number|null;
      source_status:string; uploaded_at:string;
    }>(
      `select id,filename,document_type,version_label,mime_type,size_bytes,sha256,integrity_status,
              extraction_status,extraction_method,page_count,source_status,uploaded_at
         from documents where matter_id=$1 order by uploaded_at desc`,
      [id]
    );
    return Response.json({ ok:true, mode:"database", documents:result.rows.map((row) => ({ ...row, size_bytes:Number(row.size_bytes) })) });
  } catch (error) {
    const access = accessErrorResponse(error);
    if (access) return access;
    return Response.json({ ok:false, error:"Unable to load documents." }, { status:500 });
  }
}
