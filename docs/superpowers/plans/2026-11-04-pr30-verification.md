# PR30 Verification and Hardening Implementation Plan

> **For agentic workers:** Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Finish feasible local verification of the five PR30 fixes and address independently identified correctness defects without pushing, merging or deploying.

**Architecture:** Preserve the existing isolated fix branch and hash-verified canonical reading path. Keep amendment chronology explicitly confirmed and conditional; preserve classifications and provenance through API and UI.

**Tech Stack:** Next.js/React/TypeScript, Python ContractTwin, Playwright.

**Spec:** User's PR30 five-finding request and no-merge/no-deployment constraint; prior patch README at ../ContractTwin_PR30_Fixes/README.md.

## Global Constraints
- No push to PR30 because its workflow can deploy a preview; no merge or deployment.
- Preserve source provenance and fact/inference/assumption distinction.
- Report executed results separately from unverified live infrastructure.

## Review Focus
- Matter navigation while a read is in flight must not show another matter's result.
- Financial impacts must retain classification and all source citations in the UI.
- Source eligibility changes during a read must not silently publish stale analysis.
- Multi-page real PDF extraction must not duplicate overlap or genuine repeated text.
- Browser tests must execute with a working local browser or report the exact remaining blocker.

### Task 1: Complete test infrastructure and independent review
- [x] Diagnose prior Chromium download failure; use a local test-only browser if available without changing application dependencies.
- [x] Execute existing matter UI tests; retain failures and logs.
- [x] Obtain independent diff review and record actionable findings.

### Task 2: Correct review findings
Files: components/MatterDocumentReading.tsx, app/api/matters/[id]/reading/route.ts, lib/matterDocumentReading.mjs and .d.mts, scripts/matter-reading-regression-check.mjs, e2e/matter-reading.spec.ts.
Interfaces: retain POST baseDocumentId/amendmentDocumentIds/amendmentOrderConfirmed, canonical source extraction, typed statements and citations.
- [x] For each confirmed important finding, add failing regression, observe failure, then implement minimal fix and rerun.
- [x] Keep declaration files consistent with API/UI changes.

### Task 3: Verify and package
- [x] Run route regressions, controls, Python suite, typecheck, build and browser suite; record full logs and boundaries.
- [x] Verify final patch applies to baseline dac85bc6f9f72290b7e42137ac77d9eb37472da9.
- [x] Save versioned patch package with verification report and exact commands; keep branch local.

## Execution ledger
Ruling: Continue directly under the user's explicit “think plan execute all recommended next steps” authorization; do not insert another plan-approval pause. Preserve the existing dedicated fix/pr30-reading checkout rather than duplicate it.
Ruling: Remote production credentials, live customer data, deployment and shared-branch writes are outside this run. Local synthetic checks cannot replace staging acceptance.


Task 1: complete — independent review returned three P2 findings; local Chromium 153.0.8010.0 was obtained through a test-only npm package after the official download returned a 195-byte HTML document rather than a ZIP. Default package extraction hit unsupported chown; manual Brotli/tar extraction without ownership changes succeeded.
Task 2: complete — conditional current/superseded labels, matter-keyed component state, and financial impact provenance each had an observed failing regression before correction. An additional observed 200-versus-409 regression for quarantine during analysis was corrected with pre-service and pre-response state/access checks.
Task 3: complete — 4 browser tests, 2 component scenarios, focused route/engine and real-PDF regressions, complete controls, Python 44 passed/1 smoke deselected, typecheck and build passed. Patch application is checked against the baseline during packaging.
Ruling: Keep the branch local, consistent with the user's existing no-merge/no-deployment decision; PR updates can trigger Vercel previews. Cost: shared PR remains unchanged until a separately authorized publication path exists.
Final review: Three important findings fixed with observed RED→GREEN tests. No deferred minor findings were reported. Actual PDF decoding additionally verified 130 clauses across two long pages.
Environment failure resolved: --single-process caused Chromium to close between browser contexts (2 initial passes/2 failures before app execution). Removing that local-only flag produced 4/4 passes; initial log retained.
