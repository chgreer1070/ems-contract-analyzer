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


class TestTermComparison(unittest.TestCase):
    def setUp(self):
        self.analyzer = ContractAnalyzer()

    def test_compare_returns_all_keys(self):
        result = self.analyzer.compare_terms("1 year warranty", "6 month warranty")
        expected_keys = {
            "overall_status", "gap_count", "categories",
            "customer_extracted", "supplier_extracted",
        }
        self.assertEqual(set(result.keys()), expected_keys)

    def test_warranty_duration_gap(self):
        customer = "The product shall include a 2 year warranty from date of delivery."
        supplier = "Supplier provides a 6 month warranty on all products."
        result = self.analyzer.compare_terms(customer, supplier)
        duration_cat = next(c for c in result["categories"] if c["category"] == "Warranty Duration")
        self.assertEqual(duration_cat["status"], "GAP")
        self.assertEqual(result["overall_status"], "GAP")

    def test_warranty_duration_secure(self):
        customer = "The product shall include a 1 year warranty."
        supplier = "Supplier provides a 2 year warranty on all products."
        result = self.analyzer.compare_terms(customer, supplier)
        duration_cat = next(c for c in result["categories"] if c["category"] == "Warranty Duration")
        self.assertEqual(duration_cat["status"], "SECURE")

    def test_warranty_coverage_gap_as_is(self):
        customer = "Vendor warrants merchantability and fitness for a particular purpose."
        supplier = "All products are provided as-is without warranty."
        result = self.analyzer.compare_terms(customer, supplier)
        coverage_cat = next(c for c in result["categories"] if c["category"] == "Warranty Coverage")
        self.assertEqual(coverage_cat["status"], "GAP")

    def test_warranty_coverage_secure(self):
        customer = "Vendor warrants merchantability."
        supplier = "Supplier warrants merchantability and fitness for a particular purpose."
        result = self.analyzer.compare_terms(customer, supplier)
        coverage_cat = next(c for c in result["categories"] if c["category"] == "Warranty Coverage")
        self.assertEqual(coverage_cat["status"], "SECURE")

    def test_remedy_gap(self):
        customer = "Customer is entitled to a full refund for defective products."
        supplier = "Supplier will repair or replace defective products. This is the sole and exclusive remedy."
        result = self.analyzer.compare_terms(customer, supplier)
        remedy_cat = next(c for c in result["categories"] if c["category"] == "Remedies")
        self.assertEqual(remedy_cat["status"], "GAP")

    def test_remedy_secure(self):
        customer = "Vendor shall repair or replace defective goods."
        supplier = "Supplier will repair or replace any defective items at no cost."
        result = self.analyzer.compare_terms(customer, supplier)
        remedy_cat = next(c for c in result["categories"] if c["category"] == "Remedies")
        self.assertEqual(remedy_cat["status"], "SECURE")

    def test_overall_secure(self):
        customer = "Simple agreement with no warranty or remedy terms."
        supplier = "Simple agreement with no warranty or remedy terms."
        result = self.analyzer.compare_terms(customer, supplier)
        self.assertEqual(result["overall_status"], "SECURE")
        self.assertEqual(result["gap_count"], 0)

    def test_extracted_terms_structure(self):
        customer = "2 year warranty with merchantability. Refund available."
        supplier = "1 year warranty as-is. Repair or replace only."
        result = self.analyzer.compare_terms(customer, supplier)
        ce = result["customer_extracted"]
        se = result["supplier_extracted"]
        self.assertIn("warranty", ce)
        self.assertIn("remedies", ce)
        self.assertIn("warranty", se)
        self.assertIn("remedies", se)
        self.assertEqual(ce["warranty"]["duration"]["value"], 2)
        self.assertEqual(se["warranty"]["duration"]["value"], 1)
        self.assertIn("merchantability", ce["warranty"]["coverage"])
        self.assertIn("refund", ce["remedies"]["types"])
        self.assertIn("repair_or_replace", se["remedies"]["types"])

    def test_no_supplier_duration(self):
        customer = "Products must have a 1 year warranty."
        supplier = "Supplier agrees to provide quality products."
        result = self.analyzer.compare_terms(customer, supplier)
        duration_cat = next(c for c in result["categories"] if c["category"] == "Warranty Duration")
        self.assertEqual(duration_cat["status"], "GAP")


class TestCompareEndpoint(unittest.TestCase):
    def setUp(self):
        app.config["TESTING"] = True
        self.client = app.test_client()

    def test_compare_success(self):
        resp = self.client.post("/compare", data={
            "customer_terms": "2 year warranty with refund.",
            "supplier_terms": "1 year warranty, repair or replace.",
        })
        self.assertEqual(resp.status_code, 200)
        data = json.loads(resp.data)
        self.assertIn("overall_status", data)
        self.assertIn("categories", data)

    def test_compare_missing_customer(self):
        resp = self.client.post("/compare", data={
            "supplier_terms": "1 year warranty.",
        })
        self.assertEqual(resp.status_code, 400)

    def test_compare_missing_supplier(self):
        resp = self.client.post("/compare", data={
            "customer_terms": "2 year warranty.",
        })
        self.assertEqual(resp.status_code, 400)

    def test_compare_json_input(self):
        resp = self.client.post("/compare",
            data=json.dumps({
                "customer_terms": "2 year warranty.",
                "supplier_terms": "1 year warranty.",
            }),
            content_type="application/json",
        )
        self.assertEqual(resp.status_code, 200)
        data = json.loads(resp.data)
        self.assertEqual(data["overall_status"], "GAP")


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
