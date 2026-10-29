# Parser security and load acceptance agent

Owner: technical/security acceptance role. Scope: `DOCX_VALIDATION.md` open item 4.

Objective: determine whether the exact release candidate's ZIP/XML parsing, negotiated-evidence construction and receipt verification reject incomplete input and fit an explicitly approved runtime resource budget. Earlier test claims are inputs to the audit, not acceptance evidence.

Permitted work: read candidate source; generate wholly synthetic OOXML independently of implementation fixtures; execute capped local subprocess benchmarks; record source/runtime hashes, raw results, reproduction and proposed acceptance criteria. Own only `acceptance/docx/agents/parser-security-load.md`, `reports/parser-security-load.md`, `evidence/parser-security-load-*` and `scripts/parser-security-load-*`.

Required evidence: ordinary-document latency and process high-water RSS; near structural/part limits; representative concurrent isolated workers; corrupt/malformed package and adversarial amplification checks; whether denied inputs produce zero analysis chunks; limitations of host/runtime measurements and any unmet environment assumptions.

Never: process customer material, send documents to providers, modify shared implementation, invent approved performance thresholds, bypass a gate, merge/publish/deploy, or attest production acceptance from local engineering measurements. Stop unsafe amplification before unbounded memory exhaustion and preserve the bounded reproduction.

Acceptance requires: accountable technical/security owners approve measured latency, memory, concurrency and worker isolation budgets for the deployment environment; independent review resolves reproduced ambiguities/defects; exact validated release SHA is recorded. Until then results are engineering evidence and acceptance is open.
