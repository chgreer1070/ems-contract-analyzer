import { accessErrorResponse, getPrincipal, requireRole } from "@/lib/access";
import { analyzeContractText, legalRelianceEnabled, PROMPT_VERSION } from "@/lib/analysisEngine";
import { writeAuditEvent } from "@/lib/audit";
import { enrichFindings } from "@/lib/findings";
import { enforceRateLimit, rateLimitResponse } from "@/lib/rateLimit";
import { assertLegalRelianceReady } from "@/lib/readiness";
import { internalErrorResponse } from "@/lib/safeErrors";

const MAX_AD_HOC_TEXT_CHARS = 50_000;

export async function POST(request: Request) {
  try {
    const body = (await request.json()) as { text?:string; matterId?:string; documentId?:string };
    const source = (body.text ?? "").trim();
    if (source.length < 20) return Response.json({ ok:false, error:"Paste at least 20 characters of contract text." }, { status:400 });
    if (source.length > MAX_AD_HOC_TEXT_CHARS) return Response.json({ ok:false, error:`Ad-hoc analysis is limited to ${MAX_AD_HOC_TEXT_CHARS.toLocaleString()} characters.` }, { status:413 });
    if (body.matterId || body.documentId) {
      return Response.json({ ok:false, error:"Ad-hoc text cannot be attached to a persistent matter. Upload and process an immutable source document instead." }, { status:400 });
    }

    let principal = await getPrincipal(request);
    if (!principal.demo) {
      principal = await requireRole(request, "LAWYER");
      await enforceRateLimit(principal,"ai-analysis",60,3600);
      await assertLegalRelianceReady();
    }

    const analysis = await analyzeContractText(source,{allowAi:!principal.demo});
    const enriched = await enrichFindings(analysis.findings, principal.demo);
    const findings = enriched.map((finding) => ({ ...finding, sourceLocator:"Ad-hoc text · not retained" }));

    await writeAuditEvent({principal,action:"ANALYSIS_RUN",entityType:"ad_hoc_analysis",metadata:{mode:analysis.mode,modelName:analysis.modelName,promptVersion:PROMPT_VERSION,findingCount:findings.length,rejectedUngroundedFindings:analysis.rejectedUngroundedFindings,persisted:false}});

    return Response.json({ok:true,mode:analysis.mode,humanReviewRequired:true,legalRelianceEnabled:principal.demo?false:legalRelianceEnabled,persistent:false,sourceMode:"AD_HOC_TEXT",promptVersion:PROMPT_VERSION,findings,findingIds:[],rejectedUngroundedFindings:analysis.rejectedUngroundedFindings,warning:analysis.warning});
  } catch (error) {
    const rate=rateLimitResponse(error);if(rate)return rate;
    const access = accessErrorResponse(error);if(access)return access;
    const status = legalRelianceEnabled ? 502 : 500;
    return internalErrorResponse(error,"Contract analysis could not be completed.",status);
  }
}
