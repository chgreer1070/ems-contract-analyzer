import { del } from "@vercel/blob";
import { handleUpload, type HandleUploadBody } from "@vercel/blob/client";
import { NextResponse } from "next/server";
import { accessErrorResponse, requireMatterAccess, type Principal } from "@/lib/access";
import { databaseConfigured, withTransaction } from "@/lib/db";
import { enforceRateLimit, rateLimitResponse } from "@/lib/rateLimit";
import { internalErrorResponse } from "@/lib/safeErrors";

const ALLOWED_TYPES = [
  "application/pdf",
  "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
  "text/plain"
];
const DOCUMENT_TYPES=new Set(["MSA","SOW","AMENDMENT","EXHIBIT","QUALITY","PRICING","PURCHASE_ORDER","OTHER"]);
const SOURCE_STATUSES=new Set(["CURRENT","SUPERSEDED","DRAFT","EXECUTED","REFERENCE"]);
const MAX_UPLOAD_BYTES=75*1024*1024;
class UploadRequestError extends Error {}

function parsePayload(raw: string | null | undefined) {
  if (!raw) throw new UploadRequestError("Missing document upload metadata.");
  let parsed:{ matterId?: string; documentType?: string; versionLabel?: string; filename?: string; sha256?: string; sizeBytes?: number; sourceStatus?: string };
  try{parsed=JSON.parse(raw);}catch{throw new UploadRequestError("Document upload metadata must be valid JSON.");}
  if (!parsed.matterId || !parsed.filename) throw new UploadRequestError("Matter and filename are required.");
  if(parsed.filename.length>255||/[\u0000-\u001f\u007f]/.test(parsed.filename))throw new UploadRequestError("Filename is invalid.");
  if (!parsed.sha256 || !/^[0-9a-f]{64}$/i.test(parsed.sha256)) throw new UploadRequestError("Valid SHA-256 is required.");
  const documentType=(parsed.documentType||"OTHER").toUpperCase();
  const sourceStatus=(parsed.sourceStatus||"CURRENT").toUpperCase();
  if(!DOCUMENT_TYPES.has(documentType))throw new UploadRequestError("Unsupported document type.");
  if(!SOURCE_STATUSES.has(sourceStatus))throw new UploadRequestError("Unsupported source status.");
  if(!Number.isFinite(parsed.sizeBytes)||Number(parsed.sizeBytes)<=0||Number(parsed.sizeBytes)>MAX_UPLOAD_BYTES)throw new UploadRequestError("Upload size metadata is invalid.");
  parsed.documentType=documentType;parsed.sourceStatus=sourceStatus;
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
        if (principal.demo) throw new UploadRequestError("Private document uploads are disabled in demo mode.");
        await enforceRateLimit(principal,"source-upload",100,86400);
        const prefix=`contracts/${metadata.matterId}/`;const relativePath=pathname.slice(prefix.length);
        if (!pathname.startsWith(prefix)||!relativePath||relativePath.length>300||relativePath.includes("\\")||relativePath.split("/").some(segment=>segment===".."||segment==="."||!segment)||/[\u0000-\u001f\u007f]/.test(relativePath)) throw new UploadRequestError("Upload pathname does not match the authorized matter.");
        return {allowedContentTypes:ALLOWED_TYPES,maximumSizeInBytes:MAX_UPLOAD_BYTES,addRandomSuffix:true,validUntil:Date.now()+10*60*1000,tokenPayload:JSON.stringify({...metadata,principal})};
      },
      onUploadCompleted: async ({ blob, tokenPayload }) => {
        const payload = JSON.parse(tokenPayload ?? "{}") as ReturnType<typeof parsePayload> & { principal: Principal };
        const principal = payload.principal;if (!principal || principal.demo) throw new UploadRequestError("Upload authorization metadata is invalid.");
        try{
          await withTransaction(async client=>{
            const inserted = await client.query<{ id: string }>(
              `insert into documents (matter_id,filename,document_type,version_label,mime_type,size_bytes,blob_url,blob_pathname,sha256,integrity_status,source_status,uploaded_by,security_scan_status) values ($1,$2,$3,$4,$5,$6,$7,$8,$9,'CLIENT_HASHED',$10,$11,'PENDING') on conflict(blob_pathname) do nothing returning id`,
              [payload.matterId,payload.filename,payload.documentType||"OTHER",payload.versionLabel||null,blob.contentType||"application/octet-stream",Number(payload.sizeBytes),blob.url,blob.pathname,payload.sha256,payload.sourceStatus||"CURRENT",principal.userId]
            );
            if(inserted.rows[0])await client.query(`insert into audit_events(actor_user_id,actor_name,action,matter_id,entity_type,entity_id,metadata) values($1,$2,'DOCUMENT_UPLOADED',$3,'document',$4,$5::jsonb)`,[principal.userId,principal.name,payload.matterId,inserted.rows[0].id,JSON.stringify({filename:payload.filename,documentType:payload.documentType||"OTHER",sha256:payload.sha256,securityScanStatus:"PENDING"})]);
          });
        }catch(error){
          const code=typeof error==="object"&&error&&"code" in error?String((error as {code?:unknown}).code??""):"";
          if(["22P02","22001","23503","23514"].includes(code)){
            try{await del(blob.pathname,{token:process.env.BLOB_READ_WRITE_TOKEN});}
            catch{throw new Error("Document registration was rejected and uploaded-blob cleanup also failed.",{cause:error});}
          }
          throw error;
        }
      }
    });
    return NextResponse.json(jsonResponse);
  } catch (error) {
    const rate=rateLimitResponse(error);if(rate)return rate;
    const access=accessErrorResponse(error);if(access)return access;
    if(error instanceof UploadRequestError)return Response.json({ok:false,error:error.message},{status:400});
    return internalErrorResponse(error,"Document upload could not be completed.",502);
  }
}
