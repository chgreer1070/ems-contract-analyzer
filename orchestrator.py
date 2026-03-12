"""Multi-agent orchestrator for contract analysis.

Coordinates specialized agents, cross-validates findings, and produces
a synthesized executive-level analysis through parallel execution and
iterative refinement.
"""

import time
from concurrent.futures import ThreadPoolExecutor, as_completed

from agents.clause_agent import ClauseDetectionAgent
from agents.risk_agent import RiskAssessmentAgent
from agents.financial_agent import FinancialAnalysisAgent
from agents.obligation_agent import ObligationExtractionAgent
from agents.temporal_agent import TemporalAnalysisAgent
from agents.party_agent import PartyIdentificationAgent
from agents.cross_validator import CrossValidationAgent
from agents.executive_reviewer import ExecutiveReviewAgent


class ContractOrchestrator:
    """Orchestrates multi-agent contract analysis with cross-validation."""

    def __init__(self, max_workers=6):
        self.max_workers = max_workers
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
            "total_agents_deployed": 0,
        }

        # Phase 1: Deploy initial specialized agents in parallel
        phase1_start = time.time()
        agent_results = self._run_agents_parallel(self.initial_agents, text)
        trace["phases"].append({
            "name": "Initial Analysis",
            "agents": list(agent_results.keys()),
            "duration_ms": round((time.time() - phase1_start) * 1000, 2),
        })
        trace["total_agents_deployed"] += len(agent_results)

        # Phase 2: Cross-validation
        phase2_start = time.time()
        validation_result = self.cross_validator.analyze(
            text, context={"agent_results": agent_results}
        )
        validation_findings = validation_result.findings
        trace["phases"].append({
            "name": "Cross-Validation",
            "agents": ["CrossValidationAgent"],
            "duration_ms": round((time.time() - phase2_start) * 1000, 2),
            "conflicts": len(validation_findings.get("conflicts", [])),
            "gaps": len(validation_findings.get("gaps", [])),
        })
        trace["total_agents_deployed"] += 1

        # Phase 3: Targeted follow-up agents if needed
        if validation_findings.get("needs_followup"):
            phase3_start = time.time()
            followup_agents = self._select_followup_agents(validation_findings)
            if followup_agents:
                followup_results = self._run_agents_parallel(
                    followup_agents, text,
                    context={"prior_results": agent_results}
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
                validation_result = self.cross_validator.analyze(
                    text, context={"agent_results": agent_results}
                )
                validation_findings = validation_result.findings
                trace["total_agents_deployed"] += 1

        # Phase 4: Executive review panel
        phase4_start = time.time()
        executive_result = self.executive_reviewer.analyze(
            text, context={
                "agent_results": agent_results,
                "cross_validation": validation_findings,
            }
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

    def _run_agents_parallel(self, agents, text, context=None):
        """Execute agents in parallel using a thread pool."""
        results = {}
        with ThreadPoolExecutor(max_workers=self.max_workers) as executor:
            futures = {
                executor.submit(agent.analyze, text, context): agent
                for agent in agents
            }
            for future in as_completed(futures):
                agent = futures[future]
                result = future.result()
                results[agent.name] = result
        return results

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

    def _assemble_response(self, agent_results, validation, executive_result, trace):
        """Build the unified response combining all agent outputs."""
        exec_findings = executive_result.findings

        # Extract core data from specialized agents
        clause_result = agent_results.get("ClauseDetectionAgent")
        risk_result = agent_results.get("RiskAssessmentAgent")
        financial_result = agent_results.get("FinancialAnalysisAgent")
        obligation_result = agent_results.get("ObligationExtractionAgent")
        temporal_result = agent_results.get("TemporalAnalysisAgent")
        party_result = agent_results.get("PartyIdentificationAgent")

        # Build backward-compatible response that also includes orchestration data
        response = {
            # Standard fields (backward-compatible with ContractAnalyzer)
            "summary": exec_findings.get("executive_summary", ""),
            "risk_score": (
                risk_result.findings["risk_score"]
                if risk_result else {"score": 0, "label": "Unknown"}
            ),
            "clauses": (
                {
                    "found": clause_result.findings.get("found", []),
                    "missing": clause_result.findings.get("missing", []),
                }
                if clause_result else {"found": [], "missing": []}
            ),
            "risks": (
                risk_result.findings["risks"]
                if risk_result else {"high": [], "medium": [], "low": []}
            ),
            "obligations": (
                obligation_result.findings.get("obligations", [])
                if obligation_result else []
            ),
            "key_dates": (
                temporal_result.findings.get("key_dates", [])
                if temporal_result else []
            ),
            "financial_terms": (
                financial_result.findings.get("financial_terms", [])
                if financial_result else []
            ),
            "parties": (
                party_result.findings.get("parties", [])
                if party_result else []
            ),
            "word_count": exec_findings.get("word_count", 0),
            "section_count": (
                len(clause_result.findings.get("found", []))
                if clause_result else 0
            ),

            # Orchestration-specific fields
            "orchestration": {
                "panel_scores": exec_findings.get("panel_scores", {}),
                "overall_assessment": exec_findings.get("overall_assessment", {}),
                "recommendation": exec_findings.get("recommendation", ""),
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
                    }
                    for name, result in agent_results.items()
                },
                "all_warnings": exec_findings.get("all_warnings", []),
                "trace": trace,
            },
        }

        # Add enhanced data from specialized agents
        if obligation_result:
            response["prohibitions"] = obligation_result.findings.get("prohibitions", [])
            response["conditions"] = obligation_result.findings.get("conditions", [])

        if financial_result:
            response["payment_structures"] = financial_result.findings.get("payment_structures", [])
            response["financial_risks"] = financial_result.findings.get("financial_risks", [])

        if temporal_result:
            response["durations"] = temporal_result.findings.get("durations", [])
            response["renewals"] = temporal_result.findings.get("renewals", [])

        if clause_result:
            response["clause_completeness"] = clause_result.findings.get("completeness_pct", 0)
            response["missing_critical"] = clause_result.findings.get("missing_critical", [])

        if risk_result:
            response["risk_dimensions"] = risk_result.findings.get("dimension_scores", {})

        if party_result:
            response["party_roles"] = party_result.findings.get("roles", {})
            response["relationship_type"] = party_result.findings.get("relationship_type", "")

        return response
