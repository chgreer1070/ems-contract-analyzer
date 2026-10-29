# DOCX check limits

This file records what the current synthetic checks do and do not prove. It replaces the October 9, 2026 validation write-up from draft pull request 10. That older write-up described another commit, another dependency lock, and logs from another machine. Those logs are not evidence about today's dependencies, CI, or build.

## What was ported

- The bounded OOXML reader and receipt (`lib/docxPackage.ts`, `lib/docxExtraction.ts`, `lib/docxEvidence.ts`, `lib/docxReceipt.ts`).
- Extraction, clause grounding, and term filtering so comments, revision metadata, and deleted wording are not treated as operative contract text.
- Worker behavior that stores the receipt, blocks incomplete DOCX without OCR fallback, and refuses legacy raw-text DOCX for later analysis.
- The synthetic extraction and pipeline checks, retargeted at the current worker.
- The six acceptance-agent charters under `acceptance/docx/agents/`. They are instructions for a later human review. They are not a record that the review already passed.

## What was left behind

- `package.json` and `package-lock.json` from pull request 10, including its Next.js, Workflow, and Mammoth edits. Today's dependency files stay as they are. Mammoth remains installed and is no longer the DOCX reader.
- Audit, build, typecheck, and dependency-audit logs under the old `acceptance/docx/evidence/` tree.
- `STATE.json`, publication notes, and lane reports that only describe that earlier run.
- The matter-page link. Another change owns the matter screens, so this branch does not edit them. The evidence route is still `GET /api/documents/{id}/evidence`.

## What a passing check means

A pass means the synthetic fixtures behaved as coded on this checkout. It does not mean a Word-rendered agreement was compared, a database restore was proven, a model was validated, counsel approved a term, or production is ready. Do not enable `LEGAL_RELIANCE_ENABLED` because these checks passed.
