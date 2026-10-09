# DOCX parser security and load acceptance record

Date: October 9, 2026. Owner: parser security/load agent. Acceptance item: `DOCX_VALIDATION.md` item 4. **Engineering checks pass after two reproduced defects were repaired; production resource acceptance remains OPEN.** No deployment, approved SLA, confidential input, external model, or target-environment result is asserted.

## Exact code and method

Baseline commit: `0d446203d670e086aa50ef8d65755cbc653ae6be`. The baseline's actual ZIP/XML/evidence/receipt modules were loaded from Git into an isolated temporary directory for independent defect reproduction. Candidate measurements use the repaired working tree based on that commit, extractor `docx-negotiation-2026-10-09.v2`. The final reviewed commit must contain these module hashes; this report does not invent an unpublished release SHA. The refreshed profiles bind to implementation/dependency snapshot `2f5f855f3d62e04948c17aa15fd4cc3cb80acc06f5efbef1637b28416c2139a7` (`coordinator-source-inventory.json`, ten files). Each listed source plus `package.json` and `package-lock.json` matched before and after the run; installed XML parser version `0.8.15` was also recorded. The prior build had completed and no other build/test process was running during this refresh.

| Runtime module | SHA-256 |
| --- | --- |
| `lib/docxPackage.ts` | `16be9f702e5fab4fe90225d09f0c935d8ee73113ad2948d8e6be19f63b0d366e` |
| `lib/docxExtraction.ts` | `4e9f9e70ec6c53ca619cbfab65dd39a6ce85ce61b3340010c46395f82b0826c7` |
| `lib/docxEvidence.ts` | `8598fc5455c52d0a13a7af784320ad1c710f23da74fe9cad6f3a46f521b2bc64` |
| `lib/docxReceipt.ts` | `7873cce3ffd75e980056d57ab19c8a778611d8dc88a58c7664b9fb08038b3a3f` |
| `lib/stateHash.ts` | `b97f4a57d09532aefd542a7f1ffd13d65ecfa88424385eb835be3a2bd07d6d29` |

Runtime: Node `v24.19.0`, Linux x64, AMD EPYC 9V74 80-Core Processor. Container memory limit: 8 GiB; CPU quota: 8 cores (`800000/100000`). Each child had a 512 MiB V8 old-space cap and 30-second subprocess timeout. These are harness containment controls, not the application's approved limits. Source hashes are captured before module load and checked unchanged at the end of every sample.

The harness builds ZIP headers, CRCs, compressed data and OOXML independently; it does not import the repository's DOCX fixture generator. All document bytes are synthetic. Successful cases run the actual parser, receipt creation, canonical evidence hashing and complete source/chunk receipt verifier; denied cases assert zero chunks. Each benchmark is one fresh process. Latency measures extraction separately from successful receipt creation/verification. RSS is Linux process high-water RSS, including TypeScript loading and fixture generation; ordinary pre-extraction RSS was approximately 130–141 MiB. Numbers therefore do not estimate the bundled production application's idle RSS. Single samples do not establish p95 or p99.

## Measurements

| Synthetic case | Compressed / expanded bytes | Extraction ms | Receipt ms | Process peak MiB | Result |
| --- | --- | --- | --- | --- | --- |
| ordinary | 2,336 / 65,708 | 38.8 | 38.1 | 152.1 | eligible, verified |
| negotiated | 3,656 / 87,598 | 61.1 | 61.4 | 154.0 | eligible, verified |
| many_paragraphs | 1,445 / 204,818 | 230.2 | 316.9 | 296.0 | eligible, verified |
| near_xml_token_limit | 2,433 / 544,818 | 573.0 | 737.5 | 450.6 | eligible, verified |
| over_xml_token_limit | 2,531 / 578,818 | 31.6 | — | 148.8 | denied; zero chunks |
| near_part_limit | 9,006 / 8,388,859 | 251.3 | — | 264.2 | denied; zero chunks |
| over_part_limit | 9,006 / 8,389,459 | 1.5 | — | 159.4 | denied; zero chunks |
| near_expanded_limit | 34,184 / 33,523,703 | 358.0 | — | 199.0 | denied; zero chunks |
| overlapping_comments (1000 comments × 2000 runs) | 9,566 / 227,955 | 116.7 | — | 167.7 | denied; zero chunks |
| excessive_attributes | 344,628 / 1,689,746 | 299.4 | — | 194.3 | denied; zero chunks |
| local_crc_mismatch | 837 / 873 | 1.5 | — | 126.6 | denied; zero chunks |
| local_size_mismatch | 837 / 873 | 1.4 | — | 129.3 | denied; zero chunks |
| overlapping_comments (500 comments × 2000 runs) | 5,553 / 137,455 | 85.2 | — | 157.0 | denied; zero chunks |
| overlapping_comments (1500 comments × 2000 runs) | 13,718 / 319,955 | 141.1 | — | 182.1 | denied; zero chunks |

The near lexical XML limit case has 16,000 paragraphs, approximately 96,000 opening/closing tag tokens and 64,000 tree nodes, with a 21,825,378-byte structured receipt (20.8 MiB). Every paragraph had exactly one corresponding chunk and the complete receipt verified. The 17,000-paragraph case is denied before DOM parsing by the conservative 100,000-token guard. The near part-size case keeps the main XML just below 8 MiB and is denied by projection/receipt size limits. The near expanded package contains 33,523,703 bytes, leaving 30,729 bytes before the 32 MiB package cap, and is denied because its binary parts require another adapter. This is resource evidence, not support for binary content.

| Concurrent isolated ordinary workers | Whole batch wall ms | Sum of process high-water MiB |
| --- | --- | --- |
| 1 | 549.7 | 147.7 |
| 2 | 564.2 | 299.4 |
| 4 | 737.8 | 617.8 |

Each worker extracted and verified 500 paragraph chunks. The sum of individual high-water marks is a conservative accounting number; simultaneous RSS was not sampled. Separate child processes model isolated workers, not simultaneous parsing inside one Node event loop, production queues, providers, databases, or multi-tenant traffic. The four-worker batch does not justify any production concurrency setting.

Historical preliminary profile records are retained in `evidence/parser-security-load-historical-results.json` and `parser-security-load-historical-run.log`. Those measurements preceded the story-binding repair and final dependency snapshot; they do not attest the final implementation. Their near-limit result was 432.4 MiB and 1.48 seconds combined extraction/receipt time. These are single samples; differences cannot establish a causal performance change. The refreshed record contains **14 profiles and seven burst workers**, all with the final source hashes, expected eligibility, zero chunks on denial and verified complete receipts on success.

## Reproduced defects and repair verification

1. **Local ZIP metadata inconsistency — resolved in candidate, pending exact-commit CI.** The baseline accepted classic ZIP entries whose local CRC or compressed size disagreed with their central directory while descriptor flag 3 was unset, and produced analysis-eligible chunks with valid receipts. The parser used the correct central CRC and actual decompressed bytes; the reproduction does not demonstrate altered contract wording. It nevertheless contradicted the stated local/central consistency guarantee and allowed malformed package evidence. The repair requires matching local CRC and both sizes when no descriptor is present, validates permitted placeholder/matching local metadata when a descriptor is present, checks actual signed or unsigned classic data descriptors and includes their bytes in overlap ranges.
2. **Comment/run membership amplification — resolved for the reproduced path, broader resource acceptance still open.** Only 319,955 expanded bytes with 1,500 overlapping comments and 2,000 text runs produced 3 million copied run/comment memberships on the baseline. Late serialization denial still returned zero chunks, but peak process RSS was 360.9 MiB and extraction 542.0 ms. Candidate early cumulative 4 MiB run-metadata allocation budget denies the same byte-identical source before copying the full membership set: 182.1 MiB and 141.1 ms. The new guard is denial evidence, not an approved operating threshold.

The independent CI-ready integrity check passed **10 assertions**: local CRC, local compressed size, local expanded size; valid signed and unsigned descriptors; corrupt descriptor CRC/size; missing descriptor; conflicting descriptor-mode local metadata; and early comment amplification denial. Valid descriptor cases also verify complete receipts. Every failed integrity/amplification case exposes zero analysis chunks. Independent baseline raw results retain the two expected-rejection mismatches rather than relabeling them as passes.

## Remaining acceptance blockers

- **Upfront DOM allocation remains.** XML is bounded by expanded part size and a lexical depth/token pass before `DOMParser`, but per-node attribute/name/tree memory limits are applied after the DOM exists. An otherwise small single paragraph with 150,000 attributes consumes approximately 194 MiB peak process RSS before rejection. The repair does not supply a streaming XML parser or prove peak allocation for every legal 8 MiB XML shape.
- **Output amplification and receipt verification remain material.** A 544,818-byte expanded source with 16,000 ordinary paragraphs reaches 450.6 MiB process peak RSS and about 1.31 seconds combined extraction/receipt time, while remaining eligible. Final receipt serialization, canonical hashing, projection reconstruction and database JSON load can retain several copies. No live database, bundled application memory profile, request timeout, or target-instance headroom is proven here.
- **The parser runs synchronously.** `extractDocx` and inflation/DOM parsing block their current Node execution thread. The harness supplies process isolation/timeout; these protections cannot be claimed for production without inspecting and validating its actual worker boundary.
- **No approved workload/resource contract is supplied.** Ordinary synthetic clauses, one near-boundary shape and one four-worker burst cannot establish sustained throughput, production concurrency, long-tail latency, Word fidelity, or resilience under a hostile workload mixture.

Before production, the technical/security owners must choose and record instance memory/CPU, parser worker isolation, wall-time deadline, allowed concurrency, ordinary/near-limit workload definitions and latency/RSS limits. Proposed acceptance procedure: run the bundled exact-release worker on the approved instance with at least 30 cold and 100 warm ordinary/negotiated samples, representative valid near-limit documents, malformed/allocation-heavy mixtures and sustained loads at approved concurrency; report p50/p95/p99 and simultaneously sampled container RSS. Approve limits only with measured headroom for application/database serialization, cancellation and neighbor workloads. Lower structural/input caps or add a streaming preflight/isolation boundary if measured headroom fails. These proposals are not approvals.

## Reproduction and evidence

From `commercial-legal-cockpit`:

```bash
node acceptance/docx/scripts/parser-security-load-run.mjs
node acceptance/docx/scripts/parser-security-load-integrity-check.mjs
DOCX_BASELINE_REVISION=0d446203d670e086aa50ef8d65755cbc653ae6be COMMENT_COUNT=1500 RUN_COUNT=2000 node --expose-gc --max-old-space-size=512 acceptance/docx/scripts/parser-security-load-worker.mjs overlapping_comments
```

Raw evidence: `evidence/parser-security-load-results.json`, `parser-security-load-run.log`, `parser-security-load-baseline-results.json`, `parser-security-load-integrity-check.json`, and `parser-security-load-integrity-check.log`, `parser-security-load-final-snapshot.json` and the historical profile pair. All are synthetic or public-code engineering records. The reusable agent charter is `agents/parser-security-load.md`.

Next permitted increment: integration owner runs the independent check in exact-release CI; technical/security release owners perform and approve target resource acceptance. No named approver or deployment deadline has been supplied. No production go/no-go decision or legal-reliance authority is exercised by this agent.
