import * as mammoth from "mammoth";
import { extractText, getDocumentProxy } from "unpdf";
import { chunkText, type SourceChunk } from "@/lib/chunking";

export type ExtractionResult = {
  method: "PDF_TEXT" | "DOCX_RAW_TEXT" | "PLAIN_TEXT";
  pageCount: number | null;
  chunks: SourceChunk[];
  warnings: string[];
};

export async function extractDocument(bytes: ArrayBuffer, mimeType: string): Promise<ExtractionResult> {
  if (mimeType === "application/pdf") {
    const pdf = await getDocumentProxy(new Uint8Array(bytes));
    const extracted = await extractText(pdf, { mergePages: false });
    const pages = Array.isArray(extracted.text) ? extracted.text : [extracted.text];
    const chunks = pages.flatMap((text, pageIndex) => chunkText(text, { pageNumber: pageIndex + 1 }));
    return {
      method: "PDF_TEXT",
      pageCount: extracted.totalPages,
      chunks,
      warnings: chunks.length ? [] : ["No machine-readable PDF text was extracted. OCR may be required."]
    };
  }

  if (mimeType === "application/vnd.openxmlformats-officedocument.wordprocessingml.document") {
    const result = await mammoth.extractRawText({ buffer: Buffer.from(bytes) });
    return {
      method: "DOCX_RAW_TEXT",
      pageCount: null,
      chunks: chunkText(result.value, { pageNumber: null }),
      warnings: result.messages.map((message) => message.message)
    };
  }

  if (mimeType === "text/plain") {
    const text = new TextDecoder("utf-8", { fatal: false }).decode(bytes);
    return { method: "PLAIN_TEXT", pageCount: null, chunks: chunkText(text), warnings: [] };
  }

  throw new Error(`Text extraction is not yet supported for MIME type ${mimeType}.`);
}
