import type { Principal } from "@/lib/access";
import { databaseConfigured, query } from "@/lib/db";
import type { CoreFinding } from "@/lib/analysisEngine";
import { loadNegotiationPositions, type NegotiationPosition } from "@/lib/standards";

export type EnrichedFinding = CoreFinding & NegotiationPosition & {
  sourceLocator?: string | null;
  standardVersion: string | null;
};

export async function enrichFindings(findings: CoreFinding[], allowIllustrative: boolean): Promise<EnrichedFinding[]> {
  const positions = await loadNegotiationPositions(findings, allowIllustrative);
  return findings.map((finding, index) => ({ ...finding, ...positions[index] }));
}

export async function persistFindings(input: {
  principal: Principal;
  matterId?: string;
  documentId?: string;
  findings: EnrichedFinding[];
  modelName: string;
  promptVersion: string;
}) {
  if (!input.matterId || input.principal.demo || !databaseConfigured()) return [] as string[];
  if (input.documentId) {
    const doc = await query<{ id:string }>("select id from documents where id=$1 and matter_id=$2", [input.documentId,input.matterId]);
    if (!doc.rows[0]) throw new Error("Document does not belong to the selected matter.");
  }

  const ids:string[] = [];
  for (const finding of input.findings) {
    const result = await query<{ id:string }>(
      `insert into findings
        (matter_id,document_id,clause_family,issue,risk_level,rationale,operational_consequence,source_excerpt,source_locator,
         primary_position,fallback_position,no_go_position,approval_required,financial_variables,uncertainty,review_status,
         model_name,prompt_version,standard_status,standard_version,created_by)
       values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14::jsonb,$15,'UNREVIEWED',$16,$17,$18,$19,$20)
       returning id`,
      [
        input.matterId,
        input.documentId ?? null,
        finding.clauseFamily,
        finding.issue,
        finding.risk,
        finding.rationale,
        finding.operationalConsequence,
        finding.sourceExcerpt,
        finding.sourceLocator ?? null,
        finding.primaryPosition,
        finding.fallback,
        finding.noGo,
        finding.approval,
        JSON.stringify(finding.financialVariables),
        finding.uncertainty,
        input.modelName,
        input.promptVersion,
        finding.standardStatus,
        finding.standardVersion,
        input.principal.userId
      ]
    );
    ids.push(result.rows[0].id);
  }
  return ids;
}
