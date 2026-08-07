# Production Readiness Gates

ContractTwin / EMS Commercial Legal Cockpit must satisfy these gates before confidential or privileged production use.

## 1. Identity and access — BLOCKING

- Microsoft Entra application registration approved.
- MFA / conditional access applied by corporate identity policy.
- `AUTH_REQUIRED=true` in production.
- Default role is Viewer; Lawyer/Approver/Admin roles are explicitly granted.
- Restricted matters tested against unauthorized users.
- Server-side authorization tests cover every protected API, not only UI visibility.
- Break-glass/admin process documented and reviewed.

## 2. Source-document security — BLOCKING

- Private Blob store configured; no public contract URLs.
- Matter authorization required before upload token issuance and source retrieval.
- Upload MIME/type and size limits validated.
- Client SHA-256 and server SHA-256 match before extraction.
- Integrity mismatch stops processing.
- Malware scanning / enterprise file-security control selected before broad external uploads.
- Retention, legal hold and deletion behavior approved.

## 3. Contract extraction — BLOCKING

- Machine-readable PDF/DOCX/TXT test set achieves agreed extraction fidelity.
- Scanned PDF/OCR path is implemented and tested before relying on scanned agreements.
- Tables, schedules and pricing exhibits have a validated extraction path before relying on them.
- Oversized contracts use an asynchronous worker and never silently truncate.
- Page/chunk provenance is preserved through analysis.

## 4. AI legal analysis — BLOCKING FOR LEGAL_RELIANCE_ENABLED

- Frozen regression corpus versioned and approved.
- Source-excerpt grounding precision meets acceptance threshold.
- Material clause-family recall meets acceptance threshold on representative EMS agreements.
- False positive / false negative review completed by experienced commercial counsel.
- Missing definitions, precedence conflicts, referenced documents and uncertainty are retained rather than repaired by the model.
- Exact error/unsafe-language preservation regressions pass.
- Model/prompt version is recorded for every persisted finding.
- AI cannot generate approved company negotiation policy or approval authority.
- `LEGAL_RELIANCE_ENABLED=true` only after validation sign-off; when enabled, AI failure fails closed.

## 5. Negotiation standards — BLOCKING

- Illustrative standards remain inactive.
- Each production clause standard has owner, version, effective date, business rationale, fallback, no-go threshold and approval authority.
- Admin activation requires explicit confirmation.
- Only one active standard exists per clause family.
- Standard changes and activation are auditable.

## 6. Financial engine — BLOCKING FOR EXECUTIVE RELIANCE

- Formula definitions approved by Finance/Business stakeholders.
- Units, signs, percentage conventions and rounding documented.
- Boundary cases tested (zero revenue, negative inputs, >100% percentages, zero gross profit).
- No double counting of exposures across modeled categories.
- Formula version stored on every matter-scoped run.
- Model-generated facts never directly replace financial inputs without human validation.

## 7. Human review / authority — BLOCKING

- AI findings default to `UNREVIEWED`.
- Lawyer validation/rejection retains reviewer, timestamp and note.
- Recommendation is distinct from approval.
- Exception requests are distinct from approved dispositions.
- Approver/Admin authority is tested server-side.
- No automated redline transmission, signature, purchase commitment or customer communication.

## 8. Audit and records — BLOCKING

- Audit table is append-only at the database layer.
- Matter creation, upload, extraction, analysis, finding review, economics and decisions are recorded.
- Audit access is matter-scoped except for Admin portfolio access.
- Time source, retention and export approach approved.
- Backup/restore test completed.

## 9. Application security — BLOCKING

- Dependency and secret scanning enabled in CI.
- SAST and production build checks enabled.
- OWASP-style authorization, injection, upload and session tests completed.
- CSP/security headers reviewed.
- Rate limits / abuse controls applied to AI and upload endpoints.
- Production environment separated from preview/test data.
- Penetration test or risk-based security assessment completed.

## 10. Operational acceptance — BLOCKING

- Vercel Git integration uses the intended repository/root directory.
- Preview deployments cannot access production secrets/data unless explicitly approved.
- Monitoring and alerting defined for 5xx errors, auth failures, extraction failures and AI failures.
- Incident response and credential rotation procedure documented.
- Named product owner, legal control owner and technical owner assigned.

## Current disposition

**Pilot / engineering validation only.** Do not enable `LEGAL_RELIANCE_ENABLED` or use confidential production agreements until all applicable blocking gates above have been formally accepted.
