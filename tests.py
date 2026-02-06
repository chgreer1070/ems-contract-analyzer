import json
import os
import unittest

from analyzer import ContractAnalyzer
from app import app


class TestContractAnalyzer(unittest.TestCase):
    def setUp(self):
        self.analyzer = ContractAnalyzer()
        sample_path = os.path.join(os.path.dirname(__file__), "sample_contract.txt")
        with open(sample_path, "r") as f:
            self.sample_text = f.read()

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
        sample_path = os.path.join(os.path.dirname(__file__), "sample_contract.txt")
        text = self.analyzer.extract_text(sample_path)
        self.assertIn("Agreement", text)

    def test_empty_text(self):
        result = self.analyzer.analyze("Hello world, this is a simple sentence.")
        self.assertEqual(len(result["clauses"]["found"]), 0)
        self.assertEqual(result["risk_score"]["score"], 0)


class TestFlaskApp(unittest.TestCase):
    def setUp(self):
        app.config["TESTING"] = True
        self.client = app.test_client()

    def test_index_page(self):
        resp = self.client.get("/")
        self.assertEqual(resp.status_code, 200)
        self.assertIn(b"Contract Review", resp.data)

    def test_analyze_with_text(self):
        sample_path = os.path.join(os.path.dirname(__file__), "sample_contract.txt")
        with open(sample_path, "r") as f:
            text = f.read()
        resp = self.client.post("/analyze", data={"text": text})
        self.assertEqual(resp.status_code, 200)
        data = json.loads(resp.data)
        self.assertIn("summary", data)
        self.assertIn("risk_score", data)

    def test_analyze_with_file_upload(self):
        sample_path = os.path.join(os.path.dirname(__file__), "sample_contract.txt")
        with open(sample_path, "rb") as f:
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


if __name__ == "__main__":
    unittest.main()
