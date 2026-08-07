import { accessErrorResponse, requireMatterAccess } from "@/lib/access";
import { analyzeContractText, legalRelianceEnabled, PROMPT_VERSION, sourceContainsExcerpt, type CoreFinding } from "@/lib/analysisEngine";
import { writeAuditEvent } from "@/lib/audit";
import { databaseConfigured, query } from "@/lib/db";
import { enrichFindings, persistFindings, type EnrichedFinding } from "@/lib/findings";

const MAX_SYNC_TEXT_CHARS = 90_000;
const WINDOW_CHARS = 16_000;

type ChunkRow = { id:string; page_number:number|null; chunk_index:number; content:string };

function buildWindows(chunks:ChunkRow[]) {
  const windows:string[] = [];
  let current = "";
  for (const chunk of chunks) {
    const marker = `\n\n[SOURCE_CHUNK ${chunk.id}${chunk.page_number ? ` PAGE ${chunk.page_number}` : ""}]\n`;
    const block = `${marker}${chunk.content}`;
    if (current && current.length + block.length > WINDOW_CHARS) {
      windows.push(current);
      current = block;
    } else {
      current += block;
    }
  }
  if (current) windows.push(current);
  return windows;
}

function dedupe(findings:CoreFinding[]) {
  const seen = new Set<string>();
  return findings.filter((finding) => {
    const key = `${finding.clauseFamily}|${finding.issue.toLowerCase()}|${finding.sourceExcerpt.replace(/\s+/g," ").trim().toLowerCase()}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

function locateSource(finding:CoreFinding, chunks:ChunkRow[], filename:string) {
  const chunk = chunks.find((candidate) => sourceContainsExcerpt(candidate.content, finding.sourceExcerpt));
  if (!chunk) return `${filename} · source excerpt verified in analysis window; chunk locator unresolved`;
  return chunk.page_number ? `${filename} · p. ${chunk.page_number}` : `${filename} · text chunk ${chunk.chunk_index + 1}`;
}

export async function POST(request:Request, context:{ params:Promise<{ id:string }> }) {
  try {
    if (!databaseConfigured()) return Response.json({ ok:false, error:"Document analysis requires DATABASE_URL." }, { status:503 });
    const { id } = await context.params;
    const document = await query<{ id:string; matter_id:string; filename:string; extraction_status:string }>(
      "select id,matter_id,filename,extraction_status from documents where id=$1 limit 1",
      [id]
    );
    const doc = document.rows[0];
    if (!doc) return Response.json({ ok:false, error:"Document not found." }, { status:404 });
    const principal = await requireMatterAccess(request, doc.matter_id, true);
    if (principal.demo) return Response.json({ ok:false, error:"Persisted document analysis is disabled in demo mode." }, { status:503 });
    if (doc.extraction_status !== "EXTRACTED") return Response.json({ ok:false, error:"Extract and integrity-verify the document before analysis." }, { status:409 });

    const chunkResult = await query<ChunkRow>(
      "select id,page_number,chunk_index,content from document_chunks where document_id=$1 order by coalesce(page_number,0),chunk_index",
      [id]
    );
    const chunks = chunkResult.rows;
    const totalChars = chunks.reduce((sum,chunk) => sum + chunk.content.length,0);
    if (!chunks.length) return Response.json({ ok:false, error:"No source chunks are available." }, { status:409 });
    if (totalChars > MAX_SYNC_TEXT_CHARS) {
      return Response.json({ ok:false, error:"Document exceeds the synchronous analysis limit; use the asynchronous contract-processing worker to avoid partial analysis." }, { status:413 });
    }

    const windows = buildWindows(chunks);
    const core:CoreFinding[] = [];
    let rejected = 0;
    const modes = new Set<string>();
    const models = new Set<string>();
    const warnings:string[] = [];
    for (const window of windows) {
      const result = await analyzeContractText(window);
      core.push(...result.findings);
      rejected += result.rejectedUngroundedFindings;
      modes.add(result.mode);
      models.add(result.modelName);
      if (result.warning) warnings.push(result.warning);
    }

    const unique = dedupe(core);
    const enriched = await enrichFindings(unique, false);
    const located:EnrichedFinding[] = enriched.map((finding) => ({ ...finding, sourceLocator:locateSource(finding,chunks,doc.filename) }));
    const modelName = [...models].join(",");
    const findingIds = await persistFindings({
      principal,
      matterId:doc.matter_id,
      documentId:id,
      findings:located,
      modelName,
      promptVersion:PROMPT_VERSION
    });

    await writeAuditEvent({
      principal,
      action:"ANALYSIS_RUN",
      matterId:doc.matter_id,
      entityType:"document_analysis",
      entityId:id,
      metadata:{
        filename:doc.filename,
        windowCount:windows.length,
        sourceChunkCount:chunks.length,
        sourceCharacters:totalChars,
        findingCount:located.length,
        rejectedUngroundedFindings:rejected,
        modes:[...modes],
        models:[...models],
        promptVersion:PROMPT_VERSION,
        legalRelianceEnabled
      }
    });

    return Response.json({
      ok:true,
      humanReviewRequired:true,
      legalRelianceEnabled,
      promptVersion:PROMPT_VERSION,
      findings:located,
      findingIds,
      sourceChunkCount:chunks.length,
      analysisWindowCount:windows.length,
      rejectedUngroundedFindings:rejected,
      warnings:[...new Set(warnings)]
    });
  } catch (error) {
    const access = accessErrorResponse(error);
    if (access) return access;
    return Response.json({ ok:false, error:error instanceof Error ? error.message : "Document analysis failed." }, { status:legalRelianceEnabled?502:500 });
  }
}
