import { get } from "@vercel/blob";
import { PdfPreparationError } from "@/lib/pdfPreparation";

export async function readPrivatePdfBytes(pathname: string, maxBytes: number) {
  const blob = await get(pathname, { access: "private", token: process.env.BLOB_READ_WRITE_TOKEN });
  if (!blob || blob.statusCode !== 200 || !blob.stream) throw new PdfPreparationError("PDF object is unavailable.", 409);
  const reader = blob.stream.getReader();
  const chunks: Uint8Array[] = [];
  let length = 0;
  try {
    while (true) {
      const part = await reader.read();
      if (part.done) break;
      length += part.value.length;
      if (length > maxBytes) {
        await reader.cancel();
        throw new PdfPreparationError("PDF object exceeds the preparation size limit.", 409);
      }
      chunks.push(part.value);
    }
  } finally { reader.releaseLock(); }
  return Buffer.concat(chunks, length);
}

export function pdfPreparationEnabled() {
  return process.env.PDF_PREPARATION_ENABLED === "true";
}

export async function readPreparationJson(request: Request) {
  if (!request.body) throw new PdfPreparationError("Expected a JSON preparation request.");
  const reader = request.body.getReader();
  const chunks: Uint8Array[] = [];
  let length = 0;
  try {
    while (true) {
      const part = await reader.read();
      if (part.done) break;
      length += part.value.length;
      if (length > 8192) { await reader.cancel(); throw new PdfPreparationError("Preparation request is too large.", 413); }
      chunks.push(part.value);
    }
  } finally { reader.releaseLock(); }
  try { return JSON.parse(Buffer.concat(chunks, length).toString("utf8")) as unknown; }
  catch { throw new PdfPreparationError("Expected a JSON preparation request."); }
}
