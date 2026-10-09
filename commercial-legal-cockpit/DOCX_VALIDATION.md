# DOCX ingestion validation record

Follow-on acceptance: six specialized legal and technical agents independently examined this candidate on October 9, 2026. Their reusable instructions, reproduced defects, local repair verification and unresolved acceptance gates are in [acceptance/docx/README.md](acceptance/docx/README.md) and [acceptance/docx/STATE.json](acceptance/docx/STATE.json). The original PR CI subsequently failed clean installation. Local follow-on repairs correct the lock and dependencies, linked-story/comment eligibility, contract-view fallback grounding, exact quotations and ZIP/allocation controls. The historical results below apply to the original candidate; they do not attest the repaired snapshot or close Word, target database, model, legal approval or deployment gates.

Date: October 9, 2026. Scope: code/synthetic-data candidate based on repository commit `39716dfd22f4e01a3b1f891e28fb9a64149bf661`. This is local engineering evidence, not production activation or a review of any real negotiated agreement.

## Acceptance result

Implemented and locally verified: revision language and authorship metadata; comment bodies and anchors; source part/element/hash provenance; paragraph/table/story structure; separate original/proposed hypotheses; unsupported-feature denial; complete receipt/chunk coverage; legacy extraction denial; and preserved human authority. The original binary is never rewritten.

| Check | Result | Practical limit |
| --- | --- | --- |
| `npm run test:docx` | PASS: 29 extractor scenarios + 8 worker/adapter/API scenarios | Actual in-memory OOXML; worker/database/storage/model boundaries are doubled; no live Word/provider/database acceptance |
| `npm run test:controls` | PASS, including DOCX suite | Existing application control regressions; does not replace target PostgreSQL/concurrency testing |
| `npm run test:corpus` | PASS: 24 frozen synthetic EMS cases | Corpus structure check, not fresh model evaluation |
| `npm run test:economics` | PASS | Existing deterministic scenarios; no new finance certification |
| `npm run db:check` | PASS: 32 tables; 14 canonical migration receipts | Source-schema check; no target database was migrated |
| `npm run typecheck` | PASS | TypeScript and Workflow generation |
| `npm run build` | PASS | Local build with explicit synthetic/demo auth settings, reliance disabled; no deployment |
| Root `python -m unittest tests` | PASS: 38 historical prototype tests | Run in a temporary environment with the repository's pinned requirements; prototype remains outside legal reliance |
| `git diff --check` | PASS | Whitespace/error check |
| `npm audit --omit=dev --audit-level=high` | FAIL / RELEASE BLOCKER | Remaining application dependency findings; see below |
| GitHub CI / CodeQL / target-environment acceptance | NOT ATTESTED HERE | Must be checked for the exact proposed release SHA |

Extractor regressions cover replacement text with different authors/dates, overlapping/cross-paragraph/point comments, note targets, headers/footers, cell spans and header context, Unicode/whitespace/UTF-16 and prefix aliases, metadata exclusion from quotations, original-only term exclusion, receipt/coverage manipulation, missing and inconsistent anchors, auxiliary/property/move revisions, fields/drawings/data bindings/unknown extensions, inherited numbering/cyclic styles, external and missing relationships, invalid XML, DTD/entity denial, Strict OOXML denial, ZIP corruption/duplicate/traversal/encryption/expansion bounds and oversized/nested input. Worker checks cover original-byte preservation, complete and blocked receipts, append-only blocked-receipt audit archival, legacy/missing/unfinished/tampered receipt denial, publication-time receipt rechecks, no OCR substitution, deterministic proposal labeling, and authorized/no-store evidence retrieval.

## Dependency audit

The baseline locked application reported 29 affected packages: 19 moderate, 7 high, 3 critical. After removing Mammoth and promoting/upgrading the XML parser to the exact patched `@xmldom/xmldom@0.8.15`, the candidate reported 25: 16 moderate, 6 high, 3 critical. No newly affected package appeared in the candidate audit. Findings disappeared for Mammoth, the XML parser, argparse and sprintf-js.

Remaining affected packages are in the existing Vercel/Workflow/Next.js stack and transitive dependencies, including next, workflow/devalue/undici, piscina, proxy-addr, brace-expansion, sharp and source-map-js. These are reported audit findings, not assertions that an exploit was demonstrated in ContractTwin. They still fail the repository's required security release gate. Broad framework/dependency upgrades are outside this DOCX change and require their own reviewed validation. Do not override the audit gate or deploy this candidate on the strength of the ingestion tests.

## Open acceptance work and authority

1. Technical release owner: review this exact code and CI/CodeQL results; remediate remaining dependency findings before production release.
2. Legal and technical owners: validate representative Word-created negotiated agreements, including unsupported-feature detection, against Word's original/proposed and comment views. No author-to-party mapping may be inferred from display names alone.
3. Technical/database owners: prove successful receipt immutability, blocked audit preservation, interrupted/stale-generation denial, safe re-extraction and historical review retention against the approved target PostgreSQL environment. No migration is added by this change.
4. Technical/security owners: measure parser memory, latency and load near approved limits and review the bounded ZIP/XML adapter.
5. Legal control owner: approve current clause/term engine policy versions and representative artifact-bound model validation. Existing policies/validation are intentionally not auto-activated or rewritten.
6. Authorized production release owner: approve the exact validated release through the existing protected deployment process. All existing platform evidence-kernel and infrastructure/authority requirements remain blocking.

The accountable individual names and deployment date are not supplied in this task. No deadline, approval, installed production state, confidential processing authorization, merge or production deployment is asserted.
