"""Specialized agent for extracting and analyzing financial terms."""

from agents import patterns
from agents.base_agent import BaseAgent


class FinancialAnalysisAgent(BaseAgent):
    """Extracts monetary amounts, percentages, payment structures, and financial risks."""

    name = "FinancialAnalysisAgent"
    specialty = "Financial Terms & Obligations"

    FINANCIAL_PATTERNS = patterns.FINANCIAL_PATTERNS_RAW
    PAYMENT_STRUCTURE_PATTERNS = patterns.PAYMENT_STRUCTURE_PATTERNS_RAW
    FINANCIAL_RISK_PATTERNS = patterns.FINANCIAL_RISK_PATTERNS_RAW

    def _perform_analysis(self, text, context):
        cache = context.get("match_cache") if context else None
        citations = []

        financials = []
        seen = set()
        for i, (compiled, label) in enumerate(patterns.FINANCIAL_PATTERNS):
            for start, end, g0, _groups in patterns.iter_matches(cache, f"financial:{i}", compiled, text):
                value = g0.strip()[:150]
                if value not in seen:
                    seen.add(value)
                    financials.append({"type": label, "value": value})
                    citations.append({
                        "start": start, "end": end, "label": label,
                        "excerpt": value,
                        "line": cache.line_for(start) if cache else None,
                    })

        payment_structures = []
        seen_payment = set()
        for i, (compiled, label) in enumerate(patterns.PAYMENT_STRUCTURE_PATTERNS):
            for start, end, g0, _groups in patterns.iter_matches(cache, f"payment:{i}", compiled, text):
                value = g0.strip()[:150]
                if value not in seen_payment:
                    seen_payment.add(value)
                    payment_structures.append({"type": label, "value": value})
                    citations.append({
                        "start": start, "end": end, "label": label,
                        "excerpt": value,
                        "line": cache.line_for(start) if cache else None,
                    })

        financial_risks = []
        seen_fr = set()
        for i, (compiled, label) in enumerate(patterns.FINANCIAL_RISK_PATTERNS):
            for start, end, g0, _groups in patterns.iter_matches(cache, f"fin_risk:{i}", compiled, text):
                value = g0.strip()[:150]
                if value not in seen_fr:
                    seen_fr.add(value)
                    financial_risks.append({"type": label, "value": value})
                    citations.append({
                        "start": start, "end": end, "label": label,
                        "excerpt": value,
                        "line": cache.line_for(start) if cache else None,
                    })

        monetary_amounts = [f for f in financials if f["type"] == "Monetary Amount"]
        percentages = [f for f in financials if f["type"] == "Percentage"]

        return {
            "financial_terms": financials[:25],
            "payment_structures": payment_structures,
            "financial_risks": financial_risks,
            "monetary_count": len(monetary_amounts),
            "percentage_count": len(percentages),
            "has_payment_terms": len(payment_structures) > 0,
            "_citations": citations,
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
