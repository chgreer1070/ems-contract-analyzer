import { readFileSync } from "fs";
import path from "path";
import { NextResponse } from "next/server";
import { analyzeAgreementText } from "@/lib/contracttwinCoreClient";

export async function GET() {
  const serviceUrl = process.env.CONTRACTTWIN_CORE_URL;
  const apiKey = process.env.CONTRACTTWIN_API_KEY;
  if (!serviceUrl || !apiKey) {
    return NextResponse.json({ error: "The reading service is not configured." }, { status: 503 });
  }
  const fixtures = path.join(process.cwd(), "..", "contracttwin", "tests", "fixtures");
  try {
    const base = readFileSync(path.join(fixtures, "harborline_msa.txt"), "utf8");
    const amendment = readFileSync(path.join(fixtures, "harborline_amendment_1.txt"), "utf8");
    const analysis = await analyzeAgreementText(
      serviceUrl,
      {
        agreement_key: "harborline-sample",
        base: { name: "Harborline MSA", role: "base", text: base, effective_date: "2024-01-15" },
        amendments: [
          { name: "Amendment No. 1", role: "amendment", text: amendment, effective_date: "2025-03-01" },
        ],
      },
      { apiKey },
    );
    const payment = analysis.facts.find(
      (fact) => fact.operative && fact.statement.includes("payment term is 60 days"),
    );
    if (!payment) {
      return NextResponse.json(
        { error: "The sample reading did not include the operative payment term." },
        { status: 502 },
      );
    }
    return NextResponse.json({
      disclaimer: analysis.disclaimer,
      payment: payment.statement,
      quote: payment.citations[0]?.quote ?? "",
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : "The reading service call failed.";
    return NextResponse.json({ error: message }, { status: 502 });
  }
}
