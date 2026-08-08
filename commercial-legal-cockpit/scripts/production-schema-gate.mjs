import { appendFile, readFile } from "node:fs/promises";
import { spawn } from "node:child_process";
import { resolve } from "node:path";
import { parseEnvironmentFile } from "./production-env-check.mjs";
import { establishReleaseTargetBinding, RELEASE_SOURCE_SHA_PATTERN } from "./release-target-binding.mjs";

const file=process.argv[2];
if(!file||process.argv.length!==3)throw new Error("Usage: node scripts/production-schema-gate.mjs <validated-production-env-file>");
const variables=parseEnvironmentFile(await readFile(resolve(file),"utf8"));
if(variables.has("MIGRATION_DATABASE_URL"))throw new Error("MIGRATION_DATABASE_URL must not be present in the pulled Vercel production environment.");
for(const name of ["NODE_TLS_REJECT_UNAUTHORIZED","PGOPTIONS","PGSSLMODE"]){
  if(variables.has(name)||Object.hasOwn(process.env,name))throw new Error(`Production schema gate rejects inherited ${name}.`);
}
const runtimeDatabaseUrl=variables.get("DATABASE_URL")||"";
const migrationDatabaseUrl=process.env.MIGRATION_DATABASE_URL||"";
const sourceSha=process.env.GITHUB_SHA||"";
const outputFile=process.env.GITHUB_OUTPUT||"";
if(!runtimeDatabaseUrl)throw new Error("Pulled production DATABASE_URL is required for runtime-principal verification.");
if(!migrationDatabaseUrl)throw new Error("Protected MIGRATION_DATABASE_URL is required for production schema changes.");
if(runtimeDatabaseUrl===migrationDatabaseUrl)throw new Error("Migration and runtime database credentials must be distinct.");
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
const migrationEnvironment=childEnvironment({DATABASE_URL:migrationDatabaseUrl});
const runtimeEnvironment=childEnvironment({RUNTIME_DATABASE_URL:runtimeDatabaseUrl});

async function run(script,environment){
  await new Promise((resolveRun,reject)=>{
    const child=spawn(process.platform==="win32"?"npm.cmd":"npm",["run",script],{env:environment,stdio:"inherit",shell:false});
    child.on("error",reject);child.on("exit",code=>code===0?resolveRun():reject(new Error(`${script} failed with exit code ${code}.`)));
  });
}

await run("db:verify-migration-transport",migrationEnvironment);
await run("db:verify-runtime-transport",runtimeEnvironment);
await run("db:migrate:preflight",migrationEnvironment);
await run("db:migrate",migrationEnvironment);
await run("db:migrate",migrationEnvironment);
await run("db:verify-target",migrationEnvironment);
const binding=await establishReleaseTargetBinding({
  migrationConnectionString:migrationDatabaseUrl,
  runtimeConnectionString:runtimeDatabaseUrl,
  sourceSha,
  requireVerifiedTls:true
});
process.stdout.write(`::add-mask::${binding.nonce}\n`);
await appendFile(outputFile,`release_target_nonce=${binding.nonce}\n`,{encoding:"utf8",mode:0o600});
await run("test:runtime-db-principal",runtimeEnvironment);
console.log(`Production migrations, exact ${binding.migrationReceiptCount}-receipt target binding, and restricted-runtime acceptance passed without exposing environment values.`);
