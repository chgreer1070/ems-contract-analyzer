import fs from "node:fs";
import path from "node:path";

const dir = path.join(process.cwd(), "db", "migrations");
const sql = fs.readdirSync(dir).filter((f)=>f.endsWith(".sql")).sort().map((f)=>fs.readFileSync(path.join(dir,f),"utf8")).join("\n");
const required = [
  "app_user_roles","customers","matters","matter_members","documents","document_chunks","findings","negotiation_standards",
  "decisions","economics_runs","audit_events","agreement_versions","agreement_version_documents","document_relations","contract_terms",
  "term_dependencies","processing_jobs","analysis_runs","validation_cases","validation_runs","validation_results","executive_snapshots",
  "legal_hold_events","purge_requests","api_rate_events"
];
const missing = required.filter((name) => !new RegExp(`create table if not exists\\s+${name}\\b`, "i").test(sql));
const controls = [
  [/prevent_audit_event_mutation/i,"append-only audit trigger"],
  [/uq_active_standard_per_family/i,"one active standard per clause family"],
  [/server_sha256/i,"server source hash"],
  [/standard_status/i,"standard provenance"],
  [/extraction_status/i,"document extraction state"],
  [/exact_text_sha256/i,"atomic term source hash"],
  [/idempotency_key text not null unique/i,"durable job idempotency"],
  [/document_relations/i,"document precedence graph"],
  [/validation_results/i,"case-level validation evidence"],
  [/confidentiality_level/i,"matter confidentiality classification"],
  [/privilege_status/i,"privilege classification"],
  [/legal_hold boolean/i,"legal hold state"],
  [/prevent_purge_on_hold/i,"database-enforced hold protection"],
  [/uq_open_purge_request_per_document/i,"one open purge request per source"],
  [/suppress_duplicate_contract_term/i,"contract-term rerun idempotency"],
  [/suppress_duplicate_term_dependency/i,"dependency rerun idempotency"],
  [/suppress_duplicate_document_relation/i,"document-relation rerun idempotency"],
  [/idx_api_rate_events_lookup/i,"centralized API rate-limit index"]
].filter(([pattern]) => !pattern.test(sql)).map(([,label]) => label);
if (missing.length || controls.length) {
  console.error("Schema check failed", { missingTables:missing, missingControls:controls });
  process.exit(1);
}
console.log(`Schema check passed: ${required.length} required tables and legal-control fields present.`);
