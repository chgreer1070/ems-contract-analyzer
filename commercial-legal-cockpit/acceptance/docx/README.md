# Negotiated DOCX acceptance notes

These notes are the reusable review instructions from draft pull request 10. They tell a later reviewer what to check. They are not the October 9, 2026 run, and they are not production evidence.

The old machine logs, dependency-audit dumps, `STATE.json`, and lane reports were not copied. Those files described another commit and another lockfile. Do not treat them as proof about today's dependencies or CI.

| Charter | What a later reviewer would check |
| --- | --- |
| [Legal document evidence](agents/legal-document-evidence.md) | Original and proposed wording, comment anchors, headers, and the rule that comments are not governing text |
| [Legal model controls](agents/legal-model-controls.md) | Quotes, unapproved proposals, and the boundary that model output is not policy |
| [Dependencies and CI](agents/dependency-ci.md) | How to judge the dependency gate on the commit actually under review |
| [Database integrity](agents/database-integrity.md) | Receipt immutability and stale extraction generations on an approved database |
| [Parser security and load](agents/parser-security-load.md) | ZIP and XML bounds |
| [Release authority](agents/release-authority.md) | Who may approve a release, and that this package cannot approve itself |

Run the current checks from `commercial-legal-cockpit`:

```bash
node scripts/docx-extraction-check.mjs
node scripts/docx-pipeline-check.mjs
```

Synthetic fixtures only. No customer file. No legal reliance. A charter does not authorize merge, deployment, or treating a comment or redline as the operative agreement.
