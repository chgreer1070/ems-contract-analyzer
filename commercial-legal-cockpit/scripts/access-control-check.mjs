import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import ts from "typescript";

const projectRoot = join(dirname(fileURLToPath(import.meta.url)), "..");
const accessPath = join(projectRoot, "lib", "access.ts");
const accessSource = readFileSync(accessPath, "utf8");
const compiledAccess = ts.transpileModule(accessSource, {
  compilerOptions: {
    module: ts.ModuleKind.CommonJS,
    target: ts.ScriptTarget.ES2022,
    esModuleInterop: true
  },
  fileName: accessPath
}).outputText;

function loadAccess(state) {
  const module = { exports: {} };
  const localRequire = (specifier) => {
    if (specifier === "@/lib/auth") {
      return {
        auth: { api: { getSession: async () => state.session } },
        authenticationRequired: () => state.authenticationRequired
      };
    }
    if (specifier === "@/lib/db") {
      return {
        databaseConfigured: () => state.databaseConfigured,
        query: async (sql) => {
          if (sql.includes("app_user_roles")) {
            return { rows: state.role ? [{ role: state.role }] : [], rowCount: state.role ? 1 : 0 };
          }
          if (sql.includes("from matters m")) {
            return { rows: state.matter ? [state.matter] : [], rowCount: state.matter ? 1 : 0 };
          }
          throw new Error(`Unexpected access query: ${sql}`);
        }
      };
    }
    throw new Error(`Unexpected access import: ${specifier}`);
  };
  new Function("require", "module", "exports", compiledAccess)(localRequire, module, module.exports);
  return module.exports;
}

const state = {
  authenticationRequired: true,
  databaseConfigured: true,
  role: "VIEWER",
  session: { user: { id: "user-1", name: "Test User", email: "test@example.com" } },
  matter: { owner_user_id: "owner-1", restricted: true, member_access: "VIEW" }
};
const access = loadAccess(state);
const request = new Request("https://contracttwin.test/api/test");
const matterId = "00000000-0000-4000-8000-000000000001";

const priorDemoAccess = process.env.ALLOW_DEMO_ACCESS;
try {
  process.env.ALLOW_DEMO_ACCESS = "true";
  state.authenticationRequired = false;
  const demo = await access.getPrincipal(request);
  assert.equal(demo.demo, true);
  assert.equal(demo.role, "VIEWER", "demo identities must never receive ADMIN authority");
  await assert.rejects(
    () => access.requireMatterAccess(request, matterId, "VIEW"),
    (error) => error?.status === 503 && /disabled in demo mode/i.test(error.message),
    "demo identities must never reach persistent matter resources"
  );
} finally {
  state.authenticationRequired = true;
  if (priorDemoAccess === undefined) delete process.env.ALLOW_DEMO_ACCESS;
  else process.env.ALLOW_DEMO_ACCESS = priorDemoAccess;
}

state.role = "VIEWER";
state.matter = { owner_user_id: "owner-1", restricted: true, member_access: "VIEW" };
assert.equal((await access.requireMatterAccess(request, matterId, false)).role, "VIEWER");
await assert.rejects(
  () => access.requireMatterAccess(request, matterId, true),
  (error) => error?.status === 403,
  "legacy edit=true must still reject a VIEWER"
);

state.role = "LAWYER";
state.matter = { owner_user_id: "owner-1", restricted: true, member_access: "EDIT" };
assert.equal((await access.requireMatterAccess(request, matterId, true)).role, "LAWYER");
state.matter.member_access = "VIEW";
await assert.rejects(
  () => access.requireMatterAccess(request, matterId, true),
  (error) => error?.status === 404 && /not found or access denied/i.test(error.message),
  "an explicit VIEW grant must constrain edit access without revealing matter existence"
);
state.matter = { owner_user_id: "owner-1", restricted: false, member_access: null };
assert.equal((await access.requireMatterAccess(request, matterId, true)).role, "LAWYER");

state.role = "APPROVER";
state.matter = { owner_user_id: "owner-1", restricted: true, member_access: "APPROVE" };
assert.equal((await access.requireMatterAccess(request, matterId, "APPROVE")).role, "APPROVER");
state.matter.member_access = "EDIT";
await assert.rejects(
  () => access.requireMatterAccess(request, matterId, "APPROVE"),
  (error) => error?.status === 404 && /not found or access denied/i.test(error.message),
  "matter EDIT must not authorize approval or reveal matter existence"
);
state.matter = { owner_user_id: "owner-1", restricted: false, member_access: null };
await assert.rejects(
  () => access.requireMatterAccess(request, matterId, "APPROVE"),
  (error) => error?.status === 404,
  "global access to an unrestricted matter must not imply matter approval authority"
);
state.matter = { owner_user_id: "user-1", restricted: true, member_access: "EDIT" };
assert.equal((await access.requireMatterAccess(request, matterId, "APPROVE")).role, "APPROVER");

state.role = "LAWYER";
state.matter = { owner_user_id: "owner-1", restricted: true, member_access: "APPROVE" };
await assert.rejects(
  () => access.requireMatterAccess(request, matterId, "APPROVE"),
  (error) => error?.status === 403 && /Approver role/i.test(error.message),
  "matter approval authority must be intersected with the global Approver role"
);

const decisionRoute = readFileSync(join(projectRoot, "app", "api", "decisions", "[id]", "route.ts"), "utf8");
assert.match(decisionRoute, /required_approver_role/);
assert.match(decisionRoute, /requireResourceMatterAccess\(request,"DECISION",id,"APPROVE"\)/);
assert.match(decisionRoute, /requiredApproverRole==="ADMIN"&&activeRole!=="ADMIN"/);
assert.ok(decisionRoute.indexOf('requireResourceMatterAccess(request,"DECISION",id,"APPROVE")') < decisionRoute.indexOf("withTransaction("), "decision resource authorization must precede transactional state access");

const agreementRoute = readFileSync(join(projectRoot, "app", "api", "agreement-versions", "[id]", "status", "route.ts"), "utf8");
assert.match(agreementRoute,/requireResourceMatterAccess\(request,"AGREEMENT_VERSION",id,"APPROVE"\)/);
assert.ok(agreementRoute.indexOf('requireResourceMatterAccess(request,"AGREEMENT_VERSION",id,"APPROVE")') < agreementRoute.indexOf("withTransaction("), "agreement-version authorization must precede persistent state access");
assert.match(agreementRoute,/WORKING:new Set\(\["APPROVED"\]\)/);

const governanceRoute = readFileSync(join(projectRoot, "app", "api", "matters", "[id]", "governance", "route.ts"), "utf8");
assert.match(governanceRoute,/if\(body\.legalHold===false\)\{await requireRole\(request,"APPROVER"\);await requireMatterAccess\(request,id,"APPROVE"\);\}/);

console.log("Access-control regression checks passed.");
