import fs from "node:fs";
import path from "node:path";

const file = path.join(process.cwd(), "db", "migrations", "001_app.sql");
const sql = fs.readFileSync(file, "utf8");
const required = [
  "app_user_roles","customers","matters","matter_members","documents","document_chunks","findings",
  "negotiation_standards","decisions","economics_runs","audit_events"
];
const missing = required.filter((name) => !new RegExp(`create table if not exists\\s+${name}\\b`, "i").test(sql));
const controls = [
  [/prevent_audit_event_mutation/i,"append-only audit trigger"],
  [/uq_active_standard_per_family/i,"one active standard per clause family"],
  [/server_sha256/i,"server source hash"],
  [/standard_status/i,"standard provenance"],
  [/extraction_status/i,"document extraction state"]
].filter(([pattern]) => !pattern.test(sql)).map(([,label]) => label);
if (missing.length || controls.length) {
  console.error("Schema check failed", { missingTables:missing, missingControls:controls });
  process.exit(1);
}
console.log(`Schema check passed: ${required.length} required tables and legal-control fields present.`);
