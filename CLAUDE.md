# CLAUDE.md

## Project Overview

Contract Review Application — a web-based tool for analyzing legal contracts with specialized support for EMS (Electronics Manufacturing Services) contract manufacturing agreements. Detects clauses (20 types including 8 EMS-specific), assesses risk with category-weighted scoring, extracts financial terms, obligations, key dates, identifies parties with role/alias resolution, analyzes party balance, detects clause conflicts and dependencies, compares clauses against standard templates, generates negotiation suggestions, extracts defined terms, exports reports (PDF/HTML/JSON), and compares two contracts side-by-side. Accepts `.txt`, `.pdf`, and `.docx` files or pasted text.

**Note:** Despite the repository name ("Pok-mon-analyzer-"), this project is a contract analysis tool, not Pokemon-related.

## Tech Stack

- **Backend:** Python 3, Flask 3.0.0, gunicorn 21.2.0
- **Frontend:** Vanilla HTML/CSS/JavaScript (single-page app in `templates/index.html`)
- **Document parsing:** PyPDF2 (PDF), python-docx (DOCX)
- **PDF report generation:** reportlab 4.0.7
- **Testing:** unittest (Python standard library)
- **Deployment:** Docker (Python 3.11-slim)
- **No database** — fully stateless

## Project Structure

```
app.py                    # Flask routes (GET /, POST /analyze, /export, /compare)
analyzer.py               # ContractAnalyzer class — core analysis engine
tests.py                  # Unit tests (53 tests across 3 test classes)
templates/index.html      # Frontend UI (dark theme, single file)
templates/report.html     # Printable HTML report template
requirements.txt          # Pinned Python dependencies
clause_templates/         # Standard clause text templates (20 files)
sample_contract.txt       # Service agreement test fixture
sample_ems_contract.txt   # EMS manufacturing agreement test fixture
Dockerfile                # Production container (gunicorn)
.dockerignore             # Docker build exclusions
uploads/                  # Temporary file upload storage
```

## Common Commands

```bash
# Install dependencies
pip install -r requirements.txt

# Run the app (serves on http://localhost:5000, debug mode)
python app.py

# Run tests
python -m unittest tests -v

# Docker deployment
docker build -t contract-analyzer .
docker run -p 5000:5000 contract-analyzer
```

## Architecture

- **MVC-like separation:** `analyzer.py` (model), `app.py` (controller), `templates/index.html` (view)
- **API endpoints:**
  - `POST /analyze` — accepts multipart/form-data (file) or form data (text), returns JSON analysis
  - `POST /export` — same input + `format` param (pdf|html|json), returns downloadable report
  - `POST /compare` — accepts two contracts (text_a/text_b or files), returns comparison JSON
- **Regex-based analysis:** All contract analysis uses pattern dictionaries with `re.IGNORECASE`; no ML/AI models
- **ContractAnalyzer class** contains all analysis logic:
  - Clause detection (20 types: 12 general + 8 EMS-specific) with template comparison
  - Contract type detection (9 types + General fallback)
  - Risk scoring with category weighting (financial, legal, operational, supply_chain)
  - Missing clause warnings based on contract type
  - Recursive clause dependency resolution with cycle detection
  - Clause conflict analysis
  - Party extraction with roles, aliases, and jurisdiction detection
  - Party balance and asymmetry analysis
  - Negotiation suggestion generation
  - Definition extraction
  - Financial extraction, obligation tracking, date identification
  - Clause-vs-template comparison using Jaccard n-gram similarity
  - Contract comparison (diff two contracts: clause diff, risk delta, party diff)
  - PDF report generation via reportlab

## Code Conventions

- Class-based design with private helper methods prefixed with `_`
- Pattern dictionaries for regex-based extraction
- Context extraction around matches (50 chars before, 100 chars after)
- Frontend uses `escapeHtml()` for secure rendering — maintain this practice
- Error handling with try/except around document parsing
- Flask config: max upload 16 MB, allowed extensions: txt/pdf/docx
- Risk indicators carry a `category` tag for weighted scoring
- Jaccard n-gram similarity (`_jaccard_shingles`) shared between template comparison and contract comparison

## Testing

- 53 tests in `tests.py` using `unittest`
- **TestContractAnalyzer** (34 tests): validates analysis results, clause detection, risk scoring, financial extraction, contract type detection, missing clause warnings, clause relationships, recursive dependencies, party balance, party detailed extraction, negotiation suggestions, definitions, sentence splitting, backward compatibility, edge cases, template comparison, Jaccard similarity
- **TestEMSContract** (6 tests): validates EMS-specific contract type detection, clause detection, dependency chains, risk indicators, negotiation suggestions, party role detection
- **TestFlaskApp** (13 tests): validates routes, file upload, text submission, error handling, new API fields, PDF/HTML/JSON export, contract comparison, error cases
- Uses `sample_contract.txt` and `sample_ems_contract.txt` as test fixtures
- Run with: `python -m unittest tests -v`

## Key Patterns

- Analysis results return a dict with keys: `summary`, `risk_score`, `clauses`, `risks`, `obligations`, `key_dates`, `financial_terms`, `parties`, `parties_detailed`, `word_count`, `section_count`, `contract_type`, `missing_clause_warnings`, `clause_relationships`, `party_balance`, `negotiation_suggestions`, `definitions`
- `parties_detailed` entries: `{"name": str, "role": str|None, "aliases": [str], "jurisdiction": str|None}`
- `clauses.found[i].template_comparison`: `{"similarity": float, "missing_phrases": [str], "extra_phrases": [str], "verdict": "standard"|"non-standard"|"unusual"}`
- Risk levels: "Critical Risk" (score > 75), "High Risk" (score > 50), "Moderate Risk" (score > 25), "Low Risk" (score <= 25)
- Risk score includes breakdown: base_risk_score, missing_clause_penalty (capped at 25), clause_conflict_penalty (capped at 15), dependency_penalty (capped at 10)
- 20 clause types: Termination, Indemnification, Confidentiality, IP, Payment Terms, Governing Law, Force Majeure, Non-Compete, Warranty, Dispute Resolution, Limitation of Liability, Assignment, Quality Standards, Component Sourcing, Inventory/E&O Liability, Forecast & Demand, NPI/ECO Process, Tooling & Equipment, Regulatory Compliance, Supply Chain Risk
- 9 contract types: EMS Manufacturing, Employment, NDA/Confidentiality, Service Agreement, Lease/Rental, Sales/Purchase, Partnership, License, Loan/Credit (+ General fallback)
- Recursive dependency resolution uses depth-first traversal with visited set for cycle detection, max depth 5
- Clause template comparison uses Jaccard similarity over 5-gram word shingles; thresholds: >= 0.4 = standard, >= 0.15 = non-standard, < 0.15 = unusual
