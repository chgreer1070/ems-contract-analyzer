import { createHash } from "node:crypto";

export type SourceChunk = {
  pageNumber: number | null;
  chunkIndex: number;
  text: string;
  sha256: string;
};

function hashText(text: string) {
  return createHash("sha256").update(text, "utf8").digest("hex");
}

export function chunkText(text: string, options: { pageNumber?: number | null; maxChars?: number; overlapChars?: number } = {}): SourceChunk[] {
  const pageNumber = options.pageNumber ?? null;
  const maxChars = Math.max(1000, options.maxChars ?? 3500);
  const overlapChars = Math.min(maxChars - 200, Math.max(0, options.overlapChars ?? 250));
  const normalized = text.replace(/\r\n/g, "\n").replace(/[\t ]+/g, " ").trim();
  if (!normalized) return [];

  const chunks: SourceChunk[] = [];
  let start = 0;
  let index = 0;
  while (start < normalized.length) {
    let end = Math.min(normalized.length, start + maxChars);
    if (end < normalized.length) {
      const paragraph = normalized.lastIndexOf("\n\n", end);
      const sentence = normalized.lastIndexOf(". ", end);
      const preferred = Math.max(paragraph, sentence);
      if (preferred > start + Math.floor(maxChars * 0.55)) end = preferred + (preferred === sentence ? 2 : 0);
    }
    const value = normalized.slice(start, end).trim();
    if (value) chunks.push({ pageNumber, chunkIndex: index++, text: value, sha256: hashText(value) });
    if (end >= normalized.length) break;
    start = Math.max(start + 1, end - overlapChars);
  }
  return chunks;
}
