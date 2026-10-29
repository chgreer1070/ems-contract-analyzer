import assert from "node:assert/strict";
import {createSign,generateKeyPairSync} from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import ts from "typescript";
import {
  MICROSOFT_ACCOUNT_CUTOVER_ID,
  MICROSOFT_AUTHORITY,
  MICROSOFT_CONSUMER_TENANT_ID,
  MicrosoftAccountCutoverError,
  applyMicrosoftAccountSubjectCutover,
  microsoftJwksUrl,
  parseMicrosoftAccountOidExport,
  planMicrosoftAccountSubjectCutover,
  verifyStoredMicrosoftIdToken
} from "./microsoft-account-subject.mjs";

const root=process.cwd();
const tenant="11111111-1111-4111-8111-111111111111";
const clientId="app-client";
const oid="22222222-2222-4222-8222-222222222222";
const subject="33333333-3333-4333-8333-333333333333";
const otherOid="44444444-4444-4444-8444-444444444444";
const now=1_700_000_000_000;
const {publicKey,privateKey}=generateKeyPairSync("rsa",{modulusLength:2048});
const jwk=publicKey.export({format:"jwk"});
jwk.kid="test-key";
jwk.alg="RS256";
jwk.kty="RSA";
const fetchJwks=async url=>{
  assert.equal(url,microsoftJwksUrl(tenant));
  return {keys:[jwk]};
};

function sign(payload,{kid="test-key",alg="RS256"}={}){
  const header=Buffer.from(JSON.stringify({alg,typ:"JWT",kid})).toString("base64url");
  const body=Buffer.from(JSON.stringify(payload)).toString("base64url");
  const data=`${header}.${body}`;
  const signature=createSign("RSA-SHA256").update(data).sign(privateKey).toString("base64url");
  return `${data}.${signature}`;
}

function claims(overrides={}){
  const issuedAt=Math.floor(now/1000)-7200;
  return {
    iss:`${MICROSOFT_AUTHORITY}/${tenant}/v2.0`,
    aud:clientId,
    tid:tenant,
    oid,
    sub:subject,
    iat:issuedAt,
    exp:issuedAt+3600,
    ...overrides
  };
}

async function expectCode(code,fn){
  await assert.rejects(fn,error=>error instanceof MicrosoftAccountCutoverError&&error.code===code);
}

const verified=await verifyStoredMicrosoftIdToken(sign(claims()),{clientId,tenantId:tenant,now,fetchJwks});
assert.deepEqual(verified,{oid,sub:subject,tenantId:tenant},"an expired but signed Microsoft id token remains usable as cutover evidence");
await expectCode("TOKEN_REJECTED",()=>verifyStoredMicrosoftIdToken(sign(claims(),{alg:"none"}),{clientId,tenantId:tenant,now,fetchJwks}));
await expectCode("TOKEN_REJECTED",()=>verifyStoredMicrosoftIdToken(`${sign(claims()).split(".").slice(0,2).join(".")}.AAAA`,{clientId,tenantId:tenant,now,fetchJwks}));
await expectCode("TOKEN_REJECTED",()=>verifyStoredMicrosoftIdToken(sign(claims({aud:"other-app"})),{clientId,tenantId:tenant,now,fetchJwks}));
await expectCode("TOKEN_REJECTED",()=>verifyStoredMicrosoftIdToken(sign(claims({tid:MICROSOFT_CONSUMER_TENANT_ID,iss:`${MICROSOFT_AUTHORITY}/${MICROSOFT_CONSUMER_TENANT_ID}/v2.0`})),{clientId,tenantId:"organizations",now,fetchJwks:async()=>({keys:[jwk]})}));
await expectCode("TOKEN_REJECTED",()=>verifyStoredMicrosoftIdToken(sign(claims({iat:Math.floor(now/1000)+3600,exp:Math.floor(now/1000)+7200})),{clientId,tenantId:tenant,now,fetchJwks}));
const consumer=await verifyStoredMicrosoftIdToken(sign(claims({tid:MICROSOFT_CONSUMER_TENANT_ID,iss:`${MICROSOFT_AUTHORITY}/${MICROSOFT_CONSUMER_TENANT_ID}/v2.0`})),{clientId,tenantId:"consumers",now,fetchJwks:async()=>({keys:[jwk]})});
assert.equal(consumer.tenantId,MICROSOFT_CONSUMER_TENANT_ID,"the consumer endpoint accepts only the personal Microsoft directory");

const rewrite=planMicrosoftAccountSubjectCutover({
  rows:[{id:"row-1",providerId:"microsoft",accountId:subject}],
  subjectsByRowId:new Map([["row-1",verified]]),
  exportEntries:null
});
assert.equal(rewrite.evidenceSource,"verified-id-token");
assert.deepEqual(rewrite.updates,[{id:"row-1",providerId:"microsoft",fromAccountId:subject,oid}]);
const aligned=planMicrosoftAccountSubjectCutover({
  rows:[{id:"row-1",providerId:"microsoft",accountId:oid}],
  subjectsByRowId:new Map([["row-1",verified]]),
  exportEntries:null
});
assert.equal(aligned.rewrittenCount,0);
assert.equal(aligned.alreadyAlignedCount,1);
await expectCode("IDENTITY_MISMATCH",async()=>planMicrosoftAccountSubjectCutover({
  rows:[{id:"row-1",providerId:"microsoft",accountId:otherOid}],
  subjectsByRowId:new Map([["row-1",verified]]),
  exportEntries:null
}));
await expectCode("UNMAPPED_ACCOUNT",async()=>planMicrosoftAccountSubjectCutover({
  rows:[{id:"row-1",providerId:"microsoft",accountId:subject}],
  subjectsByRowId:new Map(),
  exportEntries:null
}));
await expectCode("DUPLICATE_TARGET",async()=>planMicrosoftAccountSubjectCutover({
  rows:[
    {id:"row-1",providerId:"microsoft",accountId:subject},
    {id:"row-2",providerId:"microsoft",accountId:otherOid}
  ],
  subjectsByRowId:new Map([
    ["row-1",verified],
    ["row-2",{oid,sub:otherOid,tenantId:tenant}]
  ]),
  exportEntries:null
}));

const exportText=JSON.stringify({version:1,entries:[{providerId:"microsoft",previousAccountId:subject,oid,tenantId:tenant}]});
const parsed=parseMicrosoftAccountOidExport(exportText,tenant);
const exported=planMicrosoftAccountSubjectCutover({
  rows:[{id:"row-1",providerId:"microsoft-entra-id",accountId:subject}],
  subjectsByRowId:new Map(),
  exportEntries:parseMicrosoftAccountOidExport(JSON.stringify({version:1,entries:[{providerId:"microsoft-entra-id",previousAccountId:subject,oid,tenantId:tenant}]}),"common")
});
assert.equal(exported.evidenceSource,"entra-export");
assert.equal(exported.updates[0].oid,oid);
const secondRun=planMicrosoftAccountSubjectCutover({
  rows:[{id:"row-1",providerId:"microsoft",accountId:oid}],
  subjectsByRowId:new Map(),
  exportEntries:parsed
});
assert.equal(secondRun.rewrittenCount,0,"a second run recognizes an account id that is already the directory object id");
await expectCode("EXPORT_MISMATCH",async()=>planMicrosoftAccountSubjectCutover({
  rows:[{id:"row-1",providerId:"microsoft",accountId:subject}],
  subjectsByRowId:new Map([["row-1",verified]]),
  exportEntries:[{providerId:"microsoft",previousAccountId:subject,oid:otherOid,tenantId:tenant}]
}));
await expectCode("EXTRA_EXPORT_ENTRY",async()=>planMicrosoftAccountSubjectCutover({
  rows:[],
  subjectsByRowId:new Map(),
  exportEntries:parsed
}));
await expectCode("EXPORT_INVALID",async()=>parseMicrosoftAccountOidExport(exportText,"consumers"));
const empty=planMicrosoftAccountSubjectCutover({rows:[],subjectsByRowId:new Map(),exportEntries:null});
assert.equal(empty.evidenceSource,"no-microsoft-accounts");

function fakeClient(state){
  return {async query(sql,params=[]){
    const text=sql.replace(/\s+/g," ").trim();
    state.queries.push({text,params});
    if(text.startsWith("create table"))return {rows:[],rowCount:0};
    if(text.startsWith("revoke"))return {rows:[],rowCount:0};
    if(text.includes("information_schema.columns"))return {rows:state.columns};
    if(text.includes("group by"))return {rows:state.duplicates};
    if(text.includes("from public.microsoft_account_subject_cutover"))return {rows:state.marker};
    if(text.includes("from public.account"))return {rows:state.accounts};
    if(text.startsWith("update public.account")){
      state.updates.push(params);
      return {rows:[],rowCount:1};
    }
    if(text.startsWith("insert into public.microsoft_account_subject_cutover")){
      state.inserted=params;
      return {rows:[],rowCount:1};
    }
    throw new Error(`Unexpected cutover SQL: ${text}`);
  }};
}

const columns=[
  {column_name:"id",is_nullable:"NO"},
  {column_name:"providerId",is_nullable:"NO"},
  {column_name:"accountId",is_nullable:"NO"},
  {column_name:"idToken",is_nullable:"YES"},
  {column_name:"updatedAt",is_nullable:"NO"}
];
const token=sign(claims());
const recordedState={queries:[],columns,duplicates:[],marker:[],accounts:[{id:"row-1",provider_id:"microsoft",account_id:subject,id_token:token}],updates:[],inserted:null};
const recorded=await applyMicrosoftAccountSubjectCutover(fakeClient(recordedState),{MICROSOFT_CLIENT_ID:clientId,MICROSOFT_TENANT_ID:tenant},{fetchJwks,now});
assert.equal(recorded.status,"recorded");
assert.deepEqual(recordedState.updates,[[oid,"row-1","microsoft",subject]]);
assert.deepEqual(recordedState.inserted,[MICROSOFT_ACCOUNT_CUTOVER_ID,1,0,"verified-id-token"]);
assert.ok(recordedState.queries.some(query=>query.text.includes("for update")),"account rows are locked for the cutover");
const rerun={queries:[],columns,duplicates:[],marker:[{rewritten_count:1,already_aligned_count:0,evidence_source:"verified-id-token"}],accounts:[],updates:[],inserted:null};
const already=await applyMicrosoftAccountSubjectCutover(fakeClient(rerun),{},{fetchJwks,now});
assert.equal(already.status,"already-recorded");
assert.equal(rerun.updates.length,0,"a recorded cutover does not rewrite account ids again");
const issuerState={queries:[],columns:[...columns,{column_name:"issuer",is_nullable:"NO"}],duplicates:[],marker:[],accounts:[],updates:[],inserted:null};
await expectCode("ISSUER_COLUMN",()=>applyMicrosoftAccountSubjectCutover(fakeClient(issuerState),{},{fetchJwks,now}));
assert.equal(issuerState.updates.length,0);
const duplicateState={queries:[],columns,duplicates:[{provider_id:"microsoft",copies:2}],marker:[],accounts:[],updates:[],inserted:null};
await expectCode("DUPLICATE_ACCOUNT_KEY",()=>applyMicrosoftAccountSubjectCutover(fakeClient(duplicateState),{},{fetchJwks,now}));
const unmapped={queries:[],columns,duplicates:[],marker:[],accounts:[{id:"row-1",provider_id:"microsoft",account_id:subject,id_token:null}],updates:[],inserted:null};
await expectCode("UNMAPPED_ACCOUNT",()=>applyMicrosoftAccountSubjectCutover(fakeClient(unmapped),{MICROSOFT_CLIENT_ID:clientId,MICROSOFT_TENANT_ID:tenant},{fetchJwks,now}));

function load(relativePath,mocks){
  const filename=path.join(root,relativePath);
  const source=fs.readFileSync(filename,"utf8");
  const output=ts.transpileModule(source,{compilerOptions:{module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2022,esModuleInterop:true},fileName:filename}).outputText;
  const module={exports:{}};
  const localRequire=id=>Object.hasOwn(mocks,id)?mocks[id]:(()=>{throw new Error(`Unexpected import ${id}`)})();
  new Function("require","module","exports",output)(localRequire,module,module.exports);
  return module.exports;
}

const calls=[];
const db={configured:true,async query(sql,params){calls.push({sql,params});return {rows:[]};}};
const gate=load("lib/microsoftAccountCutover.ts",{"@/lib/db":{databaseConfigured:()=>db.configured,query:(sql,params)=>db.query(sql,params)}});
assert.equal(gate.microsoftSignInAllowed({accountTablePresent:false,microsoftAccountCount:4,cutoverRecorded:false}),true);
assert.equal(gate.microsoftSignInAllowed({accountTablePresent:true,microsoftAccountCount:0,cutoverRecorded:false}),true);
assert.equal(gate.microsoftSignInAllowed({accountTablePresent:true,microsoftAccountCount:2,cutoverRecorded:false}),false);
assert.equal(gate.microsoftSignInAllowed({accountTablePresent:true,microsoftAccountCount:2,cutoverRecorded:true}),true);
const previousAuth=process.env.AUTH_REQUIRED;
delete process.env.AUTH_REQUIRED;
gate.resetMicrosoftAccountCutoverAllowance();
assert.equal(await gate.enforceMicrosoftAccountCutover(),null);
process.env.AUTH_REQUIRED="true";
db.configured=false;
assert.equal(await gate.enforceMicrosoftAccountCutover(),null);
db.configured=true;
db.query=async sql=>{
  calls.push(sql);
  if(sql.includes("to_regclass"))return {rows:[{account_table:true,cutover_table:false}]};
  if(sql.includes("count(*)"))return {rows:[{n:2}]};
  return {rows:[]};
};
const paused=await gate.enforceMicrosoftAccountCutover();
assert.equal(paused.status,503);
const pausedBody=await paused.json();
assert.equal(pausedBody.error,"Microsoft sign-in is paused until the Better Auth 1.7 directory-object account migration is recorded.");
db.query=async()=>{throw new Error("database unavailable");};
const hidden=await gate.enforceMicrosoftAccountCutover();
assert.equal(hidden.status,503);
assert.doesNotMatch(JSON.stringify(await hidden.json()),/database unavailable/);
calls.length=0;
db.query=async sql=>{
  calls.push(sql);
  if(sql.includes("to_regclass"))return {rows:[{account_table:true,cutover_table:true}]};
  if(sql.includes("count(*)"))return {rows:[{n:1}]};
  return {rows:[{present:1}]};
};
gate.resetMicrosoftAccountCutoverAllowance();
assert.equal(await gate.enforceMicrosoftAccountCutover(),null);
const queryCount=calls.length;
assert.equal(await gate.enforceMicrosoftAccountCutover(),null);
assert.equal(calls.length,queryCount,"a completed cutover is remembered for the life of the process");
if(previousAuth===undefined)delete process.env.AUTH_REQUIRED;else process.env.AUTH_REQUIRED=previousAuth;

const authSource=fs.readFileSync(path.join(root,"lib/auth.ts"),"utf8");
assert.match(authSource,/authority:\s*"https:\/\/login\.microsoftonline\.com"/);
assert.doesNotMatch(authSource,/mapProfileToUser|genericOAuth|microsoft-entra-id|signIn\.oauth2/);
const packageManifest=JSON.parse(fs.readFileSync(path.join(root,"package.json"),"utf8"));
assert.equal(packageManifest.dependencies["better-auth"],"1.7.14");
const authMigrate=fs.readFileSync(path.join(root,"scripts/auth-migrate.mjs"),"utf8");
assert.ok(authMigrate.indexOf("targetClient.query(compiledAuthMigrationSql)")<authMigrate.indexOf("applyMicrosoftAccountSubjectCutover(targetClient,process.env)"));
assert.ok(authMigrate.indexOf("applyMicrosoftAccountSubjectCutover(targetClient,process.env)")<authMigrate.indexOf('await targetClient.query("commit")'));
for(const relativePath of ["lib/runtimeDatabasePrincipal.ts","scripts/runtime-database-principal.mjs"]){
  const source=fs.readFileSync(path.join(root,relativePath),"utf8");
  assert.equal([...source.matchAll(/microsoft_account_subject_cutover/g)].length,3,`${relativePath} must treat the cutover record as read-only in every privilege list`);
}
const workflow=fs.readFileSync(path.join(root,"../.github/workflows/commercial-legal-cockpit-vercel.yml"),"utf8");
assert.equal(workflow.split(/\r?\n/).filter(line=>line.includes("MICROSOFT_ACCOUNT_OID_EXPORT")).length,1,"the directory export is a single protected release secret");
assert.doesNotMatch(fs.readFileSync(path.join(root,"../.github/workflows/contracttwin-production-target-bootstrap.yml"),"utf8"),/MICROSOFT_ACCOUNT_OID_EXPORT/);

console.log("Microsoft account subject checks passed: signed directory ids replace app-specific subjects, unsigned exports cannot disagree, and sign-in stays paused until the cutover is recorded.");
