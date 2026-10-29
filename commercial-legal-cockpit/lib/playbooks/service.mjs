import { validatePlaybook, contentDigest, sha256, evaluatePlaybook, exportReviewedPlaybook } from './kernel.mjs';

const UUID = /^[0-9a-f]{8}-(?:[0-9a-f]{4}-){3}[0-9a-f]{12}$/i;
const rank = { VIEWER: 10, LAWYER: 20, APPROVER: 30, ADMIN: 40 };
const levels = { VIEW: 10, EDIT: 20, APPROVE: 30 };
export class PlaybookError extends Error { constructor(message, status = 400) { super(message); this.status = status; } }
const check = (condition, message, status = 400) => { if (!condition) throw new PlaybookError(message, status); };
const nonblank = value => typeof value === 'string' && value.trim().length > 0;
const validTime = value => typeof value === 'string' && /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{3})?Z$/.test(value) && Number.isFinite(Date.parse(value)) && new Date(value).toISOString() === (value.includes('.') ? value : value.replace('Z', '.000Z'));
function checkedBook(book, catalog, status) {
  try { return validatePlaybook(book, catalog); }
  catch (error) { throw new PlaybookError(error.message, status); }
}

// All calls run inside the host's withTransaction. Recheck authority under row
// locks rather than relying solely on the earlier HTTP access check.
export async function checkAuthority(client, userId, matterId, level, counsel = false) {
  const role = (await client.query('/* pb:role */ select role from app_user_roles where user_id=$1 and active=true for share', [userId])).rows[0]?.role;
  const matter = (await client.query('/* pb:matter */ select owner_user_id,restricted from matters where id=$1 for share', [matterId])).rows[0];
  const member = (await client.query('/* pb:member */ select access_level from matter_members where matter_id=$1 and user_id=$2 for share', [matterId, userId])).rows[0]?.access_level;
  const minimum = level === 'APPROVE' ? 30 : level === 'EDIT' ? 20 : 10;
  if (!matter || !(rank[role] >= minimum)) return false;
  // An explicit lower membership is a denial, even on an unrestricted matter.
  // Match access.ts: global legal access applies only when no membership exists.
  const scopeOK = role === 'ADMIN' || matter.owner_user_id === userId || (member !== undefined ? levels[member] >= levels[level] : level !== 'APPROVE' && !matter.restricted && rank[role] >= 20);
  if (!scopeOK) return false;
  if (counsel) {
    const capability = await client.query("/* pb:capability */ select 1 from app_user_capabilities where user_id=$1 and capability='LEGAL_COUNSEL_ATTEST' and active=true for share", [userId]);
    if (capability.rowCount !== 1) return false;
  }
  return true;
}

export async function loadCatalog(client, matterId, book) {
  check(Array.isArray(book?.sources), 'Sources required.');
  const catalog = new Map(), evidence = [];
  for (const source of book.sources) {
    check(source && UUID.test(source.documentId), 'A source document UUID is required.');
    if (catalog.has(source.documentId)) continue;
    const doc = (await client.query(`/* pb:document */ select id,matter_id,version_label,sha256,server_sha256,integrity_status,extraction_status,extraction_method,source_status,security_scan_status,deletion_status
      from documents where id=$1 and matter_id=$2 for share`, [source.documentId, matterId])).rows[0];
    check(doc, 'Source unavailable or access denied.', 404);
    check(doc.integrity_status === 'SERVER_VERIFIED' && /^[a-f0-9]{64}$/i.test(doc.sha256 ?? '') && doc.sha256.toLowerCase() === doc.server_sha256?.toLowerCase(), 'Server-verified source integrity required.', 409);
    check(doc.extraction_status === 'EXTRACTED' && doc.extraction_method === 'PLAIN_TEXT' && doc.security_scan_status === 'CLEAN' && doc.deletion_status === 'ACTIVE', 'Only clean, active, verified plain-text extraction is supported.', 409);
    check(doc.source_status === 'EXECUTED' && nonblank(doc.version_label), 'Executed source with an explicit version label required.', 409);
    const chunks = (await client.query('/* pb:chunks */ select id,content,content_sha256,chunk_index,page_number from document_chunks where document_id=$1 and matter_id=$2 order by chunk_index,id for share', [doc.id, matterId])).rows;
    check(chunks.length > 0 && chunks.every(chunk => typeof chunk.content === 'string' && sha256(Buffer.from(chunk.content, 'utf8')) === chunk.content_sha256?.toLowerCase()), 'Source chunk integrity required.', 409);
    check(new Set(chunks.map(chunk => chunk.chunk_index)).size === chunks.length && chunks.every((chunk, index) => chunk.chunk_index === index), 'Plain-text chunks must have contiguous unique indices.', 409);
    const bytes = Buffer.from(chunks.map(chunk => chunk.content).join('\n'), 'utf8');
    check(bytes.length <= 1_000_000, 'Source text exceeds trial limit.');
    const record = { bytes, version: doc.version_label, scope: 'live', executionStatus: 'executed', mediaType: 'text/plain; charset=utf-8', originalSha256: doc.sha256.toLowerCase(), extractionMethod: doc.extraction_method };
    catalog.set(doc.id, record);
    evidence.push({ documentId: doc.id, originalFileSha256: record.originalSha256, derivedTextSha256: sha256(bytes), extractionMethod: record.extractionMethod, version: record.version, chunks: chunks.map(chunk => ({ id: chunk.id, sha256: chunk.content_sha256, index: chunk.chunk_index })) });
  }
  for (const source of book.sources) check(source.originalSha256 === catalog.get(source.documentId)?.originalSha256 && source.extractionMethod === 'PLAIN_TEXT', 'Original file hash and extraction method must be pinned.', 409);
  return { catalog, evidence };
}

const candidate = book => { const copy = structuredClone(book); copy.options.forEach(option => option.reviewStatus = 'reviewed'); return copy; };
async function append(client, principal, matterId, bookId, action, metadata) {
  const result = await client.query(`/* pb:append */ insert into audit_events(actor_user_id,actor_name,action,matter_id,entity_type,entity_id,metadata,event_time)
    values($1,$2,$3,$4,'playbook',$5,$6::jsonb,clock_timestamp()) returning id::text,event_time`, [principal.userId, principal.name, action, matterId, bookId, JSON.stringify(metadata)]);
  return result.rows[0];
}
async function events(client, matterId, bookId) {
  return (await client.query(`/* pb:events */ select id::text,event_time,actor_user_id,action,metadata from audit_events
    where matter_id=$1 and entity_type='playbook' and entity_id=$2 and action in ('PLAYBOOK_CREATED','PLAYBOOK_REVIEWED','PLAYBOOK_REVIEW_REVOKED','PLAYBOOK_EXPORTED') order by id`, [matterId, bookId])).rows;
}
function registry(stream, book, now) {
  const revoked = new Set(stream.filter(event => event.action === 'PLAYBOOK_REVIEW_REVOKED').map(event => event.metadata.reviewEventId));
  return stream.filter(event => event.action === 'PLAYBOOK_REVIEWED').map(event => ({
    eventId: event.id, actor: event.actor_user_id, record: {
      bookId: book.id, bookVersion: book.version, bookDigest: event.metadata.candidateDigest, optionId: event.metadata.optionId,
      reviewer: event.actor_user_id, role: 'legal-reviewer', scope: 'live', status: revoked.has(event.id) || Date.parse(event.metadata.expiresAt) <= Date.parse(now) ? 'revoked' : 'active', reviewedAt: new Date(event.event_time).toISOString(), expiresAt: event.metadata.expiresAt,
    }
  }));
}

export async function runPlaybookOperation(client, principal, matterId, input, now) {
  const providedNow = now; // Tests may supply a clock; the HTTP route never does.
  check(principal && !principal.demo && nonblank(principal.userId), 'Authenticated identity required.', 403);
  check(UUID.test(matterId) && input && typeof input === 'object' && !Array.isArray(input), 'Valid matter and request required.');
  check(now === undefined || validTime(now), 'Valid server time required.');
  const operation = input.operation;
  check(['create', 'review', 'revoke', 'evaluate', 'export'].includes(operation), 'Unsupported operation.');
  const allowed = { create: ['operation','book'], review: ['operation','bookId','candidateDigest','optionId','expiresAt','note'], revoke: ['operation','bookId','reviewEventId','note'], evaluate: ['operation','bookId','business','jurisdiction'], export: ['operation','bookId','business','jurisdiction'] };
  check(Object.keys(input).every(key => allowed[operation].includes(key)), 'Unsupported request field.');
  check(Buffer.byteLength(JSON.stringify(input)) <= 131072, 'Request exceeds 128 KiB trial limit.');
  const bookId = operation === 'create' ? input.book?.id : input.bookId;
  check(UUID.test(bookId ?? ''), 'Playbook UUID required.');
  const level = operation === 'evaluate' ? 'VIEW' : operation === 'create' ? 'EDIT' : 'APPROVE';
  check(await checkAuthority(client, principal.userId, matterId, level, ['review','revoke'].includes(operation)), 'Current role, matter access, and legal authority required.', 403);
  // Serialize all registry transitions for this matter. Export and revocation
  // cannot concurrently observe different local registry states.
  await client.query('/* pb:lock */ select pg_advisory_xact_lock(hashtextextended($1,0))', [`playbook:${matterId}`]);
  now ??= new Date().toISOString();
  const stream = await events(client, matterId, bookId);
  if (operation === 'create') {
    check(!stream.some(event => event.action === 'PLAYBOOK_CREATED'), 'Immutable playbook identity already exists; create a new UUID for a revision.', 409);
    const book = input.book;
    check(book.scope === 'live' && book.options?.length > 0 && book.options.length <= 64 && book.sources?.length <= 32, 'Live host evidence required; maximum 64 options and 32 references.');
    check(book.options.every(option => option?.reviewStatus === 'draft'), 'Uploaded options must enter as drafts.');
    const { catalog } = await loadCatalog(client, matterId, book);
    checkedBook(book, catalog, 400);
    const draftDigest = contentDigest(book), candidateDigest = contentDigest(candidate(book));
    const event = await append(client, principal, matterId, bookId, 'PLAYBOOK_CREATED', { book, draftDigest, candidateDigest });
    return { bookId, draftDigest, candidateDigest, eventId: event.id, status: 'draft', actionAuthority: 'none' };
  }
  const created = stream.filter(event => event.action === 'PLAYBOOK_CREATED');
  check(created.length === 1, 'Playbook unavailable or invalid event history.', 404);
  const book = created[0].metadata.book;
  check(contentDigest(book) === created[0].metadata.draftDigest, 'Stored draft integrity failure.', 409);
  const normalized = candidate(book), digest = contentDigest(normalized);
  check(digest === created[0].metadata.candidateDigest, 'Candidate integrity failure.', 409);
  const { catalog, evidence } = await loadCatalog(client, matterId, book);
  checkedBook(book, catalog, 409);
  now = providedNow ?? new Date().toISOString();
  const records = registry(stream, book, now);
  if (operation === 'review') {
    check(input.candidateDigest === digest, 'Stale review candidate.', 409);
    const option = book.options.find(option => option.id === input.optionId);
    check(option && !option.missingFacts.length && !option.conflicts.length, 'Option has unresolved facts or conflicts.', 409);
    check(Date.parse(now) >= Date.parse(option.applicability.from) && Date.parse(now) < Date.parse(option.applicability.until), 'Option is outside its effective period.', 409);
    check(validTime(input.expiresAt) && Date.parse(input.expiresAt) > Date.parse(now) && Date.parse(input.expiresAt) <= Date.parse(option.applicability.until), 'Review expiry must be valid and within applicability.');
    check(nonblank(input.note) && input.note.trim().length >= 12, 'Substantive legal review note required.');
    check(!records.some(row => row.record.optionId === option.id && row.record.status === 'active'), 'Active review already exists; revoke it before replacement.', 409);
    const event = await append(client, principal, matterId, bookId, 'PLAYBOOK_REVIEWED', { optionId: option.id, candidateDigest: digest, expiresAt: input.expiresAt, note: input.note.trim() });
    return { bookId, optionId: option.id, reviewEventId: event.id, actionAuthority: 'none' };
  }
  if (operation === 'revoke') {
    check(typeof input.reviewEventId === 'string' && /^\d+$/.test(input.reviewEventId), 'Review event ID required.');
    check(nonblank(input.note) && input.note.trim().length >= 12, 'Substantive revocation note required.');
    const review = records.find(row => row.eventId === input.reviewEventId);
    check(review && review.record.status === 'active', 'Active review unavailable.', 409);
    const event = await append(client, principal, matterId, bookId, 'PLAYBOOK_REVIEW_REVOKED', { reviewEventId: input.reviewEventId, note: input.note.trim() });
    return { bookId, revokedReviewEventId: input.reviewEventId, eventId: event.id, actionAuthority: 'none' };
  }
  check(nonblank(input.business) && nonblank(input.jurisdiction), 'Explicit business and jurisdiction required.');
  const active = records.filter(row => row.record.status === 'active');
  for (const row of active) {
    if (!await checkAuthority(client, row.actor, matterId, 'APPROVE', true)) row.record.status = 'revoked';
  }
  const context = { now: providedNow ?? new Date().toISOString(), business: input.business, jurisdiction: input.jurisdiction };
  const currentRecords = active.map(row => row.record);
  const evaluation = evaluatePlaybook(normalized, catalog, currentRecords, context);
  if (operation === 'evaluate') return { ...evaluation, hostEvidence: evidence, storedDraftDigest: created[0].metadata.draftDigest };
  check(evaluation.options.every(option => option.status === 'ready_for_host_review'), 'Export blocked by source, review, applicability, or dependency gates.', 409);
  const exported = exportReviewedPlaybook(normalized, catalog, currentRecords, context);
  const event = await append(client, principal, matterId, bookId, 'PLAYBOOK_EXPORTED', { candidateDigest: digest, reviewEventIds: active.filter(row => row.record.status === 'active').map(row => row.eventId), actionAuthority: 'none' });
  return { ...exported, hostEvidence: evidence, reviewReceipt: { exportEventId: event.id, reviewEventIds: active.filter(row => row.record.status === 'active').map(row => row.eventId) }, notice: 'Reviewed playbook snapshot only. Contract-specific entitlement and customer actions require separate authority.' };
}
