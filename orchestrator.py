"""Multi-agent orchestrator for contract analysis.

Coordinates specialized agents, cross-validates findings, and produces
a synthesized executive-level analysis through parallel execution and
iterative refinement.

Resilience features:
- Per-agent timeouts and exception containment: one failed agent no longer
  kills the whole analysis; it is replaced with an empty-findings placeholder.
- Total-time budget: the orchestrator aborts remaining phases if the wall
  clock exceeds ``total_timeout``.
- Input truncation: very large text is clipped to ``max_text_chars`` to
  defend against pathological regex backtracking.
- Shared ``MatchCache``: every regex in the pattern registry runs once
  against the text and all agents read from the cache, eliminating the
  O(agents x patterns) re-scan cost.
"""

import time
from concurrent.futures import ThreadPoolExecutor, TimeoutError as FuturesTimeout

from agents import patterns
from agents.base_agent import AgentResult
from agents.clause_agent import ClauseDetectionAgent
from agents.risk_agent import RiskAssessmentAgent
from agents.financial_agent import FinancialAnalysisAgent
from agents.obligation_agent import ObligationExtractionAgent
from agents.temporal_agent import TemporalAnalysisAgent
from agents.party_agent import PartyIdentificationAgent
from agents.cross_validator import CrossValidationAgent
from agents.executive_reviewer import ExecutiveReviewAgent
from agents.match_cache import MatchCache


class ContractOrchestrator:
    """Orchestrates multi-agent contract analysis with cross-validation."""

    def __init__(
        self,
        max_workers: int = 6,
        agent_timeout: float = 10.0,
        total_timeout: float = 60.0,
        max_text_chars: int = 500_000,
    ):
        self.max_workers = max_workers
        self.agent_timeout = agent_timeout
        self.total_timeout = total_timeout
        self.max_text_chars = max_text_chars
        self.initial_agents = [
            ClauseDetectionAgent(),
            RiskAssessmentAgent(),
            FinancialAnalysisAgent(),
            ObligationExtractionAgent(),
            TemporalAnalysisAgent(),
            PartyIdentificationAgent(),
        ]
        self.cross_validator = CrossValidationAgent()
        self.executive_reviewer = ExecutiveReviewAgent()

    def analyze(self, text):
        """Run full multi-agent orchestrated analysis."""
        start = time.time()
        trace = {
            "phases": [],
            "failures": [],
            "notes": [],
            "total_agents_deployed": 0,
        }

        # Guard against runaway regex backtracking on huge inputs.
        if len(text) > self.max_text_chars:
            trace["notes"].append(
                f"Input truncated from {len(text)} to {self.max_text_chars} chars"
            )
            text = text[: self.max_text_chars]

        # Build the shared match cache once — every agent reads from it.
        cache_build_start = time.time()
        match_cache = MatchCache(text)
        match_cache.run_all(patterns.PATTERN_ID)
        cache_ms = round((time.time() - cache_build_start) * 1000, 2)
        trace["match_cache_build_ms"] = cache_ms
        trace["match_cache_pattern_count"] = len(match_cache)

        base_context = {"match_cache": match_cache}

        # Phase 1: Deploy initial specialized agents in parallel
        phase1_start = time.time()
        agent_results = self._run_agents_parallel(
            self.initial_agents, text, context=base_context,
            phase_name="Initial Analysis", trace=trace,
        )
        trace["phases"].append({
            "name": "Initial Analysis",
            "agents": list(agent_results.keys()),
            "duration_ms": round((time.time() - phase1_start) * 1000, 2),
        })
        trace["total_agents_deployed"] += len(agent_results)

        if self._budget_exceeded(start, trace):
            return self._assemble_response(
                agent_results, {}, self._empty_executive(), trace
            )

        # Phase 2: Cross-validation
        phase2_start = time.time()
        validation_findings = self._safe_analyze(
            self.cross_validator, text,
            context={"agent_results": agent_results, "match_cache": match_cache},
            phase_name="Cross-Validation", trace=trace,
        )
        trace["phases"].append({
            "name": "Cross-Validation",
            "agents": ["CrossValidationAgent"],
            "duration_ms": round((time.time() - phase2_start) * 1000, 2),
            "conflicts": len(validation_findings.get("conflicts", [])),
            "gaps": len(validation_findings.get("gaps", [])),
        })
        trace["total_agents_deployed"] += 1

        if self._budget_exceeded(start, trace):
            return self._assemble_response(
                agent_results, validation_findings, self._empty_executive(), trace
            )

        # Phase 3: Targeted follow-up agents if needed
        if validation_findings.get("needs_followup"):
            phase3_start = time.time()
            followup_agents = self._select_followup_agents(validation_findings)
            if followup_agents:
                followup_results = self._run_agents_parallel(
                    followup_agents, text,
                    context={**base_context, "prior_results": agent_results},
                    phase_name="Targeted Follow-up", trace=trace,
                )
                for name, result in followup_results.items():
                    agent_results[name] = result
                trace["phases"].append({
                    "name": "Targeted Follow-up",
                    "agents": list(followup_results.keys()),
                    "duration_ms": round((time.time() - phase3_start) * 1000, 2),
                })
                trace["total_agents_deployed"] += len(followup_results)

                # Re-validate after follow-up
                validation_findings = self._safe_analyze(
                    self.cross_validator, text,
                    context={"agent_results": agent_results, "match_cache": match_cache},
                    phase_name="Cross-Validation (post follow-up)", trace=trace,
                )
                trace["total_agents_deployed"] += 1

        if self._budget_exceeded(start, trace):
            return self._assemble_response(
                agent_results, validation_findings, self._empty_executive(), trace
            )

        # Phase 4: Executive review panel
        phase4_start = time.time()
        executive_result = self._safe_analyze_full(
            self.executive_reviewer, text,
            context={
                "agent_results": agent_results,
                "cross_validation": validation_findings,
                "match_cache": match_cache,
                "failures": trace["failures"],
            },
            phase_name="Executive Review", trace=trace,
        )
        trace["phases"].append({
            "name": "Executive Review",
            "agents": ["ExecutiveReviewAgent"],
            "duration_ms": round((time.time() - phase4_start) * 1000, 2),
        })
        trace["total_agents_deployed"] += 1

        total_ms = round((time.time() - start) * 1000, 2)
        trace["total_duration_ms"] = total_ms

        # Assemble final response
        return self._assemble_response(
            agent_results, validation_findings, executive_result, trace
        )

    # ------------------------------------------------------------------
    # Resilience helpers
    # ------------------------------------------------------------------

    def _budget_exceeded(self, start_time: float, trace: dict) -> bool:
        """Return True and record a note if the total timeout elapsed."""
        if (time.time() - start_time) >= self.total_timeout:
            trace["notes"].append(
                f"Total timeout {self.total_timeout}s exceeded; skipping remaining phases"
            )
            return True
        return False

    def _failed_result(self, agent_name: str, specialty: str, error: str) -> AgentResult:
        return AgentResult(
            agent_name=agent_name,
            specialty=specialty,
            findings={},
            top_insights=[],
            warnings=[f"Agent failed: {error}"],
            confidence=0.0,
            metadata={"failed": True, "error": error},
        )

    def _empty_executive(self) -> AgentResult:
        return AgentResult(
            agent_name="ExecutiveReviewAgent",
            specialty="Executive Review",
            findings={
                "executive_summary": "Analysis incomplete due to timeout or failure.",
                "panel_scores": {},
                "overall_assessment": {"decision": "review", "confidence": 0},
                "recommendation": "Re-run analysis with a smaller input or increased timeout.",
                "decision_rationale": ["Analysis was aborted before completion."],
                "weighted_score": 0,
                "all_warnings": [],
                "word_count": 0,
            },
            confidence=0.0,
            metadata={"failed": True},
        )

    def _run_agents_parallel(self, agents, text, context=None, phase_name="", trace=None):
        """Execute agents in parallel; never let one failure crash the batch."""
        results = {}
        if not agents:
            return results
        with ThreadPoolExecutor(max_workers=self.max_workers) as executor:
            future_to_agent = {
                executor.submit(agent.analyze, text, context): agent
                for agent in agents
            }
            for future, agent in future_to_agent.items():
                try:
                    result = future.result(timeout=self.agent_timeout)
                except FuturesTimeout as exc:
                    future.cancel()
                    error = f"timeout after {self.agent_timeout}s"
                    result = self._failed_result(agent.name, agent.specialty, error)
                    if trace is not None:
                        trace["failures"].append({
                            "agent": agent.name,
                            "error": error,
                            "phase": phase_name,
                        })
                except Exception as exc:  # noqa: BLE001 — we intentionally trap everything
                    error = f"{type(exc).__name__}: {exc}"
                    result = self._failed_result(agent.name, agent.specialty, error)
                    if trace is not None:
                        trace["failures"].append({
                            "agent": agent.name,
                            "error": error,
                            "phase": phase_name,
                        })
                results[agent.name] = result
        return results

    def _safe_analyze(self, agent, text, context, phase_name, trace):
        """Run a single (non-pooled) agent and return its findings dict."""
        result = self._safe_analyze_full(agent, text, context, phase_name, trace)
        return result.findings or {}

    def _safe_analyze_full(self, agent, text, context, phase_name, trace):
        """Run a single agent with exception containment, return the AgentResult."""
        try:
            return agent.analyze(text, context=context)
        except Exception as exc:  # noqa: BLE001
            error = f"{type(exc).__name__}: {exc}"
            trace["failures"].append({
                "agent": agent.name,
                "error": error,
                "phase": phase_name,
            })
            return self._failed_result(agent.name, agent.specialty, error)

    # ------------------------------------------------------------------
    # Phase helpers
    # ------------------------------------------------------------------

    def _select_followup_agents(self, validation_findings):
        """Select additional agents based on identified gaps and conflicts."""
        followup = []
        for gap in validation_findings.get("gaps", []):
            gap_type = gap.get("type", "")
            if gap_type == "missing_payment_structure":
                followup.append(FinancialAnalysisAgent())
            elif gap_type == "unattributed_obligations":
                followup.append(PartyIdentificationAgent())
            elif gap_type == "incomplete_low_risk":
                followup.append(ClauseDetectionAgent())
        # Deduplicate by agent name
        seen = set()
        unique = []
        for agent in followup:
            if agent.name not in seen:
                seen.add(agent.name)
                unique.append(agent)
        return unique

    # ------------------------------------------------------------------
    # Response assembly
    # ------------------------------------------------------------------

    @staticmethod
    def _safe_findings(result):
        """Return the findings dict for a result, or an empty dict."""
        if result is None:
            return {}
        return result.findings or {}

    def _assemble_response(self, agent_results, validation, executive_result, trace):
        """Build the unified response combining all agent outputs."""
        exec_findings = self._safe_findings(executive_result)

        clause_result = agent_results.get("ClauseDetectionAgent")
        risk_result = agent_results.get("RiskAssessmentAgent")
        financial_result = agent_results.get("FinancialAnalysisAgent")
        obligation_result = agent_results.get("ObligationExtractionAgent")
        temporal_result = agent_results.get("TemporalAnalysisAgent")
        party_result = agent_results.get("PartyIdentificationAgent")

        clause_f = self._safe_findings(clause_result)
        risk_f = self._safe_findings(risk_result)
        financial_f = self._safe_findings(financial_result)
        obligation_f = self._safe_findings(obligation_result)
        temporal_f = self._safe_findings(temporal_result)
        party_f = self._safe_findings(party_result)

        # Collect every agent's citations into a flat, agent-tagged list.
        all_citations = []
        for name, result in agent_results.items():
            if result is None:
                continue
            for cite in getattr(result, "citations", []) or []:
                all_citations.append(cite)

        response = {
            # Standard fields (backward-compatible with ContractAnalyzer)
            "summary": exec_findings.get("executive_summary", ""),
            "risk_score": risk_f.get("risk_score", {"score": 0, "label": "Unknown"}),
            "clauses": {
                "found": clause_f.get("found", []),
                "missing": clause_f.get("missing", []),
            },
            "risks": risk_f.get("risks", {"high": [], "medium": [], "low": []}),
            "obligations": obligation_f.get("obligations", []),
            "key_dates": temporal_f.get("key_dates", []),
            "financial_terms": financial_f.get("financial_terms", []),
            "parties": party_f.get("parties", []),
            "word_count": exec_findings.get("word_count", 0),
            "section_count": len(clause_f.get("found", [])),

            # Orchestration-specific fields
            "orchestration": {
                "panel_scores": exec_findings.get("panel_scores", {}),
                "overall_assessment": exec_findings.get("overall_assessment", {}),
                "recommendation": exec_findings.get("recommendation", ""),
                "decision_rationale": exec_findings.get("decision_rationale", []),
                "weighted_score": exec_findings.get("weighted_score", 0),
                "cross_validation": {
                    "consistency_score": validation.get("overall_consistency", 0),
                    "conflicts": validation.get("conflicts", []),
                    "gaps": validation.get("gaps", []),
                    "reinforcements": validation.get("reinforcements", []),
                },
                "agent_reports": {
                    name: {
                        "specialty": result.specialty,
                        "top_insights": result.top_insights,
                        "warnings": result.warnings,
                        "confidence": result.confidence,
                        "execution_time_ms": result.execution_time_ms,
                        "citations": getattr(result, "citations", []) or [],
                        "failed": bool((result.metadata or {}).get("failed")),
                        "error": (result.metadata or {}).get("error"),
                    }
                    for name, result in agent_results.items()
                },
                "all_warnings": exec_findings.get("all_warnings", []),
                "all_citations": all_citations,
                "trace": trace,
            },
        }

        # Add enhanced data from specialized agents
        response["prohibitions"] = obligation_f.get("prohibitions", [])
        response["conditions"] = obligation_f.get("conditions", [])

        response["payment_structures"] = financial_f.get("payment_structures", [])
        response["financial_risks"] = financial_f.get("financial_risks", [])

        response["durations"] = temporal_f.get("durations", [])
        response["renewals"] = temporal_f.get("renewals", [])

        response["clause_completeness"] = clause_f.get("completeness_pct", 0)
        response["missing_critical"] = clause_f.get("missing_critical", [])

        response["risk_dimensions"] = risk_f.get("dimension_scores", {})

        response["party_roles"] = party_f.get("roles", {})
        response["relationship_type"] = party_f.get("relationship_type", "")

        return response
