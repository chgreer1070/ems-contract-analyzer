/**
 * Thin caller for the separate Python reading service in `/contracttwin`.
 *
 * This file is not used by the cockpit's legal-reliance path. Nothing here
 * approves a term, stores a matter, or treats the response as a decision.
 * The service address is passed in by the caller. It is not a production default.
 */

export type StatementKind = "fact" | "inference" | "assumption";

export type ImpactArea = "margin" | "cash" | "working_capital" | "inventory";

export type Determination = "supported" | "cannot_be_determined";

export type ContractTwinCitation = {
  document_id: string;
  document_name: string;
  section: string | null;
  quote: string;
};

export type ContractTwinDocument = {
  name: string;
  role: "base" | "amendment";
  text: string;
  filename?: string | null;
  effective_date?: string | null;
};

export type ContractTwinAgreementRequest = {
  base: ContractTwinDocument;
  amendments?: ContractTwinDocument[];
};

export type ContractTwinImpact = {
  area: ImpactArea;
  determination: Determination;
  kind: StatementKind | null;
  summary: string;
  amount: string | null;
  currency: string | null;
  source_fact_ids: string[];
  citations: ContractTwinCitation[];
};

export type ContractTwinAnalysis = {
  analysis_id: string;
  engine_version: string;
  extractor: string;
  fallback_used: boolean;
  review_required: boolean;
  disclaimer: string;
  clause_register: Array<{
    id: string;
    section: string;
    title: string;
    operative: boolean;
    survives_termination: boolean;
    document_id: string;
    citation: ContractTwinCitation;
  }>;
  obligation_register: Array<{
    id: string;
    kind: "fact";
    domain: string;
    statement: string;
    operative: boolean;
    section: string | null;
    citation: ContractTwinCitation;
  }>;
  facts: Array<{
    id: string;
    kind: StatementKind;
    domain: string;
    statement: string;
    operative: boolean;
    citations: ContractTwinCitation[];
  }>;
  calendar: Array<{
    id: string;
    kind: StatementKind;
    description: string;
    date: string | null;
    operative: boolean;
    citations: ContractTwinCitation[];
  }>;
  exposure: {
    domains: Array<{
      domain: "pricing" | "ncnr" | "excess_and_obsolete";
      impacts: ContractTwinImpact[];
    }>;
  };
  rejected: Array<{ statement: string; reason: string }>;
  warnings: string[];
};

export async function analyzeAgreementText(
  serviceUrl: string,
  body: ContractTwinAgreementRequest,
  fetchImpl: typeof fetch = fetch,
): Promise<ContractTwinAnalysis> {
  const response = await fetchImpl(new URL("/v1/agreements", serviceUrl), {
    method: "POST",
    headers: { "content-type": "application/json", accept: "application/json" },
    body: JSON.stringify(body),
  });
  if (!response.ok) {
    const detail = await response.text();
    throw new Error(`ContractTwin reading service returned ${response.status}: ${detail}`);
  }
  return (await response.json()) as ContractTwinAnalysis;
}

export function describeImpact(impact: ContractTwinImpact): string {
  switch (impact.determination) {
    case "supported":
      return impact.amount
        ? `${impact.summary} Amount: ${impact.amount} ${impact.currency ?? ""}.`.trim()
        : impact.summary;
    case "cannot_be_determined":
      return impact.summary;
    default: {
      const unexpected: never = impact.determination;
      return unexpected;
    }
  }
}
