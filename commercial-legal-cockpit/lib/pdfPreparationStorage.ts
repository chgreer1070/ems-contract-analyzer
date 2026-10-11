import { get } from "@vercel/blob";
import { PdfPreparationError } from "@/lib/pdfPreparation";

export async function readBoundedPreparationStream(stream: ReadableStream<Uint8Array>, maxBytes: number, timeoutMs = 30_000) {
  if (!Number.isSafeInteger(maxBytes) || maxBytes < 1 || !Number.isSafeInteger(timeoutMs) || timeoutMs < 1) throw new PdfPreparationError("Invalid stream limit.");
  const reader = stream.getReader();
  const chunks: Uint8Array[] = [];
  let length = 0;
  let timer: ReturnType<typeof setTimeout>;
  const deadline = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new PdfPreparationError("PDF preparation input timed out.", 408)), timeoutMs);
  });
  try {
    while (true) {
      const part = await Promise.race([reader.read(), deadline]);
      if (part.done) break;
      length += part.value.length;
      if (length > maxBytes) {
        throw new PdfPreparationError("PDF object exceeds the preparation size limit.", 409);
      }
      chunks.push(part.value);
    }
  } catch (error) {
    // Cancellation must not delay returning an error if an underlying source stalls.
    void reader.cancel().catch(() => {});
    throw error;
  } finally { clearTimeout(timer!); reader.releaseLock(); }
  return Buffer.concat(chunks, length);
}

export async function readPrivatePdfBytes(pathname: string, maxBytes: number) {
  const blob = await get(pathname, {
    access: "private", token: process.env.BLOB_READ_WRITE_TOKEN,
    useCache: false, abortSignal: AbortSignal.timeout(30_000)
  });
  if (!blob || blob.statusCode !== 200 || !blob.stream) throw new PdfPreparationError("PDF object is unavailable.", 409);
  return readBoundedPreparationStream(blob.stream, maxBytes);
}

export function pdfPreparationEnabled() {
  return process.env.PDF_PREPARATION_ENABLED === "true";
}

export async function readPreparationJson(request: Request) {
  if (!request.body) throw new PdfPreparationError("Expected a JSON preparation request.");
  let bytes: Buffer;
  try {
    bytes = await readBoundedPreparationStream(request.body, 8192, 10_000);
  } catch (error) {
    if (error instanceof PdfPreparationError && error.status === 409) throw new PdfPreparationError("Preparation request is too large.", 413);
    throw error;
  }
  try { return JSON.parse(bytes.toString("utf8")) as unknown; }
  catch { throw new PdfPreparationError("Expected a JSON preparation request."); }
}
