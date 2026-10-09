import { extractText, getDocumentProxy } from "unpdf";
import { chunkText, type SourceChunk } from "@/lib/chunking";
import { extractDocx } from "@/lib/docxExtraction";
import type { DocxEvidence } from "@/lib/docxEvidence";

export type ExtractionResult = {
  method: "PDF_TEXT" | "DOCX_OOXML_EVIDENCE" | "PLAIN_TEXT" | "EXTERNAL_LAYOUT_REQUIRED";
  pageCount: number | null;
  chunks: SourceChunk[];
  warnings: string[];
  docxEvidence?: DocxEvidence;
};

export async function extractDocument(bytes: ArrayBuffer, mimeType: string): Promise<ExtractionResult> {
  if (mimeType === "application/pdf") {
    const pdf = await getDocumentProxy(new Uint8Array(bytes));
    const extracted = await extractText(pdf, { mergePages: false });
    const pages = Array.isArray(extracted.text) ? extracted.text : [extracted.text];
    const chunks = pages.flatMap((text, pageIndex) => chunkText(text, { pageNumber: pageIndex + 1 }));
    return { method:"PDF_TEXT",pageCount:extracted.totalPages,chunks,warnings:chunks.length?[]:["No machine-readable PDF text was extracted. External layout/OCR processing is required."] };
  }

  if (mimeType === "application/vnd.openxmlformats-officedocument.wordprocessingml.document") {
    const result = extractDocx(bytes);
    return { method:"DOCX_OOXML_EVIDENCE",pageCount:null,chunks:result.chunks,docxEvidence:result.evidence,warnings:["DOCX original and proposed views are negotiation evidence. Revision authors are unverified metadata; counsel must establish party identity and operative text.",...result.evidence.issues.map(issue=>`${issue.code}: ${issue.message}`)] };
  }

  if (mimeType === "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet" || mimeType === "application/vnd.ms-excel") {
    return { method:"EXTERNAL_LAYOUT_REQUIRED",pageCount:null,chunks:[],warnings:["Spreadsheet extraction is delegated to Azure Document Intelligence Layout so worksheet/table structure remains in the controlled source-processing path."] };
  }

  if (mimeType === "text/plain") {
    const text = new TextDecoder("utf-8", { fatal: false }).decode(bytes);
    return { method:"PLAIN_TEXT",pageCount:null,chunks:chunkText(text),warnings:[] };
  }

  throw new Error(`Text extraction is not supported for MIME type ${mimeType}.`);
}
