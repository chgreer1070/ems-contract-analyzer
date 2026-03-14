# CLAUDE.md

## Project Overview

Contract Review Application — a web-based tool for analyzing legal contracts. Detects clauses, assesses risk, extracts financial terms, obligations, key dates, and identifies parties. Accepts `.txt`, `.pdf`, and `.docx` files or pasted text.

**Note:** Despite the repository name ("Pok-mon-analyzer-"), this project is a contract analysis tool, not Pokémon-related.

## Tech Stack

- **Backend:** Python 3, Flask 3.0.0
- **Frontend:** Vanilla HTML/CSS/JavaScript (single-page app in `templates/index.html`)
- **Document parsing:** PyPDF2 (PDF), python-docx (DOCX)
- **Testing:** unittest (Python standard library)
- **No database** — fully stateless

## Project Structure

```
app.py              # Flask routes (GET /, POST /analyze)
analyzer.py         # ContractAnalyzer class — core analysis engine
tests.py            # Unit tests (13 tests across 2 test classes)
templates/index.html # Frontend UI (dark theme, single file)
requirements.txt    # Pinned Python dependencies
sample_contract.txt # Example contract used in tests
uploads/            # Temporary file upload storage
```

## Common Commands

```bash
# Install dependencies
pip install -r requirements.txt

# Run the app (serves on http://localhost:5000, debug mode)
python app.py

# Run tests
python -m unittest tests -v
```

## Architecture

- **MVC-like separation:** `analyzer.py` (model), `app.py` (controller), `templates/index.html` (view)
- **Single API endpoint:** `POST /analyze` — accepts multipart/form-data (file) or form data (text), returns JSON
- **Regex-based analysis:** All contract analysis uses pattern dictionaries with `re.IGNORECASE`; no ML/AI models
- **ContractAnalyzer class** contains all analysis logic: clause detection (12 types), risk scoring (0–100), financial extraction, obligation tracking, date identification, party identification

## Code Conventions

- Class-based design with private helper methods prefixed with `_`
- Pattern dictionaries for regex-based extraction
- Context extraction around matches (50 chars before, 100 chars after)
- Frontend uses `escapeHtml()` for secure rendering — maintain this practice
- Error handling with try/except around document parsing
- Flask config: max upload 16 MB, allowed extensions: txt/pdf/docx

## Testing

- 13 tests in `tests.py` using `unittest`
- **TestContractAnalyzer** (9 tests): validates analysis results, clause detection, risk scoring, financial extraction, edge cases
- **TestFlaskApp** (4 tests): validates routes, file upload, text submission, error handling
- Uses `sample_contract.txt` as test fixture
- Run with: `python -m unittest tests -v`

## Key Patterns

- Analysis results always return a dict with keys: `clauses`, `risks`, `risk_score`, `risk_level`, `financial_terms`, `obligations`, `key_dates`, `parties`, `metadata`
- Risk levels: "High Risk" (score >= 70), "Medium Risk" (score >= 40), "Low Risk" (score < 40)
- 12 clause types: Termination, Indemnification, Confidentiality, IP, Payment Terms, Governing Law, Force Majeure, Non-Compete, Warranty, Dispute Resolution, Limitation of Liability, Assignment
