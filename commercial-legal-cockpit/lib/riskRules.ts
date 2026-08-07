export type RiskResult = {
  issue: string;
  risk: "Low" | "Medium" | "High" | "Critical";
  rationale: string;
  primaryPosition: string;
  fallback: string;
  approval: string;
  sourceExcerpt: string;
};

type Rule = {
  issue: string;
  pattern: RegExp;
  risk: RiskResult["risk"];
  rationale: string;
  primaryPosition: string;
  fallback: string;
  approval: string;
};

const rules: Rule[] = [
  { issue: "Payment terms", pattern: /(?:net\s*(?:75|90|120)|payment.{0,30}(?:75|90|120)\s*days)/i, risk: "High", rationale: "Extended payment terms increase receivables and working-capital carrying cost.", primaryPosition: "Net 45 or better.", fallback: "Net 60 with pricing or financing recovery.", approval: "Finance + BU President for terms beyond approved threshold." },
  { issue: "Unlimited liability", pattern: /unlimited liability|without limitation|liability.{0,30}uncapped|no limit.{0,20}liability/i, risk: "Critical", rationale: "Uncapped exposure can materially exceed contract economics and insurance coverage.", primaryPosition: "Aggregate liability cap tied to defined fees/revenue with narrow customary carve-outs.", fallback: "Higher negotiated cap only for specifically identified risks.", approval: "GC/CFO-level escalation." },
  { issue: "Broad consequential damages", pattern: /consequential|indirect damages|lost profits|loss of revenue/i, risk: "High", rationale: "Consequential loss exposure can be difficult to quantify and disproportionate to manufacturing margin.", primaryPosition: "Mutual exclusion of indirect, special, incidental and consequential damages.", fallback: "Defined exceptions subject to an agreed super-cap.", approval: "Legal leadership if customer will not accept mutual exclusion." },
  { issue: "Excess / obsolete inventory", pattern: /excess inventory|obsolete inventory|e&o|non[- ]cancelable|non[- ]returnable|ncnr/i, risk: "High", rationale: "Inventory procurement commitments can become stranded when forecasts, demand or product plans change.", primaryPosition: "Customer purchases affected inventory and NCNR commitments triggered by its forecasts, POs or changes.", fallback: "Defined recovery schedule plus carrying charges.", approval: "Operations + Finance + Legal for material unrecovered exposure." },
  { issue: "Warranty duration", pattern: /warranty.{0,80}(?:36|48|60)\s*months|(?:three|four|five)\s*year warranty/i, risk: "High", rationale: "Long warranty tails can exceed manufacturing-defect visibility and increase reserve requirements.", primaryPosition: "Manufacturing-defect warranty limited in duration and scope.", fallback: "Extended warranty only with defined pricing and exclusions.", approval: "Quality + Finance + Legal." },
  { issue: "Termination for convenience", pattern: /terminate.{0,30}convenience|termination for convenience/i, risk: "Medium", rationale: "Convenience termination is manageable only if committed inventory, WIP, finished goods and cancellation costs are recoverable.", primaryPosition: "Termination charges cover all committed material, WIP, finished goods and supplier cancellation liabilities.", fallback: "Negotiated notice period plus inventory purchase obligation.", approval: "BU + Legal if recovery is incomplete." }
];

function excerpt(text: string, matchIndex: number, length = 280) {
  const start = Math.max(0, matchIndex - 80);
  return text.slice(start, Math.min(text.length, start + length)).trim();
}

export function runRuleTriage(text: string): RiskResult[] {
  const results: RiskResult[] = [];
  for (const rule of rules) {
    const match = rule.pattern.exec(text);
    if (!match) continue;
    results.push({ issue: rule.issue, risk: rule.risk, rationale: rule.rationale, primaryPosition: rule.primaryPosition, fallback: rule.fallback, approval: rule.approval, sourceExcerpt: excerpt(text, match.index) });
  }
  return results;
}
