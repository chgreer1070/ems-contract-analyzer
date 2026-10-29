import {createHash, createPublicKey, createVerify} from "node:crypto";

export const BETTER_AUTH_CUTOVER_VERSION="1.7.14";
export const MICROSOFT_AUTHORITY="https://login.microsoftonline.com";
export const MICROSOFT_PROVIDER_IDS=["microsoft","microsoft-entra-id"];
const TENANT_ALIASES=new Set(["common","organizations","consumers"]);
const GUID_PATTERN=/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/iu;
const CLOCK_SKEW_SECONDS=5*60;
const MAX_MAP_CHARS=1_000_000;
const MAX_MAP_ACCOUNTS=10_000;

export function isConcreteDirectoryId(value){
  const trimmed=String(value??"").trim();
  return GUID_PATTERN.test(trimmed)&&!TENANT_ALIASES.has(trimmed.toLowerCase());
}

export function assertConcreteDirectoryId(value,label){
  if(!isConcreteDirectoryId(value)){
    throw new Error(`${label} must be a concrete Entra directory id. common, organizations, and consumers are not accepted.`);
  }
  return String(value).trim().toLowerCase();
}

function sha256(value){
  return createHash("sha256").update(value,"utf8").digest("hex");
}

function assertString(value,label,maxLength){
  if(typeof value!=="string"||value.trim()!==value||value.length===0||value.length>maxLength||/[\u0000-\u001f\u007f]/u.test(value)){
    throw new Error(`${label} is missing or not a plain identifier.`);
  }
  return value;
}

export function parseMicrosoftAccountOidMap(raw){
  if(typeof raw!=="string"||raw.trim().length===0)return null;
  if(raw.length>MAX_MAP_CHARS)throw new Error("MICROSOFT_ACCOUNT_OID_MAP is too large.");
  let parsed;
  try{parsed=JSON.parse(raw);}catch{throw new Error("MICROSOFT_ACCOUNT_OID_MAP is not valid JSON.");}
  if(!parsed||typeof parsed!=="object"||Array.isArray(parsed))throw new Error("MICROSOFT_ACCOUNT_OID_MAP must be an object.");
  const allowedTop=["version","tenantId","clientId","accounts"];
  for(const key of Object.keys(parsed)){
    if(!allowedTop.includes(key))throw new Error("MICROSOFT_ACCOUNT_OID_MAP contains an unexpected field.");
  }
  if(parsed.version!==1)throw new Error("MICROSOFT_ACCOUNT_OID_MAP version must be 1.");
  const tenantId=assertConcreteDirectoryId(parsed.tenantId,"MICROSOFT_ACCOUNT_OID_MAP tenantId");
  const clientId=assertConcreteDirectoryId(parsed.clientId,"MICROSOFT_ACCOUNT_OID_MAP clientId");
  if(!Array.isArray(parsed.accounts)||parsed.accounts.length>MAX_MAP_ACCOUNTS){
    throw new Error("MICROSOFT_ACCOUNT_OID_MAP accounts must be a list.");
  }
  const accounts=[];
  const previousKeys=new Set();
  const oidKeys=new Set();
  for(const entry of parsed.accounts){
    if(!entry||typeof entry!=="object"||Array.isArray(entry))throw new Error("MICROSOFT_ACCOUNT_OID_MAP has an invalid account entry.");
    for(const key of Object.keys(entry)){
      if(!["providerId","userId","previousAccountId","oid"].includes(key))throw new Error("MICROSOFT_ACCOUNT_OID_MAP account entry contains an unexpected field.");
    }
    if(!MICROSOFT_PROVIDER_IDS.includes(entry.providerId))throw new Error("MICROSOFT_ACCOUNT_OID_MAP provider must be microsoft or microsoft-entra-id.");
    const userId=assertString(entry.userId,"Account user id",256);
    const previousAccountId=assertString(entry.previousAccountId,"Previous Microsoft account id",512);
    const oid=assertConcreteDirectoryId(entry.oid,"Directory object id");
    const previousKey=`${entry.providerId}\u0000${userId}\u0000${previousAccountId}`;
    const oidKey=`${entry.providerId}\u0000${userId}\u0000${oid}`;
    if(previousKeys.has(previousKey)||oidKeys.has(oidKey))throw new Error("MICROSOFT_ACCOUNT_OID_MAP lists the same account more than once.");
    previousKeys.add(previousKey);
    oidKeys.add(oidKey);
    accounts.push({providerId:entry.providerId,userId,previousAccountId,oid});
  }
  return {version:1,tenantId,clientId,accounts};
}

function decodePart(part,label){
  try{return JSON.parse(Buffer.from(part,"base64url").toString("utf8"));}
  catch{throw new Error(`Microsoft id token ${label} could not be read.`);}
}

function audienceMatches(audience,clientId){
  const values=Array.isArray(audience)?audience:[audience];
  return values.some(value=>typeof value==="string"&&value.toLowerCase()===clientId);
}

export function verifyStoredMicrosoftIdToken(token,{jwks,tenantId,clientId,authority=MICROSOFT_AUTHORITY,now=new Date(),allowExpired=true}){
  const directoryId=assertConcreteDirectoryId(tenantId,"Microsoft directory id");
  const applicationId=assertConcreteDirectoryId(clientId,"Microsoft application id");
  if(authority!==MICROSOFT_AUTHORITY)throw new Error("Microsoft token verification only accepts the Entra authority.");
  if(typeof token!=="string")return {ok:false,reason:"missing"};
  const parts=token.split(".");
  if(parts.length!==3||parts.some(part=>part.length===0))return {ok:false,reason:"shape"};
  const [encodedHeader,encodedPayload,encodedSignature]=parts;
  let header;
  let claims;
  try{
    header=decodePart(encodedHeader,"header");
    claims=decodePart(encodedPayload,"body");
  }catch{return {ok:false,reason:"shape"};}
  if(!header||header.alg!=="RS256"||typeof header.kid!=="string"||header.kid.length===0)return {ok:false,reason:"header"};
  if(header.typ!==undefined&&header.typ!=="JWT")return {ok:false,reason:"header"};
  const jwk=(Array.isArray(jwks)?jwks:[]).find(key=>key&&key.kid===header.kid);
  if(!jwk||jwk.kty!=="RSA"||typeof jwk.n!=="string"||typeof jwk.e!=="string")return {ok:false,reason:"key"};
  if(jwk.alg!==undefined&&jwk.alg!=="RS256")return {ok:false,reason:"key"};
  if(jwk.use!==undefined&&jwk.use!=="sig")return {ok:false,reason:"key"};
  let verified=false;
  try{
    const key=createPublicKey({key:jwk,format:"jwk"});
    const verifier=createVerify("RSA-SHA256");
    verifier.update(`${encodedHeader}.${encodedPayload}`);
    verifier.end();
    verified=verifier.verify(key,Buffer.from(encodedSignature,"base64url"));
  }catch{return {ok:false,reason:"signature"};}
  if(!verified)return {ok:false,reason:"signature"};
  const nowSeconds=Math.floor(now.getTime()/1000);
  if(typeof claims.exp!=="number"||!Number.isFinite(claims.exp))return {ok:false,reason:"expiry"};
  if(!allowExpired&&claims.exp<nowSeconds)return {ok:false,reason:"expiry"};
  if(typeof claims.nbf==="number"&&claims.nbf>nowSeconds+CLOCK_SKEW_SECONDS)return {ok:false,reason:"time"};
  if(typeof claims.iat==="number"&&claims.iat>nowSeconds+CLOCK_SKEW_SECONDS)return {ok:false,reason:"time"};
  const expectedIssuer=`${authority}/${directoryId}/v2.0`;
  if(typeof claims.iss!=="string"||claims.iss.toLowerCase()!==expectedIssuer)return {ok:false,reason:"issuer"};
  if(typeof claims.tid!=="string"||claims.tid.toLowerCase()!==directoryId)return {ok:false,reason:"directory"};
  if(!audienceMatches(claims.aud,applicationId))return {ok:false,reason:"audience"};
  if(claims.azp!==undefined&&(typeof claims.azp!=="string"||claims.azp.toLowerCase()!==applicationId))return {ok:false,reason:"audience"};
  if(typeof claims.sub!=="string"||claims.sub.trim().length===0)return {ok:false,reason:"subject"};
  if(!isConcreteDirectoryId(claims.oid))return {ok:false,reason:"oid"};
  return {ok:true,sub:claims.sub,oid:String(claims.oid).trim().toLowerCase()};
}

function previousKey(providerId,userId,accountId){
  return `${providerId}\u0000${userId}\u0000${accountId}`;
}

export function planMicrosoftAccountCutover({rows,proofsById,oidMap,receiptExists}){
  const previousEntries=new Map();
  const oidEntries=new Map();
  for(const entry of oidMap?.accounts??[]){
    previousEntries.set(previousKey(entry.providerId,entry.userId,entry.previousAccountId),entry);
    oidEntries.set(previousKey(entry.providerId,entry.userId,entry.oid),entry);
  }
  const entries=[];
  const errors=[];
  for(const row of rows){
    const proof=proofsById.get(row.id);
    const mappedPrevious=previousEntries.get(previousKey(row.providerId,row.userId,row.accountId))??null;
    const mappedCurrent=oidEntries.get(previousKey(row.providerId,row.userId,row.accountId))??null;
    if(proof?.ok){
      if(mappedPrevious&&mappedPrevious.oid!==proof.oid){
        errors.push(`Account ${row.id} has a verified token that disagrees with the directory export.`);
        continue;
      }
      if(mappedCurrent&&mappedCurrent.oid!==proof.oid){
        errors.push(`Account ${row.id} has a verified token that disagrees with the directory export.`);
        continue;
      }
      if(row.accountId===proof.sub&&row.accountId!==proof.oid){
        entries.push({id:row.id,providerId:row.providerId,userId:row.userId,previousAccountId:row.accountId,oid:proof.oid,action:"rewrite"});
        continue;
      }
      if(row.accountId===proof.oid){
        entries.push({id:row.id,providerId:row.providerId,userId:row.userId,previousAccountId:row.accountId,oid:proof.oid,action:"already-directory-id"});
        continue;
      }
      errors.push(`Account ${row.id} does not match its verified Microsoft token.`);
      continue;
    }
    if(mappedPrevious){
      entries.push({id:row.id,providerId:row.providerId,userId:row.userId,previousAccountId:row.accountId,oid:mappedPrevious.oid,action:row.accountId===mappedPrevious.oid?"already-directory-id":"rewrite"});
      continue;
    }
    if(mappedCurrent){
      entries.push({id:row.id,providerId:row.providerId,userId:row.userId,previousAccountId:row.accountId,oid:mappedCurrent.oid,action:"already-directory-id"});
      continue;
    }
    if(receiptExists){
      entries.push({id:row.id,providerId:row.providerId,userId:row.userId,previousAccountId:row.accountId,oid:null,action:"unchecked-existing"});
      continue;
    }
    errors.push(`Account ${row.id} has no verified Microsoft id token and no trusted directory export.`);
  }
  const destinations=new Map();
  for(const entry of entries){
    if(!entry.oid)continue;
    const key=`${entry.providerId}\u0000${entry.oid}`;
    const existing=destinations.get(key);
    if(existing&&existing!==entry.id)errors.push("Two Microsoft accounts would share one directory object id.");
    destinations.set(key,entry.id);
  }
  const canonical=entries
    .filter(entry=>entry.action!=="unchecked-existing")
    .map(entry=>({action:entry.action,id:entry.id,oid:entry.oid,providerId:entry.providerId,userId:entry.userId}))
    .sort((left,right)=>left.id<right.id?-1:left.id>right.id?1:0);
  return {
    ok:errors.length===0,
    errors,
    entries,
    rewritten:entries.filter(entry=>entry.action==="rewrite"),
    legacy:entries.filter(entry=>entry.action==="rewrite"),
    mappingSha256:sha256(JSON.stringify(canonical))
  };
}

async function fetchJwks(tenantId,fetchImpl){
  const url=`${MICROSOFT_AUTHORITY}/${tenantId}/discovery/v2.0/keys`;
  let response;
  try{response=await fetchImpl(url,{signal:AbortSignal.timeout(10_000)});}
  catch{throw new Error("Microsoft signing keys could not be loaded.");}
  if(!response?.ok||typeof response.json!=="function")throw new Error("Microsoft signing keys could not be loaded.");
  const body=await response.json();
  if(!body||!Array.isArray(body.keys))throw new Error("Microsoft signing keys were not in the expected shape.");
  return body.keys;
}

function normalizedIdentity(value){
  const trimmed=String(value??"").trim();
  return trimmed.length?trimmed:"";
}

export async function applyMicrosoftAccountCutover(client,{
  tenantId="",
  clientId="",
  oidMapJson="",
  now=new Date(),
  fetchImpl=globalThis.fetch,
  jwks=null
}={}){
  const accountTable=await client.query("select pg_catalog.to_regclass('public.account')::text as relation_name");
  if(accountTable.rows[0]?.relation_name!=="account")throw new Error("Better Auth account table is missing, so the Microsoft directory-id cutover cannot run.");
  const issuer=await client.query(`
    select is_nullable
      from information_schema.columns
     where table_schema='public' and table_name='account' and column_name='issuer'
  `);
  if(issuer.rows[0]?.is_nullable==="NO"){
    throw new Error("account.issuer is still required. Better Auth 1.7.3 and later identify accounts by provider and account id and do not write issuer. Make issuer optional and drop index account_issuer_accountId_uidx before continuing. Do not start Microsoft sign-in on this database until that cleanup is done.");
  }
  await client.query("lock table public.account in share row exclusive mode");
  const duplicates=await client.query(`
    select count(*)::int as duplicate_keys
      from (
        select 1
          from public.account
         group by "providerId","accountId"
        having count(*)>1
      ) duplicates
  `);
  if(Number(duplicates.rows[0]?.duplicate_keys)>0){
    throw new Error(`Microsoft account cutover refused: ${duplicates.rows[0].duplicate_keys} duplicate provider/account keys exist. Resolve them before upgrading.`);
  }
  const accounts=await client.query(`
    select id,"accountId","providerId","userId","idToken"
      from public.account
     where "providerId" in ('microsoft','microsoft-entra-id')
     order by id
  `);
  const rows=accounts.rows.map(row=>{
    if(typeof row.id!=="string"||typeof row.accountId!=="string"||typeof row.userId!=="string"||!MICROSOFT_PROVIDER_IDS.includes(row.providerId)){
      throw new Error("A Microsoft account row is missing its local id, provider, or user.");
    }
    return {
      id:row.id,
      accountId:row.accountId,
      providerId:row.providerId,
      userId:row.userId,
      idToken:typeof row.idToken==="string"&&row.idToken.trim().length?row.idToken:null
    };
  });
  const receipt=await client.query(`
    select singleton,better_auth_version,account_row_count
      from public.microsoft_account_oid_cutover
     where singleton is true
  `);
  if(receipt.rows.length>1)throw new Error("More than one Microsoft directory-id cutover receipt exists.");
  const receiptExists=receipt.rows.length===1;
  if(receiptExists&&receipt.rows[0].better_auth_version!==BETTER_AUTH_CUTOVER_VERSION){
    throw new Error("The recorded Microsoft directory-id cutover is not the Better Auth 1.7.14 move.");
  }
  const oidMap=parseMicrosoftAccountOidMap(oidMapJson);
  const configuredTenant=normalizedIdentity(tenantId);
  const configuredClient=normalizedIdentity(clientId);
  if(configuredTenant)assertConcreteDirectoryId(configuredTenant,"MICROSOFT_TENANT_ID");
  if(configuredClient)assertConcreteDirectoryId(configuredClient,"MICROSOFT_CLIENT_ID");
  if(oidMap&&configuredTenant&&oidMap.tenantId!==configuredTenant.toLowerCase())throw new Error("MICROSOFT_ACCOUNT_OID_MAP directory id does not match MICROSOFT_TENANT_ID.");
  if(oidMap&&configuredClient&&oidMap.clientId!==configuredClient.toLowerCase())throw new Error("MICROSOFT_ACCOUNT_OID_MAP application id does not match MICROSOFT_CLIENT_ID.");
  const proofTenant=(configuredTenant||oidMap?.tenantId||"").toLowerCase();
  const proofClient=(configuredClient||oidMap?.clientId||"").toLowerCase();
  const needsTokenProof=rows.some(row=>row.idToken)&&(!receiptExists||rows.length>0);
  let keys=jwks;
  if(needsTokenProof&&rows.some(row=>row.idToken)){
    if(!proofTenant||!proofClient)throw new Error("MICROSOFT_TENANT_ID and MICROSOFT_CLIENT_ID are required to verify stored Microsoft id tokens. Do not guess directory object ids.");
    if(!keys)keys=await fetchJwks(proofTenant,fetchImpl);
  }
  const proofsById=new Map();
  for(const row of rows){
    if(!row.idToken)continue;
    if(!keys){
      proofsById.set(row.id, {ok:false,reason:"key"});
      continue;
    }
    proofsById.set(row.id, verifyStoredMicrosoftIdToken(row.idToken,{jwks:keys,tenantId:proofTenant,clientId:proofClient,now,allowExpired:true}));
  }
  const plan=planMicrosoftAccountCutover({rows,proofsById,oidMap,receiptExists});
  if(receiptExists){
    if(plan.legacy.length){
      throw new Error(`Microsoft account cutover refused: ${plan.legacy.length} account row(s) are still keyed by the old Microsoft subject after the cutover receipt was recorded. Stop Microsoft sign-in and rerun the move before accepting traffic.`);
    }
    if(!plan.ok)throw new Error(`Microsoft account cutover refused: ${plan.errors.join(" ")}`);
    console.log(`Microsoft directory-id cutover receipt already recorded; checked ${rows.length} Microsoft account row(s).`);
    return {recorded:true,accountRowCount:rows.length,rewrittenRowCount:0};
  }
  if(!plan.ok)throw new Error(`Microsoft account cutover refused: ${plan.errors.join(" ")}`);
  for(const entry of plan.rewritten){
    const updated=await client.query(`
      update public.account
         set "accountId"=$1,"updatedAt"=clock_timestamp()
       where id=$2 and "providerId"=$3 and "accountId"=$4
    `,[entry.oid,entry.id,entry.providerId,entry.previousAccountId]);
    if(updated.rowCount!==1)throw new Error(`Microsoft account ${entry.id} could not be moved to its directory object id.`);
  }
  const providerIds=[...new Set(rows.map(row=>row.providerId))].sort();
  await client.query(`
    insert into public.microsoft_account_oid_cutover
      (singleton,better_auth_version,provider_ids,account_row_count,rewritten_row_count,mapping_sha256)
    values (true,$1,$2::text[],$3,$4,$5)
  `,[BETTER_AUTH_CUTOVER_VERSION,providerIds,rows.length,plan.rewritten.length,plan.mappingSha256]);
  console.log(rows.length
    ?`Microsoft directory-id cutover recorded for ${rows.length} Microsoft account row(s), ${plan.rewritten.length} rewritten.`
    :"Microsoft directory-id cutover recorded with no existing Microsoft accounts.");
  return {recorded:false,accountRowCount:rows.length,rewrittenRowCount:plan.rewritten.length};
}
