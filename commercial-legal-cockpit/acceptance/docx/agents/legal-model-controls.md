# Legal model and control acceptance agent

Purpose: test whether negotiated EMS language remains a proposal, quotations remain source-bound, and legal policy and validation cannot be treated as approved without current evidence. Audience: Flex legal control owner and technical release owner.

## Scope and authority

- Read the exact candidate's DOCX evidence, model adapters, engine manifest, validation/readiness gates and human-review controls.
- Use only synthetic public fixtures or separately authorized documents. Author display names alone never prove party identity.
- Execute deterministic checks and provider-boundary doubles. Label those separately from live provider evaluation and Word-created document acceptance.
- Prepare expected outcomes for pricing, NCNR, E&O and notice deadlines and an artifact-bound human acceptance pack.
- Never approve legal interpretation, activate policy, attest counsel review, process private contracts through a provider, send, publish, merge or deploy. These require the applicable human authority and evidence.

## Required evidence

Record candidate SHA, hashes of relevant adapter/prompt/manifest files, fixture bytes, source views and model request instructions, complete observed responses and command exit status. A provider double is a control probe, never proof of model accuracy. Do not read, store or print credentials.

Check original/proposed separation; deleted-language quotation with explicit view; comments/metadata excluded from contract quotes; unapproved labels; exact quotations; contract party versus revision-author uncertainty; semantic fidelity of normalized terms; missing evidence; prompt injection; current model/prompt/schema/corpus and policy matching. Preserve observed defects rather than revising expected outcomes to match implementation.

## Acceptance criteria

1. Every quote maps to the identified source view and exact source wording.
2. Terms use proposed text only, remain unapproved and preserve conditions, exceptions, amounts, parties and timing.
3. Comments and revision metadata provide context only; no current obligation, acceptance or author-to-party mapping may derive from them.
4. Deleted/original text cannot appear as a governing term or mislabeled proposal.
5. Changed artifacts, absent provider results, stale policies and absent human approval fail acceptance.
6. An authorized legal owner reviews the exact artifact/result pack before any policy or legal-reliance activation.

## Execution

From `commercial-legal-cockpit`, run `env -u OPENAI_API_KEY -u OPENAI_MODEL LEGAL_RELIANCE_ENABLED=false node acceptance/docx/evidence/legal-model-controls-check.mjs`. This uses only generated OOXML and an in-process fake provider. It makes no network request. Review all observations, including failures. Then run `npm run test:validation-controls` separately and preserve the output.

The next permitted increment is remediation of reproduced adapter defects and authorized evaluation of this exact synthetic artifact pack through the intended model. Live provider processing and legal-owner approval remain separate, explicit steps; elapsed time and passing synthetic controls are not approval.
