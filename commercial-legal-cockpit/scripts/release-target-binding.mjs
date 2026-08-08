import {createHash,randomBytes} from "node:crypto";
import pg from "pg";
import {verifiedDatabaseConnectionConfig} from "./database-connection-config.mjs";
import {
  assertExactSchemaMigrationReceipts,
  loadSchemaMigrationManifest
} from "./schema-migration-manifest.mjs";

const {Client}=pg;

export const RELEASE_SOURCE_SHA_PATTERN=/^[0-9a-f]{40}$/u;
export const RELEASE_TARGET_NONCE_PATTERN=/^[0-9a-f]{64}$/u;

const DATABASE_IDENTITY_QUERY=`
  select database_id::text database_id
    from public.release_database_identity
   where singleton=true
`;

const RELEASE_RECEIPT_QUERY=`
  select database_id::text database_id,source_sha,nonce_sha256
    from public.release_target_receipts
   where source_sha=$1 and nonce_sha256=$2
`;

function quoteIdentifier(value){
  return `"${String(value).replaceAll('"','""')}"`;
}

export function hashReleaseTargetNonce(nonce){
  if(!RELEASE_TARGET_NONCE_PATTERN.test(nonce))throw new Error("Release target nonce is invalid.");
  return createHash("sha256").update(nonce,"utf8").digest("hex");
}

export function evaluateReleaseTargetBinding({
  migrationDatabaseId,
  runtimeDatabaseId,
  receipt,
  expectedSourceSha,
  expectedNonceSha256
}){
  const errors=[];
  if(!migrationDatabaseId||!runtimeDatabaseId||migrationDatabaseId!==runtimeDatabaseId){
    errors.push("migration and runtime database identities do not match");
  }
  if(!receipt||receipt.database_id!==migrationDatabaseId||receipt.database_id!==runtimeDatabaseId){
    errors.push("release receipt is not bound to the exact database identity");
  }
  if(receipt?.source_sha!==expectedSourceSha)errors.push("release receipt source SHA does not match");
  if(receipt?.nonce_sha256!==expectedNonceSha256)errors.push("release receipt nonce hash does not match");
  return {ok:errors.length===0,errors};
}

async function grantReleaseControlReadAccess(migrationClient,runtimeRoleName){
  const role=quoteIdentifier(runtimeRoleName);
  await migrationClient.query("begin");
  try{
    await migrationClient.query(`revoke all privileges on table public.release_database_identity,public.release_target_receipts from ${role}`);
    await migrationClient.query(`revoke select(singleton,database_id,created_at),insert(singleton,database_id,created_at),update(singleton,database_id,created_at),references(singleton,database_id,created_at) on table public.release_database_identity from ${role}`);
    await migrationClient.query(`revoke select(nonce_sha256,database_id,source_sha,created_at),insert(nonce_sha256,database_id,source_sha,created_at),update(nonce_sha256,database_id,source_sha,created_at),references(nonce_sha256,database_id,source_sha,created_at) on table public.release_target_receipts from ${role}`);
    await migrationClient.query(`grant select on table public.release_database_identity,public.release_target_receipts to ${role}`);
    await migrationClient.query("commit");
  }catch(error){
    await migrationClient.query("rollback");
    throw error;
  }
}

export async function establishReleaseTargetBinding({
  migrationConnectionString,
  runtimeConnectionString,
  sourceSha,
  requireVerifiedTls=true
}){
  if(!RELEASE_SOURCE_SHA_PATTERN.test(sourceSha))throw new Error("Release source SHA must be exactly 40 lowercase hexadecimal characters.");
  const migrationClient=new Client(verifiedDatabaseConnectionConfig(
    migrationConnectionString,
    "contracttwin-release-target-migrator",
    {requireVerifiedTls}
  ));
  const runtimeClient=new Client(verifiedDatabaseConnectionConfig(
    runtimeConnectionString,
    "contracttwin-release-target-runtime",
    {requireVerifiedTls}
  ));
  try{
    await migrationClient.connect();
    await runtimeClient.connect();
    const runtimeIdentity=(await runtimeClient.query("select session_user::text session_user_name,current_user::text current_user_name")).rows[0];
    if(!runtimeIdentity?.session_user_name||runtimeIdentity.session_user_name!==runtimeIdentity.current_user_name){
      throw new Error("Release target runtime session identity is ambiguous.");
    }
    await grantReleaseControlReadAccess(migrationClient,runtimeIdentity.session_user_name);

    const migrationDatabaseRows=(await migrationClient.query(DATABASE_IDENTITY_QUERY)).rows;
    const runtimeDatabaseRows=(await runtimeClient.query(DATABASE_IDENTITY_QUERY)).rows;
    if(migrationDatabaseRows.length!==1||runtimeDatabaseRows.length!==1){
      throw new Error("Release database identity must contain exactly one immutable row.");
    }
    const migrationDatabaseId=migrationDatabaseRows[0].database_id;
    const runtimeDatabaseId=runtimeDatabaseRows[0].database_id;
    if(migrationDatabaseId!==runtimeDatabaseId){
      throw new Error("Migration and runtime credentials do not reach the same release database.");
    }

    const manifest=await loadSchemaMigrationManifest();
    const migrationReceipts=(await migrationClient.query("select filename,sha256 from public.schema_migrations order by filename")).rows;
    const runtimeReceipts=(await runtimeClient.query("select filename,sha256 from public.schema_migrations order by filename")).rows;
    assertExactSchemaMigrationReceipts(migrationReceipts,manifest,"Migration target");
    assertExactSchemaMigrationReceipts(runtimeReceipts,manifest,"Runtime target");

    const nonce=randomBytes(32).toString("hex");
    const nonceSha256=hashReleaseTargetNonce(nonce);
    await migrationClient.query(
      `insert into public.release_target_receipts(nonce_sha256,database_id,source_sha)
       values($1,$2::uuid,$3)`,
      [nonceSha256,migrationDatabaseId,sourceSha]
    );
    const runtimeReceiptRows=(await runtimeClient.query(RELEASE_RECEIPT_QUERY,[sourceSha,nonceSha256])).rows;
    if(runtimeReceiptRows.length!==1)throw new Error("Runtime credential cannot read the exact per-release target receipt.");
    const evaluated=evaluateReleaseTargetBinding({
      migrationDatabaseId,
      runtimeDatabaseId,
      receipt:runtimeReceiptRows[0],
      expectedSourceSha:sourceSha,
      expectedNonceSha256:nonceSha256
    });
    if(!evaluated.ok)throw new Error(`Release target binding failed: ${evaluated.errors.join("; ")}`);
    return {nonce,migrationReceiptCount:manifest.migrations.length};
  }finally{
    await Promise.allSettled([migrationClient.end(),runtimeClient.end()]);
  }
}
