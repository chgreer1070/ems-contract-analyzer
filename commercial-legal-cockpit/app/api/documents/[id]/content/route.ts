import { get } from "@vercel/blob";
import { accessErrorResponse, requireResourceMatterAccess } from "@/lib/access";
import { databaseConfigured, query } from "@/lib/db";
import { internalErrorResponse } from "@/lib/safeErrors";

export async function GET(request:Request, context:{ params:Promise<{ id:string }> }) {
  try {
    if (!databaseConfigured()) return Response.json({ ok:false, error:"Document access requires DATABASE_URL." }, { status:503 });
    if (!process.env.BLOB_READ_WRITE_TOKEN) return Response.json({ ok:false, error:"Private Blob storage is not configured." }, { status:503 });
    const { id } = await context.params;
    const {matterId}=await requireResourceMatterAccess(request,"DOCUMENT",id,"VIEW");
    const result = await query<{ matter_id:string; blob_pathname:string; filename:string; mime_type:string; deletion_status:string; security_scan_status:string }>(
      "select matter_id,blob_pathname,filename,mime_type,deletion_status,security_scan_status from documents where id=$1 and matter_id=$2 limit 1",
      [id,matterId]
    );
    const doc = result.rows[0];
    if (!doc) return Response.json({ ok:false, error:"Document is no longer available." }, { status:404 });
    if(doc.deletion_status==="PURGED")return Response.json({ok:false,error:"The source object has been purged under records-management controls. Audit metadata is retained."},{status:410});
    if(doc.deletion_status!=="ACTIVE")return Response.json({ok:false,error:`Source retrieval is blocked while deletion state is ${doc.deletion_status}.`},{status:423});
    if(doc.security_scan_status!=="CLEAN")return Response.json({ok:false,error:`Source retrieval is blocked until malware scanning reports CLEAN (current state: ${doc.security_scan_status}).`},{status:423});

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
    return internalErrorResponse(error,"The document could not be retrieved.");
  }
}
