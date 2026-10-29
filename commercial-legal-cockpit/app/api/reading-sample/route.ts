import { readFileSync } from "fs";
import path from "path";
import { NextResponse } from "next/server";
import { analyzeAgreementText, markAgreementLookedAt, type ContractTwinAnalysis } from "@/lib/contracttwinCoreClient";
import { internalErrorResponse } from "@/lib/safeErrors";

type SampleTerm = {
  statement: string;
  quote: string;
};

type SampleImpact = {
  area: "margin" | "cash" | "working_capital" | "inventory";
  summary: string;
  amount: string | null;
};

function serviceConfig(): { serviceUrl: string; apiKey: string } | null {
  const serviceUrl = process.env.CONTRACTTWIN_CORE_URL;
  const apiKey = process.env.CONTRACTTWIN_API_KEY;
  if (!serviceUrl || !apiKey) return null;
  return { serviceUrl, apiKey };
}

function term(analysis: ContractTwinAnalysis, snippet: string, operative: boolean): SampleTerm | null {
  const fact = analysis.facts.find(
    (item) => item.operative === operative && item.statement.includes(snippet),
  );
  if (!fact) return null;
  return { statement: fact.statement, quote: fact.citations[0]?.quote ?? "" };
}

export async function GET() {
  const config = serviceConfig();
  if (!config) {
    return NextResponse.json({ error: "The reading service is not configured." }, { status: 503 });
  }
  const fixtures = path.join(process.cwd(), "..", "contracttwin", "tests", "fixtures");
  try {
    const base = readFileSync(path.join(fixtures, "harborline_msa.txt"), "utf8");
    const amendment = readFileSync(path.join(fixtures, "harborline_amendment_1.txt"), "utf8");
    const analysis = await analyzeAgreementText(
      config.serviceUrl,
      {
        agreement_key: "harborline-sample",
        base: { name: "Harborline MSA", role: "base", text: base, effective_date: "2024-01-15" },
        amendments: [
          { name: "Amendment No. 1", role: "amendment", text: amendment, effective_date: "2025-03-01" },
        ],
      },
      { apiKey: config.apiKey },
    );
    const payment = term(analysis, "payment term is 60 days", true);
    const replacedPayment = term(analysis, "payment term is 45 days", false);
    const ncnr = term(analysis, "firm period is 120 days", true);
    const replacedNcnr = term(analysis, "firm period is 90 days", false);
    const notice = analysis.calendar.find((entry) => entry.date === "2025-07-14");
    const pricing = analysis.exposure.domains.find((domain) => domain.domain === "pricing");
    if (!payment || !replacedPayment || !ncnr || !replacedNcnr || !notice || !pricing) {
      return NextResponse.json(
        { error: "The sample reading did not include the expected Harborline terms." },
        { status: 503 },
      );
    }
    const impacts: SampleImpact[] = pricing.impacts.map((impact) => ({
      area: impact.area,
      summary: impact.summary,
      amount: impact.amount,
    }));
    return NextResponse.json({
      analysisId: analysis.analysis_id,
      disclaimer: analysis.disclaimer,
      payment,
      replacedPayment,
      ncnr,
      replacedNcnr,
      notice: {
        date: notice.date,
        kind: notice.kind,
        description: notice.description,
        quote: notice.citations[0]?.quote ?? "",
      },
      impacts,
    });
  } catch (error) {
    return internalErrorResponse(error, "The sample agreement could not be read.");
  }
}

export async function POST(request: Request) {
  const config = serviceConfig();
  if (!config) {
    return NextResponse.json({ error: "The reading service is not configured." }, { status: 503 });
  }
  try {
    const body = (await request.json()) as { analysisId?: string };
    if (!body.analysisId) {
      return NextResponse.json({ error: "The sample reading is missing." }, { status: 400 });
    }
    const marked = await markAgreementLookedAt(config.serviceUrl, body.analysisId, { apiKey: config.apiKey });
    return NextResponse.json({ message: marked.message });
  } catch (error) {
    return internalErrorResponse(error, "The sample could not be marked as looked at.");
  }
}
