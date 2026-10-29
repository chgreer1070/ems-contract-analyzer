# ContractTwin reading service

This is a small Python service that reads an electronics-manufacturing customer agreement and its amendments. It is the core the cockpit can call. It is also meant to be reusable later by DealDesk and ValueGuard.

It answers four questions:

- What does the contract say, and where did that sentence come from?
- Which version is in force after the amendments?
- Which notice dates can be put on a calendar?
- What can we say about price, non-cancellable orders (NCNR), and excess and obsolete inventory (E&O)?

Every fact names the document, the section, and a quote copied exactly from the file. If the quote is not in that file, the fact is thrown out. A dollar effect on margin, cash, working capital, or inventory is reported only when the contract states the amount. Otherwise the service says **cannot be determined**.

This is a reading aid. It is not a legal conclusion, not a finance close, and not an approval. A person still has to review it. The sample agreements are made up. They are not Flex contracts and they are not customer data.

The Next.js cockpit remains the place for matters, sign-in, and the governed record. This service does not write that record.

## What you can run

From this folder:

```bash
python -m venv .venv
source .venv/bin/activate
pip install -e ".[dev]"
pytest
uvicorn contracttwin.api:app --host 127.0.0.1 --port 8080
```

Then open `http://127.0.0.1:8080/docs` for the interactive page, or call the service as shown below.

Docker, from the repository root:

```bash
docker build -t contracttwin-core contracttwin
docker run --rm -p 8080:8080 contracttwin-core
```

Tests do not call a model and do not need a network. The sample files are `tests/fixtures/harborline_msa.txt` and `tests/fixtures/harborline_amendment_1.txt`.

## Send an agreement

`POST /v1/agreements` takes JSON. The first document is the base agreement. Later documents are amendments. `effective_date` is only used to apply amendments in date order. The date written in the contract is the one that shows up as a fact.

```bash
curl -s http://127.0.0.1:8080/v1/agreements \
  -H 'content-type: application/json' \
  -d @- <<'JSON'
{
  "base": {
    "name": "Harborline MSA",
    "role": "base",
    "filename": "harborline_msa.txt",
    "effective_date": "2024-01-15",
    "text": "<paste the base agreement>"
  },
  "amendments": [
    {
      "name": "Amendment No. 1",
      "role": "amendment",
      "filename": "harborline_amendment_1.txt",
      "effective_date": "2025-03-01",
      "text": "<paste the amendment>"
    }
  ]
}
JSON
```

`POST /v1/agreements/files` takes a form field named `manifest` (the same JSON, without the text) and one or more `files`. Use `.txt`, `.pdf`, or `.docx`. The manifest `filename` must match the uploaded file name.

`GET /v1/agreements/{analysis_id}` returns the same reading until the process restarts. `GET /health` returns `{"status":"ok"}`.

On the Harborline sample, a correct reading shows:

- Payment in force is 60 days. The old 45-day sentence is kept and marked as no longer in force.
- The non-cancellable firm period in force is 120 days. The old 90-day sentence is no longer in force.
- The excess-and-obsolete notice for the quarter ending June 30, 2025 is July 14, 2025. That date is an inference: the contract states the quarter end, ten business days, and that a business day is Monday through Friday with holidays not removed.
- Price-notice dates November 16, 2024 and November 16, 2025 are inferences from the stated effective date and the 60-day notice rule.
- Margin, cash, working-capital, and inventory dollar amounts cannot be determined. The sample states a unit price and who bears the liability. It does not state volume or cost.

## How a reading is labeled

- **Fact.** The contract says it. The quote is copied from the file.
- **Inference.** The service counted a date from facts the contract states. The quotes for those facts are still attached.
- **Assumption.** A convention the contract does not state. The Harborline sample does not need one. A February 29 effective date does, because the contract does not say what to do in a year that has no February 29. The service labels that assumption instead of hiding it.

Facts, inferences, and assumptions are separate items. They are not mixed into one unlabeled paragraph.

## Amendment order

Amendments are applied from earliest date you type in to the latest. The date written in the document is the fact. If those two dates disagree, the reading says so. A sentence that says a section "is deleted and replaced in its entirety," or that a definition "is deleted and replaced," replaces that section. A later amendment wins over an earlier one on the same section. Sections the amendment does not mention stay as they were. Old text is kept and marked not operative. A survival sentence such as "Sections 3, 4, 5, and 7 survive" marks those operative sections.

## Quote check

A fact or an inference must cite at least 20 characters that appear exactly in the named document. Capitalization, spaces, and punctuation all count. The check uses the text extracted from the file. It does not guess. The cockpit's older check is looser: it ignores case and extra spaces. This service does not.

## Model extractor

The default extractor is the rule reader. Tests use only that.

A caller can pass another extractor. The HTTP service uses one only when `CONTRACTTWIN_EXTRACTOR=llm` and `CONTRACTTWIN_LLM_API_KEY` are set. Optional settings: `CONTRACTTWIN_LLM_BASE_URL` and `CONTRACTTWIN_LLM_MODEL`.

Turning that on sends the agreement text to the model provider. Do not point it at a real customer contract unless that provider is approved.

Model output is still quote-checked. A paraphrase is rejected. A quote that survives only in replaced text is marked not operative. If the model is down or returns junk, the rule reading is kept. The model is never the system of record.

## Cockpit

The cockpit file `commercial-legal-cockpit/lib/contracttwinCoreClient.ts` can POST text to this service. The matter screens do not call it. Wiring it into a matter would be a later, separate decision.

## What this is not

- Not the full 41-topic EMS taxonomy, and not the cockpit economics engine.
- Not sign-in, virus scanning, a database, or a human-approval record.
- Not layout, tables, tracked changes, footnotes, or scanned-page reading. PDF and Word support is plain text. If the extractor changes a character, the quote check fails closed.
- Not a holiday calendar beyond what the contract itself says.
- Not production evidence. Passing these tests does not make a deployment ready for legal reliance.
