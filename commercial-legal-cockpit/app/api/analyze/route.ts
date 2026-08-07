import { runRuleTriage } from "@/lib/riskRules";

const schema = {
  type: "object",
  additionalProperties: false,
  required: ["findings"],
  properties: {
    findings: {
      type: "array",
      items: {
        type: "object",
        additionalProperties: false,
        required: ["issue", "risk", "rationale", "primaryPosition", "fallback", "approval", "sourceExcerpt"],
        properties: {
          issue: { type: "string" },
          risk: { type: "string", enum: ["Low", "Medium", "High", "Critical"] },
          rationale: { type: "string" },
          primaryPosition: { type: "string" },
          fallback: { type: "string" },
          approval: { type: "string" },
          sourceExcerpt: { type: "string" }
        }
      }
    }
  }
};

function extractOutputText(payload: any): string | null {
  for (const item of payload?.output ?? []) {
    for (const content of item?.content ?? []) {
      if (content?.type === "output_text" && typeof content.text === "string") return content.text;
    }
  }
  return null;
}

function grounded(findings: any[], source: string) {
  const normalized = source.replace(/\s+/g, " ").trim().toLowerCase();
  return findings.filter((finding) => {
    const excerpt = String(finding?.sourceExcerpt ?? "").replace(/\s+/g, " ").trim().toLowerCase();
    return excerpt.length >= 12 && normalized.includes(excerpt);
  });
}

export async function POST(request: Request) {
  const { text } = (await request.json()) as { text?: string };
  const source = (text ?? "").trim();
  if (source.length < 20) {
    return Response.json({ ok: false, error: "Paste at least 20 characters of contract text." }, { status: 400 });
  }

  const apiKey = process.env.OPENAI_API_KEY;
  if (!apiKey) {
    return Response.json({
      ok: true,
      mode: "rules",
      humanReviewRequired: true,
      findings: runRuleTriage(source),
      warning: "Deterministic triage mode only. Configure OPENAI_API_KEY for structured AI analysis. Do not treat triage output as a legal conclusion."
    });
  }

  try {
    const response = await fetch("https://api.openai.com/v1/responses", {
      method: "POST",
      headers: {
        "Authorization": `Bearer ${apiKey}`,
        "Content-Type": "application/json"
      },
      body: JSON.stringify({
        model: process.env.OPENAI_MODEL || "gpt-5",
        store: false,
        instructions: "You are a commercial contracts issue-spotting engine for electronics manufacturing services agreements. Identify material commercial/legal risks only from the supplied text. Preserve exact source wording in sourceExcerpt. Never invent a clause. Every finding requires human legal review.",
        input: source,
        text: {
          format: {
            type: "json_schema",
            name: "ems_contract_triage",
            strict: true,
            schema
          }
        }
      })
    });

    if (!response.ok) throw new Error(`OpenAI request failed: ${response.status}`);
    const payload = await response.json();
    const outputText = extractOutputText(payload);
    if (!outputText) throw new Error("No structured output returned.");
    const parsed = JSON.parse(outputText);
    const verifiedFindings = grounded(parsed.findings ?? [], source);

    return Response.json({
      ok: true,
      mode: "ai",
      humanReviewRequired: true,
      findings: verifiedFindings,
      rejectedUngroundedFindings: Math.max(0, (parsed.findings?.length ?? 0) - verifiedFindings.length)
    });
  } catch (error) {
    return Response.json({
      ok: true,
      mode: "rules-fallback",
      humanReviewRequired: true,
      findings: runRuleTriage(source),
      warning: error instanceof Error ? error.message : "AI analysis unavailable; deterministic triage used."
    });
  }
}
