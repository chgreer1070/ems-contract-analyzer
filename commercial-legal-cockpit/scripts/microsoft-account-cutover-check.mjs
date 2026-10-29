import assert from "node:assert/strict";
import {createSign, generateKeyPairSync} from "node:crypto";
import fs from "node:fs/promises";
import {
  applyMicrosoftAccountCutover,
  isConcreteDirectoryId,
  parseMicrosoftAccountOidMap,
  planMicrosoftAccountCutover,
  verifyStoredMicrosoftIdToken
} from "./microsoft-account-cutover.mjs";

const tenantId="aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee";
const clientId="11111111-2222-4333-8444-555555555555";
const oid="99999999-8888-4777-8666-555555555555";
const otherOid="88888888-7777-4666-8555-444444444444";
const now=new Date("2026-10-29T15:00:00.000Z");
const {publicKey,privateKey}=generateKeyPairSync("rsa",{modulusLength:2048});
const jwk=publicKey.export({format:"jwk"});
jwk.kid="test-key";
jwk.alg="RS256";
jwk.use="sig";
export const microsoftFixtureJwks=[jwk];

export function signMicrosoftFixtureToken({
  tenant=tenantId,
  client=clientId,
  subject="old-app-subject",
  directoryId=oid,
  expired=true,
  header={alg:"RS256",kid:"test-key",typ:"JWT"},
  extraClaims={},
  signingKey=privateKey
}={}){
  const issuedAt=Math.floor(now.getTime()/1000)-7200;
  const payload={
    iss:`https://login.microsoftonline.com/${tenant}/v2.0`,
    aud:client,
    tid:tenant,
    sub:subject,
    oid:directoryId,
    iat:issuedAt,
    nbf:issuedAt,
    exp:expired?issuedAt+60:Math.floor(now.getTime()/1000)+3600,
    ...extraClaims
  };
  const encodedHeader=Buffer.from(JSON.stringify(header)).toString("base64url");
  const encodedPayload=Buffer.from(JSON.stringify(payload)).toString("base64url");
  const signer=createSign("RSA-SHA256");
  signer.update(`${encodedHeader}.${encodedPayload}`);
  signer.end();
  return `${encodedHeader}.${encodedPayload}.${signer.sign(signingKey).toString("base64url")}`;
}

function row(overrides={}){
  return {id:"account-1",accountId:"old-app-subject",providerId:"microsoft",userId:"user-1",...overrides};
}

function verified(token=signMicrosoftFixtureToken()){
  return verifyStoredMicrosoftIdToken(token,{jwks:[jwk],tenantId,clientId,now,allowExpired:true});
}

assert.equal(isConcreteDirectoryId(tenantId),true);
assert.equal(isConcreteDirectoryId("common"),false);
assert.equal(isConcreteDirectoryId("organizations"),false);
assert.equal(isConcreteDirectoryId("consumers"),false);
assert.equal(isConcreteDirectoryId("not-a-guid"),false);

const proof=verified();
assert.equal(proof.ok,true);
assert.equal(proof.oid,oid);
assert.equal(verifyStoredMicrosoftIdToken(signMicrosoftFixtureToken(),{jwks:[jwk],tenantId,clientId,now,allowExpired:false}).reason,"expiry");
assert.equal(verifyStoredMicrosoftIdToken(signMicrosoftFixtureToken({client:"22222222-3333-4444-8555-666666666666"}),{jwks:[jwk],tenantId,clientId,now,allowExpired:true}).reason,"audience");
assert.equal(verifyStoredMicrosoftIdToken(signMicrosoftFixtureToken({tenant:"bbbbbbbb-bbbb-4ccc-8ddd-eeeeeeeeeeee"}),{jwks:[jwk],tenantId,clientId,now,allowExpired:true}).reason,"issuer");
assert.equal(verifyStoredMicrosoftIdToken(signMicrosoftFixtureToken({directoryId:"not-an-oid"}),{jwks:[jwk],tenantId,clientId,now,allowExpired:true}).reason,"oid");
assert.equal(verifyStoredMicrosoftIdToken(signMicrosoftFixtureToken({header:{alg:"none",kid:"test-key"}}),{jwks:[jwk],tenantId,clientId,now,allowExpired:true}).reason,"header");
assert.equal(verifyStoredMicrosoftIdToken(`${signMicrosoftFixtureToken()}x`,{jwks:[jwk],tenantId,clientId,now,allowExpired:true}).reason,"signature");

const moved=planMicrosoftAccountCutover({
  rows:[row()],
  proofsById:new Map([["account-1",proof]]),
  oidMap:null,
  receiptExists:false
});
assert.equal(moved.ok,true);
assert.equal(moved.rewritten.length,1);
assert.equal(moved.rewritten[0].oid,oid);

const already=planMicrosoftAccountCutover({
  rows:[row({accountId:oid})],
  proofsById:new Map([["account-1",proof]]),
  oidMap:null,
  receiptExists:false
});
assert.equal(already.ok,true);
assert.equal(already.rewritten.length,0);

const uncovered=planMicrosoftAccountCutover({
  rows:[row({idToken:null})],
  proofsById:new Map(),
  oidMap:null,
  receiptExists:false
});
assert.equal(uncovered.ok,false);

const mapped=parseMicrosoftAccountOidMap(JSON.stringify({
  version:1,
  tenantId,
  clientId,
  accounts:[{providerId:"microsoft",userId:"user-1",previousAccountId:"old-app-subject",oid}]
}));
const fromExport=planMicrosoftAccountCutover({
  rows:[row()],
  proofsById:new Map([["account-1",{ok:false,reason:"signature"}]]),
  oidMap:mapped,
  receiptExists:false
});
assert.equal(fromExport.ok,true);
assert.equal(fromExport.rewritten.length,1);

const disagreement=planMicrosoftAccountCutover({
  rows:[row()],
  proofsById:new Map([["account-1",proof]]),
  oidMap:parseMicrosoftAccountOidMap(JSON.stringify({
    version:1,tenantId,clientId,
    accounts:[{providerId:"microsoft",userId:"user-1",previousAccountId:"old-app-subject",oid:otherOid}]
  })),
  receiptExists:false
});
assert.equal(disagreement.ok,false);

const collision=planMicrosoftAccountCutover({
  rows:[row(),row({id:"account-2",accountId:"other-subject",userId:"user-2"})],
  proofsById:new Map([
    ["account-1",proof],
    ["account-2",verified(signMicrosoftFixtureToken({subject:"other-subject",directoryId:oid}))]
  ]),
  oidMap:null,
  receiptExists:false
});
assert.equal(collision.ok,false);

const afterReceipt=planMicrosoftAccountCutover({
  rows:[row()],
  proofsById:new Map([["account-1",proof]]),
  oidMap:null,
  receiptExists:true
});
assert.equal(afterReceipt.legacy.length,1);

assert.throws(()=>parseMicrosoftAccountOidMap('{"version":1,"tenantId":"common","clientId":"'+clientId+'","accounts":[]}'),/concrete Entra directory id/);
assert.throws(()=>parseMicrosoftAccountOidMap("not-json"),/not valid JSON/);
assert.equal(parseMicrosoftAccountOidMap("  "),null);

const authSource=await fs.readFile(new URL("../lib/auth.ts",import.meta.url),"utf8");
assert.match(authSource,/authority: "https:\/\/login\.microsoftonline\.com"/);
assert.match(authSource,/microsoft_account_oid_cutover/);
assert.match(authSource,/common", "organizations", "consumers"/);
assert.match(authSource,/mapProfileToUser cannot replace that id/);
assert.doesNotMatch(authSource,/mapProfileToUser\s*:/);

function memoryClient(initial={}){
  const state={
    issuerNullable:initial.issuerNullable??null,
    accounts:initial.accounts??[],
    receipt:initial.receipt??null,
    updates:0
  };
  return {state,client:{query:async(sql,params=[])=>{
    const text=sql.replace(/\s+/gu," ").trim().toLowerCase();
    if(text.includes("to_regclass"))return {rows:[{relation_name:"account"}],rowCount:1};
    if(text.includes("information_schema.columns")){
      return state.issuerNullable?{rows:[{is_nullable:state.issuerNullable}],rowCount:1}:{rows:[],rowCount:0};
    }
    if(text.startsWith("lock table"))return {rows:[],rowCount:0};
    if(text.includes("duplicate_keys")){
      const counts=new Map();
      for(const account of state.accounts){
        const key=`${account.providerId}\u0000${account.accountId}`;
        counts.set(key,(counts.get(key)??0)+1);
      }
      const duplicateKeys=[...counts.values()].filter(count=>count>1).length;
      return {rows:[{duplicate_keys:duplicateKeys}],rowCount:1};
    }
    if(text.includes("from public.account")){
      return {rows:state.accounts.filter(account=>account.providerId==="microsoft"||account.providerId==="microsoft-entra-id"),rowCount:state.accounts.length};
    }
    if(text.includes("from public.microsoft_account_oid_cutover")){
      return {rows:state.receipt?[state.receipt]:[],rowCount:state.receipt?1:0};
    }
    if(text.startsWith("update public.account")){
      const [nextId,id,providerId,previousId]=params;
      const account=state.accounts.find(item=>item.id===id&&item.providerId===providerId&&item.accountId===previousId);
      if(!account)return {rows:[],rowCount:0};
      account.accountId=nextId;
      state.updates+=1;
      return {rows:[],rowCount:1};
    }
    if(text.startsWith("insert into public.microsoft_account_oid_cutover")){
      if(state.receipt)throw new Error("duplicate receipt");
      state.receipt={singleton:true,better_auth_version:params[0],account_row_count:params[2]};
      return {rows:[],rowCount:1};
    }
    throw new Error(`Unexpected cutover SQL: ${sql}`);
  }}};
}

const token=signMicrosoftFixtureToken();
const first=memoryClient({accounts:[{id:"account-1",accountId:"old-app-subject",providerId:"microsoft",userId:"user-1",idToken:token}]});
const recorded=await applyMicrosoftAccountCutover(first.client,{tenantId,clientId,now,jwks:[jwk]});
assert.equal(recorded.rewrittenRowCount,1);
assert.equal(first.state.accounts[0].accountId,oid);
assert.equal(first.state.updates,1);
const second=await applyMicrosoftAccountCutover(first.client,{tenantId,clientId,now,jwks:[jwk]});
assert.equal(second.recorded,true);
assert.equal(first.state.updates,1);

const blocked=memoryClient({issuerNullable:"NO"});
await assert.rejects(()=>applyMicrosoftAccountCutover(blocked.client,{now,jwks:[jwk]}),/account\.issuer is still required/);

const empty=memoryClient();
const emptyResult=await applyMicrosoftAccountCutover(empty.client,{now});
assert.equal(emptyResult.accountRowCount,0);
assert.ok(empty.state.receipt);

const duplicate=memoryClient({accounts:[
  {id:"account-1",accountId:"same",providerId:"microsoft",userId:"user-1",idToken:null},
  {id:"account-2",accountId:"same",providerId:"microsoft",userId:"user-2",idToken:null}
]});
await assert.rejects(()=>applyMicrosoftAccountCutover(duplicate.client,{now}),/duplicate provider\/account keys/);

const authMigrate=await fs.readFile(new URL("./auth-migrate.mjs",import.meta.url),"utf8");
assert.ok(authMigrate.indexOf("targetClient.query(compiledAuthMigrationSql)")<authMigrate.indexOf("applyMicrosoftAccountCutover(targetClient"));

console.log("Microsoft directory-id cutover checks passed.");
