"""Specialized agent for extracting and analyzing financial terms."""

import re
from agents.base_agent import BaseAgent


class FinancialAnalysisAgent(BaseAgent):
    """Extracts monetary amounts, percentages, payment structures, and financial risks."""

    name = "FinancialAnalysisAgent"
    specialty = "Financial Terms & Obligations"

    FINANCIAL_PATTERNS = [
        (r"\$[\d,]+(?:\.\d{2})?(?:\s*(?:per|/)\s*\w+)?", "Monetary Amount"),
        (r"(\d+(?:\.\d+)?)\s*%", "Percentage"),
        (r"(?:fee|cost|price|rate|compensation|salary|payment)[:\s]+([^.;]{5,80})", "Financial Term"),
    ]

    PAYMENT_STRUCTURE_PATTERNS = [
        (r"net\s+(\d+)\s+days?", "Payment Window"),
        (r"(?:payable|due)\s+(?:within|upon|on)\s+([^.;]{5,60})", "Payment Timing"),
        (r"(?:monthly|quarterly|annual(?:ly)?|weekly|bi-weekly)\s+(?:payment|installment|fee)",
         "Recurring Payment"),
        (r"(?:late\s+(?:fee|charge|payment|penalty))[:\s]*([^.;]{3,80})", "Late Fee"),
        (r"(?:interest\s+(?:rate|at|of))[:\s]*([^.;]{3,60})", "Interest Rate"),
    ]

    FINANCIAL_RISK_PATTERNS = [
        (r"(?:penalty|penalt?ies)\s+(?:for|of)\s+([^.;]{5,80})", "Penalty Clause"),
        (r"(?:liquidated\s+damages)[:\s]*([^.;]{5,80})", "Liquidated Damages"),
        (r"(?:price\s+(?:increase|adjustment|escalation))", "Price Escalation"),
        (r"(?:cost\s+(?:plus|overrun))", "Cost Overrun Risk"),
    ]

    def _perform_analysis(self, text, context):
        financials = []
        seen = set()
        for pattern, label in self.FINANCIAL_PATTERNS:
            for match in re.finditer(pattern, text, re.IGNORECASE):
                value = match.group().strip()[:150]
                if value not in seen:
                    seen.add(value)
                    financials.append({"type": label, "value": value})

        payment_structures = []
        for pattern, label in self.PAYMENT_STRUCTURE_PATTERNS:
            for match in re.finditer(pattern, text, re.IGNORECASE):
                value = match.group().strip()[:150]
                if value not in [p["value"] for p in payment_structures]:
                    payment_structures.append({"type": label, "value": value})

        financial_risks = []
        for pattern, label in self.FINANCIAL_RISK_PATTERNS:
            for match in re.finditer(pattern, text, re.IGNORECASE):
                value = match.group().strip()[:150]
                if value not in [r["value"] for r in financial_risks]:
                    financial_risks.append({"type": label, "value": value})

        monetary_amounts = [f for f in financials if f["type"] == "Monetary Amount"]
        percentages = [f for f in financials if f["type"] == "Percentage"]

        return {
            "financial_terms": financials[:25],
            "payment_structures": payment_structures,
            "financial_risks": financial_risks,
            "monetary_count": len(monetary_amounts),
            "percentage_count": len(percentages),
            "has_payment_terms": len(payment_structures) > 0,
        }

    def _extract_insights(self, findings):
        insights = []
        insights.append(
            f"Found {findings['monetary_count']} monetary amount(s) and "
            f"{findings['percentage_count']} percentage(s)"
        )
        if findings["payment_structures"]:
            insights.append(
                f"{len(findings['payment_structures'])} payment structure(s) identified"
            )
        if findings["financial_risks"]:
            insights.append(
                f"{len(findings['financial_risks'])} financial risk clause(s) detected"
            )
        return insights

    def _identify_warnings(self, findings):
        warnings = []
        if not findings["has_payment_terms"]:
            warnings.append("No explicit payment structure detected")
        if findings["financial_risks"]:
            for risk in findings["financial_risks"]:
                warnings.append(f"Financial risk: {risk['type']} - {risk['value']}")
        return warnings

    def _compute_confidence(self, findings):
        total = len(findings["financial_terms"])
        if total == 0:
            return 0.3
        return min(0.9, 0.5 + total * 0.04)
