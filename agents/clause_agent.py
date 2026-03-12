"""Specialized agent for detecting and analyzing contract clauses."""

import re
from agents.base_agent import BaseAgent


class ClauseDetectionAgent(BaseAgent):
    """Detects standard contract clauses, assesses completeness, and flags gaps."""

    name = "ClauseDetectionAgent"
    specialty = "Clause Detection & Completeness"

    CLAUSE_PATTERNS = {
        "Termination": [
            r"terminat(?:e|ion|ed)",
            r"cancel(?:lation)?",
            r"end\s+(?:of\s+)?(?:this\s+)?agreement",
        ],
        "Indemnification": [
            r"indemnif(?:y|ication|ied)",
            r"hold\s+harmless",
            r"defend\s+and\s+indemnify",
        ],
        "Confidentiality": [
            r"confidential(?:ity)?",
            r"non-disclosure",
            r"proprietary\s+information",
            r"trade\s+secret",
        ],
        "Limitation of Liability": [
            r"limit(?:ation)?\s+(?:of\s+)?liability",
            r"in\s+no\s+event\s+shall.*(?:be\s+)?liable",
            r"aggregate\s+liability",
            r"cap\s+on\s+(?:damages|liability)",
        ],
        "Payment Terms": [
            r"payment\s+(?:terms?|schedule|due)",
            r"invoic(?:e|ing)",
            r"net\s+\d+\s+days?",
            r"(?:payable|due)\s+(?:within|upon|on)",
        ],
        "Intellectual Property": [
            r"intellectual\s+property",
            r"(?:patent|copyright|trademark)s?",
            r"ownership\s+of\s+(?:work|deliverables|ip)",
            r"license\s+grant",
        ],
        "Governing Law": [
            r"governing\s+law",
            r"governed\s+by\s+the\s+laws",
            r"jurisdiction",
            r"venue\s+(?:shall\s+be|for)",
        ],
        "Force Majeure": [
            r"force\s+majeure",
            r"act\s+of\s+god",
            r"unforeseeable\s+(?:event|circumstance)",
        ],
        "Non-Compete": [
            r"non-compet(?:e|ition)",
            r"(?:shall|will)\s+not\s+(?:directly\s+or\s+indirectly\s+)?compete",
            r"restrictive\s+covenant",
        ],
        "Warranty": [
            r"warrant(?:y|ies|s)",
            r"represent(?:s|ation)?\s+and\s+warrant",
            r"as[\s-]is",
            r"merchantability",
        ],
        "Dispute Resolution": [
            r"dispute\s+resolution",
            r"arbitrat(?:ion|e|or)",
            r"mediat(?:ion|e|or)",
            r"(?:shall|will)\s+(?:attempt\s+to\s+)?resolve.*(?:dispute|disagreement)",
        ],
        "Assignment": [
            r"assign(?:ment)?(?:\s+of\s+(?:this\s+)?agreement)?",
            r"(?:shall|may)\s+not\s+(?:be\s+)?assign(?:ed)?",
            r"transfer(?:ability)?\s+of\s+(?:rights|obligations)",
        ],
    }

    CRITICAL_CLAUSES = {
        "Termination", "Indemnification", "Limitation of Liability",
        "Confidentiality", "Governing Law",
    }

    def _perform_analysis(self, text, context):
        sentences = re.split(r"(?<=[.!?])\s+", text)
        found = []
        for clause_name, patterns in self.CLAUSE_PATTERNS.items():
            matching = []
            for pattern in patterns:
                for sentence in sentences:
                    if re.search(pattern, sentence, re.IGNORECASE):
                        clean = sentence.strip()[:300]
                        if clean not in matching:
                            matching.append(clean)
            if matching:
                found.append({
                    "name": clause_name,
                    "present": True,
                    "excerpts": matching[:3],
                    "match_strength": min(len(matching), 3),
                })

        found_names = {c["name"] for c in found}
        missing = [n for n in self.CLAUSE_PATTERNS if n not in found_names]
        missing_critical = [n for n in missing if n in self.CRITICAL_CLAUSES]

        completeness = len(found) / len(self.CLAUSE_PATTERNS) * 100

        return {
            "found": found,
            "missing": missing,
            "missing_critical": missing_critical,
            "completeness_pct": round(completeness, 1),
            "total_checked": len(self.CLAUSE_PATTERNS),
        }

    def _extract_insights(self, findings):
        insights = []
        pct = findings["completeness_pct"]
        insights.append(f"Contract clause completeness: {pct}%")
        if findings["missing_critical"]:
            insights.append(
                f"CRITICAL clauses missing: {', '.join(findings['missing_critical'])}"
            )
        count = len(findings["found"])
        insights.append(f"{count} of {findings['total_checked']} standard clauses detected")
        return insights

    def _identify_warnings(self, findings):
        warnings = []
        for clause in findings["missing_critical"]:
            warnings.append(f"Missing critical clause: {clause}")
        if findings["completeness_pct"] < 50:
            warnings.append("Contract has less than 50% of standard clauses")
        return warnings

    def _state_assumptions(self, findings):
        return [
            "Regex pattern matching; nuanced or paraphrased clauses may be missed",
            "Clause completeness is based on 12 common commercial contract clauses",
        ]

    def _compute_confidence(self, findings):
        strong = sum(1 for c in findings["found"] if c["match_strength"] >= 2)
        total = max(len(findings["found"]), 1)
        return round(0.5 + 0.5 * (strong / total), 2)
