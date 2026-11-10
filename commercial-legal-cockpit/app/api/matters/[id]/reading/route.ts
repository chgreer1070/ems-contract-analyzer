import { createHash } from "node:crypto";
import { get } from "@vercel/blob";
import { extractDocument } from "@/lib/documentExtraction";
import { accessErrorResponse, requireMatterAccess } from "@/lib/access";
import { ContractTwinRequestError, analyzeAgreementText } from "@/lib/contracttwinCoreClient";
import { databaseConfigured, query } from "@/lib/db";
import { MatterReadingError, assertReadable, projectReadingCitations, projectReadingFacts, buildMatterReadingRequest, type MatterReadingDocument } from "@/lib/matterDocumentReading.mjs";
import { internalErrorResponse } from "@/lib/safeErrors";

const UUID_PATTERN = /^[0-9a-f]{8}-(?:[0-9a-f]{4}-){3}[0-9a-f]{12}$/i;
const BODY_LIMIT = 16_384;

type StoredDocument = {
  id: string;
  filename: string;
  document_type: string;
  extraction_method: string | null;
  extraction_status: string;
  integrity_status: string;
  security_scan_status: string;
  deletion_status: string;
  source_status: string;
  blob_pathname: string;
  mime_type: string;
  server_sha256: string;
};

function serviceConfig(): { serviceUrl: string; apiKey: string } | null {
  const serviceUrl = process.env.CONTRACTTWIN_CORE_URL;
  const apiKey = process.env.CONTRACTTWIN_API_KEY;
  if (!serviceUrl || !apiKey) return null;
  return { serviceUrl, apiKey };
}

async function readBody(request: Request): Promise<unknown> {
  const reader = request.body?.getReader();
  if (!reader) throw new MatterReadingError("JSON body required.", 400);
  const chunks: Uint8Array[] = [];
  let size = 0;
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.byteLength;
    if (size > BODY_LIMIT) {
      await reader.cancel();
      throw new MatterReadingError("Request exceeds 16 KiB.", 413);
    }
    chunks.push(value);
  }
  try {
    return JSON.parse(Buffer.concat(chunks).toString("utf8")) as unknown;
  } catch {
    throw new MatterReadingError("Valid JSON required.", 400);
  }
}

function documentIds(body: unknown): { baseDocumentId: string; amendmentDocumentIds: string[] } {
  if (!body || typeof body !== "object" || Array.isArray(body)) throw new MatterReadingError("JSON object required.", 400);
  const record = body as { baseDocumentId?: unknown; amendmentDocumentIds?: unknown };
  if (typeof record.baseDocumentId !== "string" || !UUID_PATTERN.test(record.baseDocumentId)) {
    throw new MatterReadingError("Choose the base agreement.", 400);
  }
  const amendments = record.amendmentDocumentIds ?? [];
  if (!Array.isArray(amendments) || amendments.some((id) => typeof id !== "string" || !UUID_PATTERN.test(id))) {
    throw new MatterReadingError("Amendments must be a list of documents in this matter.", 400);
  }
  return { baseDocumentId: record.baseDocumentId, amendmentDocumentIds: amendments };
}

function toReadingDocument(row: StoredDocument): MatterReadingDocument {
  return {
    id: row.id,
    filename: row.filename,
    documentType: row.document_type,
    extractionMethod: row.extraction_method,
    extractionStatus: row.extraction_status,
    integrityStatus: row.integrity_status,
    securityScanStatus: row.security_scan_status,
    deletionStatus: row.deletion_status,
    sourceStatus: row.source_status,
  };
}

export async function POST(request: Request, context: { params: Promise<{ id: string }> }) {
  try {
    if (!databaseConfigured()) {
      return Response.json({ ok: false, error: "A matter reading needs the matter database." }, { status: 503 });
    }
    const { id } = await context.params;
    await requireMatterAccess(request, id, "VIEW");
    const config = serviceConfig();
    if (!config) return Response.json({ ok: false, error: "The reading service is not configured." }, { status: 503 });
    const { baseDocumentId, amendmentDocumentIds } = documentIds(await readBody(request));
    const ids = [baseDocumentId, ...amendmentDocumentIds];
    const loadSources = () => query<StoredDocument>(
      `select id, filename, document_type, extraction_method, extraction_status, integrity_status,
              security_scan_status, deletion_status, source_status, blob_pathname, mime_type, server_sha256
         from documents
        where matter_id = $1 and id = any($2::uuid[])`,
      [id, ids],
    );
    const stored = await loadSources();
    const assertSourcesUnchanged = async () => {
      await requireMatterAccess(request, id, "VIEW");
      const current = await loadSources();
      const byId = new Map(current.rows.map(document => [document.id, document]));
      if (current.rows.length !== stored.rows.length || stored.rows.some(document => {
        const latest = byId.get(document.id);
        return !latest || (Object.keys(document) as Array<keyof StoredDocument>).some(key => latest[key] !== document[key]);
      })) throw new MatterReadingError("The source documents changed during reading. Reload the matter and try again.", 409);
    };
    if (ids.length > 12 || new Set(ids).size !== ids.length) throw new MatterReadingError("Choose at most 12 distinct documents.", 400);
    if (stored.rows.length !== ids.length) throw new MatterReadingError("A selected document is not in this matter.", 404);
    const chunksByDocumentId = new Map<string, string[]>();
    const extractionWarnings: string[] = [];
    let totalCharacters = 0;
    for (const document of stored.rows) {
      assertReadable(toReadingDocument(document));
      const blob = await get(document.blob_pathname, { access: "private", token: process.env.BLOB_READ_WRITE_TOKEN });
      if (!blob || blob.statusCode !== 200 || !blob.stream) throw new MatterReadingError("The verified source file is unavailable.", 409);
      const bytes = await new Response(blob.stream).arrayBuffer();
      const sha = createHash("sha256").update(Buffer.from(bytes)).digest("hex");
      if (sha !== document.server_sha256?.toLowerCase()) throw new MatterReadingError("The source file no longer matches its verified hash.", 409);
      const extracted = await extractDocument(bytes, document.mime_type);
      if (extracted.method !== document.extraction_method || extracted.canonicalText === undefined) throw new MatterReadingError("Canonical agreement text is unavailable.", 409);
      totalCharacters += extracted.canonicalText.length;
      if (totalCharacters > 1_500_000) throw new MatterReadingError("The extracted text is too large to read in one request.", 413);
      chunksByDocumentId.set(document.id, [extracted.canonicalText]);
      extractionWarnings.push(...extracted.warnings.map(warning => `${document.filename}: ${warning}`));
    }
    const reading = buildMatterReadingRequest({
      documents: stored.rows.map(toReadingDocument),
      chunksByDocumentId,
      baseDocumentId,
      amendmentDocumentIds,
    });
    await assertSourcesUnchanged();
    const analysis = await analyzeAgreementText(
      config.serviceUrl,
      {
        agreement_key: `matter-reading:${id}`,
        base: reading.base,
        amendments: reading.amendments,
      },
      { apiKey: config.apiKey },
    );
    await assertSourcesUnchanged();
    const facts = projectReadingFacts(analysis, reading.documents);
    if (!facts.some(fact => fact.citations.some(citation => citation.quote.trim()))) reading.notes.push("The reading did not include a cited sentence. No operative conclusion can be drawn.");
    return Response.json({
      ok: true,
      relianceRecord: false,
      approval: false,
      disclaimer: analysis.disclaimer,
      notes: [...reading.notes, ...extractionWarnings],
      warnings: analysis.warnings,
      operativeStatusUncertain: analysis.warnings.length > 0 || reading.notes.length > 0 || extractionWarnings.length > 0,
      documents: reading.documents,
      facts,
      impacts: analysis.exposure.domains.flatMap((domain) =>
        domain.impacts.map((impact) => ({
          domain: domain.domain,
          area: impact.area,
          summary: impact.summary,
          amount: impact.amount,
          determination: impact.determination,
          kind: impact.kind,
          citations: projectReadingCitations(impact.citations, reading.documents),
          source_fact_ids: impact.source_fact_ids,
        })),
      ),
    });
  } catch (error) {
    const access = accessErrorResponse(error);
    if (access) return access;
    if (error instanceof MatterReadingError) return Response.json({ ok: false, error: error.message }, { status: error.status });
    if (error instanceof ContractTwinRequestError && error.status !== 400) return internalErrorResponse(error, "The matter reading could not be completed.");
    if (error instanceof ContractTwinRequestError) return Response.json({ ok: false, error: error.message }, { status: 400 });
    return internalErrorResponse(error, "The matter reading could not be completed.");
  }
}
