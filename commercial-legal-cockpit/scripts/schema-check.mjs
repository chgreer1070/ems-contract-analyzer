import fs from "node:fs";
import path from "node:path";
import {assertSchemaMigrationManifestMatchesRepository} from "./schema-migration-manifest.mjs";

const dir = path.join(process.cwd(), "db", "migrations");
const sql = fs.readdirSync(dir).filter((f)=>f.endsWith(".sql")).sort().map((f)=>fs.readFileSync(path.join(dir,f),"utf8")).join("\n");
const required = [
  "app_user_roles","customers","matters","matter_members","documents","document_chunks","findings","negotiation_standards",
  "decisions","economics_runs","audit_events","agreement_versions","agreement_version_documents","document_relations","contract_terms",
  "term_dependencies","processing_jobs","analysis_runs","validation_cases","validation_runs","validation_results","executive_snapshots",
  "legal_hold_events","purge_requests","api_rate_events","decision_conditions","app_user_capabilities","analysis_review_attestations","analysis_engine_policies",
  "release_database_identity","release_database_external_identity","release_target_receipts"
];
const missing = required.filter((name) => !new RegExp(`create table(?: if not exists)?\\s+(?:public\\.)?${name}\\b`, "i").test(sql));
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
  ,[/security_scan_status/i,"source malware quarantine state"]
  ,[/prevent_unscanned_extraction/i,"malware-before-parser trigger"]
  ,[/enforce_verified_document_hash/i,"matching client/server source hash trigger"]
  ,[/analysis_run_id/i,"published-output analysis-run provenance"]
  ,[/enforce_human_review_record/i,"documented human review trigger"]
  ,[/enforce_decision_disposition/i,"independent decision disposition trigger"]
  ,[/enforce_active_standard_governance/i,"governed active-standard trigger"]
  ,[/prevent_purge_request_on_hold/i,"hold-safe purge-request trigger"]
  ,[/enforce_derived_text_hash/i,"derived-text digest enforcement"]
  ,[/enforce_agreement_document_lineage/i,"agreement source matter lineage"]
  ,[/prevent_reviewed_object_mutation/i,"reviewed legal-object immutability"]
  ,[/prevent_terminal_decision_mutation/i,"terminal decision immutability"]
  ,[/trg_executive_snapshots_append_only/i,"append-only frozen snapshots"]
  ,[/enforce_snapshot_manifest/i,"canonical snapshot manifest integrity"]
  ,[/uq_documents_blob_pathname/i,"idempotent source registration key"]
  ,[/decisions_agreement_version_required/i,"version-bound decision authority"]
  ,[/economics_runs_agreement_version_required/i,"version-bound economics evidence"]
  ,[/enforce_decision_condition_lifecycle/i,"structured decision-condition lifecycle"]
  ,[/enforce_decision_finding_lineage/i,"decision finding and version lineage"]
  ,[/enforce_economics_run_lifecycle/i,"one-time economics human review"]
  ,[/enforce_agreement_execution_controls/i,"database-level execution gate"]
  ,[/uq_one_approved_agreement_version_per_matter/i,"one approved successor per matter"]
  ,[/lock_documents_for_legal_publication/i,"execution and legal-output publication serialization"]
  ,[/uq_contract_terms_active_per_run/i,"race-safe term uniqueness per analysis run"]
  ,[/enforce_extraction_generation_lineage/i,"same-document extraction-generation lineage"]
  ,[/LEGACY_UNATTESTED/i,"explicit legacy graph provenance"]
  ,[/uq_model_dependency_active_per_job/i,"race-safe model dependency uniqueness"]
  ,[/uq_model_relation_active_per_job/i,"race-safe model precedence uniqueness"]
  ,[/enforce_analysis_review_attestation/i,"exact analysis-review attestation integrity"]
  ,[/enforce_execution_review_attestations/i,"execution counsel-completion gate"]
  ,[/canonical_jsonb_text/i,"database canonical evidence hashing"]
  ,[/uq_active_analysis_engine_policy/i,"one governed current engine policy per analysis scope"]
  ,[/economics_formula_version/i,"current governed economics formula binding"]
  ,[/rejected_ungrounded_count/i,"rejection-free grounded analysis evidence"]
  ,[/enforce_terminal_validation_result_manifest/i,"terminal validation-result manifest binding"]
  ,[/enforce_open_validation_result_parent/i,"terminal validation child immutability"]
  ,[/enforce_executive_snapshot_job_lineage/i,"authorized executive-snapshot generator lineage"]
  ,[/enforce_executive_summary_terminal_receipt/i,"terminal executive-summary receipt binding"]
  ,[/executive_snapshot_receipt_verified/i,"fail-closed snapshot receipt verification"]
].filter(([pattern]) => !pattern.test(sql)).map(([,label]) => label);
if (missing.length || controls.length) {
  console.error("Schema check failed", { missingTables:missing, missingControls:controls });
  process.exit(1);
}
const manifest=await assertSchemaMigrationManifestMatchesRepository(process.cwd());
console.log(`Schema check passed: ${required.length} required tables and legal-control fields present; ${manifest.migrations.length} canonical-LF migration receipts match manifest v${manifest.version}.`);
