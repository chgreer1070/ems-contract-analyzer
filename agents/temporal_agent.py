"""Specialized agent for extracting dates, deadlines, and temporal provisions."""

from agents import patterns
from agents.base_agent import BaseAgent


class TemporalAnalysisAgent(BaseAgent):
    """Extracts and analyzes dates, deadlines, durations, and temporal clauses."""

    name = "TemporalAnalysisAgent"
    specialty = "Temporal Analysis & Deadlines"

    # Aliases for legacy access
    KEY_DATE_PATTERNS = patterns.KEY_DATE_PATTERNS_RAW
    DURATION_PATTERNS = patterns.DURATION_PATTERNS_RAW
    RENEWAL_PATTERNS = patterns.RENEWAL_PATTERNS_RAW

    def _perform_analysis(self, text, context):
        cache = context.get("match_cache") if context else None
        citations = []

        dates = []
        seen = set()
        for i, (compiled, label) in enumerate(patterns.KEY_DATE_PATTERNS):
            for start, end, g0, groups in patterns.iter_matches(
                cache, f"date:{i}", compiled, text
            ):
                value = (groups[0].strip() if groups and groups[0] else g0.strip())
                if value not in seen:
                    seen.add(value)
                    dates.append({"type": label, "value": value})
                    citations.append({
                        "start": start, "end": end, "label": label,
                        "excerpt": g0.strip()[:160],
                        "line": cache.line_for(start) if cache else None,
                    })

        durations = []
        for i, (compiled, label) in enumerate(patterns.DURATION_PATTERNS):
            for start, end, g0, groups in patterns.iter_matches(
                cache, f"duration:{i}", compiled, text
            ):
                value = (groups[0].strip() if groups and groups[0] else g0.strip())
                if value not in seen:
                    seen.add(value)
                    durations.append({"type": label, "value": value})
                    citations.append({
                        "start": start, "end": end, "label": label,
                        "excerpt": g0.strip()[:160],
                        "line": cache.line_for(start) if cache else None,
                    })

        renewals = []
        for i, (compiled, label) in enumerate(patterns.RENEWAL_PATTERNS):
            for start, end, g0, _groups in patterns.iter_matches(
                cache, f"renewal:{i}", compiled, text
            ):
                value = g0.strip()[:150]
                if value not in seen:
                    seen.add(value)
                    renewals.append({"type": label, "value": value})
                    citations.append({
                        "start": start, "end": end, "label": label,
                        "excerpt": value[:160],
                        "line": cache.line_for(start) if cache else None,
                    })

        has_auto_renewal = any(r["type"] == "Auto-Renewal" for r in renewals)

        return {
            "key_dates": dates,
            "durations": durations,
            "renewals": renewals,
            "has_auto_renewal": has_auto_renewal,
            "date_count": len(dates),
            "has_expiration": any(d["type"] == "Expiration Date" for d in dates),
            "_citations": citations,
        }

    def _extract_insights(self, findings):
        insights = []
        insights.append(f"{findings.get('date_count', 0)} key date(s) found")
        if findings.get("has_auto_renewal"):
            insights.append("Contract contains auto-renewal provisions")
        if not findings.get("has_expiration"):
            insights.append("No explicit expiration date detected")
        return insights

    def _identify_warnings(self, findings):
        warnings = []
        if findings.get("has_auto_renewal"):
            warnings.append("Auto-renewal detected; review cancellation terms")
        if not findings.get("has_expiration") and not findings.get("durations"):
            warnings.append("No expiration date or duration specified; could imply perpetual term")
        return warnings

    def _compute_confidence(self, findings):
        total = findings.get("date_count", 0) + len(findings.get("durations", []))
        if total == 0:
            return 0.3
        return min(0.85, 0.5 + total * 0.1)
