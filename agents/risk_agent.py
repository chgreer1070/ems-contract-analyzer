"""Specialized agent for risk assessment in contracts."""

import re
from agents.base_agent import BaseAgent


class RiskAssessmentAgent(BaseAgent):
    """Identifies and scores risk indicators across multiple risk dimensions."""

    name = "RiskAssessmentAgent"
    specialty = "Risk Assessment & Scoring"

    RISK_INDICATORS = {
        "high": [
            (r"unlimited\s+liability", "Unlimited liability exposure"),
            (r"waiv(?:e|er)\s+(?:all|any)\s+(?:right|claim)", "Broad waiver of rights"),
            (r"sole\s+(?:discretion|judgment)", "Sole discretion clause favoring one party"),
            (r"irrevocabl[ey]", "Irrevocable commitment"),
            (r"perpetual(?:ly)?(?:\s+and\s+irrevocabl[ey])?", "Perpetual obligation"),
            (r"(?:shall|will)\s+not\s+(?:be\s+)?(?:liable|responsible)\s+(?:for\s+)?(?:any|all)",
             "Broad liability exclusion"),
            (r"automatic(?:ally)?\s+renew", "Auto-renewal clause"),
            (r"(?:penalty|penalt?ies)\s+(?:for|of|in)", "Penalty clause detected"),
        ],
        "medium": [
            (r"(?:may|shall)\s+(?:be\s+)?(?:amended|modified)\s+(?:at\s+)?(?:any\s+time|unilaterally)",
             "Unilateral modification rights"),
            (r"(?:reasonable\s+)?(?:best|commercial(?:ly)?)\s+efforts?",
             "Best/commercial efforts standard (vague)"),
            (r"(?:liquidated\s+)?damages", "Damages clause present"),
            (r"non-solicitat(?:ion|e)", "Non-solicitation restriction"),
            (r"(?:3|three|five|5)\s+year", "Long-term commitment period"),
            (r"(?:exclusive|exclusivity)", "Exclusivity requirement"),
        ],
        "low": [
            (r"(?:30|thirty)\s+days?\s+(?:written\s+)?notice", "Standard notice period"),
            (r"mutual(?:ly)?\s+(?:agree|consent)", "Mutual agreement required"),
            (r"(?:pro[\s-]?rata|proportional)", "Pro-rata provisions"),
        ],
    }

    RISK_DIMENSIONS = {
        "liability": [
            r"(?:un)?limited\s+liability",
            r"(?:shall|will)\s+not\s+(?:be\s+)?(?:liable|responsible)",
            r"aggregate\s+liability",
            r"cap\s+on\s+(?:damages|liability)",
        ],
        "commitment": [
            r"perpetual", r"irrevocabl[ey]",
            r"automatic(?:ally)?\s+renew",
            r"(?:3|three|five|5|10|ten)\s+year",
        ],
        "control": [
            r"sole\s+(?:discretion|judgment)",
            r"unilateral(?:ly)?",
            r"without\s+(?:prior\s+)?(?:consent|approval)",
        ],
        "flexibility": [
            r"(?:may|shall)\s+(?:be\s+)?(?:amended|modified)",
            r"(?:exclusive|exclusivity)",
            r"non-compet(?:e|ition)",
            r"restrictive\s+covenant",
        ],
    }

    def _perform_analysis(self, text, context):
        risks = {"high": [], "medium": [], "low": []}
        for severity, patterns in self.RISK_INDICATORS.items():
            for pattern, description in patterns:
                for match in re.finditer(pattern, text, re.IGNORECASE):
                    start = max(0, match.start() - 50)
                    end = min(len(text), match.end() + 100)
                    ctx = text[start:end].strip()
                    entry = {
                        "description": description,
                        "context": ctx,
                        "matched": match.group(),
                    }
                    if entry["description"] not in [r["description"] for r in risks[severity]]:
                        risks[severity].append(entry)

        dimension_scores = {}
        for dim, patterns in self.RISK_DIMENSIONS.items():
            hits = 0
            for pattern in patterns:
                if re.search(pattern, text, re.IGNORECASE):
                    hits += 1
            dimension_scores[dim] = round(hits / len(patterns) * 100, 1)

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
        }

    def _extract_insights(self, findings):
        insights = []
        score = findings["risk_score"]
        insights.append(f"Overall risk score: {score['score']}/100 ({score['label']})")
        high_count = len(findings["risks"]["high"])
        if high_count:
            insights.append(f"{high_count} high-severity risk indicator(s) found")
        worst_dim = max(findings["dimension_scores"], key=findings["dimension_scores"].get)
        insights.append(f"Highest risk dimension: {worst_dim} ({findings['dimension_scores'][worst_dim]}%)")
        return insights

    def _identify_warnings(self, findings):
        warnings = []
        if findings["risk_score"]["score"] >= 75:
            warnings.append("CRITICAL: Risk score exceeds 75/100")
        for risk in findings["risks"]["high"]:
            warnings.append(f"High risk: {risk['description']}")
        return warnings

    def _state_assumptions(self, findings):
        return [
            "Risk scoring weights: high=20, medium=10, low=3 per indicator",
            "Dimension analysis is presence-based, not severity-weighted",
        ]

    def _compute_confidence(self, findings):
        total = findings["total_indicators"]
        if total == 0:
            return 0.4
        return min(0.9, 0.5 + total * 0.05)
