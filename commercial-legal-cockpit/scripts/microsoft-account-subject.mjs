import {createPublicKey,createVerify} from "node:crypto";
import {readFileSync} from "node:fs";

// Better Auth 1.7 identifies Microsoft accounts by the Entra directory object
// id (`oid`). Version 1.6 stored the app-specific `sub` claim instead. This
// cutover rewrites those rows before 1.7 can treat an old subject as a new
// person. A stored id token is accepted after signature and claim checks even
// when it has expired: it is historical evidence of a past sign-in, not a live
// login. An Entra export is operator-supplied and is not signed by Microsoft.

export const MICROSOFT_ACCOUNT_PROVIDERS=["microsoft","microsoft-entra-id"];
export const MICROSOFT_ACCOUNT_CUTOVER_ID="better-auth-1.7-microsoft-oid";
export const MICROSOFT_AUTHORITY="https://login.microsoftonline.com";
export const MICROSOFT_CONSUMER_TENANT_ID="9188040d-6c67-4c5b-b112-36a304b66dad";
const GUID=/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const PRINTABLE=/^[\x21-\x7e]+$/;
const MAX_TOKEN_LIFETIME_SECONDS=24*60*60;
const CLOCK_SKEW_SECONDS=5*60;
const MAX_EXPORT_CHARS=1_000_000;

export class MicrosoftAccountCutoverError extends Error{
  constructor(code,message){
    super(message);
    this.name="MicrosoftAccountCutoverError";
    this.code=code;
  }
}

function fail(code,message){
  throw new MicrosoftAccountCutoverError(code,message);
}

export function assertMicrosoftTenant(tenantId){
  if(typeof tenantId!=="string")fail("MISSING_MICROSOFT_CONFIG","Microsoft tenant id is missing.");
  const tenant=tenantId.trim();
  if(GUID.test(tenant)||tenant==="common"||tenant==="organizations"||tenant==="consumers")return tenant;
  fail("MISSING_MICROSOFT_CONFIG","Microsoft tenant id must be a directory GUID or common, organizations, or consumers.");
}

export function microsoftTenantAllows(configuredTenant,tokenTenantId){
  const configured=assertMicrosoftTenant(configuredTenant).toLowerCase();
  if(!GUID.test(tokenTenantId))return false;
  const tokenTenant=tokenTenantId.toLowerCase();
  if(GUID.test(configured))return configured===tokenTenant;
  if(configured==="common")return true;
  if(configured==="organizations")return tokenTenant!==MICROSOFT_CONSUMER_TENANT_ID;
  if(configured==="consumers")return tokenTenant===MICROSOFT_CONSUMER_TENANT_ID;
  return false;
}

function printableAccountId(value){
  return typeof value==="string"&&value.length>0&&value.length<=255&&PRINTABLE.test(value);
}

function decodeSegment(segment){
  try{
    return JSON.parse(Buffer.from(segment,"base64url").toString("utf8"));
  }catch{
    return null;
  }
}

function audienceAllows(audience,clientId){
  if(typeof audience==="string")return audience===clientId;
  return Array.isArray(audience)&&audience.some(value=>value===clientId);
}

export function microsoftJwksUrl(tenantId){
  const tenant=assertMicrosoftTenant(tenantId);
  return `${MICROSOFT_AUTHORITY}/${tenant}/discovery/v2.0/keys`;
}

async function defaultFetchJwks(url){
  const parsed=new URL(url);
  if(parsed.origin!==MICROSOFT_AUTHORITY||parsed.username||parsed.password||parsed.search||parsed.hash||!parsed.pathname.endsWith("/discovery/v2.0/keys")){
    fail("SIGNING_KEYS","Microsoft signing-key address was rejected.");
  }
  let response;
  try{
    response=await fetch(url,{redirect:"error",signal:AbortSignal.timeout(10_000),headers:{accept:"application/json"}});
  }catch{
    fail("SIGNING_KEYS","Microsoft signing keys could not be retrieved.");
  }
  if(!response.ok)fail("SIGNING_KEYS","Microsoft signing keys were not available.");
  const text=await response.text();
  if(text.length>MAX_EXPORT_CHARS)fail("SIGNING_KEYS","Microsoft signing-key document was too large.");
  try{return JSON.parse(text);}catch{fail("SIGNING_KEYS","Microsoft signing-key document was not JSON.");}
}

export async function verifyStoredMicrosoftIdToken(token,{clientId,tenantId,now=Date.now(),fetchJwks=defaultFetchJwks}){
  if(typeof clientId!=="string"||clientId.length===0)fail("MISSING_MICROSOFT_CONFIG","Microsoft client id is required to verify a stored id token.");
  const configuredTenant=assertMicrosoftTenant(tenantId);
  if(typeof token!=="string")fail("TOKEN_REJECTED","A stored Microsoft id token could not be verified.");
  const parts=token.split(".");
  if(parts.length!==3||parts.some(part=>part.length===0))fail("TOKEN_REJECTED","A stored Microsoft id token could not be verified.");
  const [encodedHeader,encodedPayload,encodedSignature]=parts;
  const header=decodeSegment(encodedHeader);
  if(!header||header.alg!=="RS256"||typeof header.kid!=="string"||header.kid.length===0||header.crit){
    fail("TOKEN_REJECTED","A stored Microsoft id token could not be verified.");
  }
  if(header.typ!==undefined&&String(header.typ).toLowerCase()!=="jwt")fail("TOKEN_REJECTED","A stored Microsoft id token could not be verified.");
  const jwks=await fetchJwks(microsoftJwksUrl(configuredTenant));
  const keys=Array.isArray(jwks?.keys)?jwks.keys:[];
  const jwk=keys.find(key=>key&&key.kid===header.kid);
  if(!jwk||jwk.kty!=="RSA"||(jwk.alg&&jwk.alg!=="RS256"))fail("TOKEN_REJECTED","A stored Microsoft id token could not be verified.");
  let publicKey;
  try{publicKey=createPublicKey({key:jwk,format:"jwk"});}catch{fail("TOKEN_REJECTED","A stored Microsoft id token could not be verified.");}
  const signature=Buffer.from(encodedSignature,"base64url");
  const verified=createVerify("RSA-SHA256").update(`${encodedHeader}.${encodedPayload}`).verify(publicKey,signature);
  if(!verified)fail("TOKEN_REJECTED","A stored Microsoft id token could not be verified.");
  const claims=decodeSegment(encodedPayload);
  if(!claims||typeof claims.sub!=="string"||!printableAccountId(claims.sub)||!GUID.test(claims.oid)||typeof claims.tid!=="string"){
    fail("TOKEN_REJECTED","A stored Microsoft id token could not be verified.");
  }
  if(!microsoftTenantAllows(configuredTenant,claims.tid))fail("TOKEN_REJECTED","A stored Microsoft id token is for a different directory.");
  const issuer=`${MICROSOFT_AUTHORITY}/${claims.tid}/v2.0`;
  if(claims.iss!==issuer)fail("TOKEN_REJECTED","A stored Microsoft id token could not be verified.");
  if(GUID.test(configuredTenant)&&claims.tid.toLowerCase()!==configuredTenant.toLowerCase())fail("TOKEN_REJECTED","A stored Microsoft id token is for a different directory.");
  if(!audienceAllows(claims.aud,clientId))fail("TOKEN_REJECTED","A stored Microsoft id token was issued for a different application.");
  if(typeof claims.iat!=="number"||typeof claims.exp!=="number"||!Number.isFinite(claims.iat)||!Number.isFinite(claims.exp)){
    fail("TOKEN_REJECTED","A stored Microsoft id token could not be verified.");
  }
  const nowSeconds=Math.floor(now/1000);
  if(claims.iat>nowSeconds+CLOCK_SKEW_SECONDS||claims.exp<=claims.iat||claims.exp-claims.iat>MAX_TOKEN_LIFETIME_SECONDS){
    fail("TOKEN_REJECTED","A stored Microsoft id token could not be verified.");
  }
  if(claims.nbf!==undefined&&(typeof claims.nbf!=="number"||claims.nbf>claims.iat+CLOCK_SKEW_SECONDS||claims.nbf>claims.exp)){
    fail("TOKEN_REJECTED","A stored Microsoft id token could not be verified.");
  }
  return {oid:claims.oid,sub:claims.sub,tenantId:claims.tid};
}

function matchingExportIndexes(entries,row,subject){
  const indexes=[];
  entries.forEach((entry,index)=>{
    if(entry.providerId!==row.providerId)return;
    const related=subject
      ?entry.previousAccountId===row.accountId||entry.previousAccountId===subject.sub||entry.oid===subject.oid
      :entry.previousAccountId===row.accountId||entry.oid===row.accountId;
    if(related)indexes.push(index);
  });
  return indexes;
}

export function planMicrosoftAccountSubjectCutover({rows,subjectsByRowId,exportEntries}){
  const seen=new Set();
  for(const row of rows){
    if(!MICROSOFT_ACCOUNT_PROVIDERS.includes(row.providerId)||!printableAccountId(row.accountId)||!printableAccountId(row.id)){
      fail("ACCOUNT_SHAPE","A Microsoft account row has an unexpected identifier.");
    }
    const key=`${row.providerId}\u0000${row.accountId}`;
    if(seen.has(key))fail("DUPLICATE_ACCOUNT_KEY","Duplicate Microsoft account keys are present. Resolve them before upgrading.");
    seen.add(key);
  }
  const entries=exportEntries??null;
  const matched=new Set();
  const updates=[];
  const finalKeys=new Set();
  let tokenRows=0;
  let exportOnlyRows=0;
  for(const row of rows){
    const subject=subjectsByRowId.get(row.id)??null;
    let targetOid;
    if(subject){
      tokenRows+=1;
      if(!GUID.test(subject.oid)||!printableAccountId(subject.sub)||!GUID.test(subject.tenantId))fail("TOKEN_REJECTED","A stored Microsoft id token could not be verified.");
      if(row.accountId===subject.oid)targetOid=subject.oid;
      else if(row.accountId===subject.sub)targetOid=subject.oid;
      else fail("IDENTITY_MISMATCH",`Microsoft account row ${row.id} matches neither the token subject nor the directory object id.`);
      if(entries){
        for(const index of matchingExportIndexes(entries,row,subject)){
          matched.add(index);
          const entry=entries[index];
          if(entry.oid!==subject.oid||entry.tenantId.toLowerCase()!==subject.tenantId.toLowerCase()){
            fail("EXPORT_MISMATCH","The Entra export disagrees with a verified Microsoft id token.");
          }
        }
      }
    }else if(!entries){
      fail("UNMAPPED_ACCOUNT",`Microsoft account row ${row.id} has no stored id token. Pause Microsoft sign-in and provide the Entra directory-object export before production traffic.`);
    }else{
      exportOnlyRows+=1;
      const indexes=matchingExportIndexes(entries,row,null);
      if(indexes.length===0)fail("UNMAPPED_ACCOUNT",`Microsoft account row ${row.id} has no stored id token and no matching Entra export entry.`);
      indexes.forEach(index=>matched.add(index));
      const oids=new Set(indexes.map(index=>entries[index].oid));
      if(oids.size!==1)fail("EXPORT_MISMATCH","More than one directory object id was supplied for one Microsoft account.");
      targetOid=entries[indexes[0]].oid;
    }
    const finalKey=`${row.providerId}\u0000${targetOid}`;
    if(finalKeys.has(finalKey))fail("DUPLICATE_TARGET","Two Microsoft accounts would share one directory object id.");
    finalKeys.add(finalKey);
    if(row.accountId!==targetOid)updates.push({id:row.id,providerId:row.providerId,fromAccountId:row.accountId,oid:targetOid});
  }
  if(entries){
    for(let index=0;index<entries.length;index+=1){
      if(!matched.has(index))fail("EXTRA_EXPORT_ENTRY","The Entra export contains an entry that does not match a Microsoft account row.");
    }
  }
  let evidenceSource="mixed";
  if(rows.length===0)evidenceSource="no-microsoft-accounts";
  else if(tokenRows===rows.length)evidenceSource="verified-id-token";
  else if(exportOnlyRows===rows.length)evidenceSource="entra-export";
  return {updates,rewrittenCount:updates.length,alreadyAlignedCount:rows.length-updates.length,evidenceSource};
}

export function parseMicrosoftAccountOidExport(text,configuredTenant){
  assertMicrosoftTenant(configuredTenant);
  if(typeof text!=="string"||text.length===0||text.length>MAX_EXPORT_CHARS||text.includes("\u0000")){
    fail("EXPORT_INVALID","The Microsoft account export is missing or not a single JSON document.");
  }
  let parsed;
  try{parsed=JSON.parse(text);}catch{fail("EXPORT_INVALID","The Microsoft account export is not valid JSON.");}
  if(!parsed||parsed.version!==1||!Array.isArray(parsed.entries)||parsed.entries.length>10_000){
    fail("EXPORT_INVALID","The Microsoft account export must be version 1 with an entries list.");
  }
  const seenPrevious=new Set();
  const seenOid=new Set();
  const entries=parsed.entries.map(entry=>{
    if(!entry||typeof entry!=="object")fail("EXPORT_INVALID","A Microsoft account export entry is not an object.");
    const providerId=entry.providerId;
    const previousAccountId=entry.previousAccountId;
    const oid=entry.oid;
    const tenantId=entry.tenantId;
    if(!MICROSOFT_ACCOUNT_PROVIDERS.includes(providerId)||!printableAccountId(previousAccountId)||!GUID.test(oid)||!GUID.test(tenantId)){
      fail("EXPORT_INVALID","A Microsoft account export entry is missing a provider, previous account id, directory object id, or tenant id.");
    }
    if(!microsoftTenantAllows(configuredTenant,tenantId))fail("EXPORT_INVALID","A Microsoft account export entry is for a different directory than this application.");
    const previousKey=`${providerId}\u0000${previousAccountId}`;
    const oidKey=`${providerId}\u0000${oid.toLowerCase()}`;
    if(seenPrevious.has(previousKey)||seenOid.has(oidKey))fail("EXPORT_INVALID","The Microsoft account export repeats an account.");
    seenPrevious.add(previousKey);
    seenOid.add(oidKey);
    return {providerId,previousAccountId,oid,tenantId};
  });
  return entries;
}

function readExportText(env){
  const inline=typeof env.MICROSOFT_ACCOUNT_OID_EXPORT==="string"?env.MICROSOFT_ACCOUNT_OID_EXPORT.trim():"";
  const filePath=typeof env.MICROSOFT_ACCOUNT_OID_EXPORT_PATH==="string"?env.MICROSOFT_ACCOUNT_OID_EXPORT_PATH.trim():"";
  if(inline&&filePath)fail("EXPORT_CONFLICT","Provide either the Microsoft account export value or a file path, not both.");
  if(!inline&&!filePath)return null;
  if(inline.includes("\n")||inline.includes("\r"))fail("EXPORT_INVALID","The Microsoft account export value must be one line of JSON.");
  if(inline)return inline;
  try{return readFileSync(filePath,"utf8");}catch{fail("EXPORT_INVALID","The Microsoft account export file could not be read.");}
}

const CUTOVER_TABLE_SQL=`
create table if not exists public.microsoft_account_subject_cutover (
  cutover_id text primary key,
  completed_at timestamptz not null default now(),
  rewritten_count integer not null,
  already_aligned_count integer not null,
  evidence_source text not null,
  constraint microsoft_account_subject_cutover_id_check check (cutover_id='better-auth-1.7-microsoft-oid'),
  constraint microsoft_account_subject_cutover_counts_check check (rewritten_count>=0 and already_aligned_count>=0),
  constraint microsoft_account_subject_cutover_source_check check (evidence_source in ('no-microsoft-accounts','verified-id-token','entra-export','mixed'))
)`;

export async function applyMicrosoftAccountSubjectCutover(client,env,dependencies={}){
  const fetchJwks=dependencies.fetchJwks;
  const now=dependencies.now??Date.now();
  await client.query(CUTOVER_TABLE_SQL);
  await client.query("revoke all privileges on table public.microsoft_account_subject_cutover from public");
  const columns=await client.query(`
    select column_name,is_nullable
      from information_schema.columns
     where table_schema='public' and table_name='account'
  `);
  const byName=new Map(columns.rows.map(row=>[row.column_name,row]));
  if(!byName.has("id")||!byName.has("providerId")||!byName.has("accountId")){
    fail("ACCOUNT_TABLE","Better Auth account table is missing the provider and account identifier columns.");
  }
  const issuer=byName.get("issuer");
  if(issuer&&issuer.is_nullable!=="YES"){
    fail("ISSUER_COLUMN","The account.issuer column is still required. That column belongs to Better Auth 1.7.0 through 1.7.2. Make it optional and drop account_issuer_accountId_uidx before upgrading to 1.7.14. This application did not add that column.");
  }
  const duplicates=await client.query(`
    select "providerId" as provider_id,count(*)::int as copies
      from public.account
     group by "providerId","accountId"
    having count(*)>1
  `);
  if(duplicates.rows.length)fail("DUPLICATE_ACCOUNT_KEY","Duplicate account keys exist. Better Auth 1.7 rejects a provider account id that matches more than one row.");
  const recorded=await client.query(`
    select rewritten_count,already_aligned_count,evidence_source
      from public.microsoft_account_subject_cutover
     where cutover_id=$1
  `,[MICROSOFT_ACCOUNT_CUTOVER_ID]);
  if(recorded.rows.length){
    const row=recorded.rows[0];
    return {
      status:"already-recorded",
      rewrittenCount:Number(row.rewritten_count),
      alreadyAlignedCount:Number(row.already_aligned_count),
      evidenceSource:row.evidence_source
    };
  }
  const selected=await client.query(`
    select id,"providerId" as provider_id,"accountId" as account_id${byName.has("idToken")?',"idToken" as id_token':""}
      from public.account
     where "providerId" = any($1::text[])
     order by id
     for update
  `,[MICROSOFT_ACCOUNT_PROVIDERS]);
  const rows=selected.rows.map(row=>({
    id:row.id,
    providerId:row.provider_id,
    accountId:row.account_id,
    idToken:typeof row.id_token==="string"&&row.id_token.trim()?row.id_token:null
  }));
  const needsVerification=rows.some(row=>row.idToken);
  const exportText=readExportText(env);
  const clientId=typeof env.MICROSOFT_CLIENT_ID==="string"?env.MICROSOFT_CLIENT_ID.trim():"";
  const tenantId=typeof env.MICROSOFT_TENANT_ID==="string"?env.MICROSOFT_TENANT_ID.trim():"";
  if((needsVerification||exportText)&&(clientId.length===0||tenantId.length===0)){
    fail("MISSING_MICROSOFT_CONFIG","Microsoft client id and tenant id are required before rewriting Microsoft account ids.");
  }
  const subjectsByRowId=new Map();
  for(const row of rows){
    if(!row.idToken)continue;
    const subject=await verifyStoredMicrosoftIdToken(row.idToken,{clientId,tenantId,now,fetchJwks});
    subjectsByRowId.set(row.id,subject);
  }
  const exportEntries=exportText?parseMicrosoftAccountOidExport(exportText,tenantId):null;
  const plan=planMicrosoftAccountSubjectCutover({rows,subjectsByRowId,exportEntries});
  const hasUpdatedAt=byName.has("updatedAt");
  for(const update of plan.updates){
    const result=await client.query(
      `update public.account
          set "accountId"=$1${hasUpdatedAt?',"updatedAt"=now()':""}
        where id=$2 and "providerId"=$3 and "accountId"=$4`,
      [update.oid,update.id,update.providerId,update.fromAccountId]
    );
    if(result.rowCount!==1)fail("UPDATE_FAILED","A Microsoft account id changed while the cutover was running. The migration was rolled back.");
  }
  await client.query(`
    insert into public.microsoft_account_subject_cutover
      (cutover_id,rewritten_count,already_aligned_count,evidence_source)
    values ($1,$2,$3,$4)
  `,[MICROSOFT_ACCOUNT_CUTOVER_ID,plan.rewrittenCount,plan.alreadyAlignedCount,plan.evidenceSource]);
  return {status:"recorded",...plan};
}
