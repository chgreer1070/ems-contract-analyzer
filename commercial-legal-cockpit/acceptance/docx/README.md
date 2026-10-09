# Negotiated DOCX acceptance agents

See [PUBLICATION.md](PUBLICATION.md) for the later approved draft-PR publication scope. The reports and state below retain the earlier acceptance-time evidence; publishing them does not grant legal or production approval.

These six specialist agents were created and run on October 9, 2026 to perform the open work in `../../DOCX_VALIDATION.md`. They are reusable task instructions and a record of this invocation, not installed services or a promise of background execution.

The reviewed input is Git commit `0d446203d670e086aa50ef8d65755cbc653ae6be` in draft PR 10. Reports must identify the exact revision or digest of any later repair they test. A report on the original revision cannot approve a changed release.

| Agent | Responsibility | Output | Human authority retained |
| --- | --- | --- | --- |
| [Legal document evidence](agents/legal-document-evidence.md) | Original/proposed language, comment anchors, story context and representative Word comparisons | Independent evidence review and Word comparison protocol | Legal owner confirms source completeness, author attribution and applicability |
| [Legal model controls](agents/legal-model-controls.md) | Quote grounding, unapproved proposals, pricing/NCNR/E&O/notice evaluation and policy binding | Artifact-bound evaluation and proposed acceptance criteria | Legal control owner approves interpretations and current engine policies |
| [Dependencies and CI](agents/dependency-ci.md) | Exact-revision CI/CodeQL and dependency release gates | Actual checks, advisories and tested local remediation | Technical owner reviews changes; release owner approves release |
| [Database integrity](agents/database-integrity.md) | Receipt immutability, audit retention, stale generations and concurrent publication | Disposable local tests or executable target harness | Database owner supplies an approved test environment and accepts results |
| [Parser security and load](agents/parser-security-load.md) | ZIP/XML security bounds, memory, latency and load | Reproducible synthetic probes and measured limits | Security/technical owner approves workload and resource criteria |
| [Release authority](agents/release-authority.md) | Independent completeness, exact revision, deployment controls and rollback | Evidence inventory and human go/no-go record | Authorized human release owner decides production deployment |

## How to rerun

Start each agent with its charter, the user-level objective, the exact candidate checkout, and raw evidence. Run independent lanes in isolated contexts. Give dependency changes their own worktree; do not let parallel agents overwrite shared implementation files. The coordinator reviews reproduced defects, applies authorized reversible repairs, reruns affected checks and invalidates stale reports. The release reviewer examines raw results rather than accepting another agent's summary.

Every result records source revision, command, exit code, scope, assertions, raw artifact hashes, unresolved facts and the next permitted increment. Use `PASS` only for executed matching evidence; distinguish `FAIL`, `NOT EXECUTED`, `BLOCKED` and `HUMAN APPROVAL REQUIRED`. A completed agent task can leave its acceptance gate blocked.

## Shared limits

Use public code and synthetic agreements for this run. Do not place customer documents, privileged material, credentials or private endpoint details in this repository. Do not connect an unapproved live database or model provider, infer a party from a revision display name, convert a proposal into an accepted obligation, or fabricate Word-created documents. No agent may approve legal positions, activate policy or reliance, send notices, merge, publish externally or deploy.

Missing evidence stops the affected conclusion. It does not stop useful independent tests. Production acceptance additionally requires the existing platform gates; this focused DOCX package is not a full-platform release certificate.

## Timing and ownership

All unresolved release gates must close before production approval. No deployment date or accountable person's name has been supplied. Each report assigns an owner role and the smallest needed input. Until closure, the mitigation is to keep production and legal reliance blocked; the release owner owns that mitigation.

See the lane reports under `reports/` and the coordinator's `STATE.json` for the final checked result of this invocation.
