"""Specialized agent for identifying contracting parties and their roles."""

import re
from agents.base_agent import BaseAgent


class PartyIdentificationAgent(BaseAgent):
    """Identifies contracting parties, their roles, and relationship structure."""

    name = "PartyIdentificationAgent"
    specialty = "Party Identification & Roles"

    PARTY_PATTERNS = [
        r"(?:between|by\s+and\s+between)\s+([A-Z][A-Za-z\s,.'&]+?)(?:\s*\(.*?\))?\s+(?:and|&)\s+([A-Z][A-Za-z\s,.'&]+?)(?:\s*\(.*?\))?(?:\s*[.,;])",
        r"(?:\"([^\"]{2,60})\"|'([^']{2,60})')\s*\((?:hereinafter\s+)?(?:referred\s+to\s+as\s+)?[\"']?(Party|Company|Client|Contractor|Vendor|Seller|Buyer|Licensor|Licensee)",
    ]

    ROLE_PATTERNS = [
        (r"(?:hereinafter|referred\s+to\s+as)\s+[\"']?(?:the\s+)?(Client|Customer|Buyer|Purchaser)", "Client"),
        (r"(?:hereinafter|referred\s+to\s+as)\s+[\"']?(?:the\s+)?(Contractor|Vendor|Seller|Provider|Supplier|Consultant)", "Service Provider"),
        (r"(?:hereinafter|referred\s+to\s+as)\s+[\"']?(?:the\s+)?(Licensor|Franchisor)", "Licensor"),
        (r"(?:hereinafter|referred\s+to\s+as)\s+[\"']?(?:the\s+)?(Licensee|Franchisee)", "Licensee"),
    ]

    def _perform_analysis(self, text, context):
        parties = []
        for pattern in self.PARTY_PATTERNS:
            for match in re.finditer(pattern, text):
                for group in match.groups():
                    if group and group.strip() and len(group.strip()) > 1:
                        clean = group.strip().rstrip(",.")
                        if clean not in parties and len(clean) < 100:
                            parties.append(clean)

        roles = {}
        for pattern, role in self.ROLE_PATTERNS:
            match = re.search(pattern, text, re.IGNORECASE)
            if match:
                roles[role] = match.group(1)

        return {
            "parties": parties[:4],
            "roles": roles,
            "party_count": len(parties[:4]),
            "relationship_type": self._infer_relationship(roles),
        }

    def _infer_relationship(self, roles):
        if "Client" in roles and "Service Provider" in roles:
            return "Client-Service Provider"
        if "Licensor" in roles and "Licensee" in roles:
            return "Licensor-Licensee"
        if "Client" in roles:
            return "Client Agreement"
        return "General Commercial Agreement"

    def _extract_insights(self, findings):
        insights = []
        count = findings["party_count"]
        insights.append(f"{count} contracting part{'y' if count == 1 else 'ies'} identified")
        insights.append(f"Relationship type: {findings['relationship_type']}")
        if findings["roles"]:
            role_str = ", ".join(f"{v} ({k})" for k, v in findings["roles"].items())
            insights.append(f"Roles: {role_str}")
        return insights

    def _identify_warnings(self, findings):
        warnings = []
        if findings["party_count"] == 0:
            warnings.append("Could not identify any contracting parties")
        if findings["party_count"] == 1:
            warnings.append("Only one party identified; may be incomplete")
        return warnings

    def _compute_confidence(self, findings):
        if findings["party_count"] >= 2:
            return 0.85
        if findings["party_count"] == 1:
            return 0.5
        return 0.2
