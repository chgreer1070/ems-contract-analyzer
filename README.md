# Contract Review App

A web application for analyzing contracts. Upload or paste contract text to get automated clause detection, risk assessment, financial term extraction, and obligation identification.

## Features

- **Clause Detection** - Identifies 12 standard clause types (termination, indemnification, confidentiality, IP, etc.) and flags missing ones
- **Risk Assessment** - Scores contracts 0-100 based on detected risk indicators (unlimited liability, auto-renewal, broad waivers, etc.)
- **Financial Term Extraction** - Finds monetary amounts, percentages, and payment terms
- **Obligation Tracking** - Extracts duties and requirements from the contract language
- **Key Date Identification** - Locates effective dates, deadlines, and renewal dates
- **Party Identification** - Attempts to identify the contracting parties
- **Negotiation Playbook** - Produces prioritized, actionable redline recommendations based on detected risks and missing clauses
- **File Support** - Accepts `.txt`, `.pdf`, and `.docx` file uploads, or direct text paste

## Setup

```bash
pip install -r requirements.txt
python app.py
```

Open `http://localhost:5000` in your browser.

## Testing

```bash
python -m unittest tests -v
```

## Project Structure

```
app.py              - Flask web server and API routes
analyzer.py         - Contract analysis engine
templates/index.html - Frontend UI
tests.py            - Unit tests
sample_contract.txt - Example contract for testing
```
