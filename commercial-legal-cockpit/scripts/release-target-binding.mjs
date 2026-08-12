import {createHash,randomBytes} from "node:crypto";
import pg from "pg";
import {assertTrustedMigrationTarget,verifiedDatabaseConnectionConfig} from "./database-connection-config.mjs";
import {
  assertExactSchemaMigrationReceipts,
  loadSchemaMigrationManifest,
  MIGRATION_ADVISORY_XACT_LOCK_QUERY
} from "./schema-migration-manifest.mjs";
import {assertProductionTargetAnchor} from "./production-target-anchor.mjs";

const {Client}=pg;

export const RELEASE_SOURCE_SHA_PATTERN=/^[0-9a-f]{40}$/u;
export const RELEASE_TARGET_NONCE_PATTERN=/^[0-9a-f]{64}$/u;
export const LIVE_DATABASE_FINGERPRINT_PATTERN=/^[0-9a-f]{64}$/u;
const HELD_DATABASE_CHALLENGE_PATTERN=/^-?\d+:-?\d+,-?\d+:-?\d+$/u;

const PRE_MIGRATION_DATABASE_IDENTITY_QUERY=`
  select
    pg_catalog.current_database()::text database_name,
    d.oid::text database_oid,
    c.system_identifier::text system_identifier,
    extract(epoch from pg_catalog.pg_postmaster_start_time())::text postmaster_started_at,
    pg_catalog.pg_is_in_recovery() in_recovery,
    pg_catalog.current_setting('transaction_read_only') transaction_read_only,
    session_user::text session_user_name,
    current_user::text current_user_name
  from pg_catalog.pg_database d
  cross join pg_catalog.pg_control_system() c
  where d.datname OPERATOR(pg_catalog.=) pg_catalog.current_database()
`;

const DATABASE_IDENTITY_QUERY=`
  select identity_record.database_id::text database_id,
         external_identity.external_database_id::text external_database_id
    from public.release_database_identity identity_record
    join public.release_database_external_identity external_identity
      on external_identity.release_database_id=identity_record.database_id
     and external_identity.singleton=true
   where identity_record.singleton=true
`;

const RELEASE_RECEIPT_QUERY=`
  select database_id::text database_id,source_sha,nonce_sha256
    from public.release_target_receipts
   where source_sha=$1 and nonce_sha256=$2
`;

function quoteIdentifier(value){
  return `"${String(value).replaceAll('"','""')}"`;
}

function randomAdvisoryLockKey(){
  const bytes=randomBytes(8);
  return [bytes.readInt32BE(0),bytes.readInt32BE(4)];
}

function encodeChallengeLocks(locks){
  return locks.map(key=>key.join(":")).join(",");
}

function parseChallengeLocks(encoded){
  if(!HELD_DATABASE_CHALLENGE_PATTERN.test(encoded||"")){
    throw new Error("Held pre-migration database challenge is missing or malformed.");
  }
  const locks=encoded.split(",").map(value=>value.split(":").map(Number));
  if(
    locks.length!==2||
    locks.some(key=>key.length!==2||key.some(part=>!Number.isInteger(part)||part<-(2**31)||part>(2**31)-1))
  ){
    throw new Error("Held pre-migration database challenge is outside PostgreSQL int32 bounds.");
  }
  if(locks[0][0]===locks[1][0]&&locks[0][1]===locks[1][1]){
    throw new Error("Held pre-migration database challenges must be independent.");
  }
  return locks;
}

export function liveDatabaseFingerprint(identity){
  const fields=[
    identity?.database_name,
    identity?.database_oid,
    identity?.system_identifier,
    identity?.postmaster_started_at,
    identity?.in_recovery
  ];
  if(fields.some(value=>value===undefined||value===null||value==="")){
    throw new Error("Live database fingerprint evidence is incomplete.");
  }
  return createHash("sha256").update(JSON.stringify(fields),"utf8").digest("hex");
}

async function acquireChallengeLocks(client,count=2){
  const locks=[];
  for(let index=0;index<count;index+=1){
    let acquired=false;
    for(let attempt=0;attempt<8;attempt+=1){
      const key=randomAdvisoryLockKey();
      if(locks.some(existing=>existing[0]===key[0]&&existing[1]===key[1]))continue;
      const row=(await client.query(
        "select pg_catalog.pg_try_advisory_xact_lock($1,$2) acquired",
        key
      )).rows[0];
      if(row?.acquired===true){
        locks.push(key);
        acquired=true;
        break;
      }
    }
    if(!acquired)throw new Error("Could not reserve an unpredictable pre-migration database challenge lock.");
  }
  return locks;
}

export function evaluatePreMigrationTargetBinding({migrationIdentity,runtimeIdentity,runtimeChallengeResults}){
  const errors=[];
  if(!migrationIdentity?.database_name||!migrationIdentity?.database_oid){
    errors.push("migration database identity is incomplete");
  }
  if(!runtimeIdentity?.database_name||!runtimeIdentity?.database_oid){
    errors.push("runtime database identity is incomplete");
  }
  if(migrationIdentity?.session_user_name!==migrationIdentity?.current_user_name){
    errors.push("migration session identity is ambiguous");
  }
  if(runtimeIdentity?.session_user_name!==runtimeIdentity?.current_user_name){
    errors.push("runtime session identity is ambiguous");
  }
  if(!migrationIdentity?.session_user_name||migrationIdentity.session_user_name===runtimeIdentity?.session_user_name){
    errors.push("migration and runtime database principals are not distinct");
  }
  if(
    migrationIdentity?.database_name!==runtimeIdentity?.database_name||
    migrationIdentity?.database_oid!==runtimeIdentity?.database_oid||
    migrationIdentity?.system_identifier!==runtimeIdentity?.system_identifier||
    migrationIdentity?.postmaster_started_at!==runtimeIdentity?.postmaster_started_at||
    migrationIdentity?.in_recovery!==runtimeIdentity?.in_recovery
  ){
    errors.push("migration and runtime credentials do not report the same live database evidence");
  }
  if(migrationIdentity?.in_recovery!==false||runtimeIdentity?.in_recovery!==false){
    errors.push("production schema changes require the writable primary database");
  }
  if(migrationIdentity?.transaction_read_only!=="on"||runtimeIdentity?.transaction_read_only!=="on"){
    errors.push("pre-migration target proof did not remain read-only");
  }
  if(
    !Array.isArray(runtimeChallengeResults)||
    runtimeChallengeResults.length!==2||
    runtimeChallengeResults.some(result=>result!==false)
  ){
    errors.push("migration and runtime credentials did not prove the same live database instance");
  }
  return {ok:errors.length===0,errors};
}

// This proof deliberately runs before any application or authentication
// migration. Two unpredictable advisory locks are held by the migrator and
// challenged through the runtime credential. Matching catalog identity alone
// is insufficient because independently reachable databases can share names
// and copied catalog values; the live lock challenge cannot cross a different
// PostgreSQL database instance. It does not distinguish an in-place restore or
// clone routed behind the same externally approved endpoint.
// The read-only transactions pin pooled connections while transaction-scoped
// advisory locks leave no schema or data behind, so the same protocol safely
// covers an empty first-bootstrap target.
export async function verifyPreMigrationTargetBinding({
  migrationConnectionString,
  runtimeConnectionString,
  expectedTargetAnchor=null,
  requireVerifiedTls=true
}){
  const migrationClient=new Client(verifiedDatabaseConnectionConfig(
    migrationConnectionString,
    "contracttwin-pre-migration-target-migrator",
    {requireVerifiedTls}
  ));
  const runtimeClient=new Client(verifiedDatabaseConnectionConfig(
    runtimeConnectionString,
    "contracttwin-pre-migration-target-runtime",
    {requireVerifiedTls}
  ));
  let migrationTransaction=false;
  let runtimeTransaction=false;
  let released=false;
  const release=async()=>{
    if(released)return;
    released=true;
    if(runtimeTransaction){try{await runtimeClient.query("rollback");}catch{}}
    if(migrationTransaction){try{await migrationClient.query("rollback");}catch{}}
    await Promise.allSettled([migrationClient.end(),runtimeClient.end()]);
  };
  try{
    await migrationClient.connect();
    await runtimeClient.connect();
    await migrationClient.query("begin transaction read only");
    migrationTransaction=true;
    await runtimeClient.query("begin transaction read only");
    runtimeTransaction=true;
    await assertTrustedMigrationTarget(migrationClient);
    const migrationIdentityRows=(await migrationClient.query(PRE_MIGRATION_DATABASE_IDENTITY_QUERY)).rows;
    const runtimeIdentityRows=(await runtimeClient.query(PRE_MIGRATION_DATABASE_IDENTITY_QUERY)).rows;
    if(migrationIdentityRows.length!==1||runtimeIdentityRows.length!==1){
      throw new Error("Pre-migration database identity queries must each return exactly one row.");
    }

    const migrationLocks=await acquireChallengeLocks(migrationClient,2);
    const runtimeChallengeResults=[];
    for(const key of migrationLocks){
      const row=(await runtimeClient.query(
        "select pg_catalog.pg_try_advisory_xact_lock($1,$2) acquired",
        key
      )).rows[0];
      const acquired=row?.acquired===true;
      runtimeChallengeResults.push(acquired);
    }
    const evaluated=evaluatePreMigrationTargetBinding({
      migrationIdentity:migrationIdentityRows[0],
      runtimeIdentity:runtimeIdentityRows[0],
      runtimeChallengeResults
    });
    if(!evaluated.ok)throw new Error(`Pre-migration target binding failed: ${evaluated.errors.join("; ")}`);
    const allowedReaderNames=[migrationIdentityRows[0].session_user_name,runtimeIdentityRows[0].session_user_name];
    if(expectedTargetAnchor){
      await assertProductionTargetAnchor(migrationClient,{
        expectedAnchor:expectedTargetAnchor,
        allowedReaderNames,
        label:"Migration credential production target"
      });
      await assertProductionTargetAnchor(runtimeClient,{
        expectedAnchor:expectedTargetAnchor,
        allowedReaderNames,
        label:"Runtime credential production target"
      });
    }
    return {
      challenge:encodeChallengeLocks(migrationLocks),
      liveDatabaseFingerprint:liveDatabaseFingerprint(migrationIdentityRows[0]),
      migrationPrincipal:allowedReaderNames[0],
      runtimePrincipal:allowedReaderNames[1],
      release,
      verified:true
    };
  }catch(error){
    await release();
    throw error;
  }
}

export async function assertHeldPreMigrationTargetChallenge(client,{
  withinTransaction=false,
  encodedChallenge=process.env.HELD_PRE_MIGRATION_DATABASE_CHALLENGE||"",
  expectedFingerprint=process.env.EXPECTED_LIVE_DATABASE_FINGERPRINT||""
}={}){
  if(process.env.APP_ENV!=="production"&&!encodedChallenge&&!expectedFingerprint){
    return {skipped:true};
  }
  const locks=parseChallengeLocks(encodedChallenge);
  if(!LIVE_DATABASE_FINGERPRINT_PATTERN.test(expectedFingerprint)){
    throw new Error("Expected live database fingerprint is missing or malformed.");
  }
  let ownTransaction=false;
  try{
    if(!withinTransaction){
      await client.query("begin transaction read only");
      ownTransaction=true;
    }
    const identityRows=(await client.query(PRE_MIGRATION_DATABASE_IDENTITY_QUERY)).rows;
    if(identityRows.length!==1||liveDatabaseFingerprint(identityRows[0])!==expectedFingerprint){
      throw new Error("Migration connection does not match the held live database fingerprint.");
    }
    const challengeResults=[];
    for(const key of locks){
      const row=(await client.query(
        "select pg_catalog.pg_try_advisory_xact_lock($1,$2) acquired",
        key
      )).rows[0];
      challengeResults.push(row?.acquired);
    }
    if(challengeResults.length!==2||challengeResults.some(result=>result!==false)){
      throw new Error("Migration connection does not reach the database protected by the held pre-migration challenge.");
    }
    return {verified:true};
  }finally{
    if(ownTransaction){try{await client.query("rollback");}catch{}}
  }
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
  await migrationClient.query(`revoke all privileges on table public.release_database_identity,public.release_database_external_identity,public.release_target_receipts from ${role}`);
  await migrationClient.query(`revoke select(singleton,database_id,created_at),insert(singleton,database_id,created_at),update(singleton,database_id,created_at),references(singleton,database_id,created_at) on table public.release_database_identity from ${role}`);
  await migrationClient.query(`revoke select(singleton,external_database_id,release_database_id,created_at),insert(singleton,external_database_id,release_database_id,created_at),update(singleton,external_database_id,release_database_id,created_at),references(singleton,external_database_id,release_database_id,created_at) on table public.release_database_external_identity from ${role}`);
  await migrationClient.query(`revoke select(nonce_sha256,database_id,source_sha,created_at),insert(nonce_sha256,database_id,source_sha,created_at),update(nonce_sha256,database_id,source_sha,created_at),references(nonce_sha256,database_id,source_sha,created_at) on table public.release_target_receipts from ${role}`);
  await migrationClient.query(`grant select on table public.release_database_identity,public.release_database_external_identity,public.release_target_receipts to ${role}`);
}

export async function establishReleaseTargetBinding({
  migrationConnectionString,
  runtimeConnectionString,
  sourceSha,
  heldChallenge="",
  expectedLiveDatabaseFingerprint="",
  expectedTargetAnchor=null,
  requireVerifiedTls=true
}){
  if(!RELEASE_SOURCE_SHA_PATTERN.test(sourceSha))throw new Error("Release source SHA must be exactly 40 lowercase hexadecimal characters.");
  if(!heldChallenge||!expectedLiveDatabaseFingerprint){
    throw new Error("Release target mutation requires the still-held pre-migration database challenge and live fingerprint.");
  }
  if(!expectedTargetAnchor)throw new Error("Release target mutation requires the externally approved production target anchor.");
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
  let migrationTransactionOpen=false;
  let runtimeTransactionOpen=false;
  try{
    await migrationClient.connect();
    await runtimeClient.connect();
    await migrationClient.query("begin");
    migrationTransactionOpen=true;
    await assertHeldPreMigrationTargetChallenge(migrationClient,{
      withinTransaction:true,
      encodedChallenge:heldChallenge,
      expectedFingerprint:expectedLiveDatabaseFingerprint
    });
    await migrationClient.query(MIGRATION_ADVISORY_XACT_LOCK_QUERY);
    await assertTrustedMigrationTarget(migrationClient);

    await runtimeClient.query("begin transaction read only");
    runtimeTransactionOpen=true;
    await assertHeldPreMigrationTargetChallenge(runtimeClient,{
      withinTransaction:true,
      encodedChallenge:heldChallenge,
      expectedFingerprint:expectedLiveDatabaseFingerprint
    });
    const migrationIdentity=(await migrationClient.query("select session_user::text session_user_name,current_user::text current_user_name")).rows[0];
    const runtimeIdentity=(await runtimeClient.query("select session_user::text session_user_name,current_user::text current_user_name")).rows[0];
    if(!migrationIdentity?.session_user_name||migrationIdentity.session_user_name!==migrationIdentity.current_user_name){
      throw new Error("Release target migration session identity is ambiguous.");
    }
    if(!runtimeIdentity?.session_user_name||runtimeIdentity.session_user_name!==runtimeIdentity.current_user_name){
      throw new Error("Release target runtime session identity is ambiguous.");
    }
    if(migrationIdentity.session_user_name===runtimeIdentity.session_user_name){
      throw new Error("Release target migration and runtime principals must remain distinct.");
    }
    const allowedReaderNames=[migrationIdentity.session_user_name,runtimeIdentity.session_user_name];
    await assertProductionTargetAnchor(migrationClient,{
      expectedAnchor:expectedTargetAnchor,
      allowedReaderNames,
      label:"Migration credential production target"
    });
    await assertProductionTargetAnchor(runtimeClient,{
      expectedAnchor:expectedTargetAnchor,
      allowedReaderNames,
      label:"Runtime credential production target"
    });
    await grantReleaseControlReadAccess(migrationClient,runtimeIdentity.session_user_name);

    const migrationDatabaseRows=(await migrationClient.query(DATABASE_IDENTITY_QUERY)).rows;
    if(migrationDatabaseRows.length!==1)throw new Error("Migration release database identity must contain exactly one immutable row.");
    const migrationDatabaseId=migrationDatabaseRows[0].database_id;
    if(migrationDatabaseRows[0].external_database_id!==expectedTargetAnchor.databaseId){
      throw new Error("Migration release database external identity does not match the externally approved production target.");
    }

    const manifest=await loadSchemaMigrationManifest();
    const migrationReceipts=(await migrationClient.query("select filename,sha256 from public.schema_migrations order by filename")).rows;
    assertExactSchemaMigrationReceipts(migrationReceipts,manifest,"Migration target");

    const nonce=randomBytes(32).toString("hex");
    const nonceSha256=hashReleaseTargetNonce(nonce);
    await migrationClient.query(
      `insert into public.release_target_receipts(nonce_sha256,database_id,source_sha)
       values($1,$2::uuid,$3)`,
      [nonceSha256,migrationDatabaseId,sourceSha]
    );
    await assertHeldPreMigrationTargetChallenge(migrationClient,{
      withinTransaction:true,
      encodedChallenge:heldChallenge,
      expectedFingerprint:expectedLiveDatabaseFingerprint
    });
    await assertTrustedMigrationTarget(migrationClient);
    await migrationClient.query("commit");
    migrationTransactionOpen=false;

    const runtimeDatabaseRows=(await runtimeClient.query(DATABASE_IDENTITY_QUERY)).rows;
    if(runtimeDatabaseRows.length!==1)throw new Error("Runtime release database identity must contain exactly one immutable row.");
    const runtimeDatabaseId=runtimeDatabaseRows[0].database_id;
    if(migrationDatabaseId!==runtimeDatabaseId){
      throw new Error("Migration and runtime credentials do not reach the same release database.");
    }
    if(runtimeDatabaseRows[0].external_database_id!==expectedTargetAnchor.databaseId){
      throw new Error("Runtime release database external identity does not match the externally approved production target.");
    }
    const runtimeReceipts=(await runtimeClient.query("select filename,sha256 from public.schema_migrations order by filename")).rows;
    assertExactSchemaMigrationReceipts(runtimeReceipts,manifest,"Runtime target");
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
    await assertHeldPreMigrationTargetChallenge(runtimeClient,{
      withinTransaction:true,
      encodedChallenge:heldChallenge,
      expectedFingerprint:expectedLiveDatabaseFingerprint
    });
    await runtimeClient.query("commit");
    runtimeTransactionOpen=false;
    return {nonce,migrationReceiptCount:manifest.migrations.length};
  }finally{
    if(runtimeTransactionOpen){try{await runtimeClient.query("rollback");}catch{}}
    if(migrationTransactionOpen){try{await migrationClient.query("rollback");}catch{}}
    await Promise.allSettled([migrationClient.end(),runtimeClient.end()]);
  }
}
