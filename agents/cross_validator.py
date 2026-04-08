"""Cross-validation agent that checks consistency across agent findings."""

from agents.base_agent import BaseAgent


class CrossValidationAgent(BaseAgent):
    """Validates consistency across multiple agent reports and identifies conflicts."""

    name = "CrossValidationAgent"
    specialty = "Cross-Agent Validation"

    def _perform_analysis(self, text, context):
        agent_results = context.get("agent_results", {})
        conflicts = []
        gaps = []
        reinforcements = []

        clause_result = agent_results.get("ClauseDetectionAgent")
        risk_result = agent_results.get("RiskAssessmentAgent")
        financial_result = agent_results.get("FinancialAnalysisAgent")
        obligation_result = agent_results.get("ObligationExtractionAgent")
        temporal_result = agent_results.get("TemporalAnalysisAgent")
        party_result = agent_results.get("PartyIdentificationAgent")

        # Check clause-risk consistency
        if clause_result and risk_result:
            clause_findings = clause_result.findings or {}
            risk_findings = risk_result.findings or {}
            found_names = {c["name"] for c in clause_findings.get("found", [])}
            high_risks = (risk_findings.get("risks") or {}).get("high", [])

            if "Limitation of Liability" not in found_names and high_risks:
                conflicts.append({
                    "type": "clause_risk_mismatch",
                    "detail": "High risk indicators found but no Limitation of Liability clause detected",
                    "severity": "high",
                })
            if "Limitation of Liability" in found_names and not high_risks:
                reinforcements.append(
                    "Liability clause present with no high-risk indicators: positive sign"
                )

        # Check financial-obligation consistency
        if financial_result and obligation_result:
            has_payment_terms = financial_result.findings.get("has_payment_terms", False)
            obl_count = obligation_result.findings.get("obligation_count", 0)
            if obl_count > 0 and not has_payment_terms:
                gaps.append({
                    "type": "missing_payment_structure",
                    "detail": "Obligations exist but no payment structure detected",
                    "severity": "medium",
                })

        # Check temporal-risk consistency
        if temporal_result and risk_result:
            has_auto = (temporal_result.findings or {}).get("has_auto_renewal", False)
            risk_findings = risk_result.findings or {}
            high_risks = (risk_findings.get("risks") or {}).get("high", [])
            risk_descs = [r.get("description", "") for r in high_risks]
            if has_auto and "Auto-renewal clause" not in risk_descs:
                conflicts.append({
                    "type": "temporal_risk_gap",
                    "detail": "Auto-renewal found by temporal agent but not flagged as high risk",
                    "severity": "low",
                })

        # Check party identification vs obligation scope
        if party_result and obligation_result:
            party_count = party_result.findings.get("party_count", 0)
            if party_count == 0 and obligation_result.findings.get("obligation_count", 0) > 0:
                gaps.append({
                    "type": "unattributed_obligations",
                    "detail": "Obligations found but no parties identified to bind them",
                    "severity": "medium",
                })

        # Check clause completeness vs overall risk
        if clause_result and risk_result:
            completeness = (clause_result.findings or {}).get("completeness_pct", 0)
            risk_score = ((risk_result.findings or {}).get("risk_score") or {}).get("score", 0)
            if completeness < 50 and risk_score < 25:
                gaps.append({
                    "type": "incomplete_low_risk",
                    "detail": (
                        f"Low risk score ({risk_score}) with low clause completeness "
                        f"({completeness}%); may indicate incomplete document"
                    ),
                    "severity": "medium",
                })

        # Compute confidence from all agents
        confidences = {}
        for name, result in agent_results.items():
            if result:
                confidences[name] = result.confidence

        return {
            "conflicts": conflicts,
            "gaps": gaps,
            "reinforcements": reinforcements,
            "agent_confidences": confidences,
            "overall_consistency": self._score_consistency(conflicts, gaps, reinforcements),
            "needs_followup": len(conflicts) > 0 or len(gaps) > 2,
        }

    def _score_consistency(self, conflicts, gaps, reinforcements):
        score = 100
        for c in conflicts:
            if c["severity"] == "high":
                score -= 20
            elif c["severity"] == "medium":
                score -= 10
            else:
                score -= 5
        score -= len(gaps) * 8
        score += len(reinforcements) * 3
        return max(0, min(100, score))

    def _extract_insights(self, findings):
        insights = []
        consistency = findings.get("overall_consistency", 0)
        insights.append(f"Cross-agent consistency score: {consistency}/100")
        if findings.get("conflicts"):
            insights.append(f"{len(findings['conflicts'])} conflict(s) between agent findings")
        if findings.get("gaps"):
            insights.append(f"{len(findings['gaps'])} analysis gap(s) identified")
        return insights

    def _identify_warnings(self, findings):
        warnings = []
        for c in findings.get("conflicts", []):
            if c.get("severity") == "high":
                warnings.append(f"Conflict: {c.get('detail', '')}")
        for g in findings.get("gaps", []):
            if g.get("severity") in ("high", "medium"):
                warnings.append(f"Gap: {g.get('detail', '')}")
        return warnings

    def _compute_confidence(self, findings):
        return round(findings.get("overall_consistency", 0) / 100, 2)
