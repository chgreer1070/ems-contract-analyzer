import { get } from "@vercel/blob";
import { accessErrorResponse, requireMatterAccess } from "@/lib/access";
import { databaseConfigured, query } from "@/lib/db";

export async function GET(request:Request, context:{ params:Promise<{ id:string }> }) {
  try {
    if (!databaseConfigured()) return Response.json({ ok:false, error:"Document access requires DATABASE_URL." }, { status:503 });
    if (!process.env.BLOB_READ_WRITE_TOKEN) return Response.json({ ok:false, error:"Private Blob storage is not configured." }, { status:503 });
    const { id } = await context.params;
    const result = await query<{ matter_id:string; blob_pathname:string; filename:string; mime_type:string; deletion_status:string }>(
      "select matter_id,blob_pathname,filename,mime_type,deletion_status from documents where id=$1 limit 1",
      [id]
    );
    const doc = result.rows[0];
    if (!doc) return Response.json({ ok:false, error:"Document not found." }, { status:404 });
    await requireMatterAccess(request, doc.matter_id, false);
    if(doc.deletion_status==="PURGED")return Response.json({ok:false,error:"The source object has been purged under records-management controls. Audit metadata is retained."},{status:410});

    const blob = await get(doc.blob_pathname, {
      access:"private",
      token:process.env.BLOB_READ_WRITE_TOKEN,
      ifNoneMatch:request.headers.get("if-none-match") ?? undefined
    });
    if (!blob) return new Response("Not found", { status:404 });
    if (blob.statusCode === 304) {
      return new Response(null, { status:304, headers:{ ETag:blob.blob.etag, "Cache-Control":"private, no-cache" } });
    }
    return new Response(blob.stream, {
      headers:{
        "Content-Type":blob.blob.contentType || doc.mime_type,
        "Content-Disposition":`inline; filename*=UTF-8''${encodeURIComponent(doc.filename)}`,
        "X-Content-Type-Options":"nosniff",
        "Cache-Control":"private, no-cache, no-store",
        ETag:blob.blob.etag
      }
    });
  } catch (error) {
    const access = accessErrorResponse(error);
    if (access) return access;
    return Response.json({ ok:false, error:"Unable to retrieve document." }, { status:500 });
  }
}
