import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

const read = relative => readFileSync(resolve(relative),"utf8");
const workspace = read("app/api/matters/[id]/workspace/route.ts");
const ui = read("components/MatterWorkspace.tsx");

for (const required of [
  "member_access",
  "requested_by_name",
  "requested_by_email",
  "validated_economics",
  "ECONOMICS_FORMULA_VERSION",
  "canReviewLegal:canAttest",
  "can_approve",
  "can_reject",
  "capability_reason"
]) {
  assert.ok(workspace.includes(required),`workspace response must bind ${required}`);
}
assert.match(workspace,/er\.id=case when d\.decision_status='PENDING' then av\.authoritative_economics_run_id else d\.economics_run_id end/,"pending and terminal decision evidence must resolve from explicit authoritative or exact bound economics");
assert.match(workspace,/canApproveDecision=authorityGate&&hasAuthoritativeEconomics/,"approval must fail closed without exact authoritative economics");
assert.match(workspace,/const canReject=authorityGate/,"authorized rejection must remain available without economics");
assert.match(workspace,/disposition_note:null[\s\S]*decided_by:null[\s\S]*decided_by_name:null/,"viewer projection must redact permanent disposition rationale and decider identity");

for (const required of [
  "Permanent decision disposition rationale",
  "JSON.stringify({status,dispositionNote})",
  "decision.can_approve",
  "decision.can_reject",
  "decision.capability_reason",
  "Full economics inputs",
  "Full economics outputs",
  "Requester ID",
  "source hashes are not verified",
  "No documents are selected automatically",
  "Authoritative economics — explicit immutable selection",
  "Select a validated run; no default",
  "Lock package and bind selected economics",
  "role=\"tablist\"",
  "aria-live=\"polite\"",
  "minLength={12}"
]) {
  assert.ok(ui.includes(required),`matter workspace must render/control ${required}`);
}
assert.doesNotMatch(ui,/local confirmation note|not sent to or stored|not audit evidence/i,"decision rationale must not be described as local or non-recorded");
assert.doesNotMatch(ui,/setSelectedDocs\([^\n]*documents[^\n]*map/i,"workspace must not auto-select a document set from loaded records");
assert.match(ui,/authoritativeEconomicsRunId=status==="APPROVED"\?versionEconomicsSelections\[id\]\|\|null:null/,"version lock must submit only an explicit user-selected authoritative economics run");

console.log("Matter-workspace evidence and authority UI checks passed.");
