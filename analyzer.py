import re
import os


class ContractAnalyzer:
    """Analyzes contract text for clauses, risks, key terms, and obligations."""

    CLAUSE_PATTERNS = {
        "Termination": [
            r"terminat(?:e|ion|ed)",
            r"cancel(?:lation)?",
            r"end\s+(?:of\s+)?(?:this\s+)?agreement",
        ],
        "Indemnification": [
            r"indemnif(?:y|ication|ied)",
            r"hold\s+harmless",
            r"defend\s+and\s+indemnify",
        ],
        "Confidentiality": [
            r"confidential(?:ity)?",
            r"non-disclosure",
            r"proprietary\s+information",
            r"trade\s+secret",
        ],
        "Limitation of Liability": [
            r"limit(?:ation)?\s+(?:of\s+)?liability",
            r"in\s+no\s+event\s+shall.*(?:be\s+)?liable",
            r"aggregate\s+liability",
            r"cap\s+on\s+(?:damages|liability)",
        ],
        "Payment Terms": [
            r"payment\s+(?:terms?|schedule|due)",
            r"invoic(?:e|ing)",
            r"net\s+\d+\s+days?",
            r"(?:payable|due)\s+(?:within|upon|on)",
        ],
        "Intellectual Property": [
            r"intellectual\s+property",
            r"(?:patent|copyright|trademark)s?",
            r"ownership\s+of\s+(?:work|deliverables|ip)",
            r"license\s+grant",
        ],
        "Governing Law": [
            r"governing\s+law",
            r"governed\s+by\s+the\s+laws",
            r"jurisdiction",
            r"venue\s+(?:shall\s+be|for)",
        ],
        "Force Majeure": [
            r"force\s+majeure",
            r"act\s+of\s+god",
            r"unforeseeable\s+(?:event|circumstance)",
        ],
        "Non-Compete": [
            r"non-compet(?:e|ition)",
            r"(?:shall|will)\s+not\s+(?:directly\s+or\s+indirectly\s+)?compete",
            r"restrictive\s+covenant",
        ],
        "Warranty": [
            r"warrant(?:y|ies|s)",
            r"represent(?:s|ation)?\s+and\s+warrant",
            r"as[\s-]is",
            r"merchantability",
        ],
        "Dispute Resolution": [
            r"dispute\s+resolution",
            r"arbitrat(?:ion|e|or)",
            r"mediat(?:ion|e|or)",
            r"(?:shall|will)\s+(?:attempt\s+to\s+)?resolve.*(?:dispute|disagreement)",
        ],
        "Assignment": [
            r"assign(?:ment)?(?:\s+of\s+(?:this\s+)?agreement)?",
            r"(?:shall|may)\s+not\s+(?:be\s+)?assign(?:ed)?",
            r"transfer(?:ability)?\s+of\s+(?:rights|obligations)",
        ],
    }

    RISK_INDICATORS = {
        "high": [
            (r"unlimited\s+liability", "Unlimited liability exposure"),
            (r"waiv(?:e|er)\s+(?:all|any)\s+(?:right|claim)", "Broad waiver of rights"),
            (r"sole\s+(?:discretion|judgment)", "Sole discretion clause favoring one party"),
            (r"irrevocabl[ey]", "Irrevocable commitment"),
            (r"perpetual(?:ly)?(?:\s+and\s+irrevocabl[ey])?", "Perpetual obligation"),
            (r"(?:shall|will)\s+not\s+(?:be\s+)?(?:liable|responsible)\s+(?:for\s+)?(?:any|all)", "Broad liability exclusion"),
            (r"automatic(?:ally)?\s+renew", "Auto-renewal clause"),
            (r"(?:penalty|penalt?ies)\s+(?:for|of|in)", "Penalty clause detected"),
        ],
        "medium": [
            (r"(?:may|shall)\s+(?:be\s+)?(?:amended|modified)\s+(?:at\s+)?(?:any\s+time|unilaterally)", "Unilateral modification rights"),
            (r"(?:reasonable\s+)?(?:best|commercial(?:ly)?)\s+efforts?", "Best/commercial efforts standard (vague)"),
            (r"(?:liquidated\s+)?damages", "Damages clause present"),
            (r"non-solicitat(?:ion|e)", "Non-solicitation restriction"),
            (r"(?:3|three|five|5)\s+year", "Long-term commitment period"),
            (r"(?:exclusive|exclusivity)", "Exclusivity requirement"),
        ],
        "low": [
            (r"(?:30|thirty)\s+days?\s+(?:written\s+)?notice", "Standard notice period"),
            (r"mutual(?:ly)?\s+(?:agree|consent)", "Mutual agreement required"),
            (r"(?:pro[\s-]?rata|proportional)", "Pro-rata provisions"),
        ],
    }

    OBLIGATION_PATTERNS = [
        (r"(?:party|company|contractor|vendor|client|customer)\s+(?:shall|must|will|agrees?\s+to)\s+([^.;]{10,120})", "Obligation"),
        (r"(?:is|are)\s+(?:required|obligated)\s+to\s+([^.;]{10,120})", "Requirement"),
        (r"(?:shall|must)\s+(?:provide|deliver|submit|maintain|ensure|comply)\s+([^.;]{10,80})", "Duty"),
    ]

    KEY_DATE_PATTERNS = [
        (r"(?:effective\s+date|commenc(?:e|ement)\s+date)[:\s]+([^.;,]{5,60})", "Effective Date"),
        (r"(?:expir(?:ation|y)|termination)\s+date[:\s]+([^.;,]{5,60})", "Expiration Date"),
        (r"(?:renew(?:al)?)\s+(?:date|deadline)[:\s]+([^.;,]{5,60})", "Renewal Date"),
        (r"(?:within|no\s+later\s+than)\s+(\d+\s+(?:days?|months?|years?|business\s+days?))", "Deadline"),
    ]

    FINANCIAL_PATTERNS = [
        (r"\$[\d,]+(?:\.\d{2})?(?:\s*(?:per|/)\s*\w+)?", "Monetary Amount"),
        (r"(\d+(?:\.\d+)?)\s*%", "Percentage"),
        (r"(?:fee|cost|price|rate|compensation|salary|payment)[:\s]+([^.;]{5,80})", "Financial Term"),
    ]

    WARRANTY_DURATION_PATTERNS = [
        (r"(\d+)\s*[-\s]?\s*year\s+warrant(?:y|ies)", "year"),
        (r"warrant(?:y|ies)\s+(?:period|term|duration)\s+(?:of|is|shall\s+be)\s+(\d+)\s*(year|month|day)s?", None),
        (r"(\d+)\s*[-\s]?\s*month\s+warrant(?:y|ies)", "month"),
        (r"(\d+)\s*[-\s]?\s*day\s+warrant(?:y|ies)", "day"),
        (r"warrant(?:y|ies)\s+(?:for|of)\s+(\d+)\s*(year|month|day)s?", None),
        (r"(\d+)\s*(year|month|day)s?\s+warrant(?:y|ies)", None),
    ]

    WARRANTY_COVERAGE_PATTERNS = [
        (r"merchantability", "merchantability"),
        (r"fitness\s+for\s+(?:a\s+)?particular\s+purpose", "fitness_for_purpose"),
        (r"workmanlike\s+manner", "workmanlike"),
        (r"free\s+(?:from|of)\s+defects?", "defect_free"),
        (r"conform(?:s|ance|ity)?\s+(?:to|with)\s+(?:the\s+)?specifications?", "conformance"),
        (r"professional(?:ly)?\s+(?:and\s+)?(?:workmanlike)?\s*(?:manner)?", "professional"),
        (r"non-infring(?:e|ement|ing)", "non_infringement"),
        (r"title\s+and\s+(?:quiet\s+)?enjoyment", "title"),
    ]

    WARRANTY_EXCLUSION_PATTERNS = [
        (r"as[\s-]is", "as_is"),
        (r"no\s+(?:express\s+or\s+implied\s+)?warrant(?:y|ies)", "no_warranty"),
        (r"without\s+warrant(?:y|ies)", "no_warranty"),
        (r"disclaim(?:s|ed|er)?\s+(?:all|any)\s+(?:express\s+or\s+implied\s+)?warrant(?:y|ies)", "disclaimer"),
        (r"(?:exclude|exclud(?:es|ing)|waiv(?:e|es|er))\s+(?:all|any)\s+(?:implied\s+)?warrant(?:y|ies)", "disclaimer"),
    ]

    REMEDY_PATTERNS = [
        (r"repair\s+or\s+replac(?:e|ement)", "repair_or_replace"),
        (r"repair(?:s|ed|ing)?(?:\s+(?:the|any|all))?\s+(?:defect|nonconform)", "repair"),
        (r"replac(?:e|ement|ing)(?:\s+(?:the|any|all))?\s+(?:defect|nonconform)", "replace"),
        (r"refund(?:s|ed|ing)?", "refund"),
        (r"credit(?:s|ed)?(?:\s+(?:toward|for|against))?", "credit"),
        (r"(?:cure|remedy|remediat(?:e|ion))\s+(?:the\s+)?(?:defect|breach|nonconform|deficienc)", "cure"),
        (r"(?:sole|exclusive)\s+remed(?:y|ies)", "exclusive_remedy"),
        (r"(?:within|no\s+later\s+than)\s+(\d+)\s*(?:days?|business\s+days?)\s+(?:to\s+)?(?:cure|remedy|repair|fix|correct)", "cure_period"),
        (r"re-?perform(?:ance)?", "reperformance"),
    ]

    def extract_text(self, filepath):
        """Extract text from .txt, .pdf, or .docx files."""
        ext = os.path.splitext(filepath)[1].lower()
        if ext == ".txt":
            return self._read_txt(filepath)
        elif ext == ".pdf":
            return self._read_pdf(filepath)
        elif ext == ".docx":
            return self._read_docx(filepath)
        return ""

    def _read_txt(self, filepath):
        with open(filepath, "r", encoding="utf-8", errors="replace") as f:
            return f.read()

    def _read_pdf(self, filepath):
        from PyPDF2 import PdfReader

        reader = PdfReader(filepath)
        text_parts = []
        for page in reader.pages:
            page_text = page.extract_text()
            if page_text:
                text_parts.append(page_text)
        return "\n".join(text_parts)

    def _read_docx(self, filepath):
        from docx import Document

        doc = Document(filepath)
        return "\n".join(para.text for para in doc.paragraphs)

    def analyze(self, text):
        """Run full contract analysis and return structured results."""
        clauses = self._detect_clauses(text)
        risks = self._assess_risks(text)
        obligations = self._extract_obligations(text)
        dates = self._extract_dates(text)
        financials = self._extract_financials(text)
        parties = self._extract_parties(text)
        summary = self._generate_summary(text, clauses, risks)
        score = self._compute_risk_score(risks)

        return {
            "summary": summary,
            "risk_score": score,
            "clauses": clauses,
            "risks": risks,
            "obligations": obligations,
            "key_dates": dates,
            "financial_terms": financials,
            "parties": parties,
            "word_count": len(text.split()),
            "section_count": len(clauses),
        }

    def _detect_clauses(self, text):
        """Identify which standard clauses are present and extract relevant excerpts."""
        found = []
        sentences = re.split(r"(?<=[.!?])\s+", text)
        for clause_name, patterns in self.CLAUSE_PATTERNS.items():
            matching_sentences = []
            for pattern in patterns:
                for sentence in sentences:
                    if re.search(pattern, sentence, re.IGNORECASE):
                        clean = sentence.strip()[:300]
                        if clean not in matching_sentences:
                            matching_sentences.append(clean)
            if matching_sentences:
                found.append({
                    "name": clause_name,
                    "present": True,
                    "excerpts": matching_sentences[:3],
                })
        missing = [
            name for name in self.CLAUSE_PATTERNS
            if name not in [c["name"] for c in found]
        ]
        return {"found": found, "missing": missing}

    def _assess_risks(self, text):
        """Score and categorize risk indicators found in the text."""
        risks = {"high": [], "medium": [], "low": []}
        for severity, patterns in self.RISK_INDICATORS.items():
            for pattern, description in patterns:
                matches = re.finditer(pattern, text, re.IGNORECASE)
                for match in matches:
                    start = max(0, match.start() - 50)
                    end = min(len(text), match.end() + 100)
                    context = text[start:end].strip()
                    entry = {
                        "description": description,
                        "context": context,
                        "matched": match.group(),
                    }
                    if entry["description"] not in [r["description"] for r in risks[severity]]:
                        risks[severity].append(entry)
        return risks

    def _extract_obligations(self, text):
        """Extract obligations and duties from the contract text."""
        obligations = []
        seen = set()
        for pattern, label in self.OBLIGATION_PATTERNS:
            for match in re.finditer(pattern, text, re.IGNORECASE):
                full = match.group().strip()[:200]
                if full not in seen:
                    seen.add(full)
                    obligations.append({"type": label, "text": full})
        return obligations[:20]

    def _extract_dates(self, text):
        """Find key dates and deadlines mentioned in the contract."""
        dates = []
        seen = set()
        for pattern, label in self.KEY_DATE_PATTERNS:
            for match in re.finditer(pattern, text, re.IGNORECASE):
                value = match.group(1).strip() if match.lastindex else match.group().strip()
                if value not in seen:
                    seen.add(value)
                    dates.append({"type": label, "value": value})
        return dates

    def _extract_financials(self, text):
        """Extract monetary amounts, percentages, and financial terms."""
        financials = []
        seen = set()
        for pattern, label in self.FINANCIAL_PATTERNS:
            for match in re.finditer(pattern, text, re.IGNORECASE):
                value = match.group().strip()[:150]
                if value not in seen:
                    seen.add(value)
                    financials.append({"type": label, "value": value})
        return financials[:25]

    def _extract_parties(self, text):
        """Attempt to identify the contracting parties."""
        parties = []
        party_patterns = [
            r"(?:between|by\s+and\s+between)\s+([A-Z][A-Za-z\s,.'&]+?)(?:\s*\(.*?\))?\s+(?:and|&)\s+([A-Z][A-Za-z\s,.'&]+?)(?:\s*\(.*?\))?(?:\s*[.,;])",
            r"(?:\"([^\"]{2,60})\"|'([^']{2,60})')\s*\((?:hereinafter\s+)?(?:referred\s+to\s+as\s+)?[\"']?(Party|Company|Client|Contractor|Vendor|Seller|Buyer|Licensor|Licensee)",
        ]
        for pattern in party_patterns:
            for match in re.finditer(pattern, text):
                for group in match.groups():
                    if group and group.strip() and len(group.strip()) > 1:
                        clean = group.strip().rstrip(",.")
                        if clean not in parties and len(clean) < 100:
                            parties.append(clean)
        return parties[:4]

    def _generate_summary(self, text, clauses, risks):
        """Generate a brief textual summary of the contract analysis."""
        parts = []
        word_count = len(text.split())
        parts.append(f"This contract contains approximately {word_count} words.")

        found_count = len(clauses["found"])
        missing_count = len(clauses["missing"])
        parts.append(
            f"Detected {found_count} standard clause type(s) "
            f"with {missing_count} common clause type(s) not found."
        )

        high_count = len(risks["high"])
        medium_count = len(risks["medium"])
        if high_count > 0:
            parts.append(f"WARNING: {high_count} high-risk indicator(s) detected.")
        if medium_count > 0:
            parts.append(f"{medium_count} medium-risk indicator(s) found.")
        if high_count == 0 and medium_count == 0:
            parts.append("No significant risk indicators detected.")

        if clauses["missing"]:
            parts.append(
                "Missing clauses that are commonly expected: "
                + ", ".join(clauses["missing"][:5])
                + "."
            )
        return " ".join(parts)

    def _compute_risk_score(self, risks):
        """Compute a 0-100 risk score (higher = more risky)."""
        score = 0
        score += len(risks["high"]) * 20
        score += len(risks["medium"]) * 10
        score += len(risks["low"]) * 3
        score = min(score, 100)

        if score <= 25:
            label = "Low Risk"
        elif score <= 50:
            label = "Moderate Risk"
        elif score <= 75:
            label = "High Risk"
        else:
            label = "Critical Risk"

        return {"score": score, "label": label}

    def _extract_warranty_duration(self, text):
        """Extract warranty duration in days for normalization."""
        for pattern, unit_override in self.WARRANTY_DURATION_PATTERNS:
            match = re.search(pattern, text, re.IGNORECASE)
            if match:
                groups = match.groups()
                number = int(groups[0])
                unit = unit_override if unit_override else groups[1].lower()
                days = self._to_days(number, unit)
                return {"value": number, "unit": unit, "days": days}
        return None

    def _to_days(self, number, unit):
        """Convert a duration to days for comparison."""
        if unit == "year":
            return number * 365
        elif unit == "month":
            return number * 30
        return number

    def _extract_warranty_coverage(self, text):
        """Extract warranty coverage types present in the text."""
        found = []
        for pattern, label in self.WARRANTY_COVERAGE_PATTERNS:
            if re.search(pattern, text, re.IGNORECASE):
                if label not in found:
                    found.append(label)
        return found

    def _extract_warranty_exclusions(self, text):
        """Extract warranty exclusions/disclaimers present in the text."""
        found = []
        for pattern, label in self.WARRANTY_EXCLUSION_PATTERNS:
            if re.search(pattern, text, re.IGNORECASE):
                if label not in found:
                    found.append(label)
        return found

    def _extract_remedies(self, text):
        """Extract remedy types and cure periods from the text."""
        found = []
        cure_period = None
        for pattern, label in self.REMEDY_PATTERNS:
            match = re.search(pattern, text, re.IGNORECASE)
            if match:
                if label == "cure_period":
                    cure_period = int(match.group(1))
                elif label not in found:
                    found.append(label)
        return {"types": found, "cure_period_days": cure_period}

    def compare_terms(self, customer_terms, supplier_terms):
        """Compare customer and supplier terms, identifying gaps in warranty and remedies.

        Returns a structured analysis with GAP or SECURE status for each category.
        """
        customer_warranty = {
            "duration": self._extract_warranty_duration(customer_terms),
            "coverage": self._extract_warranty_coverage(customer_terms),
            "exclusions": self._extract_warranty_exclusions(customer_terms),
        }
        supplier_warranty = {
            "duration": self._extract_warranty_duration(supplier_terms),
            "coverage": self._extract_warranty_coverage(supplier_terms),
            "exclusions": self._extract_warranty_exclusions(supplier_terms),
        }
        customer_remedies = self._extract_remedies(customer_terms)
        supplier_remedies = self._extract_remedies(supplier_terms)

        gaps = []

        # Compare warranty duration
        duration_status = self._compare_duration(
            customer_warranty["duration"], supplier_warranty["duration"]
        )
        gaps.append(duration_status)

        # Compare warranty coverage
        coverage_status = self._compare_coverage(
            customer_warranty["coverage"],
            supplier_warranty["coverage"],
            supplier_warranty["exclusions"],
        )
        gaps.append(coverage_status)

        # Compare remedies
        remedy_status = self._compare_remedies(customer_remedies, supplier_remedies)
        gaps.append(remedy_status)

        gap_count = sum(1 for g in gaps if g["status"] == "GAP")
        overall = "GAP" if gap_count > 0 else "SECURE"

        return {
            "overall_status": overall,
            "gap_count": gap_count,
            "categories": gaps,
            "customer_extracted": {
                "warranty": customer_warranty,
                "remedies": customer_remedies,
            },
            "supplier_extracted": {
                "warranty": supplier_warranty,
                "remedies": supplier_remedies,
            },
        }

    def _compare_duration(self, customer_dur, supplier_dur):
        """Compare warranty durations between customer and supplier terms."""
        if customer_dur and not supplier_dur:
            return {
                "category": "Warranty Duration",
                "status": "GAP",
                "detail": (
                    f"Customer requires {customer_dur['value']} {customer_dur['unit']}(s) "
                    f"warranty but supplier specifies no warranty duration."
                ),
            }
        if not customer_dur:
            return {
                "category": "Warranty Duration",
                "status": "SECURE",
                "detail": "No specific warranty duration required by customer terms.",
            }
        if not supplier_dur:
            return {
                "category": "Warranty Duration",
                "status": "GAP",
                "detail": "Supplier does not specify a warranty duration.",
            }
        if customer_dur["days"] > supplier_dur["days"]:
            return {
                "category": "Warranty Duration",
                "status": "GAP",
                "detail": (
                    f"Customer requires {customer_dur['value']} {customer_dur['unit']}(s) "
                    f"but supplier only offers {supplier_dur['value']} {supplier_dur['unit']}(s)."
                ),
            }
        return {
            "category": "Warranty Duration",
            "status": "SECURE",
            "detail": (
                f"Supplier warranty duration ({supplier_dur['value']} {supplier_dur['unit']}(s)) "
                f"meets or exceeds customer requirement ({customer_dur['value']} {customer_dur['unit']}(s))."
            ),
        }

    def _compare_coverage(self, customer_coverage, supplier_coverage, supplier_exclusions):
        """Compare warranty coverage between customer and supplier terms."""
        missing = [c for c in customer_coverage if c not in supplier_coverage]
        excluded = []
        coverage_to_exclusion = {
            "merchantability": "disclaimer",
            "fitness_for_purpose": "disclaimer",
        }
        for cov in customer_coverage:
            mapped_excl = coverage_to_exclusion.get(cov)
            if mapped_excl and mapped_excl in supplier_exclusions:
                if cov not in excluded:
                    excluded.append(cov)
        if "as_is" in supplier_exclusions and customer_coverage:
            return {
                "category": "Warranty Coverage",
                "status": "GAP",
                "detail": (
                    f"Supplier provides 'as-is' terms, disclaiming warranties. "
                    f"Customer expects: {', '.join(customer_coverage)}."
                ),
            }

        all_gaps = list(set(missing + excluded))
        if all_gaps:
            return {
                "category": "Warranty Coverage",
                "status": "GAP",
                "detail": (
                    f"Customer expects warranty coverage for: {', '.join(all_gaps)} "
                    f"but supplier does not provide or explicitly disclaims these."
                ),
            }
        if not customer_coverage:
            return {
                "category": "Warranty Coverage",
                "status": "SECURE",
                "detail": "No specific warranty coverage requirements in customer terms.",
            }
        return {
            "category": "Warranty Coverage",
            "status": "SECURE",
            "detail": "Supplier warranty coverage meets customer requirements.",
        }

    def _compare_remedies(self, customer_remedies, supplier_remedies):
        """Compare remedy provisions between customer and supplier terms."""
        customer_types = set(customer_remedies["types"])
        supplier_types = set(supplier_remedies["types"])

        missing = customer_types - supplier_types

        # Check if customer expects refund but supplier limits to exclusive remedy
        if "refund" in customer_types and "exclusive_remedy" in supplier_types and "refund" not in supplier_types:
            return {
                "category": "Remedies",
                "status": "GAP",
                "detail": (
                    "Customer expects refund as a remedy but supplier limits to an "
                    "exclusive remedy that does not include refund."
                ),
            }

        if missing:
            return {
                "category": "Remedies",
                "status": "GAP",
                "detail": (
                    f"Customer expects remedies: {', '.join(missing)} "
                    f"not provided by supplier. "
                    f"Supplier offers: {', '.join(supplier_types) if supplier_types else 'none specified'}."
                ),
            }
        if not customer_types:
            return {
                "category": "Remedies",
                "status": "SECURE",
                "detail": "No specific remedy requirements in customer terms.",
            }
        return {
            "category": "Remedies",
            "status": "SECURE",
            "detail": "Supplier remedy provisions meet customer requirements.",
        }
