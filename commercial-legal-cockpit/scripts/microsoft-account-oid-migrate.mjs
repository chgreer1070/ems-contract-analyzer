/**
 * Better Auth 1.7 Microsoft account-identifier cutover.
 *
 * Better Auth 1.7 stores the stable Entra directory `oid` as account.accountId.
 * Rows created on 1.6 used the pairwise app-specific `sub`. Accepting production
 * Microsoft sign-in before this cutover can create duplicate accounts.
 *
 * This script is intentionally separate from `db:migrate:auth`. Schema DDL does
 * not rewrite identity keys; operators must complete this data step under the
 * Better Auth 1.7 upgrade guide before production traffic on 1.7.
 *
 * Modes:
 *   inventory              Read-only inventory + issuer-column status (default)
 *   apply-id-tokens        Rewrite accountId from verified stored idToken.oid
 *   apply-mapping <file>   Rewrite accountId from trusted CSV: oldAccountId,oid
 *
 * Requires DATABASE_URL. apply-id-tokens also requires MICROSOFT_TENANT_ID and
 * MICROSOFT_CLIENT_ID so tokens can be verified against Entra JWKS.
 */
import {createRemoteJWKSet,decodeJwt,jwtVerify} from "jose";
import {readFile} from "node:fs/promises";
import {resolve} from "node:path";
import pg from "pg";
import {verifiedDatabaseConnectionConfig} from "./database-connection-config.mjs";

const {Pool}=pg;
const MICROSOFT_PROVIDER_IDS=Object.freeze(["microsoft","microsoft-entra-id"]);
const GUID_RE=/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function usage(){
  return [
    "Usage:",
    "  node scripts/microsoft-account-oid-migrate.mjs [inventory]",
    "  node scripts/microsoft-account-oid-migrate.mjs apply-id-tokens [--dry-run]",
    "  node scripts/microsoft-account-oid-migrate.mjs apply-mapping <csv-path> [--dry-run]"
  ].join("\n");
}

function parseArgs(argv){
  const args=argv.slice(2);
  const dryRun=args.includes("--dry-run");
  const positional=args.filter(value=>value!=="--dry-run");
  const mode=positional[0]||"inventory";
  if(!["inventory","apply-id-tokens","apply-mapping"].includes(mode)){
    throw new Error(`${usage()}\nUnknown mode: ${mode}`);
  }
  if(mode==="apply-mapping"&&!positional[1]){
    throw new Error(`${usage()}\napply-mapping requires a CSV path of oldAccountId,oid rows.`);
  }
  if(positional.length>(mode==="apply-mapping"?2:1)){
    throw new Error(`${usage()}\nUnexpected arguments: ${positional.slice(mode==="apply-mapping"?2:1).join(" ")}`);
  }
  return {mode,dryRun,mappingPath:positional[1]};
}

function decodeJwtPayload(token){
  if(typeof token!=="string"||!token.trim())return null;
  try{return decodeJwt(token);}catch{return null;}
}

async function verifyMicrosoftIdToken(token,{tenantId,clientId}){
  const jwks=createRemoteJWKSet(new URL(`https://login.microsoftonline.com/${tenantId}/discovery/v2.0/keys`));
  const issuers=[
    `https://login.microsoftonline.com/${tenantId}/v2.0`,
    `https://sts.windows.net/${tenantId}/`
  ];
  let lastError;
  for(const issuer of issuers){
    try{
      const {payload}=await jwtVerify(token,jwks,{issuer,audience:clientId});
      return payload;
    }catch(error){
      lastError=error;
    }
  }
  throw lastError||new Error("Microsoft ID token verification failed.");
}

function classifyAccount(row,tokenPayload){
  const accountId=row.account_id;
  const oid=typeof tokenPayload?.oid==="string"?tokenPayload.oid.trim():"";
  const sub=typeof tokenPayload?.sub==="string"?tokenPayload.sub.trim():"";
  if(!oid){
    return {status:"needs_external_mapping",reason:"no verified oid claim available from stored idToken"};
  }
  if(accountId===oid){
    return {status:"already_oid",oid};
  }
  if(sub&&accountId===sub){
    return {status:"needs_oid_migration",oid,previous:accountId};
  }
  return {status:"unexpected_account_id",oid,previous:accountId,reason:"accountId matches neither token oid nor sub"};
}

async function tableExists(client,name){
  const result=await client.query(
    `select 1 from pg_catalog.pg_class c
       join pg_catalog.pg_namespace n on n.oid=c.relnamespace
      where n.nspname='public' and c.relname=$1 and c.relkind in ('r','p')`,
    [name]
  );
  return result.rowCount>0;
}

async function inspectIssuerColumn(client){
  if(!(await tableExists(client,"account"))){
    return {present:false,notNull:false,indexPresent:false,note:"account table is absent; Better Auth schema migration has not created it yet"};
  }
  const column=await client.query(
    `select a.attnotnull as not_null
       from pg_catalog.pg_attribute a
       join pg_catalog.pg_class c on c.oid=a.attrelid
       join pg_catalog.pg_namespace n on n.oid=c.relnamespace
      where n.nspname='public' and c.relname='account' and a.attname='issuer' and a.attnum>0 and not a.attisdropped`
  );
  if(!column.rowCount){
    return {
      present:false,
      notNull:false,
      indexPresent:false,
      note:"issuer column absent — expected when upgrading 1.6.x directly to Better Auth >=1.7.3 (including 1.7.14); no issuer schema action required"
    };
  }
  const index=await client.query(
    `select 1 from pg_catalog.pg_class c
       join pg_catalog.pg_namespace n on n.oid=c.relnamespace
      where n.nspname='public' and c.relname='account_issuer_accountId_uidx'`
  );
  return {
    present:true,
    notNull:Boolean(column.rows[0].not_null),
    indexPresent:index.rowCount>0,
    note:"issuer column present — only databases that ran Better Auth 1.7.0–1.7.2 need this relaxed before 1.7.3+ traffic; drop NOT NULL and the compound unique index per the 1.7 upgrade guide"
  };
}

async function loadMicrosoftAccounts(client){
  if(!(await tableExists(client,"account")))return [];
  const result=await client.query(
    `select id,
            "providerId" as provider_id,
            "accountId" as account_id,
            "userId" as user_id,
            "idToken" as id_token
       from public.account
      where "providerId"=any($1::text[])
      order by "providerId", id`,
    [MICROSOFT_PROVIDER_IDS]
  );
  return result.rows;
}

async function loadDuplicateAccountKeys(client){
  if(!(await tableExists(client,"account")))return [];
  const result=await client.query(
    `select "providerId" as provider_id, "accountId" as account_id, count(*)::int as row_count
       from public.account
      group by 1, 2
     having count(*)>1
      order by 1, 2`
  );
  return result.rows;
}

async function parseMappingFile(mappingPath){
  const source=await readFile(resolve(mappingPath),"utf8");
  const mapping=new Map();
  for(const [index,rawLine] of source.split(/\r?\n/u).entries()){
    const line=rawLine.trim();
    if(!line||line.startsWith("#"))continue;
    const [oldAccountId,oid,...rest]=line.split(",").map(part=>part.trim());
    if(!oldAccountId||!oid||rest.length){
      throw new Error(`Mapping CSV line ${index+1} must be exactly oldAccountId,oid`);
    }
    if(!GUID_RE.test(oid)){
      throw new Error(`Mapping CSV line ${index+1} oid must be a GUID: ${oid}`);
    }
    if(mapping.has(oldAccountId)){
      throw new Error(`Mapping CSV duplicates oldAccountId ${oldAccountId}`);
    }
    mapping.set(oldAccountId,oid);
  }
  if(!mapping.size)throw new Error("Mapping CSV contained no data rows.");
  return mapping;
}

async function resolveMigrationPlan(rows,{mode,mapping,tenantId,clientId}){
  const plan=[];
  for(const row of rows){
    if(mode==="apply-mapping"){
      const oid=mapping.get(row.account_id);
      if(!oid){
        plan.push({...row,status:"needs_external_mapping",reason:"old accountId not present in trusted mapping file"});
        continue;
      }
      if(row.account_id===oid){
        plan.push({...row,status:"already_oid",oid});
        continue;
      }
      plan.push({...row,status:"needs_oid_migration",oid,previous:row.account_id});
      continue;
    }

    let tokenPayload=null;
    if(row.id_token){
      if(mode==="apply-id-tokens"){
        tokenPayload=await verifyMicrosoftIdToken(row.id_token,{tenantId,clientId});
      }else{
        tokenPayload=decodeJwtPayload(row.id_token);
      }
    }
    const classification=classifyAccount(row,tokenPayload);
    plan.push({...row,...classification});
  }
  return plan;
}

async function applyMigrations(client,plan,{dryRun}){
  const updates=plan.filter(row=>row.status==="needs_oid_migration");
  const conflicts=[];
  for(const row of updates){
    const clash=await client.query(
      `select id from public.account
        where "providerId"=$1 and "accountId"=$2 and id<>$3`,
      [row.provider_id,row.oid,row.id]
    );
    if(clash.rowCount){
      conflicts.push({id:row.id,providerId:row.provider_id,oid:row.oid,existingId:clash.rows[0].id});
    }
  }
  if(conflicts.length){
    throw new Error(`Refusing Microsoft oid migration; target oid already exists for another account row: ${JSON.stringify(conflicts)}`);
  }
  if(dryRun){
    return {updated:0,planned:updates.length,dryRun:true};
  }
  let updated=0;
  for(const row of updates){
    const result=await client.query(
      `update public.account
          set "accountId"=$1, "updatedAt"=now()
        where id=$2 and "providerId"=$3 and "accountId"=$4`,
      [row.oid,row.id,row.provider_id,row.previous]
    );
    if(result.rowCount!==1){
      throw new Error(`Failed to update account ${row.id}; expected exactly one row.`);
    }
    updated+=1;
  }
  return {updated,planned:updates.length,dryRun:false};
}

function summarize(plan){
  const counts={already_oid:0,needs_oid_migration:0,needs_external_mapping:0,unexpected_account_id:0};
  for(const row of plan)counts[row.status]=(counts[row.status]||0)+1;
  return counts;
}

async function main(){
  const {mode,dryRun,mappingPath}=parseArgs(process.argv);
  if(!process.env.DATABASE_URL)throw new Error("DATABASE_URL is required.");

  const tenantId=process.env.MICROSOFT_TENANT_ID;
  const clientId=process.env.MICROSOFT_CLIENT_ID;
  if(mode==="apply-id-tokens"){
    if(!tenantId||!GUID_RE.test(tenantId)){
      throw new Error("apply-id-tokens requires MICROSOFT_TENANT_ID set to a concrete tenant GUID.");
    }
    if(!clientId)throw new Error("apply-id-tokens requires MICROSOFT_CLIENT_ID.");
  }

  const mapping=mode==="apply-mapping"?await parseMappingFile(mappingPath):null;
  const pool=new Pool({
    ...verifiedDatabaseConnectionConfig(process.env.DATABASE_URL,"contracttwin-microsoft-oid-migrator",{
      requireVerifiedTls:process.env.APP_ENV==="production"
    })
  });

  let client;
  try{
    client=await pool.connect();
    const issuer=await inspectIssuerColumn(client);
    const duplicates=await loadDuplicateAccountKeys(client);
    const rows=await loadMicrosoftAccounts(client);
    const plan=await resolveMigrationPlan(rows,{mode,mapping,tenantId,clientId});
    const counts=summarize(plan);

    console.log(JSON.stringify({
      mode,
      dryRun,
      betterAuthUpgrade:"1.7 Microsoft account identifiers use Entra oid; issuer column is not required on 1.7.3+",
      issuer,
      duplicateAccountKeys:duplicates,
      microsoftAccountCount:rows.length,
      statusCounts:counts,
      rows:plan.map(({id,provider_id,account_id,user_id,status,oid,previous,reason})=>({
        id,
        providerId:provider_id,
        accountId:account_id,
        userId:user_id,
        status,
        oid:oid||null,
        previous:previous||null,
        reason:reason||null
      }))
    },null,2));

    if(duplicates.length){
      throw new Error("Resolve duplicate (providerId, accountId) rows before Better Auth 1.7 upgrade traffic.");
    }
    if(issuer.present&&issuer.notNull){
      throw new Error("account.issuer is still NOT NULL. Relax or remove it per the Better Auth 1.7 upgrade guide before 1.7.3+ traffic.");
    }
    if(counts.unexpected_account_id){
      throw new Error("One or more Microsoft account rows have an unexpected accountId; resolve manually before cutover.");
    }

    if(mode==="inventory"){
      if(counts.needs_oid_migration||counts.needs_external_mapping){
        console.error("Microsoft account oid migration is still required before production Better Auth 1.7 traffic.");
        process.exitCode=2;
      }else{
        console.error("Microsoft account oid inventory is clean.");
      }
      return;
    }

    if(counts.needs_external_mapping){
      throw new Error("Cannot apply: one or more Microsoft accounts still need a trusted Entra oid mapping or a stored idToken.");
    }

    await client.query("begin");
    const result=await applyMigrations(client,plan,{dryRun});
    if(dryRun)await client.query("rollback");
    else await client.query("commit");
    console.error(JSON.stringify({applyResult:result},null,2));
  }finally{
    client?.release();
    await pool.end();
  }
}

main().catch(error=>{
  console.error(error instanceof Error?error.message:error);
  process.exitCode=1;
});
