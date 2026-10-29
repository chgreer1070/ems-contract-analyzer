import { createHash } from 'node:crypto';

export const FAMILIES = ['pricing', 'ncnr', 'eo', 'notices'];
const FAIL = message => { throw new Error(message); };
const requireThat = (condition, message) => { if (!condition) FAIL(message); };
const text = value => typeof value === 'string' && value.trim().length > 0;
const iso = value => {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{3})?Z$/.test(value) || !Number.isFinite(Date.parse(value))) return false;
  return new Date(value).toISOString() === (value.includes('.') ? value : value.replace('Z', '.000Z'));
};
function exactKeys(value, keys, label) {
  requireThat(value && typeof value === 'object' && !Array.isArray(value) && Object.getPrototypeOf(value) === Object.prototype, `${label} must be a plain object`);
  requireThat(Object.keys(value).every(key => keys.includes(key)), `Unsupported ${label} field`);
}
export const sha256 = bytes => createHash('sha256').update(bytes).digest('hex');

function canonical(value) {
  if (value === null || typeof value === 'string' || typeof value === 'boolean') return JSON.stringify(value);
  if (typeof value === 'number' && Number.isFinite(value)) return JSON.stringify(value);
  if (Array.isArray(value)) return '[' + value.map(canonical).join(',') + ']';
  requireThat(value && typeof value === 'object', 'Only JSON values are permitted');
  return '{' + Object.keys(value).sort().map(key => JSON.stringify(key) + ':' + canonical(value[key])).join(',') + '}';
}
export const contentDigest = value => sha256(canonical(value));

// Source documents are data. Nothing in their contents is interpreted as code,
// workflow instructions, or approval. Source bytes come from a host-owned catalog.
export function validatePlaybook(book, catalog) {
  exactKeys(book, ['schemaVersion', 'id', 'version', 'scope', 'sources', 'options'], 'book');
  requireThat(catalog instanceof Map, 'Host source catalog required');
  requireThat(book?.schemaVersion === '1.0', 'Unsupported schemaVersion');
  requireThat(text(book.id) && text(book.version), 'Book identity and version required');
  requireThat(['synthetic', 'live'].includes(book.scope), 'Explicit evidence scope required');
  requireThat(Array.isArray(book.sources) && book.sources.length > 0, 'Sources required');
  requireThat(Array.isArray(book.options) && book.options.length > 0, 'Options required');
  const sources = new Map();
  for (const source of book.sources) {
    exactKeys(source, ['id', 'documentId', 'version', 'locator', 'scope', 'executionStatus', 'documentSha256', 'start', 'end', 'excerpt', 'originalSha256', 'extractionMethod'], 'source');
    requireThat(text(source.id) && !sources.has(source.id), 'Duplicate or missing source ID');
    requireThat(text(source.documentId) && text(source.version) && text(source.locator), 'Source identity/version/locator required');
    requireThat(source.scope === book.scope, 'Source scope mismatch');
    requireThat(['synthetic', 'unsigned', 'negotiating', 'executed', 'approved-precedent'].includes(source.executionStatus), 'Execution status required');
    const record = catalog.get(source.documentId);
    requireThat(record && Buffer.isBuffer(record.bytes), 'Source bytes unavailable');
    requireThat(record.version === source.version && record.scope === source.scope && record.executionStatus === source.executionStatus, 'Source metadata mismatch');
    requireThat(source.documentSha256 === sha256(record.bytes), 'Source hash mismatch');
    if (source.originalSha256 !== undefined || source.extractionMethod !== undefined) {
      requireThat(source.originalSha256 === record.originalSha256 && source.extractionMethod === record.extractionMethod, 'Original evidence metadata mismatch');
    }
    // v1 requires a UTF-8 text source. Do not pass binary DOCX/PDF as text.
    requireThat(record.mediaType === 'text/plain; charset=utf-8', 'Structured text source required; binary ingestion unsupported');
    const body = record.bytes.toString('utf8');
    requireThat(Buffer.from(body, 'utf8').equals(record.bytes), 'Invalid UTF-8 source');
    requireThat(Number.isSafeInteger(source.start) && Number.isSafeInteger(source.end) && source.start >= 0 && source.end > source.start && source.end <= body.length, 'Invalid source offsets');
    requireThat(text(source.excerpt) && body.slice(source.start, source.end) === source.excerpt, 'Excerpt does not match exact source offsets');
    sources.set(source.id, source);
  }
  const ids = new Set();
  for (const option of book.options) {
    exactKeys(option, ['id', 'family', 'position', 'legalText', 'businessReason', 'owner', 'escalationOwner', 'escalationTrigger', 'reviewStatus', 'origin', 'sourceRefs', 'missingFacts', 'conflicts', 'dependencies', 'applicability'], 'option');
    requireThat(text(option.id) && !ids.has(option.id), 'Duplicate or missing option ID'); ids.add(option.id);
    requireThat(FAMILIES.includes(option.family), 'Unsupported clause family');
    requireThat(['preferred', 'fallback', 'exception'].includes(option.position), 'Position required');
    for (const key of ['legalText', 'businessReason', 'owner', 'escalationOwner', 'escalationTrigger']) requireThat(text(option[key]), `${key} required`);
    requireThat(['draft', 'reviewed'].includes(option.reviewStatus), 'Review status required');
    requireThat(option.origin === 'human-draft' || option.origin === 'ai-draft', 'Draft origin required');
    requireThat(Array.isArray(option.sourceRefs) && option.sourceRefs.length > 0 && new Set(option.sourceRefs).size === option.sourceRefs.length, 'Unique evidence references required');
    for (const ref of option.sourceRefs) requireThat(sources.has(ref), 'Unknown evidence reference');
    requireThat(Array.isArray(option.missingFacts) && option.missingFacts.every(text), 'missingFacts must be an explicit string array');
    requireThat(Array.isArray(option.conflicts) && option.conflicts.every(text), 'conflicts must be an explicit string array');
    requireThat(Array.isArray(option.dependencies) && option.dependencies.every(text), 'dependencies must be an explicit string array');
    requireThat(new Set(option.dependencies).size === option.dependencies.length, 'Duplicate dependency');
    exactKeys(option.applicability, ['business', 'jurisdiction', 'from', 'until'], 'applicability');
    requireThat(text(option.applicability?.business) && text(option.applicability?.jurisdiction), 'Applicability required');
    requireThat(iso(option.applicability?.from) && iso(option.applicability?.until) && Date.parse(option.applicability.until) > Date.parse(option.applicability.from), 'Valid applicability period required');
  }
  for (const option of book.options) for (const dep of option.dependencies) requireThat(ids.has(dep) && dep !== option.id, 'Unknown or self dependency');
  const visiting = new Set(), visited = new Set(), options = new Map(book.options.map(option => [option.id, option]));
  function visit(id) {
    requireThat(!visiting.has(id), 'Dependency cycle');
    if (visited.has(id)) return;
    visiting.add(id); options.get(id).dependencies.forEach(visit); visiting.delete(id); visited.add(id);
  }
  options.forEach(option => visit(option.id));
  return contentDigest(book);
}

// reviewRecords MUST be supplied by the host, not extracted from a contract or
// imported ClauseMaster package. This prototype validates records; it does not
// authenticate identities or authorize a customer-facing action.
export function evaluatePlaybook(book, catalog, reviewRecords, context) {
  const digest = validatePlaybook(book, catalog);
  requireThat(Array.isArray(reviewRecords), 'Host review registry required');
  for (const record of reviewRecords) exactKeys(record, ['bookId', 'bookVersion', 'bookDigest', 'optionId', 'reviewer', 'role', 'scope', 'status', 'reviewedAt', 'expiresAt'], 'review record');
  requireThat(iso(context?.now) && text(context.business) && text(context.jurisdiction), 'Explicit time and applicability context required');
  const now = Date.parse(context.now), sourceMap = new Map(book.sources.map(source => [source.id, source]));
  const outcomes = new Map();
  for (const option of book.options) {
    const reasons = [];
    if (option.reviewStatus !== 'reviewed') reasons.push('draft_requires_legal_review');
    if (option.missingFacts.length) reasons.push('missing_facts');
    if (option.conflicts.length) reasons.push('unresolved_conflicts');
    if (option.applicability.business !== context.business || option.applicability.jurisdiction !== context.jurisdiction) reasons.push('outside_approved_scope');
    if (now < Date.parse(option.applicability.from) || now >= Date.parse(option.applicability.until)) reasons.push('outside_effective_period');
    if (book.scope === 'live' && option.sourceRefs.some(ref => !['executed', 'approved-precedent'].includes(sourceMap.get(ref).executionStatus))) reasons.push('source_not_eligible');
    const records = reviewRecords.filter(record => record.optionId === option.id && record.bookId === book.id && record.bookVersion === book.version && record.bookDigest === digest);
    // Ambiguous records fail closed; revoked records are never superseded here.
    const review = records.length === 1 ? records[0] : null;
    if (!review || !text(review.reviewer) || review.role !== 'legal-reviewer' || review.scope !== book.scope || review.status !== 'active' || !iso(review.reviewedAt) || !iso(review.expiresAt) || Date.parse(review.reviewedAt) > now || Date.parse(review.expiresAt) <= now || Date.parse(review.expiresAt) <= Date.parse(review.reviewedAt)) reasons.push('missing_invalid_or_stale_review');
    outcomes.set(option.id, { optionId: option.id, family: option.family, status: reasons.length ? 'blocked' : 'ready_for_host_review', reasons });
  }
  const propagated = new Set();
  function propagate(id) {
    if (propagated.has(id)) return;
    const option = book.options.find(option => option.id === id), result = outcomes.get(id);
    for (const dep of option.dependencies) {
      propagate(dep);
      if (outcomes.get(dep).status === 'blocked' && !result.reasons.includes('blocked_dependency')) result.reasons.push('blocked_dependency');
    }
    if (result.reasons.length) result.status = 'blocked';
    propagated.add(id);
  }
  book.options.forEach(option => propagate(option.id));
  return { bookId: book.id, version: book.version, digest, scope: book.scope, evaluatedAt: context.now, actionAuthority: 'none', options: [...outcomes.values()] };
}

export function exportReviewedPlaybook(book, catalog, reviewRecords, context) {
  const evaluation = evaluatePlaybook(book, catalog, reviewRecords, context);
  requireThat(evaluation.options.every(option => option.status === 'ready_for_host_review'), 'Reviewed export blocked');
  return { format: 'contracttwin-reviewed-playbook-v1', scope: book.scope, actionAuthority: 'none', evaluation, playbook: structuredClone(book) };
}

// ClauseMaster options are imported without treating provider text, approval
// labels, or numerical bias scores as evidence or authority.
export function importClauseMasterDraft(input, familyByClause, evidenceByClause) {
  requireThat(Array.isArray(input?.clauses) && input.clauses.length > 0, 'ClauseMaster clauses required');
  const clauses = new Set(), options = [];
  for (const clause of input.clauses) {
    requireThat(text(clause.id) && !clauses.has(clause.id), 'Duplicate or missing imported clause ID'); clauses.add(clause.id);
    requireThat(FAMILIES.includes(familyByClause[clause.id]), 'Explicit family mapping required');
    requireThat(Array.isArray(evidenceByClause[clause.id]) && evidenceByClause[clause.id].length > 0, 'Explicit source mapping required');
    requireThat(Array.isArray(clause.options) && clause.options.length > 0, 'Imported options required');
    const optionIds = new Set();
    for (const option of clause.options) {
      requireThat(text(option.id) && !optionIds.has(option.id), 'Duplicate or missing imported option ID'); optionIds.add(option.id);
      requireThat(text(option.legalText) && text(option.plainDescription), 'Full legal text and description required');
      options.push({ id: JSON.stringify([clause.id, option.id]), family: familyByClause[clause.id], legalText: option.legalText, businessReason: option.plainDescription, sourceRefs: [...evidenceByClause[clause.id]], origin: 'ai-draft', reviewStatus: 'draft', missingFacts: ['Flex position, applicability, dependencies, owner, and escalation require legal review'], conflicts: [], dependencies: [] });
    }
  }
  return { status: 'incomplete_draft', actionAuthority: 'none', options };
}
