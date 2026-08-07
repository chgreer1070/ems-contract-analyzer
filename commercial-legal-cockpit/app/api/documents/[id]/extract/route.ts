import { createHash } from "node:crypto";
import { get } from "@vercel/blob";
import { accessErrorResponse, requireMatterAccess } from "@/lib/access";
import { writeAuditEvent } from "@/lib/audit";
import { databaseConfigured, query, withTransaction } from "@/lib/db";
import { extractDocument } from "@/lib/documentExtraction";

const MAX_INLINE_EXTRACTION_BYTES = 30 * 1024 * 1024;

export async function POST(request: Request, context: { params: Promise<{ id: string }> }) {
  try {
    if (!databaseConfigured()) return Response.json({ ok:false, error:"Document extraction requires DATABASE_URL." }, { status:503 });
    if (!process.env.BLOB_READ_WRITE_TOKEN) return Response.json({ ok:false, error:"Private Blob storage is not configured." }, { status:503 });

    const { id } = await context.params;
    const document = await query<{
      id:string; matter_id:string; filename:string; mime_type:string; size_bytes:string; blob_pathname:string; sha256:string|null;
    }>(
      "select id,matter_id,filename,mime_type,size_bytes,blob_pathname,sha256 from documents where id = $1 limit 1",
      [id]
    );
    const doc = document.rows[0];
    if (!doc) return Response.json({ ok:false, error:"Document not found." }, { status:404 });

    const principal = await requireMatterAccess(request, doc.matter_id, true);
    if (principal.demo) return Response.json({ ok:false, error:"Document extraction is disabled in demo mode." }, { status:503 });
    if (Number(doc.size_bytes) > MAX_INLINE_EXTRACTION_BYTES) {
      return Response.json({ ok:false, error:"Document exceeds the 30 MB inline extraction limit; route it to the external OCR/processing worker." }, { status:413 });
    }

    const blob = await get(doc.blob_pathname, { access:"private", token:process.env.BLOB_READ_WRITE_TOKEN });
    if (!blob || blob.statusCode !== 200 || !blob.stream) return Response.json({ ok:false, error:"Source blob not found." }, { status:404 });
    const bytes = await new Response(blob.stream).arrayBuffer();
    const serverSha = createHash("sha256").update(Buffer.from(bytes)).digest("hex");
    if (doc.sha256 && doc.sha256.toLowerCase() !== serverSha.toLowerCase()) {
      await query("update documents set integrity_status = 'FAILED', extraction_status = 'FAILED' where id = $1", [id]);
      return Response.json({ ok:false, error:"Source integrity verification failed. Extraction stopped." }, { status:409 });
    }

    const extraction = await extractDocument(bytes, doc.mime_type);
    if (!extraction.chunks.length) {
      await query(
        "update documents set integrity_status='SERVER_VERIFIED', extraction_status='OCR_REQUIRED', extraction_method=$2, extracted_at=now(), page_count=$3 where id=$1",
        [id, extraction.method, extraction.pageCount]
      );
      return Response.json({ ok:false, extractionStatus:"OCR_REQUIRED", warnings:extraction.warnings }, { status:422 });
    }

    await withTransaction(async (client) => {
      await client.query("delete from document_chunks where document_id = $1", [id]);
      for (const chunk of extraction.chunks) {
        await client.query(
          `insert into document_chunks(document_id,matter_id,page_number,chunk_index,content,content_sha256)
           values ($1,$2,$3,$4,$5,$6)`,
          [id, doc.matter_id, chunk.pageNumber, chunk.chunkIndex, chunk.text, chunk.sha256]
        );
      }
      await client.query(
        `update documents
            set integrity_status='SERVER_VERIFIED', extraction_status='EXTRACTED', extraction_method=$2,
                extracted_at=now(), page_count=$3, server_sha256=$4
          where id=$1`,
        [id, extraction.method, extraction.pageCount, serverSha]
      );
    });

    await writeAuditEvent({
      principal,
      action: "DOCUMENT_EXTRACTED",
      matterId: doc.matter_id,
      entityType: "document",
      entityId: id,
      metadata: { filename:doc.filename, method:extraction.method, pageCount:extraction.pageCount, chunkCount:extraction.chunks.length, serverSha256:serverSha }
    });

    return Response.json({
      ok:true,
      extractionStatus:"EXTRACTED",
      method:extraction.method,
      pageCount:extraction.pageCount,
      chunkCount:extraction.chunks.length,
      integrityStatus:"SERVER_VERIFIED",
      warnings:extraction.warnings
    });
  } catch (error) {
    const access = accessErrorResponse(error);
    if (access) return access;
    return Response.json({ ok:false, error:error instanceof Error ? error.message : "Document extraction failed." }, { status:500 });
  }
}
