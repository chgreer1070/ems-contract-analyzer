# CLAUDE.md

## Project Overview

Contract Review Application — a web-based tool for analyzing legal contracts with specialized support for EMS (Electronics Manufacturing Services) contract manufacturing agreements. Detects clauses (20 types including 8 EMS-specific), assesses risk with category-weighted scoring, extracts financial terms, obligations, key dates, identifies parties, analyzes party balance, detects clause conflicts and dependencies, generates negotiation suggestions, and extracts defined terms. Accepts `.txt`, `.pdf`, and `.docx` files or pasted text.

**Note:** Despite the repository name ("Pok-mon-analyzer-"), this project is a contract analysis tool, not Pokémon-related.

## Tech Stack

- **Backend:** Python 3, Flask 3.0.0
- **Frontend:** Vanilla HTML/CSS/JavaScript (single-page app in `templates/index.html`)
- **Document parsing:** pypdf (PDF), python-docx (DOCX)
- **Testing:** unittest (Python standard library)
- **No database** — fully stateless

## Project Structure

```
app.py                  # Flask routes (GET /, POST /analyze)
analyzer.py             # ContractAnalyzer class — core analysis engine
tests.py                # Unit tests (38 tests across 4 test classes)
templates/index.html    # Frontend UI (dark theme, single file)
requirements.txt        # Pinned Python dependencies
sample_contract.txt     # Service agreement test fixture
sample_ems_contract.txt # EMS manufacturing agreement test fixture
uploads/                # Temporary file upload storage
```

## Common Commands

```bash
# Install dependencies
pip install -r requirements.txt

# Run the app (serves on http://localhost:5000)
# Debug mode off by default; enable with: FLASK_DEBUG=true python app.py
python app.py

# Run tests
python -m unittest tests -v
```

## Architecture

- **MVC-like separation:** `analyzer.py` (model), `app.py` (controller), `templates/index.html` (view)
- **Single API endpoint:** `POST /analyze` — accepts multipart/form-data (file) or form data (text), returns JSON
- **Regex-based analysis:** All contract analysis uses pattern dictionaries with `re.IGNORECASE`; no ML/AI models
- **ContractAnalyzer class** contains all analysis logic:
  - Clause detection (20 types: 12 general + 8 EMS-specific)
  - Contract type detection (9 types + General fallback)
  - Risk scoring with category weighting (financial, legal, operational, supply_chain)
  - Missing clause warnings based on contract type
  - Recursive clause dependency resolution with cycle detection
  - Clause conflict analysis
  - Party balance and asymmetry analysis
  - Negotiation suggestion generation
  - Definition extraction
  - Financial extraction, obligation tracking, date identification, party identification

## Code Conventions

- Class-based design with private helper methods prefixed with `_`
- Pattern dictionaries for regex-based extraction
- Context extraction around matches (50 chars before, 100 chars after)
- Frontend uses `escapeHtml()` for secure rendering — maintain this practice
- Error handling with try/except around document parsing
- Flask config: max upload 16 MB, allowed extensions: txt/pdf/docx
- Risk indicators carry a `category` tag for weighted scoring

## Testing

- 38 tests in `tests.py` using `unittest`
- **TestContractAnalyzer** (27 tests): validates analysis results, clause detection, risk scoring, financial extraction, contract type detection, missing clause warnings, clause relationships, recursive dependencies, party balance, negotiation suggestions, definitions, sentence splitting, backward compatibility, edge cases
- **TestEMSContract** (5 tests): validates EMS-specific contract type detection, clause detection, dependency chains, risk indicators, and negotiation suggestions
- **TestFlaskApp** (6 tests): validates routes, file upload, text submission, error handling, new API fields
- Uses `sample_contract.txt` and `sample_ems_contract.txt` as test fixtures
- Run with: `python -m unittest tests -v`

## Key Patterns

- Analysis results return a dict with keys: `summary`, `risk_score`, `clauses`, `risks`, `obligations`, `key_dates`, `financial_terms`, `parties`, `word_count`, `section_count`, `contract_type`, `missing_clause_warnings`, `clause_relationships`, `party_balance`, `negotiation_suggestions`, `definitions`
- Risk levels: "Critical Risk" (score > 75), "High Risk" (score > 50), "Moderate Risk" (score > 25), "Low Risk" (score <= 25)
- Risk score includes breakdown: base_risk_score, missing_clause_penalty (capped at 25), clause_conflict_penalty (capped at 15), dependency_penalty (capped at 10)
- 20 clause types: Termination, Indemnification, Confidentiality, IP, Payment Terms, Governing Law, Force Majeure, Non-Compete, Warranty, Dispute Resolution, Limitation of Liability, Assignment, Quality Standards, Component Sourcing, Inventory/E&O Liability, Forecast & Demand, NPI/ECO Process, Tooling & Equipment, Regulatory Compliance, Supply Chain Risk
- 9 contract types: EMS Manufacturing, Employment, NDA/Confidentiality, Service Agreement, Lease/Rental, Sales/Purchase, Partnership, License, Loan/Credit (+ General fallback)
- Recursive dependency resolution uses depth-first traversal with visited set for cycle detection, max depth 5
