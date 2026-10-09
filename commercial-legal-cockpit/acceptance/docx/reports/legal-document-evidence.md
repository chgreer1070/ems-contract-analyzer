# Legal document evidence acceptance report

Date: October 9, 2026. Agent: legal document evidence acceptance. Candidate inspected: `0d446203d670e086aa50ef8d65755cbc653ae6be`, tree `083d866a615a5d3579cadb40485519a4657309de`. Public code and synthetic data only. No customer agreement, Word renderer, external model, live database, account session or production process was used.

## Current conclusion

**Legal document acceptance remains blocked pending authentic Word comparison and legal model acceptance.** The original 37 synthetic scenario groups pass, and independent controls confirm body-text replacement, distinct authorship, retained anchors and exclusion of comment/author text from source quotations. Additional probes reproduced three gaps in linked-story/comment eligibility. These do not prove any agreement was misanalyzed in production. Every tested receipt remains `legalEvidenceReady:false`. They show why linked-story activation must be checked before note/header text becomes a proposed-term input.

The original exact-SHA findings below are preserved separately from later repair verification. Initial repairs pass seven independent assertions on the same preserved bytes. A second cycle found a residual header relationship-type gap; its repair verification is recorded below. Word Original/Final/comment comparison and artifact-bound legal model acceptance are **NOT EXECUTED**.

## Independent results and defects

Command from `commercial-legal-cockpit`: `npm run test:docx` — exit 0; 29 extraction plus 8 pipeline/adapter/API scenario groups. Those tests mock database/storage/model boundaries and do not replace Word or target-environment acceptance.

Before repair, command: `node acceptance/docx/evidence/legal-document-evidence-probes.mjs` — six synthetic probes; four defect reproductions and two positive controls. A byte-identical `legal-document-evidence-baseline-probes.mjs` source is archived with SHA-256 `e2c212f9a8ddadd105fa0fdcd5512e114ee019bd83a73620170a13bd8b64f798`. That archival script expects the historically incorrect eligibility behavior and must not be run against the repaired code. The baseline fixture bytes and result JSON are retained. The synthetic ZIP builder stamps current ZIP dates, so regeneration may change byte hashes; use the retained bytes for exact repair comparison.

| Finding | Severity and source | Reproduced behavior | Required disposition |
| --- | --- | --- | --- |
| LDE-001 | High; `lib/docxExtraction.ts` note-reference collection and story projection; `lib/docxEvidence.ts` proposed-text gate | A note referenced only from a deletion remains its own original/proposed chunk. `proposedTextContainsExcerpt` accepts its NCNR reimbursement wording. A non-separator note with no reference is also projected. | Propagate reference/view activation, or fail closed on unresolved/revised references and orphan substantive notes. Do not let a note's plain paragraph text establish a proposed obligation. |
| LDE-002 | High; story relationship eligibility | A header part with a package relationship but no section `headerReference` produces a proposed analysis chunk containing a $2 million annual fee. | Require a supported, active section reference or block. Keep inactive source parts as provenance rather than proposed contractual wording. |
| LDE-003 | Medium; comment-anchor consistency | A range starts/ends in the main body, while its same-ID reference occurs in a header. The receipt is eligible because only start/end part agreement is checked. | Block cross-story reference/range association unless a validated interpretation establishes that association. Preserve all available anchor evidence. |

The deleted-note example retains deletion metadata in the full receipt but omits reference revision state in the note projection; its note projection contains no revision context. The proposed-term adapter does not need to invent a quote to pass its deterministic source check. This is an input-eligibility problem and cannot be fixed solely by a prompt warning.

Positive controls: a 30-day deletion and 60-day insertion preserve distinct author strings and the exact corresponding text hypotheses; a synthetic liability comment and the author string cannot ground contract quotations. No author-to-party or acceptance inference was performed.

Evidence: `evidence/legal-document-evidence-baseline-source-hashes.json`, `evidence/legal-document-evidence-baseline-probe-results.json`, the baseline probe source and six `legal-document-evidence-*.docx` files. The baseline result JSON binds each preserved file's SHA-256. These are hand-built synthetic OOXML, not Word-produced sources.

## Repair verification

The strict command `node acceptance/docx/evidence/legal-document-evidence-repair-check.mjs` asserts preserved input hashes, the specific blocking code, zero chunks, `legalEvidenceReady:false` and both positive controls. It also executes an isolated active-header/cross-story-comment check, so the inactive-header blocker cannot mask a missing comment consistency check. Its CI mode checks current behavior against archived, hash-bound baseline evidence and requires no prior git history. For optional fresh baseline comparison, `node acceptance/docx/evidence/legal-document-evidence-isolated-anchors.mjs --require-repaired` loads the original parser directly from the baseline git object; it does not rewrite the shared implementation.

First repair: seven assertions passed under extractor `docx-negotiation-2026-10-09.v2`; parser SHA-256 `f19ced5d8d00bfdf85ee2daaed42eb74cc9a8f120c60a08a14350a7d6d40a40d`. That was a local patched snapshot, not a newly committed or approved release. Specific denials: `REVISED_NOTE_ACTIVATION`, `ORPHAN_NOTE_BODY`, `UNACTIVATED_HEADER_FOOTER` and `CROSS_STORY_COMMENT_ANCHORS`.

Second-cycle LDE-002 follow-up: a section `headerReference` points to a header XML part through a relationship typed `/comments` rather than `/header`. The first repair accepts it, since its activation check matches only ID and target. The source hash is `641a26386b75575ffd7ac5652ae9eb09a4c8db3fc7b470409c430ef8ca498613`; preserved first-repair behavior is in `legal-document-evidence-second-cycle-wrong-story-baseline.json`. The coordinator added story root/content-type/relationship binding and a matching section relationship type. The eight-assertion strict check passed against parser SHA-256 `4e9f9e70ec6c53ca619cbfab65dd39a6ce85ce61b3340010c46395f82b0826c7`; the wrong-type source now gives `STORY_RELATIONSHIP_MISMATCH` plus `UNACTIVATED_HEADER_FOOTER`. The original 29+8 DOCX groups also passed against that repair. The machine result records all source hashes and the local patch hash; it does not attest a committed release or Word acceptance.

All reproduced defects are closed to the extent of these synthetic comparisons. Revised note references intentionally fail closed rather than pretend to resolve Word's view activation. This conservative scope still needs the representative Word packets below.

The final agent recheck after shared dependency installation also passed all eight assertions in the CI mode; it did not require baseline git history. The exact semantic snapshot is bound in `legal-document-evidence-repair-results.json`, including parser SHA-256 `4e9f9e70ec6c53ca619cbfab65dd39a6ce85ce61b3340010c46395f82b0826c7`, projection/gating module SHA-256 `8598fc5455c52d0a13a7af784320ad1c710f23da74fe9cad6f3a46f521b2bc64` and clause grounding/prompt module SHA-256 `6914fd55247e71ccb9805c7cb9558f80242bed42b4437be80c97db9999e6d035`. A transient install-time module-resolution failure during CI-mode preparation was retried after installation completed; the stable rerun passed. No test assertion was bypassed.

## Word comparison protocol — NOT EXECUTED

1. Legal/technical fixture owner creates the representative synthetic source in Microsoft Word, records desktop/Web edition, full version/build, platform and locale, and saves the untouched DOCX. Hash the source before extraction. Use synthetic names and positions; supply no confidential/customer terms.
2. Open the unchanged file in Word. Capture its Review pane with all reviewers and comments visible, All Markup, Original and Final/proposed display settings, and each relevant header/footer/note/table. Save view screenshots and exports, if available. Record view settings and hashes. Changing the display view must not save over the source.
3. On separately labeled copies, reject all changes and accept all changes, then export the corresponding original and proposed reference views. These are view oracles only; acceptance in a synthetic copy does not authorize terms. Keep and hash the original and both copies. Document export limitations, especially comments, floating content and hidden text.
4. Run the candidate extractor against the original source only. Retain receipt/chunks and candidate SHA plus patch hashes. Compare exact decoded original/proposed paragraph text, table cell positions, inserted/deleted wording, note/header activation, authors/dates-as-supplied and comment range membership. Use UTF-16 offsets in the combined negotiation story with both inserted/deleted text and one newline per paragraph; do not compare those offsets directly with an Original/Final view.
5. Counsel and a technical reviewer jointly record every difference: source locator, expected view/state, receipt value, discrepancy severity and disposition. An expected unsupported feature must produce a blocking receipt with no chunks. A source hash match proves byte binding; it does not prove layout, author identity, signature authenticity or governing-text status.
6. Pass only when eligible fixtures have zero unresolved material text/anchor/activation differences and unsupported fixtures consistently fail closed. The legal control owner separately approves model/artifact validation; the authorized release owner approves a fully validated exact release. No parser acceptance can override an unsupported-feature block.

## Required representative Word source artifacts

Each packet must contain the untouched Word-generated DOCX, a short creation/view settings manifest, hashed Word Original/Final/All Markup evidence, the reviewer pane/comment evidence, and the expected text/anchor ledger. No actual customer contract is required to begin.

| Packet | Synthetic content and checks | Expected disposition |
| --- | --- | --- |
| W01 — smallest first input | One payment paragraph changes 30 to 60 days, deleted and inserted by two distinct synthetic reviewer identities. One comment is anchored to the changed period. Explicitly typed section label; no automatic numbering. | Eligible after repair; exact hypotheses, edit metadata and anchors agree with Word. |
| W02 — comment geometry | A range crossing two paragraphs, overlapping comments, point comment, Unicode/emoji, whitespace, paragraph-end references and unchanged/deleted/inserted text inside the range. | Eligible if classic comment representation is supported; extended/threaded parts must block. |
| W03 — linked stories | Body clause with an ordinary note, deletion of a note reference, insertion of a note reference, changed note text, section-specific header/footer and different first/even-page settings. Include orphan/inactive source parts only as separate fault injections, not claimed Word output. | Supported live links agree with Word; unresolved revised note/section semantics block. |
| W04 — tables | Forecast/NCNR recovery table with first-row/header labels, spans, a vertical merge and a cell-text replacement with a comment. A separate copy introduces nested tables and tracked row/cell/grid changes. | Supported text/structure agree; unresolved structural cases block. |
| W05 — unsupported features | Automatic/inherited numbering, tracked moves/property/paragraph-mark changes, fields/cross-references, hidden/bidirectional text, pictures/textboxes, embeds/content controls, modern threaded comments and revised comment bodies. | Source/diagnostic evidence retained; no eligible chunks. Test each separately to prove detection. |

Model evaluation is a separate gate: artifact-bound synthetic EMS cases must ask the registered clause/term engines to distinguish original/proposed pricing, NCNR, E&O and notice-deadline wording; use comments solely as context; abstain on blocked extraction; preserve unapproved state; and quote exact supported views. Current probes did not call the model or certify prompt behavior.

## Owners, timing, authority and next input

The technical owner must close LDE-001/002/003 and preserve regression evidence before any further reliance decision; counsel owns the Word view comparison and party/state assessment. If unresolved, a note/header can be mistaken for a proposed obligation or a comment can attach to the wrong story. Failing closed is the current mitigation, owned by the technical owner. The deadline is **before release or legal-reliance activation**; no deployment date or named accountable person was supplied.

The smallest human input is **one synthetic Word-created W01 packet**: original DOCX, recorded Word version and Original/Final/All Markup/comment evidence. Additional packets follow one at a time. No consequential authorization is requested or inferred. Production release, legal policy approval and any authentic customer processing remain human decisions.
