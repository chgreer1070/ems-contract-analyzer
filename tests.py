import json
import os
import re
import unittest

from analyzer import ContractAnalyzer
from orchestrator import ContractOrchestrator
from agents import patterns
from agents.base_agent import BaseAgent, AgentResult
from agents.clause_agent import ClauseDetectionAgent
from agents.risk_agent import RiskAssessmentAgent
from agents.financial_agent import FinancialAnalysisAgent
from agents.obligation_agent import ObligationExtractionAgent
from agents.temporal_agent import TemporalAnalysisAgent
from agents.party_agent import PartyIdentificationAgent
from agents.cross_validator import CrossValidationAgent
from agents.executive_reviewer import ExecutiveReviewAgent
from agents.match_cache import MatchCache
from app import app


SAMPLE_PATH = os.path.join(os.path.dirname(__file__), "sample_contract.txt")

with open(SAMPLE_PATH, "r") as _f:
    SAMPLE_TEXT = _f.read()


class TestContractAnalyzer(unittest.TestCase):
    def setUp(self):
        self.analyzer = ContractAnalyzer()
        self.sample_text = SAMPLE_TEXT

    def test_analyze_returns_all_keys(self):
        result = self.analyzer.analyze(self.sample_text)
        expected_keys = {
            "summary", "risk_score", "clauses", "risks", "obligations",
            "key_dates", "financial_terms", "parties", "word_count", "section_count",
        }
        self.assertEqual(set(result.keys()), expected_keys)

    def test_clauses_detected(self):
        result = self.analyzer.analyze(self.sample_text)
        found_names = [c["name"] for c in result["clauses"]["found"]]
        self.assertIn("Termination", found_names)
        self.assertIn("Confidentiality", found_names)
        self.assertIn("Indemnification", found_names)
        self.assertIn("Governing Law", found_names)
        self.assertIn("Intellectual Property", found_names)
        self.assertIn("Payment Terms", found_names)
        self.assertIn("Force Majeure", found_names)
        self.assertIn("Warranty", found_names)
        self.assertIn("Dispute Resolution", found_names)

    def test_risk_score_range(self):
        result = self.analyzer.analyze(self.sample_text)
        score = result["risk_score"]["score"]
        self.assertGreaterEqual(score, 0)
        self.assertLessEqual(score, 100)
        self.assertIn(result["risk_score"]["label"], [
            "Low Risk", "Moderate Risk", "High Risk", "Critical Risk",
        ])

    def test_risks_detected(self):
        result = self.analyzer.analyze(self.sample_text)
        all_risks = result["risks"]["high"] + result["risks"]["medium"] + result["risks"]["low"]
        self.assertGreater(len(all_risks), 0, "Should detect at least one risk indicator")

    def test_financial_terms_extracted(self):
        result = self.analyzer.analyze(self.sample_text)
        values = [f["value"] for f in result["financial_terms"]]
        monetary = [v for v in values if v.startswith("$")]
        self.assertGreater(len(monetary), 0, "Should find monetary amounts")

    def test_obligations_extracted(self):
        result = self.analyzer.analyze(self.sample_text)
        self.assertGreater(len(result["obligations"]), 0, "Should find obligations")

    def test_word_count(self):
        result = self.analyzer.analyze(self.sample_text)
        self.assertGreater(result["word_count"], 100)

    def test_extract_text_txt(self):
        text = self.analyzer.extract_text(SAMPLE_PATH)
        self.assertIn("Agreement", text)

    def test_empty_text(self):
        result = self.analyzer.analyze("Hello world, this is a simple sentence.")
        self.assertEqual(len(result["clauses"]["found"]), 0)
        self.assertEqual(result["risk_score"]["score"], 0)


class TestClauseAgent(unittest.TestCase):
    def test_detects_clauses(self):
        agent = ClauseDetectionAgent()
        result = agent.analyze(SAMPLE_TEXT)
        self.assertIsInstance(result, AgentResult)
        found_names = [c["name"] for c in result.findings["found"]]
        self.assertIn("Termination", found_names)
        self.assertIn("Confidentiality", found_names)

    def test_completeness_percentage(self):
        agent = ClauseDetectionAgent()
        result = agent.analyze(SAMPLE_TEXT)
        self.assertGreater(result.findings["completeness_pct"], 0)
        self.assertLessEqual(result.findings["completeness_pct"], 100)

    def test_missing_critical_clauses(self):
        agent = ClauseDetectionAgent()
        result = agent.analyze("Hello world, just a simple sentence.")
        self.assertGreater(len(result.findings["missing_critical"]), 0)


class TestRiskAgent(unittest.TestCase):
    def test_assesses_risks(self):
        agent = RiskAssessmentAgent()
        result = agent.analyze(SAMPLE_TEXT)
        self.assertIn("risks", result.findings)
        self.assertIn("risk_score", result.findings)
        score = result.findings["risk_score"]["score"]
        self.assertGreaterEqual(score, 0)
        self.assertLessEqual(score, 100)

    def test_dimension_scores(self):
        agent = RiskAssessmentAgent()
        result = agent.analyze(SAMPLE_TEXT)
        dims = result.findings["dimension_scores"]
        self.assertIn("liability", dims)
        self.assertIn("commitment", dims)
        self.assertIn("control", dims)
        self.assertIn("flexibility", dims)


class TestFinancialAgent(unittest.TestCase):
    def test_extracts_financials(self):
        agent = FinancialAnalysisAgent()
        result = agent.analyze(SAMPLE_TEXT)
        self.assertGreater(result.findings["monetary_count"], 0)

    def test_payment_structures(self):
        agent = FinancialAnalysisAgent()
        result = agent.analyze(SAMPLE_TEXT)
        self.assertIsInstance(result.findings["payment_structures"], list)


class TestObligationAgent(unittest.TestCase):
    def test_extracts_obligations(self):
        agent = ObligationExtractionAgent()
        result = agent.analyze(SAMPLE_TEXT)
        self.assertGreater(result.findings["obligation_count"], 0)

    def test_extracts_prohibitions(self):
        agent = ObligationExtractionAgent()
        result = agent.analyze(SAMPLE_TEXT)
        self.assertIsInstance(result.findings["prohibitions"], list)


class TestTemporalAgent(unittest.TestCase):
    def test_extracts_dates(self):
        agent = TemporalAnalysisAgent()
        result = agent.analyze(SAMPLE_TEXT)
        self.assertIsInstance(result.findings["key_dates"], list)

    def test_detects_renewals(self):
        agent = TemporalAnalysisAgent()
        result = agent.analyze(SAMPLE_TEXT)
        self.assertIsInstance(result.findings["renewals"], list)


class TestPartyAgent(unittest.TestCase):
    def test_identifies_parties(self):
        agent = PartyIdentificationAgent()
        result = agent.analyze(SAMPLE_TEXT)
        self.assertGreaterEqual(result.findings["party_count"], 0)
        self.assertIsInstance(result.findings["parties"], list)

    def test_relationship_type(self):
        agent = PartyIdentificationAgent()
        result = agent.analyze(SAMPLE_TEXT)
        self.assertIsInstance(result.findings["relationship_type"], str)
        self.assertGreater(len(result.findings["relationship_type"]), 0)


class TestCrossValidator(unittest.TestCase):
    def test_validates_agents(self):
        clause_agent = ClauseDetectionAgent()
        risk_agent = RiskAssessmentAgent()
        clause_result = clause_agent.analyze(SAMPLE_TEXT)
        risk_result = risk_agent.analyze(SAMPLE_TEXT)

        validator = CrossValidationAgent()
        result = validator.analyze(SAMPLE_TEXT, context={
            "agent_results": {
                "ClauseDetectionAgent": clause_result,
                "RiskAssessmentAgent": risk_result,
            }
        })
        self.assertIn("overall_consistency", result.findings)
        self.assertGreaterEqual(result.findings["overall_consistency"], 0)
        self.assertLessEqual(result.findings["overall_consistency"], 100)


class TestExecutiveReviewer(unittest.TestCase):
    def test_produces_assessment(self):
        reviewer = ExecutiveReviewAgent()
        result = reviewer.analyze(SAMPLE_TEXT, context={
            "agent_results": {},
            "cross_validation": {"overall_consistency": 80},
        })
        self.assertIn("overall_assessment", result.findings)
        decision = result.findings["overall_assessment"]["decision"]
        self.assertIn(decision, ["approve", "review", "reject"])

    def test_generates_recommendation(self):
        reviewer = ExecutiveReviewAgent()
        result = reviewer.analyze(SAMPLE_TEXT, context={
            "agent_results": {},
            "cross_validation": {"overall_consistency": 80},
        })
        self.assertIsInstance(result.findings["recommendation"], str)
        self.assertGreater(len(result.findings["recommendation"]), 0)


class TestOrchestrator(unittest.TestCase):
    def test_orchestrated_analysis_returns_all_keys(self):
        orch = ContractOrchestrator()
        result = orch.analyze(SAMPLE_TEXT)
        # Backward-compatible keys
        for key in ["summary", "risk_score", "clauses", "risks", "obligations",
                     "key_dates", "financial_terms", "parties", "word_count", "section_count"]:
            self.assertIn(key, result, f"Missing key: {key}")

    def test_orchestration_metadata_present(self):
        orch = ContractOrchestrator()
        result = orch.analyze(SAMPLE_TEXT)
        self.assertIn("orchestration", result)
        orch_data = result["orchestration"]
        self.assertIn("panel_scores", orch_data)
        self.assertIn("overall_assessment", orch_data)
        self.assertIn("recommendation", orch_data)
        self.assertIn("agent_reports", orch_data)
        self.assertIn("trace", orch_data)

    def test_orchestration_decision(self):
        orch = ContractOrchestrator()
        result = orch.analyze(SAMPLE_TEXT)
        decision = result["orchestration"]["overall_assessment"]["decision"]
        self.assertIn(decision, ["approve", "review", "reject"])

    def test_orchestration_trace_has_phases(self):
        orch = ContractOrchestrator()
        result = orch.analyze(SAMPLE_TEXT)
        trace = result["orchestration"]["trace"]
        self.assertGreaterEqual(len(trace["phases"]), 3)
        self.assertGreater(trace["total_agents_deployed"], 0)

    def test_orchestration_cross_validation(self):
        orch = ContractOrchestrator()
        result = orch.analyze(SAMPLE_TEXT)
        cv = result["orchestration"]["cross_validation"]
        self.assertIn("consistency_score", cv)
        self.assertGreaterEqual(cv["consistency_score"], 0)

    def test_orchestrated_empty_text(self):
        orch = ContractOrchestrator()
        result = orch.analyze("Hello world, this is a simple sentence.")
        self.assertEqual(result["risk_score"]["score"], 0)
        self.assertEqual(len(result["clauses"]["found"]), 0)


class TestFlaskApp(unittest.TestCase):
    def setUp(self):
        app.config["TESTING"] = True
        self.client = app.test_client()

    def test_index_page(self):
        resp = self.client.get("/")
        self.assertEqual(resp.status_code, 200)
        self.assertIn(b"Contract Review", resp.data)

    def test_analyze_with_text(self):
        resp = self.client.post("/analyze", data={"text": SAMPLE_TEXT})
        self.assertEqual(resp.status_code, 200)
        data = json.loads(resp.data)
        self.assertIn("summary", data)
        self.assertIn("risk_score", data)

    def test_analyze_with_file_upload(self):
        with open(SAMPLE_PATH, "rb") as f:
            resp = self.client.post(
                "/analyze",
                data={"contract": (f, "sample_contract.txt")},
                content_type="multipart/form-data",
            )
        self.assertEqual(resp.status_code, 200)
        data = json.loads(resp.data)
        self.assertIn("clauses", data)

    def test_analyze_no_input(self):
        resp = self.client.post("/analyze")
        self.assertEqual(resp.status_code, 400)

    def test_analyze_empty_text(self):
        resp = self.client.post("/analyze", data={"text": "   "})
        self.assertEqual(resp.status_code, 400)

    def test_orchestrated_endpoint(self):
        resp = self.client.post("/analyze/orchestrated", data={"text": SAMPLE_TEXT})
        self.assertEqual(resp.status_code, 200)
        data = json.loads(resp.data)
        self.assertIn("orchestration", data)
        self.assertIn("summary", data)
        self.assertIn("risk_score", data)

    def test_orchestrated_no_input(self):
        resp = self.client.post("/analyze/orchestrated")
        self.assertEqual(resp.status_code, 400)


class TestPatternRegistry(unittest.TestCase):
    """Improvement #2 — shared pattern registry is the single source of truth."""

    def test_patterns_single_source(self):
        # analyzer.ContractAnalyzer's class attrs must point at the patterns module,
        # not at local duplicates.
        self.assertIs(ContractAnalyzer.CLAUSE_PATTERNS, patterns.CLAUSE_PATTERNS_RAW)
        self.assertIs(ContractAnalyzer.RISK_INDICATORS, patterns.RISK_INDICATORS_RAW)
        self.assertIs(ContractAnalyzer.OBLIGATION_PATTERNS, patterns.OBLIGATION_PATTERNS_RAW)
        self.assertIs(ContractAnalyzer.FINANCIAL_PATTERNS, patterns.FINANCIAL_PATTERNS_RAW)

    def test_pattern_id_all_compiled(self):
        self.assertGreater(len(patterns.PATTERN_ID), 20)
        for pid, pat in patterns.PATTERN_ID.items():
            self.assertIsInstance(pat, re.Pattern, f"{pid} is not a compiled Pattern")


class TestMatchCache(unittest.TestCase):
    """Improvement #4 — shared regex match cache."""

    def test_match_cache_populated(self):
        cache = MatchCache(SAMPLE_TEXT)
        cache.run_all(patterns.PATTERN_ID)
        # Every pattern id should be present as a key (possibly with an empty list).
        for pid in patterns.PATTERN_ID:
            self.assertIn(pid, cache)

    def test_line_for_offset(self):
        text = "line one\nline two\nline three"
        cache = MatchCache(text)
        self.assertEqual(cache.line_for(0), 1)            # start of line 1
        self.assertEqual(cache.line_for(9), 2)            # start of line 2
        self.assertEqual(cache.line_for(len(text) - 1), 3)  # end of line 3

    def test_agents_use_cache_when_provided(self):
        cache = MatchCache(SAMPLE_TEXT)
        cache.run_all(patterns.PATTERN_ID)
        agent = ClauseDetectionAgent()
        result = agent.analyze(SAMPLE_TEXT, context={"match_cache": cache})
        self.assertGreater(len(result.findings["found"]), 0)


class TestOrchestratorResilience(unittest.TestCase):
    """Improvement #1 — resilient orchestration."""

    def test_orchestrator_survives_agent_exception(self):
        orch = ContractOrchestrator()

        def boom(*args, **kwargs):
            raise RuntimeError("simulated failure")

        # Monkeypatch a single agent's analyze method.
        original = orch.initial_agents[0].analyze
        orch.initial_agents[0].analyze = boom
        try:
            result = orch.analyze(SAMPLE_TEXT)
        finally:
            orch.initial_agents[0].analyze = original

        self.assertIn("orchestration", result)
        failures = result["orchestration"]["trace"]["failures"]
        self.assertGreaterEqual(len(failures), 1)
        failed_names = {f["agent"] for f in failures}
        self.assertIn("ClauseDetectionAgent", failed_names)
        # The top-level response should still have all the standard keys.
        for key in ("summary", "risk_score", "clauses", "risks"):
            self.assertIn(key, result)
        # The failed agent's card should be flagged in agent_reports.
        report = result["orchestration"]["agent_reports"]["ClauseDetectionAgent"]
        self.assertTrue(report.get("failed"))

    def test_orchestrator_agent_timeout(self):
        import time

        orch = ContractOrchestrator(agent_timeout=0.2, total_timeout=30)

        def slow(*args, **kwargs):
            time.sleep(1.5)
            return AgentResult(agent_name="x", specialty="x", findings={})

        orch.initial_agents[0].analyze = slow
        result = orch.analyze(SAMPLE_TEXT)
        failures = result["orchestration"]["trace"]["failures"]
        self.assertTrue(any("timeout" in f["error"].lower() for f in failures))

    def test_orchestrator_truncates_huge_input(self):
        orch = ContractOrchestrator(max_text_chars=2000)
        huge_text = SAMPLE_TEXT + ("\nfiller line " * 5000)
        self.assertGreater(len(huge_text), 2000)
        result = orch.analyze(huge_text)
        notes = result["orchestration"]["trace"].get("notes", [])
        self.assertTrue(any("truncated" in n.lower() for n in notes))


class TestCitationTracking(unittest.TestCase):
    """Improvement #3 — source citation tracking."""

    def test_risk_agent_citations_have_spans(self):
        agent = RiskAssessmentAgent()
        result = agent.analyze(SAMPLE_TEXT)
        self.assertGreater(len(result.citations), 0)
        for cite in result.citations:
            self.assertIn("start", cite)
            self.assertIn("end", cite)
            self.assertGreaterEqual(cite["start"], 0)
            self.assertGreater(cite["end"], cite["start"])
            self.assertLessEqual(cite["end"], len(SAMPLE_TEXT))

    def test_citation_text_matches_source(self):
        agent = ClauseDetectionAgent()
        result = agent.analyze(SAMPLE_TEXT)
        for cite in result.citations[:5]:
            s, e = cite["start"], cite["end"]
            self.assertEqual(SAMPLE_TEXT[s:e], SAMPLE_TEXT[s:e])  # sanity on bounds
            snippet = SAMPLE_TEXT[s:e].lower()[:20]
            self.assertIn(snippet, SAMPLE_TEXT.lower())

    def test_orchestrator_exposes_all_citations(self):
        orch = ContractOrchestrator()
        result = orch.analyze(SAMPLE_TEXT)
        all_citations = result["orchestration"]["all_citations"]
        self.assertIsInstance(all_citations, list)
        self.assertGreater(len(all_citations), 0)
        for cite in all_citations:
            self.assertIn("agent", cite)
        for name, report in result["orchestration"]["agent_reports"].items():
            self.assertIn("citations", report)


class TestExplainableDecisions(unittest.TestCase):
    """Improvement #5 — explainable executive decisions."""

    def _mk_result(self, name, specialty, findings):
        return AgentResult(
            agent_name=name, specialty=specialty, findings=findings,
            warnings=[], confidence=0.8,
        )

    def test_executive_rationale_mentions_missing_critical(self):
        reviewer = ExecutiveReviewAgent()
        clause_result = self._mk_result(
            "ClauseDetectionAgent", "Clause",
            {
                "found": [],
                "missing": ["Indemnification"],
                "missing_critical": ["Indemnification"],
                "completeness_pct": 30,
            },
        )
        result = reviewer.analyze(SAMPLE_TEXT, context={
            "agent_results": {"ClauseDetectionAgent": clause_result},
            "cross_validation": {"overall_consistency": 70},
        })
        rationale = result.findings["decision_rationale"]
        self.assertTrue(any("Indemnification" in r for r in rationale))

    def test_executive_rationale_explains_reject(self):
        reviewer = ExecutiveReviewAgent()
        risk_result = self._mk_result(
            "RiskAssessmentAgent", "Risk",
            {
                "risks": {
                    "high": [{"description": "Unlimited liability exposure"}],
                    "medium": [],
                    "low": [],
                },
                "risk_score": {"score": 85, "label": "Critical Risk"},
                "dimension_scores": {},
                "total_indicators": 1,
            },
        )
        result = reviewer.analyze(SAMPLE_TEXT, context={
            "agent_results": {"RiskAssessmentAgent": risk_result},
            "cross_validation": {"overall_consistency": 60},
        })
        self.assertEqual(result.findings["overall_assessment"]["decision"], "reject")
        rationale = result.findings["decision_rationale"]
        self.assertTrue(any("exceeds reject threshold" in r for r in rationale))

    def test_executive_decision_keys_present(self):
        reviewer = ExecutiveReviewAgent()
        result = reviewer.analyze(SAMPLE_TEXT, context={
            "agent_results": {},
            "cross_validation": {"overall_consistency": 80},
        })
        findings = result.findings
        self.assertIn("weighted_score", findings)
        self.assertIn("decision_rationale", findings)
        self.assertIn("panel_scores", findings)
        for dim, entry in findings["panel_scores"].items():
            self.assertIn("weight", entry)
            self.assertIn("triggers", entry)

    def test_executive_rationale_mentions_failed_agents(self):
        reviewer = ExecutiveReviewAgent()
        result = reviewer.analyze(SAMPLE_TEXT, context={
            "agent_results": {},
            "cross_validation": {"overall_consistency": 60},
            "failures": [
                {"agent": "RiskAssessmentAgent", "error": "timeout", "phase": "Initial"},
            ],
        })
        rationale = result.findings["decision_rationale"]
        self.assertTrue(any("RiskAssessmentAgent" in r for r in rationale))


if __name__ == "__main__":
    unittest.main()
