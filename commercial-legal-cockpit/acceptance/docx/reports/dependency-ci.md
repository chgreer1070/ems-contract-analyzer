# Dependency and CI acceptance result

October 9, 2026. Original candidate: `0d446203d670e086aa50ef8d65755cbc653ae6be` (draft PR 10). Proposed isolated remediation: `fd56950ad7692b5ac92338367983d541538ef014` on local branch `acceptance/docx-dependencies`. Status: local dependency repair validated; remote release acceptance remains blocked. Nothing was published, merged, deployed or activated by this agent.

## Exact original CI findings

GitHub associated these completed checks with the original PR head; job logs identify the tested PR merge as `deb960055cba4877b881ef34df964d2c927ec551`, merging that head into `39716dfd22f4e01a3b1f891e28fb9a64149bf661`.

| Check | Actual result | Evidence |
| --- | --- | --- |
| Verify committed package-lock.json | FAILURE | [Job 113780966417](https://github.com/chgreer1070/ems-contract-analyzer/actions/runs/37918660093/job/113780966417) |
| Cockpit validation | FAILURE | [Job 113780966589](https://github.com/chgreer1070/ems-contract-analyzer/actions/runs/37918660110/job/113780966589) |
| CodeQL JavaScript / TypeScript | FAILURE | [Job 113780966309](https://github.com/chgreer1070/ems-contract-analyzer/actions/runs/37918660106/job/113780966309) |
| Release preflight | FAILURE | [Job 113780967971](https://github.com/chgreer1070/ems-contract-analyzer/actions/runs/37918660196/job/113780967971) |
| CodeQL SARIF processing | NEUTRAL, unsuccessful execution | [Check 113781102624](https://github.com/chgreer1070/ems-contract-analyzer/runs/113781102624) |
| Exact release CodeQL | SKIPPED | [Job 113780969207](https://github.com/chgreer1070/ems-contract-analyzer/actions/runs/37918660196/job/113780969207) |
| Vercel preview | SKIPPED | [Job 113781105332](https://github.com/chgreer1070/ems-contract-analyzer/actions/runs/37918660196/job/113781105332) |
| Approval-gated Vercel production | SKIPPED | [Job 113781104965](https://github.com/chgreer1070/ems-contract-analyzer/actions/runs/37918660196/job/113781104965) |

All four failed jobs stop at `npm ci` with `EUSAGE`: missing `@swc/helpers@0.5.23`, `chokidar@5.0.0` and `readdirp@5.1.1` lock entries. CodeQL never reaches a successful application scan. Its post-job diagnostic upload reports the expected unsuccessful-execution SARIF processing error; the neutral check is not a scan pass. Combined legacy commit statuses are empty; they are not a success indication.

## Repairs prepared and verified

1. Local commit `19a5b8eec65c66cfcc69d54af95470c5ede1d631`: repair 120 missing optional/peer lock lines, without changing direct dependency versions. Fresh Node 22.23.3/npm 10.9.9 `npm ci --ignore-scripts --no-audit --no-fund` passes. A separate minimal patch is retained.
2. Local child commit `fd56950ad7692b5ac92338367983d541538ef014`: Next.js `16.3.0 → 16.3.8`, Workflow `4.8.1 → 4.8.13`, Undici override `7.29.0 → 7.29.1`, explicit Devalue `5.9.3` override, and compatible transitive `source-map-js@1.2.2`. The refreshed graph resolves patched Piscina 4.9.4, proxy-addr 2.0.8, brace-expansion 2.1.7, sharp 0.35.5, http-cache-semantics 4.3.0 and qs 6.16.0. No forced major dependency upgrade or audit exclusion was used.
3. Align the advertised Node engine with the locked graph: `>=22.0.0`. Published Kysely 0.29.4 and mixpart 0.0.4 manifests require Node 22 or later. Existing CI already runs Node 22; local verification used 22.23.3. Other runtimes/platforms have not been certified here.

The first security refresh exposed incorrect Chokidar/readdirp peer placement in the intermediate generated lock. A targeted source-map-js update also resolved that placement. The intermediate lock was rejected and never called accepted. The final full clean install succeeds and leaves the lock SHA-256 unchanged: `4472665c35a748feb5d7fa4cc7fab95f0e7a11d8328e50f6beffdf574c5c1684`.

| Local check on proposed dependency state | Actual result | Limit |
| --- | --- | --- |
| Fresh `npm ci --no-audit --no-fund` | PASS, exit 0; unchanged lock | Disposable isolated checkout, Node 22.23.3/npm 10.9.9 |
| `npm audit --omit=dev --audit-level=high` | PASS, exit 0; 0 findings | Registry report at observation time, not proof of absence of vulnerabilities |
| Complete `npm audit --audit-level=high` | PASS, exit 0; 0 findings | Same limitation; development graph also audited |
| `npm run test:controls` | PASS | Includes 29 extractor + 8 pipeline scenarios; doubled provider/storage/database boundaries |
| `npm run test:corpus` | PASS, 24 cases | Structural frozen corpus check, not live model evaluation |
| `npm run test:economics` | PASS | Existing deterministic checks |
| `npm run db:check` | PASS | Source schema check; no target migration or database execution |
| `npm run typecheck` | PASS | Workflow generation reports 15 steps / 3 workflows |
| `npm run build` | PASS | Explicit synthetic/demo auth configuration; legal reliance disabled; no deployment |
| `git diff --check` | PASS | Dependency files only |

Current original production audit was reproduced: 25 affected packages (16 moderate, 6 high, 3 critical). The proposed production and complete audits both report zero. Raw audit JSON, bounded check/job diagnostics, result/hash summaries and exact combined remediation patch are retained in `../evidence/dependency-ci-*`. These are actual local outputs, not claimed GitHub passes.

## Publisher evidence and compatibility limits

- [Next.js 16.3.8 release](https://github.com/vercel/next.js/releases/tag/v16.3.8) identifies its security fixes. The [maintainer Windows RCE advisory](https://github.com/vercel/next.js/security/advisories/GHSA-p293-qw3h-jr36) gives the affected range and earlier patched threshold; no exploit in ContractTwin is asserted. The installed 16.3.8 manifest retains React 19 compatibility and Node >=20.9.
- [Workflow 4.8.13 core manifest](https://github.com/vercel/workflow/blob/workflow@4.8.13/packages/core/package.json) still pins Devalue 5.9.2. [Devalue 5.9.3 changelog](https://github.com/sveltejs/devalue/blob/v5.9.3/CHANGELOG.md) documents the patch fixes. The explicit override is necessary to remove the residual advisory; a Workflow version bump alone was not assumed sufficient. Publisher upstream guarantees for this override are not asserted.
- The [Undici maintainer advisory](https://github.com/nodejs/undici/security/advisories/GHSA-w293-vg96-wgc3), published package metadata and audit establish the patched range; 7.29.1 retains Node >=20.18.1. Next's patched optional Sharp range accepts 0.35.5; PostCSS's `^1.2.1` range accepts source-map-js 1.2.2. Exact resolved package manifests are preserved in the proposed lock.
- [npm ci documentation](https://docs.npmjs.com/cli/v10/commands/npm-ci/) requires manifest/lock agreement and a frozen install. Existing node_modules and an earlier successful build did not establish this criterion; clean installs were performed.

## Remaining acceptance and next permitted increment

Technical release owner must review and integrate the two local dependency commits or the exact combined patch into the final candidate, then run the protected CI/CodeQL workflows on that new immutable SHA. A new source change invalidates the old remote check evidence. Both fresh successful remote checks and live target database controls remain required. This agent did not rerun or bypass remote checks, request deployment, change GitHub settings or mark the draft ready.

Workflow persisted-job/serialization compatibility across this patch upgrade must be exercised in an approved nonproduction target, including interrupted work and existing receipts. Local control tests/build do not prove that behavior. Legal policy/model acceptance, Word-authored comparison, parser resource/load acceptance, infrastructure authority and final human deployment approval remain separate gates owned by their assigned reviewers.

Until those gates pass, production release remains blocked. Accountable human names and dates are not supplied; none are invented.
