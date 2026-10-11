import test from 'node:test';
import assert from 'node:assert/strict';
import { runPlaybookOperation, PlaybookError } from '../lib/playbooks/service.mjs';
import { sha256, contentDigest } from '../lib/playbooks/kernel.mjs';

const matterId = '11111111-1111-4111-8111-111111111111';
const bookId = '22222222-2222-4222-8222-222222222222';
const documentId = '33333333-3333-4333-8333-333333333333';
const principal = { userId: 'counsel', name: 'Synthetic counsel', demo: false };
const now = '2026-10-11T14:00:00Z';
const originalSha256 = 'a'.repeat(64);

function fixture() {
  const sourceText = 'Synthetic database fixture: notice conditions apply to pricing adjustments.';
  const book = { schemaVersion: '1.0', id: bookId, version: '0.2.0', scope: 'live', sources: [{ id: 's1', documentId, version: 'v1', locator: 'reconstructed plain-text document, paragraph 1', scope: 'live', executionStatus: 'executed', originalSha256, extractionMethod: 'PLAIN_TEXT', documentSha256: sha256(Buffer.from(sourceText)), start: 0, end: sourceText.length, excerpt: sourceText }], options: ['notices', 'pricing'].map(family => ({ id: family, family, position: 'preferred', legalText: 'Illustrative drafting language.', businessReason: 'Illustrative business explanation.', owner: 'Synthetic counsel', escalationOwner: 'Synthetic BU counsel', escalationTrigger: 'Material deviation.', reviewStatus: 'draft', origin: 'human-draft', sourceRefs: ['s1'], missingFacts: [], conflicts: [], dependencies: family === 'pricing' ? ['notices'] : [], applicability: { business: 'fixture-business', jurisdiction: 'fixture-law', from: '2026-01-01T00:00:00Z', until: '2027-01-01T00:00:00Z' } })) };
  const db = new FakeDB(sourceText);
  return { db, book };
}

// Transactional in-memory double, not PostgreSQL. Throws for every unexpected
// query. Tests exercise the actual service but do not certify SQL or SSO.
class FakeDB {
  constructor(sourceText) {
    this.roles = { counsel: 'APPROVER', editor: 'LAWYER', viewer: 'VIEWER', stranger: 'APPROVER' };
    this.members = { counsel: 'APPROVE', editor: 'EDIT', viewer: 'VIEW' };
    this.capabilities = { counsel: true };
    this.matter = { owner_user_id: 'other', restricted: true };
    this.document = { id: documentId, matter_id: matterId, version_label: 'v1', sha256: originalSha256, server_sha256: originalSha256, integrity_status: 'SERVER_VERIFIED', extraction_status: 'EXTRACTED', extraction_method: 'PLAIN_TEXT', source_status: 'EXECUTED', security_scan_status: 'CLEAN', deletion_status: 'ACTIVE' };
    this.chunks = [{ id: 'chunk1', content: sourceText, content_sha256: sha256(Buffer.from(sourceText)), chunk_index: 0, page_number: null }];
    this.events = []; this.queries = []; this.failAction = null;
  }
  async query(sql, values = []) {
    const tag = /pb:(\w+)/.exec(sql)?.[1]; this.queries.push({ tag, sql, values });
    let rows = [];
    if (tag === 'role') rows = this.roles[values[0]] ? [{ role: this.roles[values[0]] }] : [];
    else if (tag === 'matter') rows = values[0] === matterId ? [this.matter] : [];
    else if (tag === 'member') rows = values[0] === matterId && this.members[values[1]] ? [{ access_level: this.members[values[1]] }] : [];
    else if (tag === 'capability') rows = this.capabilities[values[0]] ? [{ '?column?': 1 }] : [];
    else if (tag === 'lock') assert.match(sql, /pg_advisory_xact_lock/);
    else if (tag === 'document') { assert.match(sql, /for share/); rows = values[0] === documentId && values[1] === this.document.matter_id ? [this.document] : []; }
    else if (tag === 'chunks') { assert.match(sql, /for share/); rows = this.chunks; }
    else if (tag === 'events') rows = this.events.filter(e => e.matter_id === values[0] && e.entity_id === values[1]);
    else if (tag === 'append') {
      if (this.failAction === values[2]) throw new Error('Injected persistence failure');
      const event = { id: String(this.events.length + 1), event_time: now, actor_user_id: values[0], action: values[2], matter_id: values[3], entity_id: values[4], metadata: JSON.parse(values[5]) };
      this.events.push(event); rows = [event];
    } else throw new Error(`Unexpected query: ${sql}`);
    return { rows: structuredClone(rows), rowCount: rows.length };
  }
  async transaction(fn) {
    const saved = structuredClone(this.events);
    try { return await fn(this); } catch (error) { this.events = saved; throw error; }
  }
}
const run = (f, input, actor = principal) => f.db.transaction(client => runPlaybookOperation(client, actor, matterId, input, now));
const create = f => run(f, { operation: 'create', book: f.book });
const evaluate = f => run(f, { operation: 'evaluate', bookId, business: 'fixture-business', jurisdiction: 'fixture-law' });
const exportBook = f => run(f, { operation: 'export', bookId, business: 'fixture-business', jurisdiction: 'fixture-law' });
async function review(f, optionId, digest) { return run(f, { operation: 'review', bookId, candidateDigest: digest, optionId, expiresAt: '2026-12-31T00:00:00Z', note: 'Synthetic legal review attestation.' }); }
async function approved() { const f = fixture(), created = await create(f); await review(f, 'notices', created.candidateDigest); await review(f, 'pricing', created.candidateDigest); return f; }

test('complete persisted create -> review -> export -> revoke workflow', async () => {
  const f = fixture(), created = await create(f);
  assert.equal(created.status, 'draft'); assert.notEqual(created.draftDigest, created.candidateDigest);
  assert.ok((await evaluate(f)).options.every(option => option.status === 'blocked'));
  const reviewed = await review(f, 'notices', created.candidateDigest);
  await review(f, 'pricing', created.candidateDigest);
  const out = await exportBook(f); assert.equal(out.actionAuthority, 'none'); assert.equal(out.hostEvidence[0].originalFileSha256, originalSha256);
  assert.equal(out.reviewReceipt.reviewEventIds.length, 2);
  await run(f, { operation: 'revoke', bookId, reviewEventId: reviewed.reviewEventId, note: 'Synthetic legal review withdrawal.' });
  await assert.rejects(exportBook(f), /Export blocked/);
  const result = await evaluate(f); assert.ok(result.options.find(option => option.optionId === 'pricing').reasons.includes('blocked_dependency'));
  assert.deepEqual(f.db.events.map(event => event.action), ['PLAYBOOK_CREATED','PLAYBOOK_REVIEWED','PLAYBOOK_REVIEWED','PLAYBOOK_EXPORTED','PLAYBOOK_REVIEW_REVOKED']);
});
test('viewer cannot create or review; demo cannot access persistent service', async () => {
  const f = fixture(); await assert.rejects(run(f, { operation: 'create', book: f.book }, { ...principal, userId: 'viewer' }), /authority/);
  await assert.rejects(run(f, { operation: 'create', book: f.book }, { ...principal, demo: true }), /identity/); assert.equal(f.db.events.length, 0);
});
test('cross-matter access and foreign sources fail closed', async () => {
  const f = fixture(); await assert.rejects(run(f, { operation: 'create', book: f.book }, { ...principal, userId: 'stranger' }), /authority/);
  f.db.document.matter_id = '44444444-4444-4444-8444-444444444444'; await assert.rejects(create(f), /unavailable/);
});
test('legal capability required when recording review', async () => { const f = fixture(), c = await create(f); f.db.capabilities.counsel = false; await assert.rejects(review(f, 'notices', c.candidateDigest), /authority/); assert.equal(f.db.events.length, 1); });
test('loss of reviewer capability or matter permission invalidates existing reviews', async () => {
  for (const revoke of [f => f.db.capabilities.counsel = false, f => f.db.members.counsel = 'VIEW', f => f.db.roles.counsel = 'LAWYER']) {
    const f = await approved(); revoke(f);
    assert.ok((await evaluate(f)).options.every(option => option.status === 'blocked'));
  }
});
test('client review fields and timestamps cannot enter create operation', async () => { const f = fixture(); await assert.rejects(run(f, { operation: 'create', book: f.book, reviewer: 'admin', now }), /Unsupported request/); f.book.options[0].reviewStatus = 'reviewed'; await assert.rejects(create(f), /drafts/); });
test('stale digest, impossible expiry, and duplicates reject', async () => {
  const f = fixture(), c = await create(f);
  await assert.rejects(review(f, 'notices', 'b'.repeat(64)), /Stale/);
  await assert.rejects(run(f, { operation: 'review', bookId, candidateDigest: c.candidateDigest, optionId: 'notices', expiresAt: '2026-02-30T00:00:00Z', note: 'Synthetic legal review.' }), /expiry/);
  await review(f, 'notices', c.candidateDigest); await assert.rejects(review(f, 'notices', c.candidateDigest), /already exists/);
  await assert.rejects(create(f), /already exists/);
});
test('source hash, security, deletion, status, and raw DOCX block before persistence', async () => {
  for (const mutate of [f => f.db.document.server_sha256 = 'b'.repeat(64), f => f.db.document.extraction_method = 'DOCX_RAW_TEXT', f => f.db.document.security_scan_status = 'QUARANTINED', f => f.db.document.deletion_status = 'PURGED', f => f.db.document.source_status = 'DRAFT', f => f.db.chunks[0].content += ' tampering']) {
    const f = fixture(); mutate(f); await assert.rejects(create(f)); assert.equal(f.db.events.length, 0);
  }
});
test('source version or extraction changes invalidate prior approved export', async () => { const f = await approved(); f.db.document.version_label = 'v2'; await assert.rejects(exportBook(f), /metadata mismatch/); });
test('unresolved facts cannot receive review', async () => { const f = fixture(); f.book.options[0].conflicts.push('Precedence unresolved'); const c = await create(f); await assert.rejects(review(f, 'notices', c.candidateDigest), /unresolved/); });
test('revocation is append-only, cannot be repeated, and permits new review', async () => {
  const f = fixture(), c = await create(f), r = await review(f, 'notices', c.candidateDigest);
  const request = { operation: 'revoke', bookId, reviewEventId: r.reviewEventId, note: 'Synthetic withdrawal of review.' };
  await run(f, request); await assert.rejects(run(f, request), /unavailable/);
  await review(f, 'notices', c.candidateDigest); await review(f, 'pricing', c.candidateDigest); assert.equal((await exportBook(f)).reviewReceipt.reviewEventIds.length, 2);
  assert.ok(!f.db.queries.some(q => /\b(update|delete)\s+(?:from\s+)?audit_events/i.test(q.sql)));
});
test('failed audit insertion aborts export and leaves no success event', async () => { const f = await approved(); const n = f.db.events.length; f.db.failAction = 'PLAYBOOK_EXPORTED'; await assert.rejects(exportBook(f), /persistence failure/); assert.equal(f.db.events.length, n); });
test('stored draft tampering is detected', async () => { const f = await approved(); f.db.events[0].metadata.book.options[0].legalText = 'Changed'; await assert.rejects(exportBook(f), /integrity failure/); });
test('reviewer identity and source metadata are server-resolved', async () => { const f = await approved(); const r = f.db.events.find(e => e.action === 'PLAYBOOK_REVIEWED'); assert.equal(r.actor_user_id, 'counsel'); assert.equal(r.metadata.reviewer, undefined); assert.ok(f.db.queries.some(q => q.tag === 'capability')); assert.ok(f.db.queries.some(q => q.tag === 'lock')); });
test('request and applicability guards fail closed', async () => { const f = fixture(); f.book.options[0].legalText = 'x'.repeat(132000); await assert.rejects(create(f), /limit/); const g = await approved(); await assert.rejects(run(g, { operation: 'export', bookId, business: 'wrong', jurisdiction: 'fixture-law' }), /Export blocked/); });
test('explicit VIEW membership overrides global legal EDIT access', async () => { const f = fixture(); f.db.matter.restricted = false; f.db.roles.counsel = 'LAWYER'; f.db.members.counsel = 'VIEW'; await assert.rejects(create(f), /authority/); assert.equal(f.db.events.length, 0); });
