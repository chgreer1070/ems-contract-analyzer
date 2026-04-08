"""Specialized agent for identifying contracting parties and their roles."""

from agents import patterns
from agents.base_agent import BaseAgent


class PartyIdentificationAgent(BaseAgent):
    """Identifies contracting parties, their roles, and relationship structure."""

    name = "PartyIdentificationAgent"
    specialty = "Party Identification & Roles"

    # Aliases for legacy access
    PARTY_PATTERNS = patterns.PARTY_PATTERNS_RAW
    ROLE_PATTERNS = patterns.ROLE_PATTERNS_RAW

    def _perform_analysis(self, text, context):
        cache = context.get("match_cache") if context else None
        citations = []

        parties = []
        for i, compiled in enumerate(patterns.PARTY_PATTERNS):
            for start, end, _g0, groups in patterns.iter_matches(
                cache, f"party:{i}", compiled, text
            ):
                for group in groups:
                    if group and group.strip() and len(group.strip()) > 1:
                        clean = group.strip().rstrip(",.")
                        if clean not in parties and len(clean) < 100:
                            parties.append(clean)
                            citations.append({
                                "start": start, "end": end, "label": "Party",
                                "excerpt": clean[:160],
                                "line": cache.line_for(start) if cache else None,
                            })

        roles = {}
        for i, (compiled, role) in enumerate(patterns.ROLE_PATTERNS):
            hits = patterns.iter_matches(cache, f"role:{i}", compiled, text)
            if hits:
                start, end, _g0, groups = hits[0]
                value = groups[0] if groups and groups[0] else _g0
                roles[role] = value
                citations.append({
                    "start": start, "end": end, "label": f"Role: {role}",
                    "excerpt": value[:160],
                    "line": cache.line_for(start) if cache else None,
                })

        return {
            "parties": parties[:4],
            "roles": roles,
            "party_count": len(parties[:4]),
            "relationship_type": self._infer_relationship(roles),
            "_citations": citations,
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
        count = findings.get("party_count", 0)
        insights.append(f"{count} contracting part{'y' if count == 1 else 'ies'} identified")
        insights.append(f"Relationship type: {findings.get('relationship_type', 'Unknown')}")
        if findings.get("roles"):
            role_str = ", ".join(f"{v} ({k})" for k, v in findings["roles"].items())
            insights.append(f"Roles: {role_str}")
        return insights

    def _identify_warnings(self, findings):
        warnings = []
        count = findings.get("party_count", 0)
        if count == 0:
            warnings.append("Could not identify any contracting parties")
        if count == 1:
            warnings.append("Only one party identified; may be incomplete")
        return warnings

    def _compute_confidence(self, findings):
        count = findings.get("party_count", 0)
        if count >= 2:
            return 0.85
        if count == 1:
            return 0.5
        return 0.2
