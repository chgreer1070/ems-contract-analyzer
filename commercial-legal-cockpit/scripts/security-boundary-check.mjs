import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import ts from "typescript";
import {verifiedDatabaseConnectionConfig} from "./database-connection-config.mjs";
import {evaluateReleaseTargetBinding,hashReleaseTargetNonce} from "./release-target-binding.mjs";
import {assertSchemaMigrationManifestMatchesRepository,evaluateExactSchemaMigrationReceipts as evaluateScriptMigrationReceipts} from "./schema-migration-manifest.mjs";

const root=process.cwd();
const safeDatabaseConnection=verifiedDatabaseConnectionConfig("postgresql://runtime:secret@db.example/contracttwin","security-boundary-test");
assert.equal(safeDatabaseConnection.options,"-c search_path=public,pg_temp");
assert.throws(()=>verifiedDatabaseConnectionConfig("postgresql://runtime:secret@db.example/contracttwin?options=-c%20search_path%3Devil","security-boundary-test"),/may not override/);
const savedDatabaseOverrides=Object.fromEntries(["NODE_TLS_REJECT_UNAUTHORIZED","PGOPTIONS","PGSSLMODE"].map(name=>[name,process.env[name]]));
for(const name of Object.keys(savedDatabaseOverrides))delete process.env[name];
assert.throws(()=>verifiedDatabaseConnectionConfig("postgresql://runtime:secret@db.example/contracttwin","security-boundary-test",{requireVerifiedTls:true}),/sslmode=verify-full/);
const verifiedTlsConnection=verifiedDatabaseConnectionConfig("postgresql://runtime:secret@db.example/contracttwin?sslmode=verify-full","security-boundary-test",{requireVerifiedTls:true});
assert.equal(verifiedTlsConnection.enableChannelBinding,true);
for(const [name,value] of [["NODE_TLS_REJECT_UNAUTHORIZED","0"],["PGOPTIONS",""],["PGSSLMODE","disable"]]){
  process.env[name]=value;
  assert.throws(()=>verifiedDatabaseConnectionConfig("postgresql://runtime:secret@db.example/contracttwin?sslmode=verify-full","security-boundary-test",{requireVerifiedTls:true}),/reject inherited TLS or PostgreSQL option overrides/,`verified database transport must reject inherited ${name}`);
  delete process.env[name];
}
for(const [name,value] of Object.entries(savedDatabaseOverrides)){if(value===undefined)delete process.env[name];else process.env[name]=value;}
function load(relativePath,mocks={}){
  const filename=path.join(root,relativePath);const source=fs.readFileSync(filename,"utf8");
  const output=ts.transpileModule(source,{compilerOptions:{module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2022,esModuleInterop:true},fileName:filename}).outputText;
  const module={exports:{}};const localRequire=id=>id==="node:crypto"?crypto:id==="node:net"?{}:Object.hasOwn(mocks,id)?mocks[id]:(()=>{throw new Error(`Unexpected import ${id}`)})();
  new Function("require","module","exports",output)(localRequire,module,module.exports);return module.exports;
}

const malware=load("lib/malwareScan.ts");
assert.deepEqual(malware.parseClamAvResponse("stream: OK\0"),{clean:true,response:"stream: OK"});
assert.deepEqual(malware.parseClamAvResponse("stream: Eicar-Test-Signature FOUND\n"),{clean:false,response:"stream: Eicar-Test-Signature FOUND"});
assert.throws(()=>malware.parseClamAvResponse("stream: ERROR"),/unrecognized/i);

const decisions=load("lib/decisionPolicy.ts");
assert.equal(decisions.requiredDecisionRole({decisionType:"NEGOTIATE"}),"APPROVER");
assert.equal(decisions.requiredDecisionRole({decisionType:"APPROVE_EXCEPTION"}),"ADMIN");
assert.equal(decisions.requiredDecisionRole({decisionType:"NEGOTIATE",approvalRequired:"CFO approval"}),"ADMIN");
assert.equal(decisions.requiredDecisionRole({decisionType:"NEGOTIATE",requestedRole:"ADMIN"}),"ADMIN");
assert.throws(()=>decisions.requiredDecisionRole({decisionType:"NEGOTIATE",requestedRole:"VIEWER"}),/APPROVER or ADMIN/);

const hashes=load("lib/stateHash.ts");
assert.equal(hashes.canonicalStateHash({b:2,a:{d:4,c:3}}),hashes.canonicalStateHash({a:{c:3,d:4},b:2}),"state hash must be key-order invariant");
assert.notEqual(hashes.canonicalStateHash({a:1}),hashes.canonicalStateHash({a:2}),"material state changes must change the digest");
assert.notEqual(hashes.canonicalStateHash({at:new Date("2026-01-01T00:00:00Z")}),hashes.canonicalStateHash({at:new Date("2026-01-02T00:00:00Z")}),"date changes must change the digest");
assert.throws(()=>hashes.canonicalStateHash({missing:undefined}),/undefined/);
assert.throws(()=>hashes.canonicalStateHash({invalid:Number.NaN}),/non-finite/);

const previousOcrEndpoint=process.env.AZURE_DOCUMENT_INTELLIGENCE_ENDPOINT;
process.env.AZURE_DOCUMENT_INTELLIGENCE_ENDPOINT="https://acct.cognitiveservices.azure.com";
const ocr=load("lib/ocr.ts",{"@/lib/chunking":{chunkText:()=>[]}});
assert.equal(ocr.trustedOcrOperationUrl("https://acct.cognitiveservices.azure.com/documentintelligence/documentModels/prebuilt-layout/analyzeResults/123e4567-e89b-12d3-a456-426614174000?api-version=2024-11-30"),"https://acct.cognitiveservices.azure.com/documentintelligence/documentModels/prebuilt-layout/analyzeResults/123e4567-e89b-12d3-a456-426614174000?api-version=2024-11-30");
assert.throws(()=>ocr.trustedOcrOperationUrl("https://acct.cognitiveservices.azure.com@attacker.example/documentintelligence/documentModels/prebuilt-layout/analyzeResults/123?api-version=2024-11-30"),/unexpected operation URL/);
assert.throws(()=>ocr.trustedOcrOperationUrl("https://acct.cognitiveservices.azure.com.evil.example/documentintelligence/documentModels/prebuilt-layout/analyzeResults/123?api-version=2024-11-30"),/unexpected operation URL/);
assert.throws(()=>ocr.trustedOcrOperationUrl("http://acct.cognitiveservices.azure.com/documentintelligence/documentModels/prebuilt-layout/analyzeResults/123?api-version=2024-11-30"),/unexpected operation URL/);
assert.throws(()=>ocr.trustedOcrOperationUrl("https://acct.cognitiveservices.azure.com/documentintelligence/documentModels/prebuilt-layout/analyzeResults/123?api-version=2023-07-31"),/unexpected API version/);
if(previousOcrEndpoint===undefined)delete process.env.AZURE_DOCUMENT_INTELLIGENCE_ENDPOINT;else process.env.AZURE_DOCUMENT_INTELLIGENCE_ENDPOINT=previousOcrEndpoint;

const approvedReleaseSha="a".repeat(40);
const releaseTargetNonce="1".repeat(64);
const releaseTargetNonceSha256=hashReleaseTargetNonce(releaseTargetNonce);
const releaseDatabaseId="11111111-1111-4111-8111-111111111111";
const healthyReleaseReceipt={database_id:releaseDatabaseId,source_sha:approvedReleaseSha,nonce_sha256:releaseTargetNonceSha256};
assert.equal(evaluateReleaseTargetBinding({migrationDatabaseId:releaseDatabaseId,runtimeDatabaseId:releaseDatabaseId,receipt:healthyReleaseReceipt,expectedSourceSha:approvedReleaseSha,expectedNonceSha256:releaseTargetNonceSha256}).ok,true);
assert.equal(evaluateReleaseTargetBinding({migrationDatabaseId:releaseDatabaseId,runtimeDatabaseId:"22222222-2222-4222-8222-222222222222",receipt:healthyReleaseReceipt,expectedSourceSha:approvedReleaseSha,expectedNonceSha256:releaseTargetNonceSha256}).ok,false,"different migration and runtime databases must fail release binding");
assert.equal(evaluateReleaseTargetBinding({migrationDatabaseId:releaseDatabaseId,runtimeDatabaseId:releaseDatabaseId,receipt:null,expectedSourceSha:approvedReleaseSha,expectedNonceSha256:releaseTargetNonceSha256}).ok,false,"a restored clone without the unpredictable release receipt must fail release binding");
const savedReleaseEnvironment=Object.fromEntries(["RELEASE_ATTESTATION_TOKEN","APP_ENV","AUTH_REQUIRED","ALLOW_DEMO_ACCESS","LEGAL_RELIANCE_ENABLED","ALLOW_SOURCE_PURGE","CONTRACTTWIN_RELEASE_SHA","VERCEL_GIT_COMMIT_SHA"].map(name=>[name,process.env[name]]));
Object.assign(process.env,{RELEASE_ATTESTATION_TOKEN:"r".repeat(48),APP_ENV:"production",AUTH_REQUIRED:"true",ALLOW_DEMO_ACCESS:"false",LEGAL_RELIANCE_ENABLED:"true",ALLOW_SOURCE_PURGE:"false",CONTRACTTWIN_RELEASE_SHA:approvedReleaseSha});
delete process.env.VERCEL_GIT_COMMIT_SHA;
const databaseControlManifest=JSON.parse(fs.readFileSync(path.join(root,"lib/critical-database-controls.json"),"utf8"));
const migrationReceiptManifest=JSON.parse(fs.readFileSync(path.join(root,"lib/schema-migration-manifest.json"),"utf8"));
await assertSchemaMigrationManifestMatchesRepository(root);
assert.equal(evaluateScriptMigrationReceipts(migrationReceiptManifest.migrations,migrationReceiptManifest).ok,true);
assert.equal(evaluateScriptMigrationReceipts(migrationReceiptManifest.migrations.slice(0,-1),migrationReceiptManifest).ok,false,"a missing migration receipt must fail exact-manifest verification");
assert.equal(evaluateScriptMigrationReceipts([...migrationReceiptManifest.migrations,{filename:"999_extra.sql",sha256:"f".repeat(64)}],migrationReceiptManifest).ok,false,"an extra migration receipt must fail exact-manifest verification");
assert.equal(evaluateScriptMigrationReceipts(migrationReceiptManifest.migrations.map((row,index)=>index===0?{...row,sha256:"0".repeat(64)}:row),migrationReceiptManifest).ok,false,"a forged migration hash must fail exact-manifest verification");
const databaseControls=load("lib/databaseControls.ts",{"@/lib/critical-database-controls.json":databaseControlManifest});
const runtimeDatabasePrincipal=load("lib/runtimeDatabasePrincipal.ts");
const schemaMigrationManifest=load("lib/schemaMigrationManifest.ts",{"@/lib/schema-migration-manifest.json":migrationReceiptManifest});
const healthyDatabaseControlRows=[
  ...databaseControlManifest.columns.map(control=>({kind:"column",table_name:control.table,object_name:control.name,data_type:control.type,is_nullable:control.nullable})),
  ...databaseControlManifest.triggers.map(control=>({kind:"trigger",table_name:control.table,object_name:control.name,function_name:control.function,enabled:"O",is_internal:false,definition:`trigger:${control.table}.${control.name}`,function_definition:`trigger-function:${control.function}`})),
  ...databaseControlManifest.functions.map(control=>({kind:"function",table_name:null,object_name:control.name,identity_arguments:control.identityArguments,result_type:control.result,volatility:control.volatility,definition:`function:${control.name}(${control.identityArguments})`})),
  ...databaseControlManifest.constraints.map(control=>({kind:"constraint",table_name:control.table,object_name:control.name,constraint_type:control.type,validated:control.validated,definition:`constraint:${control.table}.${control.name}`})),
  ...databaseControlManifest.indexes.map(control=>({kind:"index",table_name:control.table,object_name:control.name,is_unique:control.unique,is_valid:true,is_ready:true,definition:`index:${control.table}.${control.name}`})),
  {kind:"server",table_name:null,object_name:"postgresql",server_version_num:String(databaseControlManifest.postgresMajor*10000)}
];
databaseControlManifest.schemaDefinitionSha256=databaseControls.calculateCriticalDatabaseControlFingerprint(healthyDatabaseControlRows,databaseControlManifest);
assert.equal(databaseControls.evaluateCriticalDatabaseControls(healthyDatabaseControlRows).ok,true);
const sameNameWeakenedRows=healthyDatabaseControlRows.map(row=>row.object_name==="trg_agreement_execution_controls"?{...row,function_definition:"CREATE FUNCTION public.enforce_agreement_execution_controls() RETURNS trigger AS 'BEGIN RETURN NEW; END' LANGUAGE plpgsql"}:row);
const sameNameWeakenedResult=databaseControls.evaluateCriticalDatabaseControls(sameNameWeakenedRows);
assert.equal(sameNameWeakenedResult.ok,false,"same-name trigger functions must remain bound to their exact clean-schema body");
assert.ok(sameNameWeakenedResult.errors.includes("critical database object definition fingerprint mismatch"));
const unexpectedTriggerRow={kind:"trigger",table_name:"app_user_roles",object_name:"zzz_test_unexpected_trigger",function_name:"contracttwin_test_unexpected_trigger",enabled:"O",is_internal:false,definition:"CREATE TRIGGER zzz_test_unexpected_trigger BEFORE INSERT OR UPDATE ON public.app_user_roles FOR EACH ROW EXECUTE FUNCTION public.contracttwin_test_unexpected_trigger()",function_definition:"CREATE FUNCTION public.contracttwin_test_unexpected_trigger() RETURNS trigger AS 'BEGIN NEW.role := ''ADMIN''; RETURN NEW; END' LANGUAGE plpgsql"};
const unexpectedTriggerResult=databaseControls.evaluateCriticalDatabaseControls([...healthyDatabaseControlRows,unexpectedTriggerRow]);
assert.equal(unexpectedTriggerResult.ok,false,"unexpected triggers on any public table must fail the globally closed trigger set");
assert.ok(unexpectedTriggerResult.errors.includes("unexpected trigger public.app_user_roles.zzz_test_unexpected_trigger"));
const unexpectedRuleRow={kind:"rule",table_name:"app_user_roles",object_name:"zzz_test_unexpected_rule",definition:"CREATE RULE zzz_test_unexpected_rule AS ON UPDATE TO public.app_user_roles DO ALSO UPDATE public.app_user_capabilities SET active = false WHERE user_id = new.user_id"};
const unexpectedRuleResult=databaseControls.evaluateCriticalDatabaseControls([...healthyDatabaseControlRows,unexpectedRuleRow]);
assert.equal(unexpectedRuleResult.ok,false,"unexpected user rewrite rules on any public table must fail the globally closed rule set");
assert.ok(unexpectedRuleResult.errors.includes("unexpected rewrite rule public.app_user_roles.zzz_test_unexpected_rule"));
let liveDatabaseControlRows=healthyDatabaseControlRows;
const healthyRuntimePrincipal={session_user_name:"contracttwin_runtime",current_user_name:"contracttwin_runtime",identities_match:true,role_attributes_safe:true,role_membership_safe:true,owner_membership_safe:true,dangerous_membership_safe:true,database_create_safe:true,database_temp_safe:true,schema_create_safe:true,application_function_execute_safe:true,approved_runtime_functions_ready:true,application_table_dml_ready:true,application_sequence_privileges_safe:true,table_trigger_safe:true,table_truncate_safe:true,table_references_safe:true,table_maintain_safe:true,replication_mode_safe:true,replication_parameter_safe:true,migration_receipts_read_only:true,release_control_tables_read_only:true};
assert.equal(runtimeDatabasePrincipal.evaluateRuntimeDatabasePrincipal(healthyRuntimePrincipal).ok,true);
for(const field of ["identities_match","role_attributes_safe","role_membership_safe","owner_membership_safe","dangerous_membership_safe","database_create_safe","database_temp_safe","schema_create_safe","application_function_execute_safe","approved_runtime_functions_ready","application_table_dml_ready","application_sequence_privileges_safe","table_trigger_safe","table_truncate_safe","table_references_safe","table_maintain_safe","replication_mode_safe","replication_parameter_safe","migration_receipts_read_only","release_control_tables_read_only"]){
  assert.equal(runtimeDatabasePrincipal.evaluateRuntimeDatabasePrincipal({...healthyRuntimePrincipal,[field]:false}).ok,false,`runtime principal must fail closed on ${field}`);
}
let liveRuntimePrincipal=healthyRuntimePrincipal;
let liveMigrationReceipts=migrationReceiptManifest.migrations;
let liveReleaseTargetRows=[{source_sha:approvedReleaseSha,nonce_sha256:releaseTargetNonceSha256,identity_matches:true}];
let liveRuntimeTransport={ssl:true,version:"TLSv1.3",cipher:"TLS_AES_256_GCM_SHA384",bits:256};
const releaseHealth=load("app/api/health/release/route.ts",{
  "@/lib/db":{query:async(sql,parameters)=>/select filename,sha256 from public\.schema_migrations/i.test(sql)?{rows:liveMigrationReceipts}:/with identities as materialized/i.test(sql)?{rows:[liveRuntimePrincipal]}:/from public\.release_database_identity i/i.test(sql)?{rows:parameters?.[0]===approvedReleaseSha&&parameters?.[1]===releaseTargetNonceSha256?liveReleaseTargetRows:[]}:/from pg_catalog\.pg_stat_ssl/i.test(sql)?{rows:[liveRuntimeTransport]}:{rows:liveDatabaseControlRows}},
  "@/lib/readiness":{getSystemReadiness:async()=>({legalRelianceReady:true})},
  "@/lib/economics":{calculateEconomics:()=>({a:0,b:0})},
  "@/lib/databaseControls":databaseControls,
  "@/lib/runtimeDatabasePrincipal":runtimeDatabasePrincipal,
  "@/lib/schemaMigrationManifest":schemaMigrationManifest
});
const releaseHeaders={Authorization:`Bearer ${"r".repeat(48)}`,"x-contracttwin-release-target-nonce":releaseTargetNonce};
let releaseResponse=await releaseHealth.GET(new Request("https://contracttwin.test/api/health/release"));
assert.equal(releaseResponse.status,401,"release health must reject unauthenticated callers");
releaseResponse=await releaseHealth.GET(new Request("https://contracttwin.test/api/health/release",{headers:{Authorization:`Bearer ${"r".repeat(48)}`}}));
assert.equal(releaseResponse.status,503,"release health must reject an authenticated request without the protected release-target nonce");
releaseResponse=await releaseHealth.GET(new Request("https://contracttwin.test/api/health/release",{headers:releaseHeaders}));
assert.equal(releaseResponse.status,200,"a fully proved staged release remains promotable");
assert.match(releaseResponse.headers.get("cache-control")||"",/no-store/i,"release health evidence must never be cacheable");
const releaseBody=await releaseResponse.json();assert.equal(releaseBody.sourceSha,approvedReleaseSha);assert.equal(releaseBody.schemaPassed,true);assert.equal(releaseBody.runtimeDatabasePrincipalPassed,true);assert.equal(releaseBody.releaseTargetBindingPassed,true);assert.equal(releaseBody.runtimeDatabaseTransportPassed,true);assert.equal(Object.hasOwn(releaseBody,"nonce"),false,"release health must not expose its nonce");assert.equal(Object.hasOwn(releaseBody,"databaseId"),false,"release health must not expose its database identity");
liveRuntimePrincipal={...healthyRuntimePrincipal,database_temp_safe:false};
releaseResponse=await releaseHealth.GET(new Request("https://contracttwin.test/api/health/release",{headers:releaseHeaders}));
assert.equal(releaseResponse.status,503,"release health must fail closed when the runtime database principal can create temp shadow objects");
const unsafePrincipalBody=await releaseResponse.json();assert.equal(unsafePrincipalBody.runtimeDatabasePrincipalPassed,false);
liveRuntimePrincipal=healthyRuntimePrincipal;
liveRuntimeTransport={...liveRuntimeTransport,version:"TLSv1.1"};
releaseResponse=await releaseHealth.GET(new Request("https://contracttwin.test/api/health/release",{headers:releaseHeaders}));
assert.equal(releaseResponse.status,503,"release health must reject TLS 1.0 and TLS 1.1 database sessions");
liveRuntimeTransport={ssl:true,version:"TLSv1.3",cipher:"TLS_AES_256_GCM_SHA384",bits:256};
liveReleaseTargetRows=[];
releaseResponse=await releaseHealth.GET(new Request("https://contracttwin.test/api/health/release",{headers:releaseHeaders}));
assert.equal(releaseResponse.status,503,"release health must reject a missing exact database target receipt");
liveReleaseTargetRows=[{source_sha:approvedReleaseSha,nonce_sha256:releaseTargetNonceSha256,identity_matches:true}];
liveMigrationReceipts=migrationReceiptManifest.migrations.map((row,index)=>index===0?{...row,sha256:"0".repeat(64)}:row);
releaseResponse=await releaseHealth.GET(new Request("https://contracttwin.test/api/health/release",{headers:releaseHeaders}));
assert.equal(releaseResponse.status,503,"release health must reject a forged migration receipt");
liveMigrationReceipts=migrationReceiptManifest.migrations;
liveDatabaseControlRows=[...healthyDatabaseControlRows,unexpectedTriggerRow];
releaseResponse=await releaseHealth.GET(new Request("https://contracttwin.test/api/health/release",{headers:releaseHeaders}));
assert.equal(releaseResponse.status,503,"release health must fail closed on an unexpected trigger on a public table with no expected triggers despite intact migration receipts");
const unexpectedTriggerReleaseBody=await releaseResponse.json();assert.equal(unexpectedTriggerReleaseBody.schemaPassed,false);assert.equal(unexpectedTriggerReleaseBody.criticalDatabaseControlsPassed,false);
liveDatabaseControlRows=[...healthyDatabaseControlRows,unexpectedRuleRow];
releaseResponse=await releaseHealth.GET(new Request("https://contracttwin.test/api/health/release",{headers:releaseHeaders}));
assert.equal(releaseResponse.status,503,"release health must fail closed on an unexpected public rewrite rule despite intact migration receipts");
const unexpectedRuleReleaseBody=await releaseResponse.json();assert.equal(unexpectedRuleReleaseBody.schemaPassed,false);assert.equal(unexpectedRuleReleaseBody.criticalDatabaseControlsPassed,false);
liveDatabaseControlRows=healthyDatabaseControlRows.map(row=>row.object_name==="trg_agreement_execution_controls"?{...row,enabled:"D"}:row);
assert.equal(databaseControls.evaluateCriticalDatabaseControls(liveDatabaseControlRows).ok,false,"a disabled critical trigger is schema drift");
releaseResponse=await releaseHealth.GET(new Request("https://contracttwin.test/api/health/release",{headers:releaseHeaders}));
assert.equal(releaseResponse.status,503,"release health must fail closed when a critical execution trigger is disabled despite intact migration receipts");
const driftedReleaseBody=await releaseResponse.json();assert.equal(driftedReleaseBody.schemaPassed,false);assert.equal(driftedReleaseBody.criticalDatabaseControlsPassed,false);
for(const [name,value] of Object.entries(savedReleaseEnvironment)){if(value===undefined)delete process.env[name];else process.env[name]=value;}

const pipeline=fs.readFileSync(path.join(root,"workflows/full-contract-pipeline.ts"),"utf8");
assert.ok(pipeline.indexOf('"MALWARE_SCAN"')<pipeline.indexOf('"EXTRACT"'),"malware scanning must precede extraction");
assert.doesNotMatch(pipeline,/EXECUTIVE_SUMMARY/,"document processing must not auto-freeze an executive snapshot");
assert.match(pipeline,/dependencyJobId/,"pipeline must run the dependency job returned by its exact term run");
assert.match(pipeline,/randomUUID\(\)/,"each workflow invocation must use a distinct worker lease identity");
const jobs=fs.readFileSync(path.join(root,"lib/jobs.ts"),"utf8");
const continuation=jobs.slice(jobs.indexOf("export async function continueJob"),jobs.indexOf("export async function waitExternal"));
assert.match(continuation,/status='WAITING_EXTERNAL'/,"internal continuation must not consume the retry budget");
assert.doesNotMatch(continuation,/status='QUEUED'/,"internal continuation must not masquerade as a retry");
const syncAnalyze=fs.readFileSync(path.join(root,"app/api/documents/[id]/analyze/route.ts"),"utf8");
assert.match(syncAnalyze,/Synchronous persistence is disabled/);
const purge=fs.readFileSync(path.join(root,"app/api/purge-requests/[id]/route.ts"),"utf8");
assert.ok(purge.indexOf("PENDING_PURGE")<purge.indexOf("await del("),"recoverable database marker must precede external deletion");
assert.match(purge,/BlobNotFoundError/);
assert.match(purge,/Cancellation is blocked after purge execution begins/);
const snapshot=fs.readFileSync(path.join(root,"lib/jobProcessor.ts"),"utf8");
for(const required of ["agreement_version_id","sourceChunks","analysisRuns:latestRuns","sourceManifestCanonical","matterContext","requestedAgreementVersionId","requestedEconomicsRunId","requestedAuditId","review_note","security_scan_status","server_sha256"])assert.match(snapshot,new RegExp(required),`snapshot must bind ${required}`);
for(const required of [/annual_revenue::text annual_revenue/,/updated_at::text updated_at/,/effective_date::text effective_date/,/reviewed_at::text reviewed_at/,/created_at::text created_at/])assert.match(snapshot,required,"snapshot receipt evidence must preserve exact PostgreSQL numeric/timestamp text without JavaScript precision loss");
const runtimePrincipalSource=fs.readFileSync(path.join(root,"lib/runtimeDatabasePrincipal.ts"),"utf8");
for(const required of ["session_user=current_user","rolsuper","rolcreaterole","rolcreatedb","rolreplication","rolbypassrls","pg_catalog.pg_has_role","pg_read_all_data","pg_write_all_data","select c.relowner from pg_catalog.pg_class c","p.proowner","'CREATE'","'TEMP'","'TRIGGER'","'TRUNCATE'","'REFERENCES'","'MAINTAIN'","has_sequence_privilege","session_replication_role","has_parameter_privilege","schema_migrations","release_database_identity","release_target_receipts","release_control_tables_read_only","p.prosecdef","has_function_privilege","canonical_jsonb_text","lock_documents_for_legal_publication","executive_snapshot_receipt_verified"]){assert.ok(runtimePrincipalSource.includes(required),`runtime principal proof must include ${required}`);}
const databaseControlAcceptance=fs.readFileSync(path.join(root,"scripts/db-control-acceptance-check.mjs"),"utf8");
for(const required of ["delete environment[name]","scripts/db-integration-check.mjs","scripts/target-schema-drift-check.mjs","scripts/runtime-database-principal-integration-check.mjs"]){assert.ok(databaseControlAcceptance.includes(required),`database-control acceptance must isolate and execute ${required}`);}
const ciRuntimeProvisioner=fs.readFileSync(path.join(root,"scripts/provision-ci-runtime-role.mjs"),"utf8");
for(const required of ["process.env.CI!==\"true\"","process.env.GITHUB_ACTIONS!==\"true\"","disposable-postgres-service","localhost","127.0.0.1","randomBytes(36)","::add-mask::","nosuperuser nocreatedb nocreaterole noinherit noreplication nobypassrls","revoke temporary","schema_migrations","revoke execute on function"]){assert.ok(ciRuntimeProvisioner.includes(required),`CI runtime-role provisioner must include ${required}`);}
const productionSchemaGate=fs.readFileSync(path.join(root,"scripts/production-schema-gate.mjs"),"utf8");
assert.match(productionSchemaGate,/MIGRATION_DATABASE_URL/);
assert.match(productionSchemaGate,/CHILD_ENVIRONMENT_ALLOWLIST/);
assert.doesNotMatch(productionSchemaGate,/Object\.fromEntries\(variables\)/,"database subprocesses must not inherit pulled Vercel secrets");
assert.match(productionSchemaGate,/const migrationEnvironment=childEnvironment\(\{DATABASE_URL:migrationDatabaseUrl\}\)/);
assert.match(productionSchemaGate,/RUNTIME_DATABASE_URL:runtimeDatabaseUrl/);
assert.doesNotMatch(productionSchemaGate,/childEnvironment\(\{[^}]*MIGRATION_DATABASE_URL/s,"migration credential must never enter a child environment");
assert.ok(productionSchemaGate.indexOf('run("db:verify-migration-transport"')<productionSchemaGate.indexOf('run("db:migrate"'),"migration TLS evidence must precede migration acceptance");
assert.ok(productionSchemaGate.indexOf('run("db:verify-runtime-transport"')<productionSchemaGate.indexOf("const binding=await establishReleaseTargetBinding"),"runtime TLS evidence must precede release-target binding");
for(const required of ["establishReleaseTargetBinding","release_target_nonce","::add-mask::","GITHUB_OUTPUT","NODE_TLS_REJECT_UNAUTHORIZED","PGOPTIONS","PGSSLMODE","test:runtime-db-principal"]){assert.match(productionSchemaGate,new RegExp(required),`production schema gate must include ${required}`);}
assert.match(productionSchemaGate,/test:runtime-db-principal/);
const productionEnvironmentCheck=fs.readFileSync(path.join(root,"scripts/production-env-check.mjs"),"utf8");
assert.match(productionEnvironmentCheck,/MIGRATION_DATABASE_URL must remain a protected CI-only secret/);
for(const required of ["sslmode=verify-full","NODE_TLS_REJECT_UNAUTHORIZED","PGOPTIONS","PGSSLMODE"]){assert.match(productionEnvironmentCheck,new RegExp(required),`production environment gate must enforce ${required}`);}
const postdeploy=fs.readFileSync(path.join(root,"scripts/production-postdeploy-check.mjs"),"utf8");
for(const required of ["runtimeDatabasePrincipalPassed","runtimeDatabaseTransportPassed","releaseTargetBindingPassed","exactMigrationReceiptsPassed","RELEASE_TARGET_NONCE","x-contracttwin-release-target-nonce","Cache-Control","no-cache","cache:\"no-store\"","non-apex vercel.app HTTPS URL"]){assert.match(postdeploy,new RegExp(required),`postdeploy gate must include ${required}`);}
const deploymentWorkflow=fs.readFileSync(path.join(root,"..",".github","workflows","commercial-legal-cockpit-vercel.yml"),"utf8");
const migrationSecretLines=deploymentWorkflow.split(/\r?\n/).filter(line=>line.includes("MIGRATION_DATABASE_URL"));
assert.equal(migrationSecretLines.length,1,"migration credential must appear in exactly one production workflow step");
assert.match(migrationSecretLines[0],/MIGRATION_DATABASE_URL:\s*\$\{\{ secrets\.MIGRATION_DATABASE_URL \}\}/);
assert.match(deploymentWorkflow,/cancel-in-progress:\s*false/,"release workflows must serialize instead of interrupting an in-flight migration and promotion protocol");
assert.ok(deploymentWorkflow.indexOf("- name: Build production")<deploymentWorkflow.indexOf("- name: Apply and verify exact target database migrations"),"production build must succeed before the production database is mutated");
assert.ok(deploymentWorkflow.indexOf("- name: Apply and verify exact target database migrations")<deploymentWorkflow.indexOf("- name: Stage production build"),"schema target binding must remain immediately upstream of staging");
assert.match(deploymentWorkflow,/CONTRACTTWIN_RELEASE_SHA:\s*\$\{\{ github\.sha \}\}/,"build must bind the exact approved source SHA");
assert.match(deploymentWorkflow,/--env CONTRACTTWIN_RELEASE_SHA="\$GITHUB_SHA"/,"prebuilt deployment must receive the exact approved runtime source SHA");
assert.doesNotMatch(deploymentWorkflow,/CONTRACTTWIN_RELEASE_SOURCE_SHA/,"release SHA binding must use one exact environment name");
assert.match(deploymentWorkflow,/RELEASE_TARGET_NONCE:\s*\$\{\{ steps\.schema_gate\.outputs\.release_target_nonce \}\}/,"the protected target nonce must flow only from schema gate to staged attestation");
assert.equal((deploymentWorkflow.match(/git fetch --no-tags origin \+refs\/heads\/main:refs\/remotes\/origin\/main/g)||[]).length,2,"main must be current both after approval and immediately before promotion");
for(const stepName of ["Install pinned Vercel CLI","Apply and verify exact target database migrations","Verify staged live controls and exact source SHA"]){
  const start=deploymentWorkflow.indexOf(`- name: ${stepName}`);const next=deploymentWorkflow.indexOf("\n      - name:",start+1);const step=deploymentWorkflow.slice(start,next<0?deploymentWorkflow.length:next);
  assert.doesNotMatch(step,/VERCEL_(?:TOKEN|ORG_ID|PROJECT_ID)/,`${stepName} must not inherit Vercel deployment authority`);
}
for(const workflowName of ["commercial-legal-cockpit.yml","commercial-legal-cockpit-vercel.yml","contracttwin-release-attestation.yml"]){
  const workflow=fs.readFileSync(path.join(root,"..",".github","workflows",workflowName),"utf8");
  assert.match(workflow,/CI_RUNTIME_ROLE_PROVISIONING: disposable-postgres-service/,`${workflowName} must explicitly constrain disposable runtime-role provisioning`);
  assert.match(workflow,/RUNTIME_DATABASE_URL:\s*\$\{\{ steps\.ci-runtime\.outputs\.runtime_database_url \}\}/,`${workflowName} must pass only the masked disposable runtime URL into database-control acceptance`);
}
const vercelConfiguration=JSON.parse(fs.readFileSync(path.join(root,"vercel.json"),"utf8"));
assert.equal(vercelConfiguration?.git?.deploymentEnabled,false,"Vercel Git auto-deployments must remain disabled so production promotion cannot bypass the approval-gated CLI workflow");
const exampleEnvironment=fs.readFileSync(path.join(root,".env.example"),"utf8");
assert.doesNotMatch(exampleEnvironment,/^MIGRATION_DATABASE_URL=/m,"migration credential must never be presented as a Vercel/runtime environment setting");

console.log("Security-boundary checks passed: malware gate, authority derivation, canonical state hash, durable analysis, controlled purge, snapshot provenance, exact-schema fingerprints, and split least-privilege runtime database identity.");
