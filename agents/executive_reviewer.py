"""Executive review agent that synthesizes all findings into a final decision.

The executive review produces a weighted decision across five dimensions and,
critically, an **explainable rationale** that tells users *why* the decision
went the way it did: which thresholds failed, which agents dissented, which
critical clauses were missing, and which agents failed during analysis.
"""

from agents.base_agent import BaseAgent


class ExecutiveReviewAgent(BaseAgent):
    """Convenes an executive-level review of all agent findings and produces a final verdict."""

    name = "ExecutiveReviewAgent"
    specialty = "Executive Review & Synthesis"

    # Weighting across the five review dimensions. Must sum to 1.0.
    WEIGHTS = {
        "clause_completeness": 0.25,
        "risk_level": 0.30,
        "financial_clarity": 0.15,
        "obligation_balance": 0.15,
        "analysis_consistency": 0.15,
    }

    # Weighted-score bands for the final decision.
    THRESHOLDS = {"approve": 65, "review": 40}

    # Per-dimension minimum thresholds (below => dimension contributes a trigger).
    DIMENSION_THRESHOLDS = {
        "clause_completeness": 60,
        "risk_level": 50,  # higher dimension score = lower risk
        "financial_clarity": 50,
        "obligation_balance": 50,
        "analysis_consistency": 50,
    }

    # A risk_score (raw risk, higher = worse) above this forces reject.
    HARD_REJECT_RISK = 75

    def _perform_analysis(self, text, context):
        agent_results = context.get("agent_results", {})
        validation = context.get("cross_validation", {})
        failures = context.get("failures", [])
        word_count = len(text.split())

        clause_data = self._get_findings(agent_results, "ClauseDetectionAgent")
        risk_data = self._get_findings(agent_results, "RiskAssessmentAgent")
        financial_data = self._get_findings(agent_results, "FinancialAnalysisAgent")
        obligation_data = self._get_findings(agent_results, "ObligationExtractionAgent")
        temporal_data = self._get_findings(agent_results, "TemporalAnalysisAgent")
        party_data = self._get_findings(agent_results, "PartyIdentificationAgent")

        panel_scores = self._build_panel_scores(
            clause_data, risk_data, financial_data,
            obligation_data, validation,
        )

        # Enrich panel scores with triggers (specific facts that drove each dimension)
        self._attach_triggers(
            panel_scores, clause_data, risk_data, financial_data,
            obligation_data, validation, agent_results,
        )

        # Weighted decision
        weighted_score, overall = self._weighted_decision(panel_scores, risk_data)

        # Build the explainable rationale
        decision_rationale = self._build_rationale(
            panel_scores, weighted_score, overall["decision"],
            clause_data, risk_data, validation, failures,
        )

        summary = self._generate_executive_summary(
            text, clause_data, risk_data, financial_data,
            obligation_data, temporal_data, party_data, panel_scores
        )

        all_warnings = []
        for name, result in agent_results.items():
            if not result:
                continue
            for w in result.warnings or []:
                all_warnings.append({"source": name, "warning": w})
        if validation:
            for c in validation.get("conflicts", []) or []:
                all_warnings.append({"source": "CrossValidation", "warning": c.get("detail", str(c))})

        return {
            "panel_scores": panel_scores,
            "weighted_score": weighted_score,
            "overall_assessment": overall,
            "decision_rationale": decision_rationale,
            "executive_summary": summary,
            "all_warnings": all_warnings[:20],
            "recommendation": self._make_recommendation(overall, decision_rationale),
            "word_count": word_count,
        }

    # ------------------------------------------------------------------
    # Panel-score construction
    # ------------------------------------------------------------------

    def _build_panel_scores(self, clause_data, risk_data, financial_data,
                            obligation_data, validation):
        panel_scores = {}

        # Clause completeness (0–100, higher = better)
        completeness = (clause_data or {}).get("completeness_pct", 0)
        panel_scores["clause_completeness"] = {
            "score": completeness,
            "verdict": self._rate(completeness, [40, 60, 80]),
        }

        # Risk level — dimension score INVERTS raw risk so higher = better
        raw_risk = 0
        risk_label = "Unknown"
        if risk_data:
            raw_risk = (risk_data.get("risk_score") or {}).get("score", 0)
            risk_label = (risk_data.get("risk_score") or {}).get("label", "Unknown")
        risk_dim_score = max(0, 100 - raw_risk)
        panel_scores["risk_level"] = {
            "score": risk_dim_score,
            "raw_risk": raw_risk,
            "label": risk_label,
            "verdict": self._rate_inverse(raw_risk, [25, 50, 75]),
        }

        # Financial clarity
        fin_score = 0
        if financial_data:
            has_payment = financial_data.get("has_payment_terms", False)
            monetary_count = financial_data.get("monetary_count", 0)
            fin_score = 30 + (40 if has_payment else 0) + min(monetary_count * 10, 30)
        fin_score = min(fin_score, 100)
        panel_scores["financial_clarity"] = {
            "score": fin_score,
            "verdict": self._rate(fin_score, [30, 50, 70]),
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
        consistency = (validation or {}).get("overall_consistency", 50)
        panel_scores["analysis_consistency"] = {
            "score": consistency,
            "verdict": self._rate(consistency, [40, 60, 80]),
        }

        return panel_scores

    # ------------------------------------------------------------------
    # Triggers — the specific facts that drove each dimension
    # ------------------------------------------------------------------

    def _attach_triggers(self, panel_scores, clause_data, risk_data,
                         financial_data, obligation_data, validation,
                         agent_results):
        # Static metadata: weight, contribution, threshold
        for dim, entry in panel_scores.items():
            weight = self.WEIGHTS.get(dim, 0.0)
            entry["weight"] = round(weight, 3)
            entry["contribution"] = round(entry["score"] * weight, 2)
            entry["threshold"] = self.DIMENSION_THRESHOLDS.get(dim, 50)
            entry["triggers"] = []

        # Clause completeness triggers
        if clause_data:
            missing_critical = clause_data.get("missing_critical", []) or []
            if missing_critical:
                panel_scores["clause_completeness"]["triggers"].append(
                    f"Missing critical clauses: {', '.join(missing_critical)}"
                )
            completeness = clause_data.get("completeness_pct", 0)
            if completeness < self.DIMENSION_THRESHOLDS["clause_completeness"]:
                panel_scores["clause_completeness"]["triggers"].append(
                    f"Only {completeness}% of standard clauses detected"
                )

        # Risk level triggers
        if risk_data:
            high_risks = (risk_data.get("risks") or {}).get("high", []) or []
            for risk in high_risks[:3]:
                desc = risk.get("description") if isinstance(risk, dict) else str(risk)
                panel_scores["risk_level"]["triggers"].append(f"High risk: {desc}")
            raw_risk = (risk_data.get("risk_score") or {}).get("score", 0)
            if raw_risk >= self.HARD_REJECT_RISK:
                panel_scores["risk_level"]["triggers"].append(
                    f"Raw risk score {raw_risk}/100 is in reject band"
                )

        # Financial clarity triggers
        if financial_data:
            if not financial_data.get("has_payment_terms", False):
                panel_scores["financial_clarity"]["triggers"].append(
                    "No explicit payment structure detected"
                )
            for fr in (financial_data.get("financial_risks") or [])[:2]:
                panel_scores["financial_clarity"]["triggers"].append(
                    f"Financial risk: {fr.get('type', 'unknown')}"
                )

        # Obligation triggers
        if obligation_data:
            count = obligation_data.get("obligation_count", 0)
            if count == 0:
                panel_scores["obligation_balance"]["triggers"].append(
                    "No explicit obligations detected"
                )
            elif count > 15:
                panel_scores["obligation_balance"]["triggers"].append(
                    f"High obligation density ({count} obligations)"
                )

        # Cross-validation triggers
        if validation:
            conflicts = validation.get("conflicts") or []
            if conflicts:
                panel_scores["analysis_consistency"]["triggers"].append(
                    f"{len(conflicts)} cross-agent conflict(s) detected"
                )
            gaps = validation.get("gaps") or []
            if gaps:
                panel_scores["analysis_consistency"]["triggers"].append(
                    f"{len(gaps)} coverage gap(s) between agents"
                )

    # ------------------------------------------------------------------
    # Weighted decision
    # ------------------------------------------------------------------

    def _weighted_decision(self, panel_scores, risk_data):
        weighted_score = round(
            sum(entry.get("contribution", 0) for entry in panel_scores.values()),
            2,
        )

        # Hard reject override: very high raw risk forces reject regardless of score.
        raw_risk = 0
        if risk_data:
            raw_risk = (risk_data.get("risk_score") or {}).get("score", 0)
        if raw_risk >= self.HARD_REJECT_RISK:
            decision = "reject"
        elif weighted_score >= self.THRESHOLDS["approve"]:
            decision = "approve"
        elif weighted_score >= self.THRESHOLDS["review"]:
            decision = "review"
        else:
            decision = "reject"

        # Confidence = distance from nearest decision boundary, mapped to 50–95
        approve = self.THRESHOLDS["approve"]
        review = self.THRESHOLDS["review"]
        if decision == "approve":
            margin = max(weighted_score - approve, 0)
            confidence = min(95, 50 + margin * 2)
        elif decision == "reject":
            margin = max(review - weighted_score, 0)
            confidence = min(95, 50 + margin * 2)
        else:
            # In review band: confidence scales with distance from boundaries
            span = max(approve - review, 1)
            mid = (approve + review) / 2
            dist = span - abs(weighted_score - mid) * 2
            confidence = max(50, min(80, 50 + dist))

        overall = {
            "decision": decision,
            "weighted_score": weighted_score,
            "confidence": round(confidence, 1),
            "thresholds": dict(self.THRESHOLDS),
        }
        return weighted_score, overall

    # ------------------------------------------------------------------
    # Rationale — the "Why this decision?" block
    # ------------------------------------------------------------------

    def _build_rationale(self, panel_scores, weighted_score, decision,
                         clause_data, risk_data, validation, failures):
        rationale = []

        # Headline numeric statement
        approve = self.THRESHOLDS["approve"]
        review = self.THRESHOLDS["review"]
        if decision == "approve":
            rationale.append(
                f"Weighted score {weighted_score}/100 meets the approve threshold ({approve})."
            )
        elif decision == "review":
            rationale.append(
                f"Weighted score {weighted_score}/100 is in the review band "
                f"({review}–{approve})."
            )
        else:
            rationale.append(
                f"Weighted score {weighted_score}/100 is below the approve threshold ({approve})."
            )

        # Risk-specific
        if risk_data:
            raw_risk = (risk_data.get("risk_score") or {}).get("score", 0)
            if raw_risk >= self.HARD_REJECT_RISK:
                rationale.append(
                    f"Risk score {raw_risk}/100 exceeds reject threshold ({self.HARD_REJECT_RISK})."
                )
            high_count = len(((risk_data.get("risks") or {}).get("high") or []))
            if high_count:
                rationale.append(
                    f"{high_count} high-severity risk indicator(s) flagged by RiskAssessmentAgent."
                )

        # Missing critical clauses
        if clause_data:
            missing_critical = clause_data.get("missing_critical") or []
            if missing_critical:
                rationale.append(
                    f"Missing critical clauses: {', '.join(missing_critical)}."
                )

        # Cross-validation conflicts
        if validation:
            conflicts = validation.get("conflicts") or []
            if conflicts:
                rationale.append(
                    f"Cross-validation flagged {len(conflicts)} conflict(s) between agents."
                )

        # Agent failures propagated from the orchestrator
        if failures:
            failed_names = sorted({f.get("agent", "?") for f in failures})
            rationale.append(
                f"{len(failures)} agent(s) failed during analysis: {', '.join(failed_names)}."
            )

        # Per-dimension threshold misses
        for dim, entry in panel_scores.items():
            if entry["score"] < entry["threshold"]:
                rationale.append(
                    f"{dim.replace('_', ' ').title()} scored "
                    f"{entry['score']}/100 (below {entry['threshold']})."
                )

        return rationale

    def _make_recommendation(self, overall, rationale):
        decision = overall["decision"]
        # Use the two most salient rationale lines for specificity
        context_snippets = [r for r in rationale[:3] if "Weighted score" not in r]
        detail = " ".join(context_snippets[:2]).strip()
        if decision == "approve":
            if detail:
                return f"Approve with caveats — {detail}"
            return "Approve: contract appears well-structured with acceptable risk levels"
        if decision == "review":
            if detail:
                return f"Further review needed — {detail}"
            return "Further review needed: several areas require attention before proceeding"
        if detail:
            return f"Reject or renegotiate — {detail}"
        return "Reject or renegotiate: significant issues identified that need resolution"

    # ------------------------------------------------------------------
    # Existing helpers
    # ------------------------------------------------------------------

    def _get_findings(self, results, agent_name):
        result = results.get(agent_name)
        if not result:
            return None
        findings = result.findings or {}
        # Empty findings from a failed agent still return {} so callers don't crash.
        return findings

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

    def _extract_insights(self, findings):
        insights = []
        decision = findings.get("overall_assessment", {}).get("decision", "review")
        confidence = findings.get("overall_assessment", {}).get("confidence", 0)
        weighted = findings.get("weighted_score", 0)
        insights.append(f"Panel decision: {decision.upper()} ({confidence:.0f}% confidence, score {weighted}/100)")
        insights.append(findings.get("recommendation", ""))
        rationale = findings.get("decision_rationale", []) or []
        if rationale:
            insights.append(f"Top driver: {rationale[0]}")
        return insights

    def _compute_confidence(self, findings):
        return round(findings.get("overall_assessment", {}).get("confidence", 0) / 100, 2)
