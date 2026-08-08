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

const adminUi=fs.readFileSync(path.join(repo,"components/AdminConsole.tsx"),"utf8");
assert.match(adminUi,/This capability is separate from Viewer, Lawyer, Approver, and Admin roles/);
assert.match(adminUi,/It does not grant matter access or approval authority/);
assert.match(adminUi,/confirmLegalCounselAuthority:true/);
assert.match(adminUi,/confirmSelfChange:selfChange/);

console.log("Legal-counsel capability regression checks passed.");
