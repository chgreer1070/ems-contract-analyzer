export class MatterReadingError extends Error {
  status: number;
  constructor(message: string, status?: number);
}

export const MATTER_READING_LIMITS: { documents: number; characters: number };

export type MatterReadingDocument = {
  id: string;
  filename: string;
  documentType: string;
  extractionMethod: string | null;
  extractionStatus: string;
  integrityStatus: string;
  securityScanStatus: string;
  deletionStatus: string;
  sourceStatus: string;
};

export type MatterReadingPayload = {
  name: string;
  role: "base" | "amendment";
  text: string;
};

export function textFromChunks(document: MatterReadingDocument, chunks: string[]): string;

export function buildMatterReadingRequest(input: {
  documents: MatterReadingDocument[];
  chunksByDocumentId: Map<string, string[]>;
  baseDocumentId: string;
  amendmentDocumentIds: string[];
}): {
  base: MatterReadingPayload;
  amendments: MatterReadingPayload[];
  notes: string[];
  documents: Array<{
    id: string;
    filename: string;
    documentType: string;
    sourceStatus: string;
    extractionMethod: string | null;
  }>;
};
