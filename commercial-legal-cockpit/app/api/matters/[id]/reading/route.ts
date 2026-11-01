import { accessErrorResponse, requireMatterAccess } from "@/lib/access";
import { analyzeAgreementText, type ContractTwinAnalysis } from "@/lib/contracttwinCoreClient";
import { databaseConfigured, query } from "@/lib/db";
import { MatterReadingError, buildMatterReadingRequest, type MatterReadingDocument } from "@/lib/matterDocumentReading.mjs";
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

function citedFacts(analysis: ContractTwinAnalysis) {
  const facts = [];
  for (const fact of analysis.facts) {
    const citation = fact.citations[0];
    const quote = citation?.quote ?? "";
    if (!quote.trim()) continue;
    facts.push({
      statement: fact.statement,
      operative: fact.operative,
      quote,
      documentName: citation?.document_name ?? "",
    });
  }
  return facts;
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
    const stored = await query<StoredDocument>(
      `select id, filename, document_type, extraction_method, extraction_status, integrity_status,
              security_scan_status, deletion_status, source_status
         from documents
        where matter_id = $1 and id = any($2::uuid[])`,
      [id, ids],
    );
    const chunks = await query<{ document_id: string; content: string }>(
      `select document_id, content
         from document_chunks
        where matter_id = $1 and document_id = any($2::uuid[])
        order by document_id, coalesce(page_number, 0), chunk_index, id`,
      [id, ids],
    );
    const chunksByDocumentId = new Map<string, string[]>();
    for (const chunk of chunks.rows) {
      const list = chunksByDocumentId.get(chunk.document_id) ?? [];
      list.push(chunk.content);
      chunksByDocumentId.set(chunk.document_id, list);
    }
    const reading = buildMatterReadingRequest({
      documents: stored.rows.map(toReadingDocument),
      chunksByDocumentId,
      baseDocumentId,
      amendmentDocumentIds,
    });
    const analysis = await analyzeAgreementText(
      config.serviceUrl,
      {
        agreement_key: `matter-reading:${id}`,
        base: { name: reading.base.name, role: "base", text: reading.base.text },
        amendments: reading.amendments.map((amendment) => ({
          name: amendment.name,
          role: "amendment",
          text: amendment.text,
        })),
      },
      { apiKey: config.apiKey },
    );
    const facts = citedFacts(analysis);
    if (facts.length === 0) throw new MatterReadingError("The reading did not include a cited sentence.", 409);
    return Response.json({
      ok: true,
      relianceRecord: false,
      approval: false,
      disclaimer: analysis.disclaimer,
      notes: reading.notes,
      documents: reading.documents,
      facts,
      impacts: analysis.exposure.domains.flatMap((domain) =>
        domain.impacts.map((impact) => ({
          domain: domain.domain,
          area: impact.area,
          summary: impact.summary,
          amount: impact.amount,
          determination: impact.determination,
        })),
      ),
    });
  } catch (error) {
    const access = accessErrorResponse(error);
    if (access) return access;
    if (error instanceof MatterReadingError) return Response.json({ ok: false, error: error.message }, { status: error.status });
    return internalErrorResponse(error, "The matter reading could not be completed.");
  }
}
