import { handleUpload, type HandleUploadBody } from "@vercel/blob/client";
import { NextResponse } from "next/server";
import { accessErrorResponse, requireMatterAccess, type Principal } from "@/lib/access";
import { databaseConfigured, query } from "@/lib/db";
import { writeAuditEvent } from "@/lib/audit";
import { enforceRateLimit, rateLimitResponse } from "@/lib/rateLimit";

const ALLOWED_TYPES = [
  "application/pdf",
  "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
  "text/plain"
];

function parsePayload(raw: string | null | undefined) {
  if (!raw) throw new Error("Missing document upload metadata.");
  const parsed = JSON.parse(raw) as { matterId?: string; documentType?: string; versionLabel?: string; filename?: string; sha256?: string; sizeBytes?: number; sourceStatus?: string };
  if (!parsed.matterId || !parsed.filename) throw new Error("Matter and filename are required.");
  if (!parsed.sha256 || !/^[0-9a-f]{64}$/i.test(parsed.sha256)) throw new Error("Valid SHA-256 is required.");
  return parsed;
}

export async function POST(request: Request) {
  try {
    if (!process.env.BLOB_READ_WRITE_TOKEN) return Response.json({ ok:false,error:"Private document storage is not configured."},{status:503});
    if (!databaseConfigured()) return Response.json({ok:false,error:"Document registration requires DATABASE_URL."},{status:503});

    const body = (await request.json()) as HandleUploadBody;
    const jsonResponse = await handleUpload({
      body,
      request,
      token: process.env.BLOB_READ_WRITE_TOKEN,
      onBeforeGenerateToken: async (pathname, clientPayload) => {
        const metadata = parsePayload(clientPayload);
        const principal = await requireMatterAccess(request, metadata.matterId as string, true);
        if (principal.demo) throw new Error("Private document uploads are disabled in demo mode.");
        await enforceRateLimit(principal,"source-upload",100,86400);
        if (!pathname.startsWith(`contracts/${metadata.matterId}/`)) throw new Error("Upload pathname does not match the authorized matter.");
        return {allowedContentTypes:ALLOWED_TYPES,maximumSizeInBytes:75*1024*1024,addRandomSuffix:true,tokenPayload:JSON.stringify({...metadata,principal})};
      },
      onUploadCompleted: async ({ blob, tokenPayload }) => {
        const payload = JSON.parse(tokenPayload ?? "{}") as ReturnType<typeof parsePayload> & { principal: Principal };
        const principal = payload.principal;if (!principal || principal.demo) throw new Error("Invalid upload principal.");
        const inserted = await query<{ id: string }>(
          `insert into documents (matter_id,filename,document_type,version_label,mime_type,size_bytes,blob_url,blob_pathname,sha256,integrity_status,source_status,uploaded_by) values ($1,$2,$3,$4,$5,$6,$7,$8,$9,'CLIENT_HASHED',$10,$11) returning id`,
          [payload.matterId,payload.filename,payload.documentType||"OTHER",payload.versionLabel||null,blob.contentType||"application/octet-stream",Number(payload.sizeBytes||0),blob.url,blob.pathname,payload.sha256,payload.sourceStatus||"CURRENT",principal.userId]
        );
        await writeAuditEvent({principal,action:"DOCUMENT_UPLOADED",matterId:payload.matterId,entityType:"document",entityId:inserted.rows[0]?.id,metadata:{filename:payload.filename,documentType:payload.documentType||"OTHER",sha256:payload.sha256,blobPathname:blob.pathname}});
      }
    });
    return NextResponse.json(jsonResponse);
  } catch (error) {
    const rate=rateLimitResponse(error);if(rate)return rate;
    const access=accessErrorResponse(error);if(access)return access;
    const message=error instanceof Error?error.message:"Document upload failed.";
    return Response.json({ok:false,error:message},{status:400});
  }
}
