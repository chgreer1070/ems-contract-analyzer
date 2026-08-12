# Contract Review App

A web application for analyzing contracts, with specialized support for EMS (Electronics Manufacturing Services) manufacturing agreements. Upload or paste contract text to get automated clause detection, risk assessment, financial term extraction, and obligation identification.

## Features

- **Clause Detection** - Identifies 20 clause types (12 general such as termination, indemnification, confidentiality, IP, plus 8 EMS-specific such as Component Sourcing, Inventory/E&O Liability, NPI/ECO Process) and flags missing ones
- **Contract Type Detection** - Classifies the document into one of 9 contract types (EMS Manufacturing, Employment, NDA, Service, Lease, Sales, Partnership, License, Loan) with a General fallback
- **Risk Assessment** - Scores contracts 0-100 using category-weighted risk indicators (financial, legal, operational, supply chain), with penalties for missing clauses, clause conflicts, and unmet dependencies
- **Missing Clause Warnings** - Flags expected-but-absent clauses based on the detected contract type
- **Clause Relationships** - Detects clause conflicts, recursive clause dependencies (with cycle detection), and ambiguous language
- **Party Balance Analysis** - Measures legal asymmetry between the contracting parties
- **Negotiation Suggestions** - Generates actionable revision advice based on detected risks and gaps
- **Financial Term Extraction** - Finds monetary amounts, percentages, and payment terms
- **Obligation Tracking** - Extracts duties and requirements from the contract language
- **Key Date Identification** - Locates effective dates, deadlines, and renewal dates
- **Party Identification** - Attempts to identify the contracting parties
- **Definition Extraction** - Pulls defined terms from the document
- **File Support** - Accepts `.txt`, `.pdf`, and `.docx` file uploads, or direct text paste

## Setup

```bash
pip install -r requirements.txt
python app.py
```

Open `http://localhost:5000` in your browser. Debug mode is off by default; enable it with `FLASK_DEBUG=true python app.py`.

## Testing

```bash
python -m unittest tests -v
```

## Project Structure

```
app.py                  - Flask web server and API routes
analyzer.py             - Contract analysis engine
templates/index.html    - Frontend UI
tests.py                - Unit tests
sample_contract.txt     - Example service agreement for testing
sample_ems_contract.txt - Example EMS manufacturing agreement for testing
CLAUDE.md               - Detailed codebase documentation
```
