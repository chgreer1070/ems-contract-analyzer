import { accessErrorResponse, requireMatterAccess, requireRole } from "@/lib/access";
import { analyzeContractText, legalRelianceEnabled, PROMPT_VERSION } from "@/lib/analysisEngine";
import { writeAuditEvent } from "@/lib/audit";
import { enrichFindings, persistFindings } from "@/lib/findings";

export async function POST(request: Request) {
  try {
    const body = (await request.json()) as { text?:string; matterId?:string; documentId?:string; sourceLocator?:string };
    const source = (body.text ?? "").trim();
    if (source.length < 20) return Response.json({ ok:false, error:"Paste at least 20 characters of contract text." }, { status:400 });

    const principal = body.matterId
      ? await requireMatterAccess(request, body.matterId, true)
      : await requireRole(request, "LAWYER");
    if (!principal.demo && principal.role === "VIEWER") return Response.json({ ok:false, error:"Legal analysis requires Lawyer access or higher." }, { status:403 });

    const analysis = await analyzeContractText(source);
    const enriched = await enrichFindings(analysis.findings, principal.demo);
    const findings = enriched.map((finding) => ({ ...finding, sourceLocator:body.sourceLocator ?? null }));
    const findingIds = await persistFindings({
      principal,
      matterId:body.matterId,
      documentId:body.documentId,
      findings,
      modelName:analysis.modelName,
      promptVersion:PROMPT_VERSION
    });

    await writeAuditEvent({
      principal,
      action:"ANALYSIS_RUN",
      matterId:body.matterId,
      entityType:"analysis",
      metadata:{
        mode:analysis.mode,
        modelName:analysis.modelName,
        promptVersion:PROMPT_VERSION,
        findingCount:findings.length,
        rejectedUngroundedFindings:analysis.rejectedUngroundedFindings,
        legalRelianceEnabled
      }
    });

    return Response.json({
      ok:true,
      mode:analysis.mode,
      humanReviewRequired:true,
      legalRelianceEnabled,
      promptVersion:PROMPT_VERSION,
      findings,
      findingIds,
      rejectedUngroundedFindings:analysis.rejectedUngroundedFindings,
      warning:analysis.warning
    });
  } catch (error) {
    const access = accessErrorResponse(error);
    if (access) return access;
    const message = error instanceof Error ? error.message : "Analysis failed.";
    const status = legalRelianceEnabled ? 502 : 500;
    return Response.json({ ok:false, error:message }, { status });
  }
}
