import test, { before, after } from 'node:test';
import assert from 'node:assert/strict';
import { readFile, mkdtemp } from 'node:fs/promises';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { randomUUID, randomBytes } from 'node:crypto';
import { createRequire } from 'node:module';
import { runPlaybookOperation } from '../lib/playbooks/service.mjs';
import { sha256 } from '../lib/playbooks/kernel.mjs';

// Actual service SQL under a non-superuser session, using PGlite 0.3.14
// or a guarded disposable native PostgreSQL 17 cluster. Native mode adds
// multi-backend checks. Neither mode proves TLS, SSO, or the full migration chain.
const native = Boolean(process.env.PLAYBOOK_TEST_OWNER_DATABASE_URL);
let PGlite, Pool, ownerUrl;
const runtimePassword = randomBytes(32).toString('hex');
if (native) {
  ownerUrl = new URL(process.env.PLAYBOOK_TEST_OWNER_DATABASE_URL);
  if (!['postgres:', 'postgresql:'].includes(ownerUrl.protocol) ||
      !['localhost', '127.0.0.1', '[::1]'].includes(ownerUrl.hostname) ||
      ownerUrl.pathname !== '/contracttwin_playbook_test' || ownerUrl.search || ownerUrl.hash) {
    throw new Error('Native checks require a disposable loopback database named contracttwin_playbook_test, without URL options.');
  }
  ({ Pool } = createRequire(import.meta.url)('pg'));
} else {
  if (!process.env.PGLITE_MODULE) throw new Error('Set PGLITE_MODULE to PGlite 0.3.14 dist/index.js or PLAYBOOK_TEST_OWNER_DATABASE_URL to a disposable native database.');
  ({ PGlite } = await import(pathToFileURL(process.env.PGLITE_MODULE).href));
}
const matterId = '11111111-1111-4111-8111-111111111111';
const foreignMatterId = '44444444-4444-4444-8444-444444444444';
const documentId = '33333333-3333-4333-8333-333333333333';
const principal = { userId: 'fixture-counsel', name: 'Synthetic legal reviewer', demo: false };
const originalSha256 = 'a'.repeat(64);
const sourceText = 'Synthetic database fixture: verified notice conditions govern price changes.';
let db, dataDir;

function extractStatement(sql, pattern, label) {
  const statement = sql.match(pattern)?.[0];
  assert.ok(statement, `Pinned schema statement missing: ${label}`);
  return statement;
}
async function openAs(username) {
  if (db) await db.close();
  if (native) {
    const url = new URL(ownerUrl);
    if (username !== 'postgres') { url.username = username; url.password = runtimePassword; }
    const pool = new Pool({ connectionString: url.href, max: 4, connectionTimeoutMillis: 5000, statement_timeout: 15000 });
    db = { pool, query: (sql, values) => pool.query(sql, values), exec: sql => pool.query(sql), close: () => pool.end(),
      transaction: async fn => {
        const client = await pool.connect();
        try { await client.query('begin'); const result = await fn(client); await client.query('commit'); return result; }
        catch (error) { await client.query('rollback'); throw error; }
        finally { client.release(); }
      } };
  } else {
    db = new PGlite(dataDir, { username });
    await db.waitReady;
  }
}
const adapt = tx => ({ query: async (sql, values = []) => {
  const result = await tx.query(sql, values);
  return { rows: result.rows, rowCount: result.rowCount ?? (result.rows.length || result.affectedRows || 0) };
} });
const operate = (input, actor = principal, clock) => db.transaction(tx => runPlaybookOperation(adapt(tx), actor, matterId, input, clock));
function book(id = randomUUID()) {
  return { schemaVersion: '1.0', id, version: '0.3-test', scope: 'live', sources: [{ id: 'source-notice', documentId, version: 'v1', locator: 'synthetic source paragraph 1', scope: 'live', executionStatus: 'executed', originalSha256, extractionMethod: 'PLAIN_TEXT', documentSha256: sha256(Buffer.from(sourceText)), start: 0, end: sourceText.length, excerpt: sourceText }], options: ['notices','pricing'].map(family => ({ id: family, family, position: 'preferred', legalText: 'Illustrative drafting language; not approved Flex policy.', businessReason: 'Synthetic test explanation.', owner: 'Synthetic counsel', escalationOwner: 'Synthetic legal lead', escalationTrigger: 'Any material deviation.', reviewStatus: 'draft', origin: 'human-draft', sourceRefs: ['source-notice'], missingFacts: [], conflicts: [], dependencies: family === 'pricing' ? ['notices'] : [], applicability: { business: 'fixture-business', jurisdiction: 'fixture-law', from: '2020-01-01T00:00:00Z', until: '2099-01-01T00:00:00Z' } })) };
}
const evaluationInput = id => ({ operation: 'evaluate', bookId: id, business: 'fixture-business', jurisdiction: 'fixture-law' });
const exportInput = id => ({ ...evaluationInput(id), operation: 'export' });
const reviewInput = (created, optionId) => ({ operation: 'review', bookId: created.bookId, candidateDigest: created.candidateDigest, optionId, expiresAt: new Date(Date.now() + 300000).toISOString(), note: 'Synthetic legal review for database acceptance.' });
async function ready() {
  const draft = book(), created = await operate({ operation: 'create', book: draft });
  const notice = await operate(reviewInput(created, 'notices'));
  const pricing = await operate(reviewInput(created, 'pricing'));
  return { draft, created, notice, pricing };
}
async function count(id, action) {
  return Number((await db.query('select count(*)::int n from audit_events where entity_id=$1 and action=$2', [id, action])).rows[0].n);
}

before(async () => {
  dataDir = await mkdtemp(join('/tmp', 'contracttwin-playbook-postgres-'));
  await openAs('postgres');
  if (native) {
    const role = (await db.query('select rolsuper from pg_roles where rolname=current_user')).rows[0];
    const occupied = (await db.query(`select count(*)::int n from pg_class c join pg_namespace n on n.oid=c.relnamespace where n.nspname='public'`)).rows[0].n;
    const existingRole = (await db.query("select count(*)::int n from pg_roles where rolname='playbook_runtime'")).rows[0].n;
    assert.equal(role.rolsuper, true, 'Disposable fixture owner must be a superuser');
    assert.equal(occupied, 0, 'Refusing a nonempty native database');
    assert.equal(existingRole, 0, 'Refusing an existing runtime role; use a disposable PostgreSQL cluster');
  }
  const base = await readFile(new URL('../db/migrations/001_app.sql', import.meta.url), 'utf8');
  // PGlite does not bundle pgcrypto; remove its extension declaration only.
  // gen_random_uuid() is built in to PostgreSQL 17. Other migration 001 SQL is
  // executed unchanged, including the actual audit immutability trigger.
  await db.exec(native ? base : base.replace('create extension if not exists pgcrypto;', ''));
  const governance = await readFile(new URL('../db/migrations/003_records_governance.sql', import.meta.url), 'utf8');
  const source = await readFile(new URL('../db/migrations/006_source_and_run_hardening.sql', import.meta.url), 'utf8');
  const capability = await readFile(new URL('../db/migrations/008_analysis_review_attestations.sql', import.meta.url), 'utf8');
  await db.exec(extractStatement(governance, /alter table documents[\s\S]*?;/, 'document governance columns'));
  await db.exec(extractStatement(source, /alter table documents[\s\S]*?;/, 'document security columns'));
  await db.exec(extractStatement(capability, /create table if not exists app_user_capabilities \([\s\S]*?\n\);/, 'counsel capability table'));
  await db.exec(`create role playbook_runtime login nosuperuser nocreatedb nocreaterole noinherit noreplication nobypassrls;
    grant usage on schema public to playbook_runtime;
    revoke create on schema public from public,playbook_runtime;
    grant select,insert,update,delete on all tables in schema public to playbook_runtime;
    revoke truncate,references,trigger,maintain on all tables in schema public from public,playbook_runtime;
    grant usage,select on all sequences in schema public to playbook_runtime;
    revoke update on all sequences in schema public from public,playbook_runtime;`);
  if (native) await db.exec(`alter role playbook_runtime password '${runtimePassword}'`);
  await db.query("insert into app_user_roles(user_id,role,active) values('fixture-counsel','APPROVER',true),('fixture-viewer','VIEWER',true),('fixture-stranger','APPROVER',true)");
  const customer = (await db.query("insert into customers(name) values('Synthetic customer') returning id")).rows[0].id;
  for (const [id, number] of [[matterId,'SYNTHETIC-1'],[foreignMatterId,'SYNTHETIC-2']]) {
    await db.query("insert into matters(id,matter_number,customer_id,agreement_title,region,owner_user_id,restricted) values($1,$2,$3,'Synthetic test agreement','TEST','fixture-owner',true)", [id,number,customer]);
  }
  await db.query("insert into matter_members(matter_id,user_id,access_level,granted_by) values($1,'fixture-counsel','APPROVE','test-owner'),($1,'fixture-viewer','VIEW','test-owner')", [matterId]);
  await db.query("insert into app_user_capabilities(user_id,capability,active,granted_by) values('fixture-counsel','LEGAL_COUNSEL_ATTEST',true,'test-owner')");
  await db.query(`insert into documents(id,matter_id,filename,document_type,version_label,mime_type,size_bytes,blob_url,blob_pathname,sha256,server_sha256,integrity_status,extraction_status,extraction_method,source_status,security_scan_status,uploaded_by)
    values($1,$2,'synthetic.txt','OTHER','v1','text/plain',100,'fixture://not-a-live-file','synthetic.txt',$3,$3,'SERVER_VERIFIED','EXTRACTED','PLAIN_TEXT','EXECUTED','CLEAN','test-owner')`, [documentId,matterId,originalSha256]);
  await db.query('insert into document_chunks(document_id,matter_id,chunk_index,content,content_sha256) values($1,$2,0,$3,$4)', [documentId,matterId,sourceText,sha256(Buffer.from(sourceText))]);
  await openAs('playbook_runtime');
  console.log(JSON.stringify({ engine: (await db.query('select version() v')).rows[0].v, schemaScope: 'migration 001 (pgcrypto declaration omitted in WASM); exact selected column/table fragments from 003,006,008', database: 'disposable disk-backed synthetic fixture', nativeMultiBackend: native, liveSSO: false }));
});
after(async () => { if (db) await db.close(); });

test('actual non-superuser PostgreSQL session cannot alter audit schema or create roles', async () => {
  const identity = (await db.query('select current_user,session_user,rolsuper,rolcreatedb,rolcreaterole,rolbypassrls from pg_roles where rolname=current_user')).rows[0];
  assert.equal(identity.current_user, 'playbook_runtime'); assert.equal(identity.session_user, 'playbook_runtime');
  for (const flag of ['rolsuper','rolcreatedb','rolcreaterole','rolbypassrls']) assert.equal(identity[flag], false);
  await assert.rejects(db.exec('alter table audit_events disable trigger audit_events_no_update'), error => error.code === '42501');
  await assert.rejects(db.exec('create role prohibited_escalation'), error => error.code === '42501');
});
test('actual SQL create/review/export writes attributable append-only records', async () => {
  const r = await ready(), out = await operate(exportInput(r.created.bookId));
  assert.equal(out.actionAuthority, 'none'); assert.equal(out.reviewReceipt.reviewEventIds.length, 2);
  assert.equal(out.hostEvidence[0].originalFileSha256, originalSha256);
  const stored = (await db.query('select actor_user_id,metadata,event_time from audit_events where id=$1', [r.notice.reviewEventId])).rows[0];
  assert.equal(stored.actor_user_id, principal.userId); assert.equal(stored.metadata.candidateDigest, r.created.candidateDigest);
  assert.ok(Number.isFinite(new Date(stored.event_time).getTime()));
  assert.equal(await count(r.created.bookId,'PLAYBOOK_EXPORTED'), 1);
});
test('actual database trigger prevents audit update and deletion', async () => {
  const r = await ready();
  for (const sql of ['update audit_events set actor_name=\'tampered\' where id=$1','delete from audit_events where id=$1']) {
    await assert.rejects(db.query(sql,[r.notice.reviewEventId]), error => error.code === 'P0001' && /append-only/.test(error.message));
  }
  assert.equal(await count(r.created.bookId,'PLAYBOOK_REVIEWED'), 2);
});
test('actual transaction rollback removes a successfully inserted review', async () => {
  const created = await operate({ operation: 'create', book: book() });
  await assert.rejects(db.transaction(async tx => { await runPlaybookOperation(adapt(tx),principal,matterId,reviewInput(created,'notices')); throw new Error('Injected failure after successful INSERT'); }), /Injected failure/);
  assert.equal(await count(created.bookId,'PLAYBOOK_REVIEWED'), 0);
  assert.ok((await operate(evaluationInput(created.bookId))).options.every(option => option.status === 'blocked'));
  await operate(reviewInput(created,'notices')); assert.equal(await count(created.bookId,'PLAYBOOK_REVIEWED'), 1);
});
test('missing audit INSERT permission prevents export without a success receipt', async () => {
  const r = await ready();
  await openAs('postgres'); await db.exec('revoke insert on audit_events from playbook_runtime'); await openAs('playbook_runtime');
  try { await assert.rejects(operate(exportInput(r.created.bookId)), error => error.code === '42501'); assert.equal(await count(r.created.bookId,'PLAYBOOK_EXPORTED'), 0); }
  finally { await openAs('postgres'); await db.exec('grant insert on audit_events to playbook_runtime'); await openAs('playbook_runtime'); }
  assert.equal((await operate(exportInput(r.created.bookId))).actionAuthority, 'none');
});
test('SQL capability revocation invalidates previously recorded reviews', async () => {
  const r = await ready(); await db.query("update app_user_capabilities set active=false where user_id=$1",[principal.userId]);
  try { await assert.rejects(operate(exportInput(r.created.bookId)), /Export blocked/); assert.ok((await operate(evaluationInput(r.created.bookId))).options.every(option => option.status === 'blocked')); }
  finally { await db.query("update app_user_capabilities set active=true where user_id=$1",[principal.userId]); }
});
test('explicit SQL VIEW membership denies editing on an unrestricted matter', async () => {
  await db.query('update matters set restricted=false where id=$1',[matterId]); await db.query("update matter_members set access_level='VIEW' where matter_id=$1 and user_id=$2",[matterId,principal.userId]);
  try { await assert.rejects(operate({ operation:'create',book:book() }), /authority/); }
  finally { await db.query('update matters set restricted=true where id=$1',[matterId]); await db.query("update matter_members set access_level='APPROVE' where matter_id=$1 and user_id=$2",[matterId,principal.userId]); }
});
test('actual SQL source tampering blocks a reviewed export', async () => {
  const r = await ready(); await db.query("update document_chunks set content=content||' tampered' where document_id=$1",[documentId]);
  try { await assert.rejects(operate(exportInput(r.created.bookId)), /chunk integrity/); }
  finally { await db.query('update document_chunks set content=$2 where document_id=$1',[documentId,sourceText]); }
});
test('review revocation persists across engine close and reopen', async () => {
  const r = await ready(); await operate({ operation:'revoke',bookId:r.created.bookId,reviewEventId:r.notice.reviewEventId,note:'Synthetic withdrawal of legal review.' });
  const before = await count(r.created.bookId,'PLAYBOOK_REVIEW_REVOKED'); await openAs('playbook_runtime');
  assert.equal(await count(r.created.bookId,'PLAYBOOK_REVIEW_REVOKED'),before); assert.equal(before,1);
  await assert.rejects(operate(exportInput(r.created.bookId)), /Export blocked/);
  assert.ok((await operate(evaluationInput(r.created.bookId))).options.find(option => option.optionId==='pricing').reasons.includes('blocked_dependency'));
});
test('PostgreSQL JSONB roundtrip preserves review digests and parameterized notes', async () => {
  const draft=book(),created=await operate({operation:'create',book:draft});
  const input=reviewInput(created,'notices');input.note="Synthetic review: 'quoted' text; select 1; remains inert data.";
  const receipt=await operate(input);
  const stored=(await db.query('select metadata from audit_events where id=$1',[receipt.reviewEventId])).rows[0].metadata;
  assert.equal(stored.note,input.note); assert.equal(stored.candidateDigest,created.candidateDigest);
  await operate(reviewInput(created,'pricing'));assert.equal((await operate(exportInput(created.bookId))).actionAuthority,'none');
});
test('expiry after persisted review blocks export under a controlled future clock', async () => {
  const r=await ready();const future=new Date(Date.now()+600000).toISOString();
  await assert.rejects(operate(exportInput(r.created.bookId),principal,future), /Export blocked/);
});
test('actual SQL data lookup denies cross-matter document references', async () => {
  await db.query('update documents set matter_id=$2 where id=$1',[documentId,foreignMatterId]);
  try {await assert.rejects(operate({operation:'create',book:book()}), /unavailable or access denied/);}
  finally {await db.query('update documents set matter_id=$2 where id=$1',[documentId,matterId]);}
});

// These checks deliberately require separate native backend connections.
// PGlite's single backend cannot establish advisory/row lock ordering.
async function waitForLock(pid) {
  const deadline = Date.now() + 4000;
  while (Date.now() < deadline) {
    const state = (await db.query('select wait_event_type from pg_stat_activity where pid=$1', [pid])).rows[0];
    if (state?.wait_event_type === 'Lock') return;
    await new Promise(resolve => setTimeout(resolve, 50));
  }
  assert.fail('Second native backend did not enter a PostgreSQL lock wait');
}
test('native backends serialize export before revocation and deny later export', { skip: !native }, async () => {
  const r = await ready(), first = await db.pool.connect(), second = await db.pool.connect();
  let pending;
  try {
    await first.query('begin'); await second.query('begin');
    const exported = await runPlaybookOperation(adapt(first), principal, matterId, exportInput(r.created.bookId));
    assert.equal(exported.actionAuthority, 'none');
    pending = runPlaybookOperation(adapt(second), principal, matterId, { operation: 'revoke', bookId: r.created.bookId, reviewEventId: r.notice.reviewEventId, note: 'Synthetic concurrent revocation test.' }).then(value => ({ value }), error => ({ error }));
    await waitForLock(second.processID);
    await first.query('commit');
    const result = await pending; if (result.error) throw result.error;
    await second.query('commit');
    await assert.rejects(operate(exportInput(r.created.bookId)));
  } finally {
    await first.query('rollback'); await second.query('rollback');
    if (pending) await pending;
    first.release(); second.release();
  }
});
test('native source row locks delay mutation until export commits', { skip: !native }, async () => {
  const r = await ready(), first = await db.pool.connect(), second = await db.pool.connect();
  let pending;
  try {
    await first.query('begin'); await second.query('begin');
    await runPlaybookOperation(adapt(first), principal, matterId, exportInput(r.created.bookId));
    pending = second.query('update document_chunks set content=$1 where document_id=$2', ['Synthetic concurrent tampering', documentId]).then(value => ({ value }), error => ({ error }));
    await waitForLock(second.processID);
    await first.query('commit');
    const result = await pending; if (result.error) throw result.error;
    await second.query('commit');
    await assert.rejects(operate(exportInput(r.created.bookId)));
  } finally {
    await first.query('rollback'); await second.query('rollback');
    if (pending) await pending;
    first.release(); second.release();
    await db.query('update document_chunks set content=$1 where document_id=$2', [sourceText, documentId]);
  }
});
