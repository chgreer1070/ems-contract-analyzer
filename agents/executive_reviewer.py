"""Executive review agent that synthesizes all findings into a final decision."""

from agents.base_agent import BaseAgent


class ExecutiveReviewAgent(BaseAgent):
    """Convenes an executive-level review of all agent findings and produces a final verdict."""

    name = "ExecutiveReviewAgent"
    specialty = "Executive Review & Synthesis"

    def _perform_analysis(self, text, context):
        agent_results = context.get("agent_results", {})
        validation = context.get("cross_validation", {})
        word_count = len(text.split())

        clause_data = self._get_findings(agent_results, "ClauseDetectionAgent")
        risk_data = self._get_findings(agent_results, "RiskAssessmentAgent")
        financial_data = self._get_findings(agent_results, "FinancialAnalysisAgent")
        obligation_data = self._get_findings(agent_results, "ObligationExtractionAgent")
        temporal_data = self._get_findings(agent_results, "TemporalAnalysisAgent")
        party_data = self._get_findings(agent_results, "PartyIdentificationAgent")

        # Panel deliberation: weigh each dimension
        panel_scores = {}

        # Clause completeness assessment
        completeness = clause_data.get("completeness_pct", 0) if clause_data else 0
        panel_scores["clause_completeness"] = {
            "score": completeness,
            "verdict": self._rate(completeness, [40, 60, 80]),
        }

        # Risk assessment
        risk_score = 0
        risk_label = "Unknown"
        if risk_data:
            risk_score = risk_data.get("risk_score", {}).get("score", 0)
            risk_label = risk_data.get("risk_score", {}).get("label", "Unknown")
        panel_scores["risk_level"] = {
            "score": risk_score,
            "label": risk_label,
            "verdict": self._rate_inverse(risk_score, [25, 50, 75]),
        }

        # Financial clarity
        fin_score = 0
        if financial_data:
            has_payment = financial_data.get("has_payment_terms", False)
            monetary_count = financial_data.get("monetary_count", 0)
            fin_score = 30 + (40 if has_payment else 0) + min(monetary_count * 10, 30)
        panel_scores["financial_clarity"] = {
            "score": min(fin_score, 100),
            "verdict": self._rate(min(fin_score, 100), [30, 50, 70]),
        }

        # Obligation balance
        obl_score = 50
        if obligation_data:
            obl_count = obligation_data.get("obligation_count", 0)
            prohibition_count = obligation_data.get("prohibition_count", 0)
            if 3 <= obl_count <= 15:
                obl_score = 80
            elif obl_count > 0:
                obl_score = 60
            if prohibition_count > obl_count and obl_count > 0:
                obl_score -= 15
        panel_scores["obligation_balance"] = {
            "score": obl_score,
            "verdict": self._rate(obl_score, [40, 60, 80]),
        }

        # Cross-agent consistency
        consistency = 50
        if validation:
            consistency = validation.get("overall_consistency", 50)
        panel_scores["analysis_consistency"] = {
            "score": consistency,
            "verdict": self._rate(consistency, [40, 60, 80]),
        }

        # Majority vote on overall assessment
        overall = self._majority_vote(panel_scores, risk_score, completeness)

        # Generate executive summary
        summary = self._generate_executive_summary(
            text, clause_data, risk_data, financial_data,
            obligation_data, temporal_data, party_data, panel_scores
        )

        # Collect all warnings across agents
        all_warnings = []
        for name, result in agent_results.items():
            if result:
                for w in result.warnings:
                    all_warnings.append({"source": name, "warning": w})
        if validation:
            for c in validation.get("conflicts", []):
                all_warnings.append({"source": "CrossValidation", "warning": c["detail"]})

        return {
            "panel_scores": panel_scores,
            "overall_assessment": overall,
            "executive_summary": summary,
            "all_warnings": all_warnings[:20],
            "recommendation": self._make_recommendation(overall, all_warnings),
            "word_count": word_count,
        }

    def _get_findings(self, results, agent_name):
        result = results.get(agent_name)
        return result.findings if result else None

    def _rate(self, score, thresholds):
        if score < thresholds[0]:
            return "Poor"
        if score < thresholds[1]:
            return "Fair"
        if score < thresholds[2]:
            return "Good"
        return "Excellent"

    def _rate_inverse(self, score, thresholds):
        if score <= thresholds[0]:
            return "Excellent"
        if score <= thresholds[1]:
            return "Good"
        if score <= thresholds[2]:
            return "Fair"
        return "Poor"

    def _majority_vote(self, panel_scores, risk_score, completeness):
        votes = {"approve": 0, "review": 0, "reject": 0}

        # Risk panelist
        if risk_score <= 25:
            votes["approve"] += 1
        elif risk_score <= 50:
            votes["review"] += 1
        else:
            votes["reject"] += 1

        # Completeness panelist
        if completeness >= 75:
            votes["approve"] += 1
        elif completeness >= 50:
            votes["review"] += 1
        else:
            votes["reject"] += 1

        # Overall quality panelist (average of all scores)
        avg = sum(s["score"] for s in panel_scores.values()) / max(len(panel_scores), 1)
        if avg >= 65:
            votes["approve"] += 1
        elif avg >= 40:
            votes["review"] += 1
        else:
            votes["reject"] += 1

        # Determine majority
        decision = max(votes, key=votes.get)
        return {
            "decision": decision,
            "votes": votes,
            "confidence": votes[decision] / sum(votes.values()) * 100,
        }

    def _generate_executive_summary(self, text, clauses, risks, financials,
                                     obligations, temporal, parties, scores):
        parts = []
        word_count = len(text.split())
        parts.append(f"This contract contains approximately {word_count} words.")

        if clauses:
            found = len(clauses.get("found", []))
            missing = len(clauses.get("missing", []))
            parts.append(
                f"Detected {found} standard clause type(s) "
                f"with {missing} common clause type(s) not found."
            )
            missing_critical = clauses.get("missing_critical", [])
            if missing_critical:
                parts.append(
                    f"CRITICAL clauses missing: {', '.join(missing_critical[:3])}."
                )

        if risks:
            high_count = len(risks.get("risks", {}).get("high", []))
            medium_count = len(risks.get("risks", {}).get("medium", []))
            if high_count > 0:
                parts.append(f"WARNING: {high_count} high-risk indicator(s) detected.")
            if medium_count > 0:
                parts.append(f"{medium_count} medium-risk indicator(s) found.")
            if high_count == 0 and medium_count == 0:
                parts.append("No significant risk indicators detected.")

        if clauses and clauses.get("missing"):
            parts.append(
                "Missing clauses that are commonly expected: "
                + ", ".join(clauses["missing"][:5]) + "."
            )

        return " ".join(parts)

    def _make_recommendation(self, overall, warnings):
        decision = overall["decision"]
        high_warnings = [w for w in warnings if "high" in w.get("warning", "").lower()
                         or "CRITICAL" in w.get("warning", "")]
        if decision == "approve":
            if high_warnings:
                return "Conditionally approve: address high-priority warnings before signing"
            return "Approve: contract appears well-structured with acceptable risk levels"
        if decision == "review":
            return "Further review needed: several areas require attention before proceeding"
        return "Reject or renegotiate: significant issues identified that need resolution"

    def _extract_insights(self, findings):
        insights = []
        decision = findings["overall_assessment"]["decision"]
        confidence = findings["overall_assessment"]["confidence"]
        insights.append(f"Panel decision: {decision.upper()} ({confidence:.0f}% consensus)")
        insights.append(findings["recommendation"])
        warning_count = len(findings["all_warnings"])
        if warning_count:
            insights.append(f"{warning_count} total warning(s) across all agents")
        return insights

    def _compute_confidence(self, findings):
        return round(findings["overall_assessment"]["confidence"] / 100, 2)
