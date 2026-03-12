import json
import os
import unittest

from analyzer import ContractAnalyzer
from orchestrator import ContractOrchestrator
from agents.base_agent import BaseAgent, AgentResult
from agents.clause_agent import ClauseDetectionAgent
from agents.risk_agent import RiskAssessmentAgent
from agents.financial_agent import FinancialAnalysisAgent
from agents.obligation_agent import ObligationExtractionAgent
from agents.temporal_agent import TemporalAnalysisAgent
from agents.party_agent import PartyIdentificationAgent
from agents.cross_validator import CrossValidationAgent
from agents.executive_reviewer import ExecutiveReviewAgent
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


if __name__ == "__main__":
    unittest.main()
