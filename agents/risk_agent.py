"""Specialized agent for risk assessment in contracts."""

from agents import patterns
from agents.base_agent import BaseAgent


class RiskAssessmentAgent(BaseAgent):
    """Identifies and scores risk indicators across multiple risk dimensions."""

    name = "RiskAssessmentAgent"
    specialty = "Risk Assessment & Scoring"

    # Aliases for legacy access.
    RISK_INDICATORS = patterns.RISK_INDICATORS_RAW
    RISK_DIMENSIONS = patterns.RISK_DIMENSIONS_RAW

    def _perform_analysis(self, text, context):
        cache = context.get("match_cache") if context else None
        risks = {"high": [], "medium": [], "low": []}
        citations = []

        for severity, entries in patterns.RISK_INDICATORS.items():
            for i, (compiled, description) in enumerate(entries):
                match_tuples = patterns.iter_matches(
                    cache, f"risk:{severity}:{i}", compiled, text
                )
                for start, end, _g0, _groups in match_tuples:
                    ctx_start = max(0, start - 50)
                    ctx_end = min(len(text), end + 100)
                    ctx = text[ctx_start:ctx_end].strip()
                    entry = {
                        "description": description,
                        "context": ctx,
                        "matched": text[start:end],
                    }
                    if entry["description"] not in [r["description"] for r in risks[severity]]:
                        risks[severity].append(entry)
                        citations.append({
                            "start": start,
                            "end": end,
                            "label": description,
                            "excerpt": ctx,
                            "line": cache.line_for(start) if cache else None,
                            "severity": severity,
                        })

        dimension_scores = {}
        for dim, compiled_list in patterns.RISK_DIMENSIONS.items():
            hits = 0
            for i, compiled in enumerate(compiled_list):
                match_tuples = patterns.iter_matches(
                    cache, f"risk_dim:{dim}:{i}", compiled, text
                )
                if match_tuples:
                    hits += 1
            dimension_scores[dim] = round(hits / len(compiled_list) * 100, 1) if compiled_list else 0.0

        score = 0
        score += len(risks["high"]) * 20
        score += len(risks["medium"]) * 10
        score += len(risks["low"]) * 3
        score = min(score, 100)

        if score <= 25:
            label = "Low Risk"
        elif score <= 50:
            label = "Moderate Risk"
        elif score <= 75:
            label = "High Risk"
        else:
            label = "Critical Risk"

        return {
            "risks": risks,
            "risk_score": {"score": score, "label": label},
            "dimension_scores": dimension_scores,
            "total_indicators": (
                len(risks["high"]) + len(risks["medium"]) + len(risks["low"])
            ),
            "_citations": citations,
        }

    def _extract_insights(self, findings):
        insights = []
        score = findings.get("risk_score", {})
        if score:
            insights.append(f"Overall risk score: {score.get('score', 0)}/100 ({score.get('label', 'Unknown')})")
        high_count = len(findings.get("risks", {}).get("high", []))
        if high_count:
            insights.append(f"{high_count} high-severity risk indicator(s) found")
        dimension_scores = findings.get("dimension_scores", {})
        if dimension_scores:
            worst_dim = max(dimension_scores, key=dimension_scores.get)
            insights.append(f"Highest risk dimension: {worst_dim} ({dimension_scores[worst_dim]}%)")
        return insights

    def _identify_warnings(self, findings):
        warnings = []
        risk_score = findings.get("risk_score", {}).get("score", 0)
        if risk_score >= 75:
            warnings.append("CRITICAL: Risk score exceeds 75/100")
        for risk in findings.get("risks", {}).get("high", []):
            warnings.append(f"High risk: {risk['description']}")
        return warnings

    def _state_assumptions(self, findings):
        return [
            "Risk scoring weights: high=20, medium=10, low=3 per indicator",
            "Dimension analysis is presence-based, not severity-weighted",
        ]

    def _compute_confidence(self, findings):
        total = findings.get("total_indicators", 0)
        if total == 0:
            return 0.4
        return min(0.9, 0.5 + total * 0.05)
