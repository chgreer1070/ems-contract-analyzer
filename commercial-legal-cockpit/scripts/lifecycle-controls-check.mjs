import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";

const root=process.cwd();
const read=relativePath=>fs.readFileSync(path.join(root,relativePath),"utf8");

const migration=read("db/migrations/007_version_scoped_lifecycle.sql");
for(const required of [
  "decisions_agreement_version_required",
  "economics_runs_agreement_version_required",
  "decision_conditions",
  "PENDING','SATISFIED','WAIVED",
  "enforce_decision_condition_lifecycle",
  "enforce_decision_finding_lineage",
  "enforce_economics_run_lifecycle",
  "enforce_agreement_execution_controls",
  "uq_one_approved_agreement_version_per_matter"
])assert.match(migration,new RegExp(required),`migration must contain ${required}`);
assert.match(migration,/review_status not in \('VALIDATED','REJECTED'\)/,"economics review must be one-time and terminal");
assert.match(migration,/decision_type in \('ACCEPT','APPROVE_EXCEPTION'\)/,"database execution gate must require affirmative decision types");
assert.match(migration,/d\.agreement_version_id=new\.id/,"database execution gate must scope authority to the exact version");
assert.match(migration,/d\.source_status='EXECUTED'/,"database execution gate must require external executed-source evidence");
assert.match(migration,/Agreement version transition from % to % is not permitted/,"database must reject direct illegal version transitions");
assert.match(migration,/Execution requires every version source to be clean, extracted, hash-verified, and active/,"database must reject dirty execution sources");
assert.match(migration,/Execution requires a validated economics run for the exact agreement version/,"database must require validated version-scoped economics");
assert.match(migration,/matter and agreement-version scope are immutable/,"decision and economics version scope must not move after creation");
assert.match(migration,/Decision finding must belong to the same matter/,"decision finding lineage must be matter-consistent");
assert.match(migration,/Decision conditions may be created or rebound only while the agreement version is WORKING or APPROVED/,"conditions cannot be appended after execution");

const snapshotReceiptMigration=read("db/migrations/009_executive_snapshot_receipts.sql");
for(const required of [
  "processing_job_id",
  "enforce_executive_snapshot_job_lineage",
  "trg_snapshot_receipt_lineage",
  "enforce_executive_summary_terminal_receipt",
  "trg_executive_summary_terminal_receipt",
  "executive_snapshot_receipt_verified",
  "requestedRelianceHash",
  "requestedEconomicsRunId",
  "requestedAgreementVersionId",
  "publicationReceipt",
  "snapshotPresentation",
  "sourceAuditId"
])assert.match(snapshotReceiptMigration,new RegExp(required),`snapshot receipt migration must contain ${required}`);
assert.match(snapshotReceiptMigration,/New executive snapshots require an exact EXECUTIVE_SUMMARY processing-job receipt/,"receipt-less direct snapshot inserts must fail closed");
assert.match(snapshotReceiptMigration,/pj\.status='SUCCEEDED'/,"snapshot reads must require a successful generator receipt");

const request=read("app/api/decision-requests/route.ts");
for(const required of ["agreementVersionId","agreement_version_id","decision_conditions","analysis_run_id","CLAUSE_RISK","SUCCEEDED","review_status='VALIDATED'"]){
  assert.match(request,new RegExp(required),`decision request must bind ${required}`);
}
assert.doesNotMatch(request,/insert into decisions\([^)]*conditions/,"new decisions must not persist unstructured legacy conditions");

const disposition=read("app/api/decisions/[id]/route.ts");
assert.match(disposition,/agreement_version_id/);
assert.match(disposition,/insert into decision_conditions/);
assert.match(disposition,/Active Approver authority is required at disposition time/);
assert.match(disposition,/dispositionNote\.length<12\|\|dispositionNote\.length>4000/,"terminal decisions must require a bounded substantive disposition note");
assert.match(disposition,/disposition_note=\$5/,"the disposition note must be persisted in the terminal decision write");
assert.match(disposition,/ECONOMICS_FORMULA_VERSION/,"approval must use the current deterministic economics formula version");
assert.match(disposition,/agreement_version_id=\$2[\s\S]*formula_version=\$3 and review_status='VALIDATED'/,"approval must select validated economics for the exact decision version and formula");
assert.match(disposition,/Approval requires the exact authoritative economics selection to remain validated and on the current formula/);
assert.match(disposition,/economicsRunId:updated\.economics_run_id/,"the exact persisted economics evidence ID must be bound to the audit and response");
assert.match(disposition,/dispositionNoteRecorded:true/,"audit metadata must record note presence without copying substantive note text");
assert.ok(disposition.indexOf("insert into decision_conditions")<disposition.indexOf("update decisions"),"new conditions must be inserted while their parent decision is still PENDING");

const authorityEvidenceMigration=read("db/migrations/011_authority_evidence_hardening.sql");
assert.match(authorityEvidenceMigration,/add column if not exists disposition_note text/);
assert.match(authorityEvidenceMigration,/decisions_terminal_disposition_note_required/);
assert.match(authorityEvidenceMigration,/between 12 and 4000[\s\S]*\) not valid/,"the forward check must enforce new writes without invalidating legacy terminal rows");
assert.match(authorityEvidenceMigration,/before insert or update of decision_status,decided_by,decided_at,disposition_note/);

const conditionRoute=read("app/api/decision-conditions/[id]/route.ts");
assert.match(conditionRoute,/SATISFIED/);
assert.match(conditionRoute,/WAIVED/);
assert.match(conditionRoute,/evidence\.length<12/);
assert.match(conditionRoute,/Active Admin authority is required to waive/);

const economics=read("app/api/economics/route.ts");
assert.match(economics,/matterId and agreementVersionId are required/);
assert.match(economics,/insert into economics_runs\([\s\S]*agreement_version_id/);
const economicsReview=read("app/api/economics/[id]/review/route.ts");
assert.match(economicsReview,/VALIDATED/);
assert.match(economicsReview,/REJECTED/);
assert.match(economicsReview,/note\.length<12/);
assert.match(economicsReview,/Active Approver authority/);

const versionStatus=read("app/api/agreement-versions/[id]/status/route.ts");
const approvalGate=versionStatus.slice(versionStatus.indexOf('if(nextStatus==="APPROVED")'),versionStatus.indexOf('if(nextStatus==="EXECUTED")'));
assert.match(approvalGate,/status='APPROVED'/,"approval must prevent a second approved successor");
assert.doesNotMatch(approvalGate,/status in \('APPROVED','EXECUTED'\)/,"an operative executed predecessor must not block an approved successor");
for(const required of ["source_status='EXECUTED'","analysis_runs","agreement_version_id=$1","decision_status='PENDING'","condition_status='PENDING'","decision_type in ('ACCEPT','APPROVE_EXCEPTION')","review_status='UNREVIEWED'","review_status='VALIDATED'"]){
  assert.ok(versionStatus.includes(required),`execution route must enforce ${required}`);
}
assert.match(versionStatus,/status='SUPERSEDED'[\s\S]*status='EXECUTED'/,"executing a successor must atomically supersede its prior executed version");

const snapshotRoute=read("app/api/matters/[id]/snapshots/route.ts");
assert.match(snapshotRoute,/agreement_version_id=\$2 and formula_version=\$3 and review_status='VALIDATED'/,"snapshot request must select validated economics for its exact agreement version and current formula");
const processor=read("lib/jobProcessor.ts");
assert.match(processor,/agreement_version_id=\$3 and formula_version=\$4 and review_status='VALIDATED'/,"snapshot worker must recheck economics review, version, and formula binding");
assert.match(processor,/executive_snapshots\(matter_id,agreement_version_id,processing_job_id/,"snapshot worker must persist its exact generator receipt");
for(const field of ["snapshotId","economicsRunId","requesterId","sourceAuditId","sourceStateHash","relianceEvidenceHash"]){
  assert.match(processor,new RegExp(field),`snapshot terminal job output must bind ${field}`);
}
assert.match(processor,/publicationReceipt/,"the frozen source manifest must embed the exact authorized publication receipt");
assert.match(processor,/snapshotPresentation/,"every displayed executive-summary projection must be inside the frozen source hash");

const workspace=read("app/api/matters/[id]/workspace/route.ts");
assert.match(workspace,/condition_records/);
assert.match(workspace,/er\.agreement_version_id/);
assert.match(workspace,/reliance_evidence/);
assert.match(workspace,/frozen_integrity_verified/);
assert.match(workspace,/executive_snapshot_receipt_verified\(es\.id\) receipt_integrity_verified/,"workspace reads must fail closed for receipt-less legacy snapshots");
const requestUi=read("components/DecisionRequestPanel.tsx");
assert.match(requestUi,/Agreement version \(required\)/);
assert.match(requestUi,/one independently clearable condition per line/);
const workspaceUi=read("components/MatterWorkspace.tsx");
assert.match(workspaceUi,/reviewEconomics/);
assert.match(workspaceUi,/resolveCondition/);
assert.match(workspaceUi,/legacy \/ non-reliance/,"snapshot list must label receipt-less legacy records as non-reliance");
const executiveUi=read("components/ExecutiveSummary.tsx");
assert.match(executiveUi,/snapshot\.receipt_integrity_verified!==true/,"executive brief must reject a missing or invalid generator receipt");
const dbIntegration=read("scripts/db-integration-check.mjs");
assert.match(dbIntegration,/sp_snapshot_without_receipt/,"database fixtures must reject a direct snapshot insert without a generator receipt");
assert.match(dbIntegration,/sp_direct_succeeded_snapshot_job/,"database fixtures must reject a directly inserted successful summary job without a snapshot");
assert.match(dbIntegration,/missingSnapshotReceipt\.verified!==false/,"database fixtures must verify receipt-less reads fail closed");
assert.match(dbIntegration,/sp_snapshot_terminal_receipt/,"database fixtures must reject an incomplete terminal job receipt");
assert.match(dbIntegration,/sp_snapshot_forged_matter_context/,"database fixtures must reject forged displayed matter/customer context despite a self-consistent hash");
assert.match(dbIntegration,/verifiedSnapshotReceipt\.verified!==true/,"database fixtures must prove an exact complete receipt verifies");

console.log("Lifecycle-control checks passed: exact version binding, one-time economics review, structured condition evidence, fail-closed execution, successor lifecycle, and receipt-bound snapshot provenance.");
