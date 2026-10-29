import { contentDigest, sha256, FAMILIES } from '../lib/playbooks/kernel.mjs';

const sampleText = {
  pricing: 'Synthetic precedent: pricing changes require an agreed mechanism and documented notice.',
  ncnr: 'Synthetic precedent: authorized noncancelable commitments require evidence and mitigation.',
  eo: 'Synthetic precedent: excess and obsolete inventory recovery must avoid duplicate charges.',
  notices: 'Synthetic precedent: notice must identify its trigger, recipient, service method, and deadline.'
};
export function fixture() {
  const catalog = new Map(), sources = [], options = [];
  for (const family of FAMILIES) {
    const bytes = Buffer.from(sampleText[family]), documentId = `sample-${family}`;
    catalog.set(documentId, { bytes, version: '1', scope: 'synthetic', executionStatus: 'synthetic', mediaType: 'text/plain; charset=utf-8' });
    sources.push({ id: `source-${family}`, documentId, version: '1', scope: 'synthetic', executionStatus: 'synthetic', documentSha256: sha256(bytes), locator: 'synthetic paragraph 1', start: 0, end: sampleText[family].length, excerpt: sampleText[family] });
    options.push({ id: `${family}-preferred`, family, position: 'preferred', legalText: sampleText[family], businessReason: 'Illustrates evidence and review controls; this is not proposed contract language.', owner: 'Flex commercial counsel (illustrative)', escalationOwner: 'BU legal lead (illustrative)', escalationTrigger: 'Any deviation from the approved scope or unresolved evidence gap.', reviewStatus: 'reviewed', origin: 'human-draft', sourceRefs: [`source-${family}`], missingFacts: [], conflicts: [], dependencies: family === 'pricing' ? ['notices-preferred'] : [], applicability: { business: 'synthetic-EMS', jurisdiction: 'synthetic', from: '2026-01-01T00:00:00Z', until: '2027-01-01T00:00:00Z' } });
  }
  const book = { schemaVersion: '1.0', id: 'synthetic-ems-playbook', version: '0.1.0', scope: 'synthetic', sources, options };
  const reviewRecords = options.map(option => ({ bookId: book.id, bookVersion: book.version, bookDigest: contentDigest(book), optionId: option.id, reviewer: 'synthetic-reviewer', role: 'legal-reviewer', scope: 'synthetic', status: 'active', reviewedAt: '2026-01-01T00:00:00Z', expiresAt: '2027-01-01T00:00:00Z' }));
  return { book, catalog, reviewRecords, context: { now: '2026-10-11T12:00:00Z', business: 'synthetic-EMS', jurisdiction: 'synthetic' } };
}
