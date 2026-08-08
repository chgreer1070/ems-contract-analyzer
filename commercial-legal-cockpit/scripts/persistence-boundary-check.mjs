import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import ts from "typescript";

const projectRoot=join(dirname(fileURLToPath(import.meta.url)),"..");
const accessPath=join(projectRoot,"lib","access.ts");
const compiledAccess=ts.transpileModule(readFileSync(accessPath,"utf8"),{
  compilerOptions:{module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2022,esModuleInterop:true},
  fileName:accessPath
}).outputText;

function loadAccess(state){
  const module={exports:{}};
  const localRequire=(specifier)=>{
    if(specifier==="@/lib/auth")return {
      auth:{api:{getSession:async()=>state.session}},
      authenticationRequired:()=>state.authenticationRequired
    };
    if(specifier==="@/lib/db")return {
      databaseConfigured:()=>state.databaseConfigured,
      query:async(sql)=>{
        state.queries.push(sql);
        if(sql.includes("app_user_roles"))return {rows:state.role?[{role:state.role}]:[]};
        if(sql.includes("from matters m"))return {rows:state.matter?[state.matter]:[]};
        if(sql.includes("from documents rsc"))return {rows:state.resource?[state.resource]:[]};
        throw new Error(`Unexpected query: ${sql}`);
      }
    };
    throw new Error(`Unexpected import: ${specifier}`);
  };
  new Function("require","module","exports",compiledAccess)(localRequire,module,module.exports);
  return module.exports;
}

const state={
  authenticationRequired:true,
  databaseConfigured:true,
  role:"LAWYER",
  session:{user:{id:"user-1",name:"Test User",email:"test@example.com"}},
  matter:null,
  resource:null,
  queries:[]
};
const access=loadAccess(state);
const request=new Request("https://contracttwin.test/api/documents/00000000-0000-4000-8000-000000000001/content");

const priorDemoAccess=process.env.ALLOW_DEMO_ACCESS;
try{
  process.env.ALLOW_DEMO_ACCESS="true";
  state.authenticationRequired=false;
  state.queries=[];
  await assert.rejects(
    ()=>access.requireResourceMatterAccess(request,"DOCUMENT","00000000-0000-4000-8000-000000000001","VIEW"),
    (error)=>error?.status===503&&/disabled in demo mode/i.test(error.message)
  );
  assert.equal(state.queries.length,0,"demo resource requests must not query persistent storage");
}finally{
  state.authenticationRequired=true;
  if(priorDemoAccess===undefined)delete process.env.ALLOW_DEMO_ACCESS;
  else process.env.ALLOW_DEMO_ACCESS=priorDemoAccess;
}

state.role="LAWYER";
state.resource={matter_id:"matter-1",owner_user_id:"owner-1",restricted:true,member_access:null};
state.queries=[];
let denied;
try{await access.requireResourceMatterAccess(request,"DOCUMENT","00000000-0000-4000-8000-000000000001","VIEW");}
catch(error){denied=error;}
assert.equal(denied?.status,404);
assert.match(denied?.message??"",/not found or access denied/i);
assert.equal(state.queries.length,2,"authenticated resource authorization uses one role lookup and one resource authorization query");

state.resource=null;
state.queries=[];
let missing;
try{await access.requireResourceMatterAccess(request,"DOCUMENT","00000000-0000-4000-8000-000000000002","VIEW");}
catch(error){missing=error;}
assert.deepEqual(
  {status:missing?.status,message:missing?.message,queryCount:state.queries.length},
  {status:denied?.status,message:denied?.message,queryCount:2},
  "missing and inaccessible resource identifiers must have indistinguishable application behavior"
);

state.queries=[];
await assert.rejects(
  ()=>access.requireResourceMatterAccess(request,"DOCUMENT","not-a-uuid","VIEW"),
  (error)=>error?.status===404&&/not found or access denied/i.test(error.message)
);
assert.equal(state.queries.length,1,"malformed resource UUIDs must be rejected after identity resolution but before a resource query");

state.resource={matter_id:"matter-1",owner_user_id:"owner-1",restricted:true,member_access:"EDIT"};
state.queries=[];
const authorized=await access.requireResourceMatterAccess(request,"DOCUMENT","00000000-0000-4000-8000-000000000001","EDIT");
assert.equal(authorized.matterId,"matter-1");
assert.equal(authorized.principal.role,"LAWYER");

state.role="VIEWER";
state.queries=[];
await assert.rejects(
  ()=>access.requireResourceMatterAccess(request,"DOCUMENT","00000000-0000-4000-8000-000000000001","EDIT"),
  (error)=>error?.status===403&&/legal edit access/i.test(error.message)
);
assert.equal(state.queries.length,1,"globally underprivileged identities must be rejected before a resource lookup");

state.role="LAWYER";
state.matter={owner_user_id:"owner-1",restricted:true,member_access:null};
state.queries=[];
let matterDenied;
try{await access.requireMatterAccess(request,"00000000-0000-4000-8000-000000000003","VIEW");}
catch(error){matterDenied=error;}
state.matter=null;
state.queries=[];
let matterMissing;
try{await access.requireMatterAccess(request,"00000000-0000-4000-8000-000000000004","VIEW");}
catch(error){matterMissing=error;}
assert.deepEqual(
  {status:matterMissing?.status,message:matterMissing?.message,queryCount:state.queries.length},
  {status:matterDenied?.status,message:matterDenied?.message,queryCount:2},
  "missing and inaccessible matter identifiers must have indistinguishable application behavior"
);
state.queries=[];
await assert.rejects(
  ()=>access.requireMatterAccess(request,"not-a-uuid","VIEW"),
  (error)=>error?.status===404&&/not found or access denied/i.test(error.message)
);
assert.equal(state.queries.length,1,"malformed matter UUIDs must return a controlled opaque error before the matter query");
state.role="ADMIN";
state.queries=[];
await assert.rejects(
  ()=>access.requireMatterAccess(request,"00000000-0000-4000-8000-000000000005","VIEW"),
  (error)=>error?.status===404&&/not found or access denied/i.test(error.message)
);
assert.equal(state.queries.length,2,"Admin authority must not bypass matter existence validation");

const protectedRoutes=[
  ["app/api/agreement-versions/[id]/status/route.ts",'requireResourceMatterAccess(request,"AGREEMENT_VERSION",id,"APPROVE")'],
  ["app/api/decisions/[id]/route.ts",'requireResourceMatterAccess(request,"DECISION",id,"APPROVE")'],
  ["app/api/documents/[id]/analyze/route.ts",'requireResourceMatterAccess(request,"DOCUMENT",id,"EDIT")'],
  ["app/api/documents/[id]/content/route.ts",'requireResourceMatterAccess(request,"DOCUMENT",id,"VIEW")'],
  ["app/api/documents/[id]/extract/route.ts",'requireResourceMatterAccess(request,"DOCUMENT",id,"EDIT")'],
  ["app/api/documents/[id]/pipeline/route.ts",'requireResourceMatterAccess(request,"DOCUMENT",id,"EDIT")'],
  ["app/api/documents/[id]/purge/route.ts",'requireResourceMatterAccess(request,"DOCUMENT",id,"EDIT")'],
  ["app/api/findings/[id]/review/route.ts",'requireResourceMatterAccess(request,"FINDING",id,"EDIT")'],
  ["app/api/graph/review/route.ts","requireResourceMatterAccess(request,resourceByType[entityType],body.id,\"EDIT\")"]
];
for(const [relativePath,call] of protectedRoutes){
  const source=readFileSync(join(projectRoot,...relativePath.split("/")),"utf8");
  const handler=source.slice(source.indexOf("export async function"));
  const authorizationIndex=handler.indexOf(call);
  assert.notEqual(authorizationIndex,-1,`${relativePath} must use the opaque resource authorization boundary`);
  const firstPersistentLookup=handler.search(/(?:\bquery(?:<|\()|\bwithTransaction\(|\bget\()/);
  assert.ok(firstPersistentLookup===-1||authorizationIndex<firstPersistentLookup,`${relativePath} must authorize before its first DB or blob access`);
}

const directExtract=readFileSync(join(projectRoot,"app","api","documents","[id]","extract","route.ts"),"utf8");
assert.match(directExtract,/Direct extraction is disabled/);
assert.doesNotMatch(directExtract,/@vercel\/blob|extractDocument|\bquery(?:<|\()/,"the retired direct extraction route must not retain a DB or blob processing sink");

console.log("Persistence-boundary checks passed: demo isolation, opaque resource authorization, global-role short-circuit, and route ordering.");
