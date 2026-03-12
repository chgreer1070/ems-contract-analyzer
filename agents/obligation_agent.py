"""Specialized agent for extracting contractual obligations and duties."""

import re
from agents.base_agent import BaseAgent


class ObligationExtractionAgent(BaseAgent):
    """Extracts and categorizes contractual obligations, duties, and requirements."""

    name = "ObligationExtractionAgent"
    specialty = "Obligations & Duties"

    OBLIGATION_PATTERNS = [
        (r"(?:party|company|contractor|vendor|client|customer)\s+(?:shall|must|will|agrees?\s+to)\s+([^.;]{10,120})",
         "Obligation"),
        (r"(?:is|are)\s+(?:required|obligated)\s+to\s+([^.;]{10,120})", "Requirement"),
        (r"(?:shall|must)\s+(?:provide|deliver|submit|maintain|ensure|comply)\s+([^.;]{10,80})", "Duty"),
    ]

    PROHIBITION_PATTERNS = [
        (r"(?:shall|must|will)\s+not\s+([^.;]{10,100})", "Prohibition"),
        (r"(?:is|are)\s+(?:prohibited|forbidden)\s+(?:from\s+)?([^.;]{10,100})", "Prohibition"),
    ]

    CONDITION_PATTERNS = [
        (r"(?:provided\s+that|on\s+condition\s+that|subject\s+to)\s+([^.;]{10,120})", "Condition"),
        (r"(?:unless|except\s+(?:where|when|if))\s+([^.;]{10,100})", "Exception"),
    ]

    def _perform_analysis(self, text, context):
        obligations = []
        seen = set()
        for pattern, label in self.OBLIGATION_PATTERNS:
            for match in re.finditer(pattern, text, re.IGNORECASE):
                full = match.group().strip()[:200]
                if full not in seen:
                    seen.add(full)
                    obligations.append({"type": label, "text": full})

        prohibitions = []
        for pattern, label in self.PROHIBITION_PATTERNS:
            for match in re.finditer(pattern, text, re.IGNORECASE):
                full = match.group().strip()[:200]
                if full not in seen:
                    seen.add(full)
                    prohibitions.append({"type": label, "text": full})

        conditions = []
        for pattern, label in self.CONDITION_PATTERNS:
            for match in re.finditer(pattern, text, re.IGNORECASE):
                full = match.group().strip()[:200]
                if full not in seen:
                    seen.add(full)
                    conditions.append({"type": label, "text": full})

        return {
            "obligations": obligations[:20],
            "prohibitions": prohibitions[:10],
            "conditions": conditions[:10],
            "obligation_count": len(obligations),
            "prohibition_count": len(prohibitions),
            "condition_count": len(conditions),
        }

    def _extract_insights(self, findings):
        insights = []
        insights.append(f"{findings['obligation_count']} obligation(s) identified")
        if findings["prohibition_count"]:
            insights.append(f"{findings['prohibition_count']} prohibition(s) found")
        if findings["condition_count"]:
            insights.append(f"{findings['condition_count']} conditional clause(s) detected")
        return insights

    def _identify_warnings(self, findings):
        warnings = []
        if findings["obligation_count"] == 0:
            warnings.append("No explicit obligations detected; contract may lack enforceability")
        if findings["obligation_count"] > 15:
            warnings.append("High obligation density; review for feasibility")
        return warnings

    def _compute_confidence(self, findings):
        total = findings["obligation_count"] + findings["prohibition_count"]
        if total == 0:
            return 0.3
        return min(0.85, 0.5 + total * 0.03)
