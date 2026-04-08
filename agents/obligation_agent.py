"""Specialized agent for extracting contractual obligations and duties."""

from agents import patterns
from agents.base_agent import BaseAgent


class ObligationExtractionAgent(BaseAgent):
    """Extracts and categorizes contractual obligations, duties, and requirements."""

    name = "ObligationExtractionAgent"
    specialty = "Obligations & Duties"

    # Aliases for legacy access
    OBLIGATION_PATTERNS = patterns.OBLIGATION_PATTERNS_RAW
    PROHIBITION_PATTERNS = patterns.PROHIBITION_PATTERNS_RAW
    CONDITION_PATTERNS = patterns.CONDITION_PATTERNS_RAW

    def _perform_analysis(self, text, context):
        cache = context.get("match_cache") if context else None
        citations = []

        obligations = []
        seen = set()
        for i, (compiled, label) in enumerate(patterns.OBLIGATION_PATTERNS):
            for start, end, g0, _groups in patterns.iter_matches(
                cache, f"obligation:{i}", compiled, text
            ):
                full = g0.strip()[:200]
                if full not in seen:
                    seen.add(full)
                    obligations.append({"type": label, "text": full})
                    citations.append({
                        "start": start, "end": end, "label": label,
                        "excerpt": full[:160],
                        "line": cache.line_for(start) if cache else None,
                    })

        prohibitions = []
        for i, (compiled, label) in enumerate(patterns.PROHIBITION_PATTERNS):
            for start, end, g0, _groups in patterns.iter_matches(
                cache, f"prohibition:{i}", compiled, text
            ):
                full = g0.strip()[:200]
                if full not in seen:
                    seen.add(full)
                    prohibitions.append({"type": label, "text": full})
                    citations.append({
                        "start": start, "end": end, "label": label,
                        "excerpt": full[:160],
                        "line": cache.line_for(start) if cache else None,
                    })

        conditions = []
        for i, (compiled, label) in enumerate(patterns.CONDITION_PATTERNS):
            for start, end, g0, _groups in patterns.iter_matches(
                cache, f"condition:{i}", compiled, text
            ):
                full = g0.strip()[:200]
                if full not in seen:
                    seen.add(full)
                    conditions.append({"type": label, "text": full})
                    citations.append({
                        "start": start, "end": end, "label": label,
                        "excerpt": full[:160],
                        "line": cache.line_for(start) if cache else None,
                    })

        return {
            "obligations": obligations[:20],
            "prohibitions": prohibitions[:10],
            "conditions": conditions[:10],
            "obligation_count": len(obligations),
            "prohibition_count": len(prohibitions),
            "condition_count": len(conditions),
            "_citations": citations,
        }

    def _extract_insights(self, findings):
        insights = []
        insights.append(f"{findings.get('obligation_count', 0)} obligation(s) identified")
        if findings.get("prohibition_count"):
            insights.append(f"{findings['prohibition_count']} prohibition(s) found")
        if findings.get("condition_count"):
            insights.append(f"{findings['condition_count']} conditional clause(s) detected")
        return insights

    def _identify_warnings(self, findings):
        warnings = []
        count = findings.get("obligation_count", 0)
        if count == 0:
            warnings.append("No explicit obligations detected; contract may lack enforceability")
        if count > 15:
            warnings.append("High obligation density; review for feasibility")
        return warnings

    def _compute_confidence(self, findings):
        total = findings.get("obligation_count", 0) + findings.get("prohibition_count", 0)
        if total == 0:
            return 0.3
        return min(0.85, 0.5 + total * 0.03)
