/**
 * Better Auth 1.7 Microsoft account-identifier cutover.
 *
 * 1.6 stored the pairwise Entra `sub` claim in account."accountId".
 * 1.7 uses the stable directory `oid` claim. Accepting production traffic
 * before this cutover can create duplicate Microsoft account rows.
 *
 * Default mode is inventory/dry-run. Mutation requires
 * CONFIRM_MICROSOFT_ACCOUNT_OID_MIGRATION=true.
 *
 * This script does not invent oid values. It only copies a verified oid from a
 * stored Microsoft ID token, or from an operator-supplied Entra export map.
 */
import fs from "node:fs";
import {createRemoteJWKSet,jwtVerify} from "jose";
import pg from "pg";
import {verifiedDatabaseConnectionConfig} from "./database-connection-config.mjs";

const {Pool}=pg;
const APPLY=process.env.CONFIRM_MICROSOFT_ACCOUNT_OID_MIGRATION==="true";
const PROVIDER_IDS=["microsoft","microsoft-entra-id"];
const MICROSOFT_TENANT_ID=process.env.MICROSOFT_TENANT_ID||"";
const MICROSOFT_CLIENT_ID=process.env.MICROSOFT_CLIENT_ID||"";
const AUTHORITY=(process.env.MICROSOFT_AUTHORITY||"https://login.microsoftonline.com").replace(/\/$/,"");
const EXPORT_MAP_PATH=process.env.MICROSOFT_OID_EXPORT_MAP_PATH||"";

if(!process.env.DATABASE_URL)throw new Error("DATABASE_URL is required.");

function loadExportMap(path){
  if(!path)return new Map();
  const raw=JSON.parse(fs.readFileSync(path,"utf8"));
  const entries=Array.isArray(raw)?raw:raw.mappings||raw.accounts||[];
  if(!Array.isArray(entries))throw new Error("MICROSOFT_OID_EXPORT_MAP_PATH must be a JSON array or {mappings|accounts:[]}.");
  const map=new Map();
  for(const entry of entries){
    const previous=String(entry.accountId||entry.sub||entry.previousAccountId||"").trim();
    const oid=String(entry.oid||entry.objectId||entry.newAccountId||"").trim();
    if(!previous||!oid)throw new Error("Each Entra export map entry needs previous accountId/sub and oid.");
    if(map.has(previous)&&map.get(previous)!==oid){
      throw new Error(`Conflicting oid mappings for previous accountId ${previous}.`);
    }
    map.set(previous,oid);
  }
  return map;
}

async function verifyMicrosoftIdToken(idToken){
  if(!idToken)return null;
  if(!MICROSOFT_TENANT_ID||!MICROSOFT_CLIENT_ID){
    throw new Error("MICROSOFT_TENANT_ID and MICROSOFT_CLIENT_ID are required to verify stored Microsoft ID tokens.");
  }
  if(["common","organizations","consumers"].includes(MICROSOFT_TENANT_ID)){
    throw new Error("Microsoft oid migration requires a concrete tenant GUID, not common/organizations/consumers.");
  }
  const issuer=`${AUTHORITY}/${MICROSOFT_TENANT_ID}/v2.0`;
  const jwks=createRemoteJWKSet(new URL(`${AUTHORITY}/${MICROSOFT_TENANT_ID}/discovery/v2.0/keys`));
  const {payload}=await jwtVerify(idToken,jwks,{
    issuer,
    audience:MICROSOFT_CLIENT_ID,
    algorithms:["RS256"]
  });
  const oid=typeof payload.oid==="string"?payload.oid.trim():"";
  if(!oid)throw new Error("Verified Microsoft ID token is missing a usable oid claim.");
  const tid=typeof payload.tid==="string"?payload.tid.trim():"";
  if(tid&&tid!==MICROSOFT_TENANT_ID){
    throw new Error(`Microsoft ID token tid ${tid} does not match configured tenant ${MICROSOFT_TENANT_ID}.`);
  }
  return oid;
}

const exportMap=loadExportMap(EXPORT_MAP_PATH);
const pool=new Pool({
  ...verifiedDatabaseConnectionConfig(process.env.DATABASE_URL,"contracttwin-microsoft-oid-migrator",{
    requireVerifiedTls:process.env.APP_ENV==="production"
  })
});

let client;
try{
  client=await pool.connect();
  const accountTable=await client.query(`
    select c.relname
      from pg_catalog.pg_class c
      join pg_catalog.pg_namespace n on n.oid=c.relnamespace
     where n.nspname='public' and c.relkind='r' and c.relname in ('account','accounts')
     order by case c.relname when 'account' then 0 else 1 end
     limit 1
  `);
  if(!accountTable.rowCount){
    console.log("No Better Auth account table found; Microsoft oid migration is a no-op.");
    process.exit(0);
  }
  const tableName=accountTable.rows[0].relname;
  const columns=await client.query(`
    select a.attname
      from pg_catalog.pg_attribute a
      join pg_catalog.pg_class c on c.oid=a.attrelid
      join pg_catalog.pg_namespace n on n.oid=c.relnamespace
     where n.nspname='public' and c.relname=$1 and a.attnum>0 and not a.attisdropped
  `,[tableName]);
  const columnNames=new Set(columns.rows.map(row=>row.attname));
  for(const required of ["id","providerId","accountId"]){
    if(!columnNames.has(required))throw new Error(`account table is missing required column ${required}.`);
  }
  if(columnNames.has("issuer")){
    const issuerConstraint=await client.query(`
      select a.attnotnull
        from pg_catalog.pg_attribute a
        join pg_catalog.pg_class c on c.oid=a.attrelid
        join pg_catalog.pg_namespace n on n.oid=c.relnamespace
       where n.nspname='public' and c.relname=$1 and a.attname='issuer' and a.attnum>0 and not a.attisdropped
    `,[tableName]);
    if(issuerConstraint.rows[0]?.attnotnull){
      throw new Error("account.issuer is still NOT NULL. This database appears to have run Better Auth 1.7.0-1.7.2; relax or drop issuer before 1.7.3+ traffic (see Better Auth 1.7 upgrade guide).");
    }
    console.log("Note: nullable account.issuer column is present (harmless leftover from 1.7.0-1.7.2). Better Auth 1.7.3+ no longer writes it.");
  }

  const duplicateKeys=await client.query(`
    select "providerId", "accountId", count(*)::int as copies
      from public.${tableName}
     group by 1, 2
    having count(*) > 1
  `);
  if(duplicateKeys.rowCount){
    throw new Error(`Duplicate (providerId, accountId) rows must be resolved before Microsoft oid migration: ${JSON.stringify(duplicateKeys.rows)}`);
  }

  const rows=(await client.query(`
    select id, "userId", "providerId", "accountId", ${columnNames.has("idToken")?`"idToken"`:"null::text as \"idToken\""}
      from public.${tableName}
     where "providerId" = any($1::text[])
     order by "providerId", id
  `,[PROVIDER_IDS])).rows;

  if(!rows.length){
    console.log("No Microsoft Better Auth account rows found; oid migration is a no-op.");
    process.exit(0);
  }

  const plan=[];
  const unresolved=[];
  for(const row of rows){
    let oid=exportMap.get(row.accountId)||null;
    let source="entra-export-map";
    if(!oid&&row.idToken){
      oid=await verifyMicrosoftIdToken(row.idToken);
      source="verified-id-token";
    }
    if(!oid){
      unresolved.push({id:row.id,providerId:row.providerId,accountId:row.accountId,userId:row.userId});
      continue;
    }
    if(row.accountId===oid){
      plan.push({...row,oid,source,action:"already-oid"});
      continue;
    }
    plan.push({...row,oid,source,action:"rewrite"});
  }

  console.log(JSON.stringify({
    mode:APPLY?"apply":"dry-run",
    table:tableName,
    microsoftAccounts:rows.length,
    alreadyOid:plan.filter(item=>item.action==="already-oid").length,
    rewrites:plan.filter(item=>item.action==="rewrite").length,
    unresolved:unresolved.length
  },null,2));

  if(unresolved.length){
    throw new Error(`Cannot safely cut over ${unresolved.length} Microsoft account row(s) without a verified oid. Pause Microsoft sign-in/linking and supply MICROSOFT_OID_EXPORT_MAP_PATH or stored ID tokens. Sample: ${JSON.stringify(unresolved.slice(0,5))}`);
  }

  const collisions=plan.filter(item=>item.action==="rewrite");
  for(const item of collisions){
    const existing=await client.query(`
      select id from public.${tableName}
       where "providerId"=$1 and "accountId"=$2 and id<>$3
       limit 1
    `,[item.providerId,item.oid,item.id]);
    if(existing.rowCount){
      throw new Error(`Rewriting account ${item.id} to oid ${item.oid} would collide with existing row ${existing.rows[0].id}. Resolve manually before cutover.`);
    }
  }

  if(!APPLY){
    console.log("Dry-run only. Re-run with CONFIRM_MICROSOFT_ACCOUNT_OID_MIGRATION=true after backup and Microsoft sign-in pause to apply.");
    process.exit(0);
  }

  await client.query("begin");
  try{
    for(const item of plan.filter(entry=>entry.action==="rewrite")){
      await client.query(`
        update public.${tableName}
           set "accountId"=$1
         where id=$2 and "providerId"=$3 and "accountId"=$4
      `,[item.oid,item.id,item.providerId,item.accountId]);
      console.log(`Rewrote ${item.providerId} account ${item.id} via ${item.source}.`);
    }
    const postDuplicates=await client.query(`
      select "providerId", "accountId", count(*)::int as copies
        from public.${tableName}
       group by 1, 2
      having count(*) > 1
    `);
    if(postDuplicates.rowCount){
      throw new Error(`Post-migration duplicate account keys detected: ${JSON.stringify(postDuplicates.rows)}`);
    }
    await client.query("commit");
  }catch(error){
    await client.query("rollback");
    throw error;
  }
  console.log("Microsoft account oid migration applied.");
}finally{
  client?.release();
  await pool.end();
}
