import { runRuleTriage, type RiskResult } from "@/lib/riskRules";

export const PROMPT_VERSION = "ems-legal-triage-2026-08-07.v4";
export const legalRelianceEnabled = process.env.LEGAL_RELIANCE_ENABLED === "true";

const clauseFamilies = [
  "forecasting_demand", "purchase_orders", "pricing_repricing", "raw_materials", "long_lead_ncnr",
  "consigned_inventory", "title_risk_of_loss", "safety_stock", "excess_obsolete_inventory", "engineering_changes",
  "quality_acceptance_audits", "delivery_incoterms_logistics", "payment_terms", "warranty", "indemnity",
  "liability_cap", "termination", "force_majeure", "regulatory_change", "sustainability", "other"
] as const;

const schema = {
  type:"object",
  additionalProperties:false,
  required:["findings"],
  properties:{
    findings:{
      type:"array",
      items:{
        type:"object",
        additionalProperties:false,
        required:["clauseFamily","issue","risk","rationale","operationalConsequence","sourceExcerpt","uncertainty","financialVariables"],
        properties:{
          clauseFamily:{ type:"string", enum:clauseFamilies },
          issue:{ type:"string" },
          risk:{ type:"string", enum:["Low","Medium","High","Critical"] },
          rationale:{ type:"string" },
          operationalConsequence:{ type:"string" },
          sourceExcerpt:{ type:"string" },
          uncertainty:{ type:"string" },
          financialVariables:{ type:"array", items:{ type:"string" } }
        }
      }
    }
  }
};

export type CoreFinding = {
  clauseFamily:string;
  issue:string;
  risk:"Low"|"Medium"|"High"|"Critical";
  rationale:string;
  operationalConsequence:string;
  sourceExcerpt:string;
  uncertainty:string;
  financialVariables:string[];
};

export type AnalysisResult = {
  mode:"ai"|"rules"|"rules-fallback";
  findings:CoreFinding[];
  modelName:string;
  rejectedUngroundedFindings:number;
  warning?:string;
};

function extractOutputText(payload:any):string|null {
  for (const item of payload?.output ?? []) {
    for (const content of item?.content ?? []) {
      if (content?.type === "output_text" && typeof content.text === "string") return content.text;
    }
  }
  return null;
}

function normalizeSource(value:string) {
  return value.replace(/\s+/g," ").trim().toLowerCase();
}

function grounded(findings:CoreFinding[], source:string) {
  const normalized = normalizeSource(source);
  return findings.filter((finding) => {
    const excerpt = normalizeSource(String(finding.sourceExcerpt ?? ""));
    return excerpt.length >= 12 && normalized.includes(excerpt);
  });
}

function normalizeRules(findings:RiskResult[]):CoreFinding[] {
  return findings.map((finding) => ({
    clauseFamily:finding.clauseFamily,
    issue:finding.issue,
    risk:finding.risk,
    rationale:finding.rationale,
    operationalConsequence:finding.rationale,
    sourceExcerpt:finding.sourceExcerpt,
    uncertainty:"Deterministic issue-spotting rule; legal interpretation not performed.",
    financialVariables:[]
  }));
}

export async function analyzeContractText(source:string):Promise<AnalysisResult> {
  const apiKey = process.env.OPENAI_API_KEY;
  if (!apiKey) {
    if (legalRelianceEnabled) throw new Error("AI analysis is required when LEGAL_RELIANCE_ENABLED=true.");
    return { mode:"rules", findings:normalizeRules(runRuleTriage(source)), modelName:"deterministic-rules", rejectedUngroundedFindings:0, warning:"Deterministic triage only. Do not treat this output as a legal conclusion." };
  }

  const model = process.env.OPENAI_MODEL || "gpt-5.6";
  try {
    const response = await fetch("https://api.openai.com/v1/responses", {
      method:"POST",
      headers:{ Authorization:`Bearer ${apiKey}`, "Content-Type":"application/json" },
      body:JSON.stringify({
        model,
        store:false,
        instructions:[
          "You are a commercial contracts issue-spotting engine for electronics manufacturing services agreements.",
          "Identify material commercial/legal risks only from supplied text; do not invent obligations, remedies, dates, amounts, clause language, company policy, fallback positions, or approval authority.",
          "Preserve exact source wording in sourceExcerpt. State uncertainty when context, definitions, precedence, exhibits, amendments, or referenced documents are missing.",
          "Translate each issue into an operational consequence and identify relevant financial variables without doing arithmetic.",
          "If text is internally inconsistent, incomplete, or operationally unsafe to implement as written, preserve that fact explicitly rather than repairing it.",
          "Negotiation positions are supplied separately by an approved standards engine; do not create them.",
          "Every finding is UNREVIEWED and requires human legal validation."
        ].join(" "),
        input:source,
        text:{ format:{ type:"json_schema", name:"ems_contract_issue_spotting", strict:true, schema } }
      })
    });
    if (!response.ok) throw new Error(`OpenAI request failed: ${response.status}`);
    const payload = await response.json();
    const outputText = extractOutputText(payload);
    if (!outputText) throw new Error("No structured output returned.");
    const parsed = JSON.parse(outputText) as { findings?:CoreFinding[] };
    const raw = parsed.findings ?? [];
    const verified = grounded(raw, source);
    return { mode:"ai", findings:verified, modelName:model, rejectedUngroundedFindings:Math.max(0,raw.length-verified.length) };
  } catch (error) {
    if (legalRelianceEnabled) throw error;
    return { mode:"rules-fallback", findings:normalizeRules(runRuleTriage(source)), modelName:"deterministic-rules-fallback", rejectedUngroundedFindings:0, warning:error instanceof Error ? error.message : "AI analysis unavailable; deterministic triage used." };
  }
}

export function sourceContainsExcerpt(source:string, excerpt:string) {
  return normalizeSource(source).includes(normalizeSource(excerpt));
}
