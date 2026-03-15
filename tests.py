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
        self.assertTrue(expected_keys.issubset(set(result.keys())))

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
        # Score may be > 0 due to missing clause penalties from the General type
        self.assertGreaterEqual(result["risk_score"]["score"], 0)
        # But base risk score should be 0 (no risk indicators in simple text)
        self.assertEqual(result["risk_score"]["breakdown"]["base_risk_score"], 0)

    # --- New tests for enhanced features ---

    def test_contract_type_detection(self):
        result = self.analyzer.analyze(self.sample_text)
        self.assertIn("contract_type", result)
        ct = result["contract_type"]
        self.assertIn("type", ct)
        self.assertIn("confidence", ct)
        self.assertIn("scores", ct)
        self.assertEqual(ct["type"], "Service Agreement")

    def test_contract_type_structure(self):
        result = self.analyzer.analyze(self.sample_text)
        ct = result["contract_type"]
        self.assertIn(ct["confidence"], ["high", "medium", "low"])
        self.assertIsInstance(ct["scores"], dict)

    def test_missing_clause_warnings(self):
        result = self.analyzer.analyze(self.sample_text)
        self.assertIn("missing_clause_warnings", result)
        warnings = result["missing_clause_warnings"]
        self.assertIsInstance(warnings, list)

    def test_missing_clause_severity_values(self):
        result = self.analyzer.analyze(self.sample_text)
        for w in result["missing_clause_warnings"]:
            self.assertIn(w["severity"], {"critical", "important", "recommended"})
            self.assertIn("clause", w)
            self.assertIn("reason", w)

    def test_clause_relationships_structure(self):
        result = self.analyzer.analyze(self.sample_text)
        self.assertIn("clause_relationships", result)
        cr = result["clause_relationships"]
        self.assertIn("conflicts", cr)
        self.assertIn("dependencies", cr)
        self.assertIn("ambiguities", cr)
        self.assertIn("circular_dependencies", cr)
        self.assertIsInstance(cr["conflicts"], list)
        self.assertIsInstance(cr["dependencies"], dict)
        self.assertIsInstance(cr["ambiguities"], list)

    def test_clause_conflict_detection(self):
        result = self.analyzer.analyze(self.sample_text)
        conflicts = result["clause_relationships"]["conflicts"]
        conflict_conditions = [c["condition"] for c in conflicts]
        self.assertIn("broad_indemnification_narrow_liability", conflict_conditions)

    def test_recursive_dependency_resolution(self):
        found_names = {"Non-Compete", "Termination", "Governing Law"}
        result = self.analyzer._resolve_dependency_chain("Non-Compete", found_names)
        self.assertIn("Termination", result["satisfied"])
        self.assertIn("Governing Law", result["satisfied"])
        self.assertEqual(len(result["missing"]), 0)

    def test_circular_dependency_detection(self):
        found_names = {"Forecast & Demand", "Inventory/E&O Liability", "Payment Terms",
                       "Component Sourcing", "Termination"}
        result = self.analyzer._resolve_dependency_chain("Forecast & Demand", found_names)
        self.assertIn("Inventory/E&O Liability", result["circular"])

    def test_max_depth_guard(self):
        found_names = set()
        result = self.analyzer._resolve_dependency_chain("Indemnification", found_names)
        self.assertIsInstance(result, dict)
        self.assertIn("satisfied", result)
        self.assertIn("missing", result)
        self.assertIn("circular", result)

    def test_enhanced_risk_score_has_breakdown(self):
        result = self.analyzer.analyze(self.sample_text)
        rs = result["risk_score"]
        self.assertIn("score", rs)
        self.assertIn("label", rs)
        self.assertIn("breakdown", rs)
        bd = rs["breakdown"]
        self.assertIn("base_risk_score", bd)
        self.assertIn("missing_clause_penalty", bd)
        self.assertIn("clause_conflict_penalty", bd)
        self.assertIn("category_scores", bd)

    def test_party_balance_structure(self):
        result = self.analyzer.analyze(self.sample_text)
        self.assertIn("party_balance", result)
        pb = result["party_balance"]
        self.assertIn("balance_score", pb)
        self.assertIn("balance_label", pb)
        self.assertIn("parties", pb)
        self.assertIn("asymmetries", pb)

    def test_negotiation_suggestions_generated(self):
        result = self.analyzer.analyze(self.sample_text)
        self.assertIn("negotiation_suggestions", result)
        suggestions = result["negotiation_suggestions"]
        self.assertIsInstance(suggestions, list)
        self.assertGreater(len(suggestions), 0, "Should generate at least one suggestion")

    def test_negotiation_suggestion_structure(self):
        result = self.analyzer.analyze(self.sample_text)
        for s in result["negotiation_suggestions"]:
            self.assertIn("suggestion", s)
            self.assertIn("priority", s)
            self.assertIn("basis", s)
            self.assertIn(s["priority"], {"high", "medium", "low"})

    def test_definition_extraction(self):
        result = self.analyzer.analyze(self.sample_text)
        self.assertIn("definitions", result)
        definitions = result["definitions"]
        self.assertIsInstance(definitions, list)
        self.assertGreater(len(definitions), 0, "Should extract at least one definition")

    def test_sentence_splitting_abbreviations(self):
        text = "Acme Inc. shall provide services. This is another sentence."
        sentences = self.analyzer._split_sentences(text)
        found = [s for s in sentences if "Acme Inc." in s and "shall provide" in s]
        self.assertGreater(len(found), 0, "Inc. should not cause sentence split")

    def test_backward_compatibility_keys(self):
        result = self.analyzer.analyze(self.sample_text)
        original_keys = {
            "summary", "risk_score", "clauses", "risks", "obligations",
            "key_dates", "financial_terms", "parties", "word_count", "section_count",
        }
        new_keys = {
            "contract_type", "missing_clause_warnings", "clause_relationships",
            "party_balance", "negotiation_suggestions", "definitions",
        }
        all_expected = original_keys | new_keys
        self.assertTrue(all_expected.issubset(set(result.keys())))

    def test_empty_text_new_fields(self):
        result = self.analyzer.analyze("Hello world, this is a simple sentence.")
        self.assertIn("contract_type", result)
        self.assertEqual(result["contract_type"]["type"], "General")
        self.assertIsInstance(result["missing_clause_warnings"], list)
        self.assertIsInstance(result["clause_relationships"]["conflicts"], list)
        self.assertIsInstance(result["definitions"], list)
        self.assertIsInstance(result["negotiation_suggestions"], list)

    def test_section_count_reflects_found_clauses(self):
        result = self.analyzer.analyze(self.sample_text)
        self.assertEqual(result["section_count"], len(result["clauses"]["found"]))


class TestEMSContract(unittest.TestCase):
    def setUp(self):
        self.analyzer = ContractAnalyzer()
        sample_path = os.path.join(os.path.dirname(__file__), "sample_ems_contract.txt")
        with open(sample_path, "r") as f:
            self.ems_text = f.read()

    def test_ems_contract_type_detection(self):
        result = self.analyzer.analyze(self.ems_text)
        self.assertEqual(result["contract_type"]["type"], "EMS Manufacturing")
        self.assertIn(result["contract_type"]["confidence"], ["high", "medium"])

    def test_ems_specific_clauses_detected(self):
        result = self.analyzer.analyze(self.ems_text)
        found_names = [c["name"] for c in result["clauses"]["found"]]
        self.assertIn("Quality Standards", found_names)
        self.assertIn("Component Sourcing", found_names)
        self.assertIn("Forecast & Demand", found_names)

    def test_ems_dependency_chains(self):
        result = self.analyzer.analyze(self.ems_text)
        deps = result["clause_relationships"]["dependencies"]
        if "Inventory/E&O Liability" in deps:
            eo_deps = deps["Inventory/E&O Liability"]
            self.assertIn("satisfied", eo_deps)
            self.assertIn("missing", eo_deps)

    def test_ems_risk_indicators(self):
        result = self.analyzer.analyze(self.ems_text)
        all_risks = result["risks"]["high"] + result["risks"]["medium"] + result["risks"]["low"]
        descs = [r["description"] for r in all_risks]
        has_ems_risk = any("E&O" in d or "inventory" in d.lower() or "auto-renewal" in d.lower()
                          for d in descs)
        self.assertTrue(has_ems_risk, "Should detect EMS-specific risk indicators")

    def test_ems_negotiation_suggestions(self):
        result = self.analyzer.analyze(self.ems_text)
        suggestions = result["negotiation_suggestions"]
        self.assertGreater(len(suggestions), 0, "Should generate EMS-relevant suggestions")


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

    def test_analyze_response_has_new_fields(self):
        sample_path = os.path.join(os.path.dirname(__file__), "sample_contract.txt")
        with open(sample_path, "r") as f:
            text = f.read()
        resp = self.client.post("/analyze", data={"text": text})
        self.assertEqual(resp.status_code, 200)
        data = json.loads(resp.data)
        self.assertIn("contract_type", data)
        self.assertIn("missing_clause_warnings", data)
        self.assertIn("clause_relationships", data)
        self.assertIn("party_balance", data)
        self.assertIn("negotiation_suggestions", data)
        self.assertIn("definitions", data)


if __name__ == "__main__":
    unittest.main()
