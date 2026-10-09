# Legal model and control acceptance — October 9, 2026

**Result: deterministic defects reproduced and repaired; live legal/model acceptance remains open.** This agent completed source review, synthetic original/proposed checks, malicious provider-response checks and current validation/readiness control checks. It did not run a real model, inspect live policy rows or grant approval.

The baseline was exact candidate `0d446203d670e086aa50ef8d65755cbc653ae6be`. Its recorded source-file hashes independently match that commit. The repaired worktree is separately pinned by `sourceHashes` in `../evidence/legal-model-controls-pack.json`; `workingTreeDiffersFromCandidate=true`. Its base SHA is not an assertion that the repaired files were already committed, reviewed or deployed.

## Work completed

Created a reusable agent charter and four actual synthetic OOXML negotiated agreements: pricing notice, NCNR payment/recovery, E&O recovery/mitigation and termination notices. Each preserves deletion/insertion author metadata, anchored comment instructions and complete original/proposed paragraph hypotheses. These documents are generated synthetic packages, not Word-created acceptance samples and not the Asahi agreement.

Executed actual extractor, grounding, clause and term modules. All provider traffic was replaced with an in-process response double and fake credential; no network request, real credential or confidential agreement was used. The malicious responses deliberately claimed acceptance, changed legal meaning and attributed reviewers to parties. They test adapter enforcement; they do not demonstrate the behavior of any live model.

| Check | Baseline | Repaired worktree | What the result proves |
| --- | --- | --- | --- |
| Original/proposed views and author metadata, four cases | 4 PASS | 4 PASS | Actual extraction preserves the hypotheses and display names |
| Comments/author metadata cannot ground quotations, four cases | 4 PASS | 4 PASS | Quote helper excludes comment text and reviewer names |
| Proposed-only term quote filtering and unapproved prefix, four cases | 4 PASS | 4 PASS | Exact quote filtering and labeling; normalized meaning/party are not validated by this check |
| Deleted/original quote requires original/unapproved clause labels, four cases | 4 FAIL | 4 PASS | Deterministic adapter labeling now supplies view and uncertainty even if the provider omits them |
| Case-mutated term quotes rejected, four cases | 4 FAIL | 4 PASS | DOCX quotations must now retain source case and contiguous wording |
| Comment-only risk language cannot trigger deterministic fallback | 1 FAIL | 1 PASS | Fallback operates on contract views rather than serialized metadata |
| Proposed quote plus invented party, meaning and acceptance rejected, four cases | 4 FAIL | 4 FAIL | Adapter does not establish semantic fidelity from quotation containment |
| Focused repair regression script | Not run on baseline | PASS | Fails on fallback leakage, absent view/uncertainty labels, altered-case quotation or original-only/metadata term acceptance |
| Existing validation/readiness controls | PASS | PASS source unchanged | Version matching, complete result manifests, no stale approval shortcuts and platform fail-closed controls are tested with doubles |
| Frozen synthetic corpus structure | PASS: 24 cases | PASS source unchanged | Structure only; zero DOCX envelopes and no fresh model result |

The full adversarial check deliberately returns exit code 1: **21 of 25 observations pass; four remain failed acceptance criteria.** The passing focused repair script is a narrower regression check. Its success does not override those four failures.

## Remaining legal/model acceptance work

The current term adapter requires a proposed contract quotation and prepends `Unapproved proposed text:`. It still accepts provider fields claiming that the agreement is accepted, changes apply within ten days or a reviewer represents an organization, even when those assertions are absent from the contract. The prefix creates a visible warning; it does not make the claim accurate. Clause issue/rationale/consequence wording also remains provider-controlled after deterministic view/uncertainty labeling. Counsel must reject unsupported claims and semantic changes rather than treating a correct quote as proof of the entire interpretation.

The production validation workflow evaluates clause findings from the 24-case frozen text corpus. That corpus contains no `CONTRACTTWIN_DOCX_EVIDENCE_V1` envelopes, and the workflow does not exercise negotiated term output. Passing that corpus alone therefore cannot approve the new DOCX term behavior. The prepared four-case model pack includes original/proposed source envelopes, exact byte/source hashes, legal expected effects, required uncertainty and malicious comment instructions. It is the concrete input for an authorized fresh clause-and-term evaluation.

The code's current engine identifiers are clause prompt `ems-legal-triage-2026-10-09.v6`, term prompt `contract-term-extraction-2026-10-09.v3`, pipeline `contracttwin-pipeline-2026-10-09.v8`; the extractor identifier is captured in each evidence receipt. The default model string is `gpt-5.6`; actual deployment configuration is unverified. Active database policy rows must exactly match the approved model/prompt/schema/graph/formula manifest. Existing result receipts must match model, clause prompt, corpus and gate versions with a complete hash-verified result manifest. No active policy or historical validation was rewritten by this work.

| Required action | Owner | Before | Risk if omitted | Mitigation and owner |
| --- | --- | --- | --- | --- |
| Run exact artifact-bound clause and term evaluation with intended provider/model | Technical/model validation owner; individual not supplied | Legal/model acceptance | A proposal or comment may be misrepresented despite a grounded quote | Use unchanged hashed cases, preserve provider results and fail every unsupported semantic/party/acceptance assertion; validation owner |
| Compare representative Word-created source views and comments | Legal and technical owners; individuals not supplied | Legal/model acceptance | Synthetic packages may miss real document behavior | Independently verify source, original/proposed views, revisions and comment anchors; legal and technical owners |
| Review every actual candidate, uncertainty and legal effect | Legal control owner; individual not supplied | Any policy or legal-reliance activation | Incorrect normalized obligations enter business decisions | Explicit artifact-bound counsel acceptance or rejection and unresolved exceptions; legal control owner |
| Verify current exact policy rows and bound validation receipts | Technical control owner, with legal authority for policy approval | Any policy activation or reliance | Stale or unrelated evidence passes as current approval | Enforce existing manifest/version checks; technical control owner |

No deployment deadline or individual owner name was supplied. The deadline for each gate is before its dependent acceptance/activation, not an invented calendar date.

## Human handoff and evidence

`../evidence/legal-model-controls-approval-template.json` is a blank evaluation/decision template, marked `NOT_EXECUTED`. Provider request IDs, model configuration, processing authorization, observed live outputs, legal owner and approval remain null. It grants no authority and contains no approval. The smallest next input is identification of the intended provider/model and the legal control owner, with authorization to run this synthetic pack through that provider. A production approval remains separate after all release gates pass.

- `../agents/legal-model-controls.md`: reusable scope, limits and execution instructions.
- `../evidence/legal-model-controls-baseline-pack.json` and `../evidence/legal-model-controls-baseline-command.json`: initial observed failures and exact baseline source hashes.
- `../evidence/legal-model-controls-pack.json` and `../evidence/legal-model-controls-repaired-command.json`: repaired-worktree hashes, source views, captured requests, complete observed results and remaining failures.
- `../evidence/legal-model-controls-*-source.json` and synthetic `.docx` files: current hash-bound negotiated fixture artifacts, including a comment-only negative case.
- `../evidence/legal-model-controls-regression.mjs` and `../evidence/legal-model-controls-repair-regression-command.json`: focused executable repair protection and actual output.
- `../evidence/legal-model-controls-validation-command.json` and `../evidence/legal-model-controls-corpus-command.json`: actual existing control/corpus command outputs.

Live provider evaluation: **NOT EXECUTED**. Word-created artifact acceptance: **NOT EXECUTED**. Live policy verification: **NOT EXECUTED**. Legal owner approval/policy activation: **NOT EXECUTED**. No send, merge or deployment was performed.
