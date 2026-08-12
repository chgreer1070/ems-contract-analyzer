import { appendFile, readFile } from "node:fs/promises";
import { spawn } from "node:child_process";
import { resolve } from "node:path";
import { parseEnvironmentFile } from "./production-env-check.mjs";
import {
  establishReleaseTargetBinding,
  RELEASE_SOURCE_SHA_PATTERN,
  verifyPreMigrationTargetBinding
} from "./release-target-binding.mjs";
import {
  assertApprovedDatabaseEndpoints,
  expectedProductionTargetAnchor
} from "./production-target-anchor.mjs";

const file=process.argv[2];
if(!file||process.argv.length!==3)throw new Error("Usage: node scripts/production-schema-gate.mjs <validated-production-env-file>");
const variables=parseEnvironmentFile(await readFile(resolve(file),"utf8"));
for(const protectedName of [
  "MIGRATION_DATABASE_URL",
  "EXPECTED_PRODUCTION_TARGET_TOKEN",
  "EXPECTED_PRODUCTION_DATABASE_ID",
  "EXPECTED_PRODUCTION_RUNTIME_DATABASE_ENDPOINT_SHA256",
  "EXPECTED_PRODUCTION_MIGRATION_DATABASE_ENDPOINT_SHA256",
  "PRODUCTION_DATABASE_BOOTSTRAP_URL",
  "EXPECTED_PRODUCTION_BOOTSTRAP_DATABASE_ENDPOINT_SHA256"
]){
  if(variables.has(protectedName))throw new Error(`${protectedName} must not be present in the pulled Vercel production environment.`);
}
for(const name of ["NODE_TLS_REJECT_UNAUTHORIZED","PGOPTIONS","PGSSLMODE"]){
  if(variables.has(name)||Object.hasOwn(process.env,name))throw new Error(`Production schema gate rejects inherited ${name}.`);
}
const runtimeDatabaseUrl=variables.get("DATABASE_URL")||"";
const migrationDatabaseUrl=process.env.MIGRATION_DATABASE_URL||"";
const expectedTargetAnchor=expectedProductionTargetAnchor({
  token:process.env.EXPECTED_PRODUCTION_TARGET_TOKEN||"",
  databaseId:process.env.EXPECTED_PRODUCTION_DATABASE_ID||"",
  runtimeEndpointSha256:process.env.EXPECTED_PRODUCTION_RUNTIME_DATABASE_ENDPOINT_SHA256||"",
  migrationEndpointSha256:process.env.EXPECTED_PRODUCTION_MIGRATION_DATABASE_ENDPOINT_SHA256||""
});
const sourceSha=process.env.GITHUB_SHA||"";
const outputFile=process.env.GITHUB_OUTPUT||"";
if(!runtimeDatabaseUrl)throw new Error("Pulled production DATABASE_URL is required for runtime-principal verification.");
if(!migrationDatabaseUrl)throw new Error("Protected MIGRATION_DATABASE_URL is required for production schema changes.");
if(runtimeDatabaseUrl===migrationDatabaseUrl)throw new Error("Migration and runtime database credentials must be distinct.");
assertApprovedDatabaseEndpoints([runtimeDatabaseUrl],expectedTargetAnchor.runtimeEndpointSha256);
assertApprovedDatabaseEndpoints([migrationDatabaseUrl],expectedTargetAnchor.migrationEndpointSha256);
if(!RELEASE_SOURCE_SHA_PATTERN.test(sourceSha))throw new Error("GITHUB_SHA must be an exact lowercase Git source identifier.");
if(!outputFile)throw new Error("GITHUB_OUTPUT is required for protected release-target handoff.");

// Database subprocesses receive only OS process essentials and their one
// purpose-specific credential. Pulled Vercel secrets and the opposite database
// credential never enter npm lifecycle-script environments.
const CHILD_ENVIRONMENT_ALLOWLIST=new Set([
  "APPDATA","COMSPEC","HOME","LANG","LC_ALL","LOCALAPPDATA","PATH","PATHEXT",
  "SYSTEMROOT","TEMP","TMP","TMPDIR","TZ","USERPROFILE","WINDIR"
]);
function childEnvironment(additions){
  const environment={};
  for(const [name,value] of Object.entries(process.env)){
    if(value!==undefined&&CHILD_ENVIRONMENT_ALLOWLIST.has(name.toUpperCase()))environment[name]=value;
  }
  return {...environment,APP_ENV:"production",...additions};
}
const migrationTransportEnvironment=childEnvironment({DATABASE_URL:migrationDatabaseUrl});
const runtimeTransportEnvironment=childEnvironment({RUNTIME_DATABASE_URL:runtimeDatabaseUrl});
const runtimePrincipalEnvironment=childEnvironment({DATABASE_URL:runtimeDatabaseUrl});

async function run(script,environment){
  await new Promise((resolveRun,reject)=>{
    const child=spawn(process.platform==="win32"?"npm.cmd":"npm",["run",script],{env:environment,stdio:"inherit",shell:false});
    child.on("error",reject);child.on("exit",code=>code===0?resolveRun():reject(new Error(`${script} failed with exit code ${code}.`)));
  });
}

await run("db:verify-migration-transport",migrationTransportEnvironment);
await run("db:verify-runtime-transport",runtimeTransportEnvironment);
const preMigrationBinding=await verifyPreMigrationTargetBinding({
  migrationConnectionString:migrationDatabaseUrl,
  runtimeConnectionString:runtimeDatabaseUrl,
  expectedTargetAnchor,
  requireVerifiedTls:true
});
const migrationEnvironment=childEnvironment({
  DATABASE_URL:migrationDatabaseUrl,
  EXPECTED_PRODUCTION_DATABASE_ID:expectedTargetAnchor.databaseId,
  EXPECTED_LIVE_DATABASE_FINGERPRINT:preMigrationBinding.liveDatabaseFingerprint,
  HELD_PRE_MIGRATION_DATABASE_CHALLENGE:preMigrationBinding.challenge
});
try{
  await run("db:migrate:preflight",migrationEnvironment);
  await run("db:migrate",migrationEnvironment);
  await run("db:migrate",migrationEnvironment);
  await run("db:verify-target",migrationEnvironment);
  const binding=await establishReleaseTargetBinding({
    migrationConnectionString:migrationDatabaseUrl,
    runtimeConnectionString:runtimeDatabaseUrl,
    sourceSha,
    heldChallenge:preMigrationBinding.challenge,
    expectedLiveDatabaseFingerprint:preMigrationBinding.liveDatabaseFingerprint,
    expectedTargetAnchor,
    requireVerifiedTls:true
  });
  process.stdout.write(`::add-mask::${binding.nonce}\n`);
  await appendFile(outputFile,`release_target_nonce=${binding.nonce}\n`,{encoding:"utf8",mode:0o600});
  await run("db:verify-runtime-principal",runtimePrincipalEnvironment);
  console.log(`Production migrations, exact ${binding.migrationReceiptCount}-receipt target binding, and restricted-runtime acceptance passed without exposing environment values.`);
}finally{
  await preMigrationBinding.release();
}
