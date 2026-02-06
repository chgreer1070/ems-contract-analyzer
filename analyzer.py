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
