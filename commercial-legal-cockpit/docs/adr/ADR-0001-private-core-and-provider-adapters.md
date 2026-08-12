# ADR-0001: Enterprise-controlled private core with provider adapters

- Status: Accepted target architecture
- Date: 2026-08-08
- Scope: ContractTwin source, evidence, negotiation, decision and execution state

## Context

ContractTwin must preserve confidential agreements and immutable negotiation history under enterprise control. The current vertical slice uses Vercel Functions and Workflow, Vercel Blob, PostgreSQL, Microsoft Entra, OpenAI and Azure Document Intelligence. Treating those products as the architecture would make the legal system of record difficult to move, operate locally, or reauthorize when a provider or deployment policy changes.

The product is an internal single-enterprise platform. It is not currently a shared SaaS tenancy model.

## Decision

The authoritative domain is a portable private core:

- original-source manifests and content-addressed object references;
- structure-preserving evidence and provenance;
- persistent clause and obligation identities;
- immutable negotiation rounds, proposals, concessions and acceptance events;
- evidence and assumption ledgers plus deterministic calculation receipts;
- human review, authority, decision, execution and snapshot receipts; and
- append-only audit and records-policy state.

Application hosting, identity, object storage, OCR, model inference, workflow execution, signing evidence and observability are adapters. Each adapter must implement a versioned interface, declare its data-processing boundary, and produce sufficient receipts for exact replay or defensible non-replay. Provider egress is deny-by-default until an exact processing-authorization manifest is approved.

The current Next.js/PostgreSQL deployment may remain the first implementation. New domain behavior must not require a Vercel-, Blob-, OpenAI- or Azure-specific identifier as its only durable identity. Export and restore must preserve canonical records, hashes, ordering and verification evidence.

## Consequences

- A private workstation or enterprise-hosted deployment can use local object storage, local workflow execution and approved local models without changing domain semantics.
- A managed-cloud deployment can use current providers after policy authorization while keeping the same ledger contracts.
- Provider adapters need conformance tests, failure semantics, idempotency, residency/retention metadata and migration procedures.
- This ADR does not claim the adapter boundary is already complete. Existing direct provider dependencies are implementation debt to be removed incrementally.

## Rejected alternatives

- **Provider-native system of record:** rejected because provider coupling would control portability, restore authorization and sensitive-source routing.
- **Shared multi-tenant SaaS now:** rejected because tenant identity, isolation, keys, policy registries and negative tests do not exist.
- **Fully offline-only product:** rejected as a mandatory topology; enterprise-approved managed services remain useful adapters when explicitly authorized.
