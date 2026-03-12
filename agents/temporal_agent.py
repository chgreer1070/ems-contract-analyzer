"""Specialized agent for extracting dates, deadlines, and temporal provisions."""

import re
from agents.base_agent import BaseAgent


class TemporalAnalysisAgent(BaseAgent):
    """Extracts and analyzes dates, deadlines, durations, and temporal clauses."""

    name = "TemporalAnalysisAgent"
    specialty = "Temporal Analysis & Deadlines"

    KEY_DATE_PATTERNS = [
        (r"(?:effective\s+date|commenc(?:e|ement)\s+date)[:\s]+([^.;,]{5,60})", "Effective Date"),
        (r"(?:expir(?:ation|y)|termination)\s+date[:\s]+([^.;,]{5,60})", "Expiration Date"),
        (r"(?:renew(?:al)?)\s+(?:date|deadline)[:\s]+([^.;,]{5,60})", "Renewal Date"),
        (r"(?:within|no\s+later\s+than)\s+(\d+\s+(?:days?|months?|years?|business\s+days?))", "Deadline"),
    ]

    DURATION_PATTERNS = [
        (r"(?:term|duration|period)\s+(?:of|is)\s+([^.;]{5,60})", "Contract Duration"),
        (r"(\d+)\s*[-–]\s*(?:year|month|day)\s+(?:term|period|agreement)", "Fixed Term"),
        (r"(?:initial\s+term)\s+(?:of|is)\s+([^.;]{5,60})", "Initial Term"),
    ]

    RENEWAL_PATTERNS = [
        (r"(?:automatic(?:ally)?\s+renew(?:al|ed|s)?)\s*([^.;]{0,80})", "Auto-Renewal"),
        (r"(?:option\s+to\s+renew)\s*([^.;]{0,60})", "Renewal Option"),
        (r"(?:renew(?:al|ed|s)?)\s+(?:for|upon)\s+([^.;]{5,60})", "Renewal Terms"),
    ]

    def _perform_analysis(self, text, context):
        dates = []
        seen = set()
        for pattern, label in self.KEY_DATE_PATTERNS:
            for match in re.finditer(pattern, text, re.IGNORECASE):
                value = match.group(1).strip() if match.lastindex else match.group().strip()
                if value not in seen:
                    seen.add(value)
                    dates.append({"type": label, "value": value})

        durations = []
        for pattern, label in self.DURATION_PATTERNS:
            for match in re.finditer(pattern, text, re.IGNORECASE):
                value = match.group(1).strip() if match.lastindex else match.group().strip()
                if value not in seen:
                    seen.add(value)
                    durations.append({"type": label, "value": value})

        renewals = []
        for pattern, label in self.RENEWAL_PATTERNS:
            for match in re.finditer(pattern, text, re.IGNORECASE):
                value = match.group().strip()[:150]
                if value not in seen:
                    seen.add(value)
                    renewals.append({"type": label, "value": value})

        has_auto_renewal = any(r["type"] == "Auto-Renewal" for r in renewals)

        return {
            "key_dates": dates,
            "durations": durations,
            "renewals": renewals,
            "has_auto_renewal": has_auto_renewal,
            "date_count": len(dates),
            "has_expiration": any(d["type"] == "Expiration Date" for d in dates),
        }

    def _extract_insights(self, findings):
        insights = []
        insights.append(f"{findings['date_count']} key date(s) found")
        if findings["has_auto_renewal"]:
            insights.append("Contract contains auto-renewal provisions")
        if not findings["has_expiration"]:
            insights.append("No explicit expiration date detected")
        return insights

    def _identify_warnings(self, findings):
        warnings = []
        if findings["has_auto_renewal"]:
            warnings.append("Auto-renewal detected; review cancellation terms")
        if not findings["has_expiration"] and not findings["durations"]:
            warnings.append("No expiration date or duration specified; could imply perpetual term")
        return warnings

    def _compute_confidence(self, findings):
        total = findings["date_count"] + len(findings["durations"])
        if total == 0:
            return 0.3
        return min(0.85, 0.5 + total * 0.1)
