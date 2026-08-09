import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import ts from "typescript";

const repo=process.cwd();

function loadTypeScriptModule(relativePath,mocks){
  const filename=path.join(repo,relativePath);
  const source=fs.readFileSync(filename,"utf8");
  const output=ts.transpileModule(source,{
    compilerOptions:{module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2022,esModuleInterop:true},
    fileName:filename
  }).outputText;
  const module={exports:{}};
  const localRequire=(id)=>{
    if(Object.hasOwn(mocks,id))return mocks[id];
    if(id==="@/lib/safeErrors")return {
      internalErrorResponse:(_error,message="The request could not be completed.",status=500)=>Response.json({ok:false,error:message,correlationId:"00000000-0000-4000-8000-000000000000"},{status}),
      safeErrorCode:()=>"UNCLASSIFIED",
      safeOperationalFailure:(_error,message)=>({correlationId:"00000000-0000-4000-8000-000000000000",message:`${message} Reference: 00000000-0000-4000-8000-000000000000.`}),
      safePersistedFailureForDisplay:(_value,message="Processing failed.")=>message
    };
    throw new Error(`Unexpected import ${id} while loading ${relativePath}`);
  };
  new Function("require","module","exports",output)(localRequire,module,module.exports);
  return module.exports;
}

class MockAccessError extends Error {
  constructor(message,status){super(message);this.status=status;}
}

const state={
  principal:{userId:"admin-1",name:"Admin One",role:"ADMIN",demo:false},
  activeAdmin:true,
  target:{id:"user-2",email:"counsel@example.com",name:"Counsel Two"},
  targetRole:{role:"LAWYER",active:true},
  capabilityRecord:null,
  transactionCount:0,
  upserts:[],
  audits:[]
};

const client={
  query:async(sql,values=[])=>{
    if(/select role,active from app_user_roles/i.test(sql)){
      assert.match(sql,/for share/i,"target role must be locked through the capability change");
      return {rows:state.targetRole?[state.targetRole]:[],rowCount:state.targetRole?1:0};
    }
    if(/from app_user_roles/i.test(sql)){
      assert.match(sql,/role='ADMIN' and active=true/i,"transaction must recheck active Admin authority");
      assert.match(sql,/for update/i,"Admin authority must be locked through commit");
      return {rows:state.activeAdmin?[{authorized:1}]:[],rowCount:state.activeAdmin?1:0};
    }
    if(/from "user"/i.test(sql)){
      assert.match(sql,/for update/i,"target identity must serialize first-time capability changes and concurrent deletion");
      return {rows:state.target?[state.target]:[],rowCount:state.target?1:0};
    }
    if(/select active\s+from app_user_capabilities/i.test(sql)){
      assert.match(sql,/for update/i,"capability state must be serialized");
      return {rows:state.capabilityRecord?[state.capabilityRecord]:[],rowCount:state.capabilityRecord?1:0};
    }
    if(/insert into app_user_capabilities/i.test(sql)){
      state.upserts.push({sql,values});
      state.capabilityRecord={active:values[2]};
      return {rows:[],rowCount:1};
    }
    if(/insert into audit_events/i.test(sql)){
      state.audits.push({sql,values});
      return {rows:[],rowCount:1};
    }
    throw new Error(`Unexpected capability query: ${sql}`);
  }
};

const accessMocks={
  AccessError:MockAccessError,
  requireRole:async(_request,role)=>{
    assert.equal(role,"ADMIN");
    return state.principal;
  },
  accessErrorResponse:(error)=>error instanceof MockAccessError
    ? Response.json({ok:false,error:error.message},{status:error.status})
    : null
};

const capabilityRoute=loadTypeScriptModule("app/api/admin/capabilities/route.ts",{
  "@/lib/access":accessMocks,
  "@/lib/db":{
    databaseConfigured:()=>true,
    withTransaction:async(fn)=>{state.transactionCount+=1;return fn(client);}
  }
});

const makeRequest=(overrides={})=>new Request("https://contracttwin.test/api/admin/capabilities",{
  method:"POST",
  headers:{"content-type":"application/json"},
  body:JSON.stringify({
    userId:"user-2",
    capability:"LEGAL_COUNSEL_ATTEST",
    active:true,
    confirmLegalCounselAuthority:true,
    reason:"Appointed under Legal policy LEG-42.",
    ...overrides
  })
});

let response=await capabilityRoute.POST(makeRequest({capability:"ADMIN"}));
assert.equal(response.status,400,"a different capability must be rejected");
assert.equal(state.transactionCount,0,"invalid capability input must not reach persistence");

response=await capabilityRoute.POST(makeRequest({confirmLegalCounselAuthority:false}));
assert.equal(response.status,400,"a grant without explicit authority confirmation must be rejected");
assert.equal(state.transactionCount,0);

response=await capabilityRoute.POST(makeRequest({reason:"too short"}));
assert.equal(response.status,400,"an unauditable reason must be rejected");
assert.equal(state.transactionCount,0);

state.principal={...state.principal,userId:"user-2"};
response=await capabilityRoute.POST(makeRequest());
assert.equal(response.status,409,"self authority changes require a second explicit confirmation");
assert.equal(state.transactionCount,0);
state.principal={...state.principal,userId:"admin-1"};

state.activeAdmin=false;
response=await capabilityRoute.POST(makeRequest());
assert.equal(response.status,403,"an Admin demoted after request authentication must fail inside the transaction");
assert.equal(state.upserts.length,0);
assert.equal(state.audits.length,0);

state.activeAdmin=true;
state.target=null;
response=await capabilityRoute.POST(makeRequest());
assert.equal(response.status,404,"authority cannot be granted to an unknown identity");
assert.equal(state.upserts.length,0);
assert.equal(state.audits.length,0);

state.target={id:"user-2",email:"counsel@example.com",name:"Counsel Two"};
state.targetRole={role:"VIEWER",active:true};
response=await capabilityRoute.POST(makeRequest());
assert.equal(response.status,409,"counsel authority cannot be granted to an active Viewer");
assert.equal(state.upserts.length,0);
state.targetRole={role:"LAWYER",active:true};
state.capabilityRecord=null;
response=await capabilityRoute.POST(makeRequest());
assert.equal(response.status,200,"a confirmed active Admin grant must remain available");
let body=await response.json();
assert.equal(body.changed,true);
assert.equal(body.active,true);
assert.equal(state.upserts.length,1);
assert.deepEqual(state.upserts[0].values,["user-2","LEGAL_COUNSEL_ATTEST",true,"admin-1"]);
assert.equal(state.audits.length,1,"the capability mutation and audit event must share one transaction");
assert.match(state.audits[0].sql,/LEGAL_COUNSEL_AUTHORITY_CHANGED/);
let auditMetadata=JSON.parse(state.audits[0].values[3]);
assert.equal(auditMetadata.operation,"GRANT");
assert.equal(auditMetadata.reason,"Appointed under Legal policy LEG-42.");
assert.equal(auditMetadata.selfChange,false);

response=await capabilityRoute.POST(makeRequest());
body=await response.json();
assert.equal(body.changed,false,"an idempotent grant must not rewrite grant provenance");
assert.equal(state.upserts.length,1);
assert.equal(state.audits.length,1);

response=await capabilityRoute.POST(makeRequest({active:false,reason:"Counsel appointment ended per LEG-42."}));
assert.equal(response.status,200,"an explicit revoke must remain available");
body=await response.json();
assert.equal(body.changed,true);
assert.equal(body.active,false);
assert.equal(state.upserts.length,2);
assert.equal(state.audits.length,2);
auditMetadata=JSON.parse(state.audits[1].values[3]);
assert.equal(auditMetadata.operation,"REVOKE");
assert.equal(auditMetadata.previousActive,true);

state.principal={...state.principal,userId:"user-2"};
state.activeAdmin=true;
state.capabilityRecord={active:false};
response=await capabilityRoute.POST(makeRequest({confirmSelfChange:true,reason:"Self appointment approved under LEG-99."}));
assert.equal(response.status,200,"a separately confirmed self change by an active Admin remains explicit and supported");
auditMetadata=JSON.parse(state.audits.at(-1).values[3]);
assert.equal(auditMetadata.selfChange,true);

let rolesSql="";
const rolesRoute=loadTypeScriptModule("app/api/admin/roles/route.ts",{
  "@/lib/access":accessMocks,
  "@/lib/db":{
    databaseConfigured:()=>true,
    query:async(sql)=>{
      rolesSql=sql;
      return {rows:[{user_id:"user-2",role:"LAWYER",legal_counsel_attest_active:true}]};
    },
    withTransaction:async()=>{throw new Error("POST role mutation not exercised");}
  }
});
state.principal={...state.principal,userId:"admin-1"};
response=await rolesRoute.GET(new Request("https://contracttwin.test/api/admin/roles"));
assert.equal(response.status,200);
body=await response.json();
assert.equal(body.currentUserId,"admin-1");
assert.equal(body.users[0].legal_counsel_attest_active,true);
assert.match(rolesSql,/left join app_user_capabilities/i,"authenticated-user listing must expose counsel capability state");
assert.match(rolesSql,/c\.capability='LEGAL_COUNSEL_ATTEST'/i);

const roleMutationState={
  roles:new Map([
    ["admin-1",{role:"ADMIN",active:true}],
    ["user-2",{role:"LAWYER",active:true}]
  ]),
  users:new Map([
    ["admin-1",{id:"admin-1",email:"admin@example.com"}],
    ["user-2",{id:"user-2",email:"counsel@example.com"}]
  ]),
  counselActive:true,
  sawTableLock:false,
  upserts:[],
  audits:[]
};
const roleMutationClient={
  query:async(sql,values=[])=>{
    if(/lock table app_user_roles in share row exclusive mode/i.test(sql)){
      roleMutationState.sawTableLock=true;
      return {rows:[],rowCount:0};
    }
    if(/select role from app_user_roles where user_id=\$1 and active=true for update/i.test(sql)){
      const record=roleMutationState.roles.get(values[0]);
      return {rows:record?.active?[{role:record.role}]:[],rowCount:record?.active?1:0};
    }
    if(/select id,email from "user" where id=\$1 for share/i.test(sql)){
      const user=roleMutationState.users.get(values[0]);
      return {rows:user?[user]:[],rowCount:user?1:0};
    }
    if(/insert into app_user_roles/i.test(sql)){
      roleMutationState.roles.set(values[0],{role:values[1],active:values[2]});
      roleMutationState.upserts.push({sql,values});
      return {rows:[],rowCount:1};
    }
    if(/select count\(\*\)::int count from app_user_roles/i.test(sql)){
      const count=[...roleMutationState.roles.values()].filter(record=>record.role==="ADMIN"&&record.active).length;
      return {rows:[{count}],rowCount:1};
    }
    if(/update app_user_capabilities set active=false/i.test(sql)){
      const changed=roleMutationState.counselActive;
      roleMutationState.counselActive=false;
      return {rows:[],rowCount:changed?1:0};
    }
    if(/insert into audit_events/i.test(sql)){
      roleMutationState.audits.push({sql,values});
      return {rows:[],rowCount:1};
    }
    throw new Error(`Unexpected role-mutation query: ${sql}`);
  }
};
const rolesMutationRoute=loadTypeScriptModule("app/api/admin/roles/route.ts",{
  "@/lib/access":accessMocks,
  "@/lib/db":{
    databaseConfigured:()=>true,
    query:async()=>({rows:[]}),
    withTransaction:async(fn)=>fn(roleMutationClient)
  }
});
const makeRoleRequest=(requestBody)=>new Request("https://contracttwin.test/api/admin/roles",{
  method:"POST",
  headers:{"content-type":"application/json"},
  body:JSON.stringify(requestBody)
});

roleMutationState.roles.set("admin-1",{role:"APPROVER",active:true});
response=await rolesMutationRoute.POST(makeRoleRequest({userId:"user-2",role:"LAWYER",active:true}));
assert.equal(response.status,403,"an administrator demoted after authentication must fail the transaction-time authority recheck");
assert.equal(roleMutationState.upserts.length,0);
assert.equal(roleMutationState.audits.length,0);

roleMutationState.roles.set("admin-1",{role:"ADMIN",active:true});
response=await rolesMutationRoute.POST(makeRoleRequest({userId:"admin-1",role:"APPROVER",active:true}));
assert.equal(response.status,409,"an active administrator cannot self-demote");
assert.equal(roleMutationState.upserts.length,0);

response=await rolesMutationRoute.POST(makeRoleRequest({userId:"user-2",role:"VIEWER",active:true}));
assert.equal(response.status,200,"a serialized role mutation by a currently active administrator remains available");
body=await response.json();
assert.equal(body.counselCapabilityRevoked,true,"a Viewer role must not retain legal-counsel attestation authority");
assert.equal(roleMutationState.sawTableLock,true,"role changes must serialize to prevent cross-demotion races");
assert.equal(roleMutationState.upserts.length,1);
assert.equal(roleMutationState.audits.length,1,"the role change and audit record must share the transaction");
assert.deepEqual(roleMutationState.roles.get("user-2"),{role:"VIEWER",active:true});

const adminUi=fs.readFileSync(path.join(repo,"components/AdminConsole.tsx"),"utf8");
assert.match(adminUi,/This capability is separate from Viewer, Lawyer, Approver, and Admin roles/);
assert.match(adminUi,/It does not grant matter access or approval authority/);
assert.match(adminUi,/confirmLegalCounselAuthority:true/);
assert.match(adminUi,/confirmSelfChange:selfChange/);

const authorityMigration=fs.readFileSync(path.join(repo,"db/migrations/011_authority_evidence_hardening.sql"),"utf8");
assert.match(authorityMigration,/create or replace function public\.enforce_human_review_record\(\)/i,"the DB review trigger function must be replaced in a forward migration");
assert.match(authorityMigration,/capability_record\.user_id=new\.reviewed_by[\s\S]*capability_record\.capability='LEGAL_COUNSEL_ATTEST'[\s\S]*capability_record\.active=true/i,"the DB must bind active counsel authority to the recorded reviewer");
assert.match(authorityMigration,/for share/i,"the DB review trigger must lock the authority row through disposition commit");
assert.match(authorityMigration,/Human disposition requires active LEGAL_COUNSEL_ATTEST capability/);

for(const reviewRoute of [
  "app/api/findings/[id]/review/route.ts",
  "app/api/graph/review/route.ts",
  "app/api/matters/[id]/relations/route.ts"
]){
  const source=fs.readFileSync(path.join(repo,reviewRoute),"utf8");
  assert.match(source,/capability='LEGAL_COUNSEL_ATTEST' and active=true for share/i,`${reviewRoute} must lock current counsel authority inside the write transaction`);
  assert.match(source,/principal\.userId/,`${reviewRoute} must check the authenticated reviewer identity`);
  assert.match(source,/new AccessError\("Active legal-counsel attestation authority[^\n]+,403\)/,`${reviewRoute} must return a safe 403 before the DB backstop`);
}
const counselRelationRoute=fs.readFileSync(path.join(repo,"app/api/matters/[id]/relations/route.ts"),"utf8");
assert.match(counselRelationRoute,/'VALIDATED',\$7,\$7,now\(\),\$6/,"a counsel-authored validated relation must record the authenticated identity as both creator and reviewer");

console.log("Legal-counsel capability and Admin-role mutation checks passed, including transaction-time authority, serialization, safe API prechecks, and DB-authoritative legal dispositions.");
