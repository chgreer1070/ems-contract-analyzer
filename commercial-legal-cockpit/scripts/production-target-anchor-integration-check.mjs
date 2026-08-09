import assert from "node:assert/strict";
import {randomBytes,randomUUID} from "node:crypto";
import pg from "pg";
import {verifiedDatabaseConnectionConfig} from "./database-connection-config.mjs";
import {loadCanonicalMigrationSources} from "./migration-source.mjs";
import {
  assertBootstrapOwnedProductionTargetAnchor,
  assertProductionTargetAnchor,
  databaseEndpointSha256,
  expectedProductionTargetAnchor
} from "./production-target-anchor.mjs";
import {
  assertHeldPreMigrationTargetChallenge,
  verifyPreMigrationTargetBinding
} from "./release-target-binding.mjs";
import {assertPristineProductionBootstrapTarget} from "./schema-migration-manifest.mjs";

const {Client}=pg;
const ownerConnectionString=process.env.DATABASE_URL||"";
if(
  process.env.CI!=="true"||
  process.env.GITHUB_ACTIONS!=="true"||
  process.env.CI_DATABASE_CONTROL_FIXTURE!=="disposable-postgres-service"
){
  throw new Error("Production target-anchor integration is restricted to the explicitly marked disposable GitHub Actions PostgreSQL service.");
}
const ownerUrl=new URL(ownerConnectionString);
if(!["localhost","127.0.0.1","[::1]"].includes(ownerUrl.hostname)||decodeURIComponent(ownerUrl.pathname)!=="/contracttwin"){
  throw new Error("Production target-anchor integration refused a non-loopback or non-ephemeral owner target.");
}

function quoteIdentifier(value){return `"${String(value).replaceAll('"','""')}"`;}
function quoteLiteral(value){return `'${String(value).replaceAll("'","''")}'`;}
function roleUrl(baseUrl,role,password,databaseName){
  const url=new URL(baseUrl);
  url.username=role;
  url.password=password;
  url.pathname=`/${databaseName}`;
  return url.toString();
}

const suffix=randomBytes(6).toString("hex");
const databaseName=`contracttwin_anchor_${suffix}`;
const migrationRole=`ct_migration_${suffix}`;
const runtimeRole=`ct_runtime_${suffix}`;
const bootstrapRole=`ct_bootstrap_${suffix}`;
const unexpectedRole=`ct_unexpected_${suffix}`;
const migrationPassword=randomBytes(32).toString("base64url");
const runtimePassword=randomBytes(32).toString("base64url");
const bootstrapPassword=randomBytes(32).toString("base64url");
const unexpectedPassword=randomBytes(32).toString("base64url");
const maintenanceUrl=new URL(ownerUrl);
maintenanceUrl.pathname="/postgres";
const adminClient=new Client(verifiedDatabaseConnectionConfig(maintenanceUrl.toString(),"contracttwin-anchor-fixture-admin"));
let databaseCreated=false;
const createdRoles=[];
try{
  await adminClient.connect();
  for(const [role,password] of [
    [migrationRole,migrationPassword],
    [runtimeRole,runtimePassword],
    [bootstrapRole,bootstrapPassword],
    [unexpectedRole,unexpectedPassword]
  ]){
    await adminClient.query(`create role ${quoteIdentifier(role)} login password ${quoteLiteral(password)} nosuperuser nocreatedb nocreaterole noinherit noreplication nobypassrls`);
    createdRoles.push(role);
  }
  await adminClient.query(`create database ${quoteIdentifier(databaseName)} owner ${quoteIdentifier(migrationRole)}`);
  databaseCreated=true;

  const fixtureAdminUrl=new URL(ownerUrl);
  fixtureAdminUrl.pathname=`/${databaseName}`;
  const fixtureAdmin=new Client(verifiedDatabaseConnectionConfig(fixtureAdminUrl.toString(),"contracttwin-anchor-fixture-setup"));
  try{
    await fixtureAdmin.connect();
    await fixtureAdmin.query(`revoke create on schema public from public`);
    await fixtureAdmin.query(`revoke temporary on database ${quoteIdentifier(databaseName)} from public`);
    await fixtureAdmin.query(`grant connect on database ${quoteIdentifier(databaseName)} to ${quoteIdentifier(migrationRole)},${quoteIdentifier(runtimeRole)},${quoteIdentifier(bootstrapRole)},${quoteIdentifier(unexpectedRole)}`);
    await fixtureAdmin.query(`grant create on database ${quoteIdentifier(databaseName)} to ${quoteIdentifier(bootstrapRole)}`);
  }finally{await fixtureAdmin.end();}

  const migrationConnectionString=roleUrl(ownerUrl,migrationRole,migrationPassword,databaseName);
  const runtimeConnectionString=roleUrl(ownerUrl,runtimeRole,runtimePassword,databaseName);
  const bootstrapConnectionString=roleUrl(ownerUrl,bootstrapRole,bootstrapPassword,databaseName);
  const unexpectedConnectionString=roleUrl(ownerUrl,unexpectedRole,unexpectedPassword,databaseName);
  const endpointSha256=databaseEndpointSha256(migrationConnectionString);
  const token=randomBytes(32).toString("hex");
  const databaseId=randomUUID();
  const expectedAnchor=expectedProductionTargetAnchor({
    token,databaseId,
    runtimeEndpointSha256:endpointSha256,
    migrationEndpointSha256:endpointSha256
  });

  await assert.rejects(
    ()=>verifyPreMigrationTargetBinding({
      migrationConnectionString,runtimeConnectionString,expectedTargetAnchor:expectedAnchor,requireVerifiedTls:false
    }),
    /not externally anchored/
  );

  const bootstrapBinding=await verifyPreMigrationTargetBinding({
    migrationConnectionString,runtimeConnectionString,requireVerifiedTls:false
  });
  try{
    const bootstrapClient=new Client(verifiedDatabaseConnectionConfig(bootstrapConnectionString,"contracttwin-anchor-fixture-bootstrap"));
    let transactionOpen=false;
    try{
      await bootstrapClient.connect();
      await bootstrapClient.query("begin");
      transactionOpen=true;
      await assertHeldPreMigrationTargetChallenge(bootstrapClient,{
        withinTransaction:true,
        encodedChallenge:bootstrapBinding.challenge,
        expectedFingerprint:bootstrapBinding.liveDatabaseFingerprint
      });
      await assertPristineProductionBootstrapTarget(bootstrapClient,"Anchor integration pristine target");
      const migrationIdentifier=quoteIdentifier(migrationRole);
      const runtimeIdentifier=quoteIdentifier(runtimeRole);
      await bootstrapClient.query("create schema contracttwin_control authorization current_user");
      await bootstrapClient.query("revoke all privileges on schema contracttwin_control from public");
      await bootstrapClient.query(`revoke all privileges on schema contracttwin_control from ${migrationIdentifier},${runtimeIdentifier}`);
      await bootstrapClient.query(`grant usage on schema contracttwin_control to ${migrationIdentifier},${runtimeIdentifier}`);
      await bootstrapClient.query(`
        create table contracttwin_control.production_target_binding(
          singleton boolean primary key default true,
          target_token_sha256 text not null unique check (target_token_sha256 ~ '^[0-9a-f]{64}$'),
          database_id uuid not null unique,
          runtime_endpoint_sha256 text not null check (runtime_endpoint_sha256 ~ '^[0-9a-f]{64}$'),
          migration_endpoint_sha256 text not null check (migration_endpoint_sha256 ~ '^[0-9a-f]{64}$'),
          created_at timestamptz not null default clock_timestamp(),
          constraint production_target_binding_singleton_check check (singleton)
        )
      `);
      await bootstrapClient.query(
        "insert into contracttwin_control.production_target_binding(singleton,target_token_sha256,database_id,runtime_endpoint_sha256,migration_endpoint_sha256) values(true,$1,$2::uuid,$3,$4)",
        [expectedAnchor.tokenSha256,databaseId,endpointSha256,endpointSha256]
      );
      await bootstrapClient.query("revoke all privileges on table contracttwin_control.production_target_binding from public");
      await bootstrapClient.query(`revoke all privileges on table contracttwin_control.production_target_binding from ${migrationIdentifier},${runtimeIdentifier}`);
      await bootstrapClient.query(`grant select on table contracttwin_control.production_target_binding to ${migrationIdentifier},${runtimeIdentifier}`);
      await assertBootstrapOwnedProductionTargetAnchor(bootstrapClient,{
        expectedAnchor,
        allowedReaderNames:[migrationRole,runtimeRole],
        label:"New integration bootstrap anchor"
      });
      await bootstrapClient.query("commit");
      transactionOpen=false;
    }finally{
      if(transactionOpen){try{await bootstrapClient.query("rollback");}catch{}}
      await bootstrapClient.end();
    }
  }finally{await bootstrapBinding.release();}

  const bootstrapRetryClient=new Client(verifiedDatabaseConnectionConfig(bootstrapConnectionString,"contracttwin-anchor-fixture-bootstrap-retry"));
  let bootstrapRetryTransactionOpen=false;
  try{
    await bootstrapRetryClient.connect();
    await bootstrapRetryClient.query("begin transaction read only");
    bootstrapRetryTransactionOpen=true;
    await assertBootstrapOwnedProductionTargetAnchor(bootstrapRetryClient,{
      expectedAnchor,
      allowedReaderNames:[migrationRole,runtimeRole],
      label:"Existing integration bootstrap anchor"
    });
    await assertPristineProductionBootstrapTarget(
      bootstrapRetryClient,
      "Existing integration bootstrap target",
      {requireExternalAnchor:true}
    );
    await assert.rejects(
      ()=>assertBootstrapOwnedProductionTargetAnchor(bootstrapRetryClient,{
        expectedAnchor:expectedProductionTargetAnchor({
          token:"f".repeat(64),databaseId,
          runtimeEndpointSha256:endpointSha256,
          migrationEndpointSha256:endpointSha256
        }),
        allowedReaderNames:[migrationRole,runtimeRole],
        label:"Mismatched retry anchor"
      }),
      /token hash does not match/
    );
    await bootstrapRetryClient.query("rollback");
    bootstrapRetryTransactionOpen=false;
  }finally{
    if(bootstrapRetryTransactionOpen){try{await bootstrapRetryClient.query("rollback");}catch{}}
    await bootstrapRetryClient.end();
  }

  const anchoredBinding=await verifyPreMigrationTargetBinding({
    migrationConnectionString,runtimeConnectionString,expectedTargetAnchor:expectedAnchor,requireVerifiedTls:false
  });
  await anchoredBinding.release();

  const bootstrapIdentifier=quoteIdentifier(bootstrapRole);
  const runtimeIdentifier=quoteIdentifier(runtimeRole);
  await adminClient.query(`grant ${bootstrapIdentifier} to ${runtimeIdentifier}`);
  try{
    const roleEscalationReader=new Client(verifiedDatabaseConnectionConfig(runtimeConnectionString,"contracttwin-anchor-owner-membership-fixture"));
    try{
      await roleEscalationReader.connect();
      const apparentPrivileges=(await roleEscalationReader.query(`
        select
          pg_catalog.has_schema_privilege(current_user,'contracttwin_control','CREATE') schema_create,
          pg_catalog.has_table_privilege(current_user,'contracttwin_control.production_target_binding','UPDATE') table_update,
          pg_catalog.pg_has_role(current_user,$1,'MEMBER') owner_member
      `,[bootstrapRole])).rows[0];
      assert.deepEqual(
        apparentPrivileges,
        {schema_create:false,table_update:false,owner_member:true},
        "NOINHERIT owner membership must reproduce the privilege-reporting loophole"
      );
      await roleEscalationReader.query("begin");
      await roleEscalationReader.query(`set role ${bootstrapIdentifier}`);
      await roleEscalationReader.query("update contracttwin_control.production_target_binding set created_at=clock_timestamp()");
      await roleEscalationReader.query("rollback");
      await roleEscalationReader.query("reset role");
      await assert.rejects(
        ()=>assertProductionTargetAnchor(roleEscalationReader,{
          expectedAnchor,
          allowedReaderNames:[migrationRole,runtimeRole],
          label:"Owner-membership escalation fixture"
        }),
        /members? of the production target anchor owner role/,
        "routine target verification must reject SET ROLE capability even when effective object privileges appear read-only"
      );
    }finally{await roleEscalationReader.end();}

    const bootstrapMembershipVerifier=new Client(verifiedDatabaseConnectionConfig(bootstrapConnectionString,"contracttwin-anchor-bootstrap-membership-fixture"));
    try{
      await bootstrapMembershipVerifier.connect();
      await assert.rejects(
        ()=>assertBootstrapOwnedProductionTargetAnchor(bootstrapMembershipVerifier,{
          expectedAnchor,
          allowedReaderNames:[migrationRole,runtimeRole],
          label:"Bootstrap owner-membership fixture"
        }),
        /members? of the production target bootstrap owner role/,
        "bootstrap verification must fail before accepting ACLs that a routine reader can bypass with SET ROLE"
      );
    }finally{await bootstrapMembershipVerifier.end();}
  }finally{
    await adminClient.query(`revoke ${bootstrapIdentifier} from ${runtimeIdentifier}`);
  }

  const migrationIdentifier=quoteIdentifier(migrationRole);
  await adminClient.query(`grant ${migrationIdentifier} to ${runtimeIdentifier}`);
  try{
    const crossReader=new Client(verifiedDatabaseConnectionConfig(runtimeConnectionString,"contracttwin-anchor-cross-reader-fixture"));
    try{
      await crossReader.connect();
      const apparentPrivileges=(await crossReader.query(`
        select
          pg_catalog.has_schema_privilege(current_user,'public','CREATE') public_schema_create,
          pg_catalog.pg_has_role(current_user,$1,'MEMBER') migration_member
      `,[migrationRole])).rows[0];
      assert.deepEqual(
        apparentPrivileges,
        {public_schema_create:false,migration_member:true},
        "NOINHERIT cross-reader membership must appear unprivileged before SET ROLE"
      );
      await crossReader.query("begin");
      await crossReader.query(`set role ${migrationIdentifier}`);
      await crossReader.query("create table public.cross_reader_escalation_probe(id integer)");
      await crossReader.query("rollback");
      await crossReader.query("reset role");
      await assert.rejects(
        ()=>assertProductionTargetAnchor(crossReader,{
          expectedAnchor,
          allowedReaderNames:[migrationRole,runtimeRole],
          label:"Cross-reader escalation fixture"
        }),
        /role memberships other than/,
        "runtime-to-migrator SET ROLE capability must fail target verification"
      );
    }finally{await crossReader.end();}

    const bootstrapCrossReaderVerifier=new Client(verifiedDatabaseConnectionConfig(bootstrapConnectionString,"contracttwin-anchor-bootstrap-cross-reader-fixture"));
    try{
      await bootstrapCrossReaderVerifier.connect();
      await assert.rejects(
        ()=>assertBootstrapOwnedProductionTargetAnchor(bootstrapCrossReaderVerifier,{
          expectedAnchor,
          allowedReaderNames:[migrationRole,runtimeRole],
          label:"Bootstrap cross-reader fixture"
        }),
        /role memberships other than/,
        "bootstrap verification must reject cross-reader SET ROLE capability before accepting the target"
      );
    }finally{await bootstrapCrossReaderVerifier.end();}
  }finally{
    await adminClient.query(`revoke ${migrationIdentifier} from ${runtimeIdentifier}`);
  }

  const unexpectedIdentifier=quoteIdentifier(unexpectedRole);
  await adminClient.query(`grant ${bootstrapIdentifier} to ${unexpectedIdentifier}`);
  try{
    const unexpectedOwnerMember=new Client(verifiedDatabaseConnectionConfig(unexpectedConnectionString,"contracttwin-anchor-inbound-owner-fixture"));
    try{
      await unexpectedOwnerMember.connect();
      await unexpectedOwnerMember.query("begin");
      await unexpectedOwnerMember.query(`set role ${bootstrapIdentifier}`);
      await unexpectedOwnerMember.query("update contracttwin_control.production_target_binding set created_at=clock_timestamp()");
      await unexpectedOwnerMember.query("rollback");
      await unexpectedOwnerMember.query("reset role");
    }finally{await unexpectedOwnerMember.end();}
    const inboundOwnerVerifier=new Client(verifiedDatabaseConnectionConfig(migrationConnectionString,"contracttwin-anchor-inbound-owner-verifier"));
    try{
      await inboundOwnerVerifier.connect();
      await assert.rejects(
        ()=>assertProductionTargetAnchor(inboundOwnerVerifier,{expectedAnchor,allowedReaderNames:[migrationRole,runtimeRole],label:"Inbound owner-member fixture"}),
        /unexpected roles must not be direct or transitive members/,
        "an unexpected login that can SET ROLE to the anchor owner must fail target verification"
      );
    }finally{await inboundOwnerVerifier.end();}
  }finally{
    await adminClient.query(`revoke ${bootstrapIdentifier} from ${unexpectedIdentifier}`);
  }

  await adminClient.query(`grant ${migrationIdentifier} to ${unexpectedIdentifier}`);
  try{
    const unexpectedMigratorMember=new Client(verifiedDatabaseConnectionConfig(unexpectedConnectionString,"contracttwin-anchor-inbound-migrator-fixture"));
    try{
      await unexpectedMigratorMember.connect();
      await unexpectedMigratorMember.query("begin");
      await unexpectedMigratorMember.query(`set role ${migrationIdentifier}`);
      await unexpectedMigratorMember.query("create table public.inbound_migrator_escalation_probe(id integer)");
      await unexpectedMigratorMember.query("rollback");
      await unexpectedMigratorMember.query("reset role");
    }finally{await unexpectedMigratorMember.end();}
    const inboundMigratorVerifier=new Client(verifiedDatabaseConnectionConfig(runtimeConnectionString,"contracttwin-anchor-inbound-migrator-verifier"));
    try{
      await inboundMigratorVerifier.connect();
      await assert.rejects(
        ()=>assertProductionTargetAnchor(inboundMigratorVerifier,{expectedAnchor,allowedReaderNames:[migrationRole,runtimeRole],label:"Inbound migrator-member fixture"}),
        /unexpected roles must not be direct or transitive members/,
        "an unexpected login that can SET ROLE to the migrator must fail target verification"
      );
    }finally{await inboundMigratorVerifier.end();}
  }finally{
    await adminClient.query(`revoke ${migrationIdentifier} from ${unexpectedIdentifier}`);
  }

  await assert.rejects(
    ()=>verifyPreMigrationTargetBinding({
      migrationConnectionString,
      runtimeConnectionString,
      expectedTargetAnchor:expectedProductionTargetAnchor({
        token:"f".repeat(64),databaseId,
        runtimeEndpointSha256:endpointSha256,
        migrationEndpointSha256:endpointSha256
      }),
      requireVerifiedTls:false
    }),
    /token hash does not match/
  );

  for(const [connectionString,label] of [
    [migrationConnectionString,"migration"],
    [runtimeConnectionString,"runtime"]
  ]){
    const reader=new Client(verifiedDatabaseConnectionConfig(connectionString,`contracttwin-anchor-${label}-denial`));
    try{
      await reader.connect();
      await assert.rejects(
        ()=>reader.query("update contracttwin_control.production_target_binding set created_at=created_at"),
        /permission denied/
      );
    }finally{await reader.end();}
  }
  const pristineReader=new Client(verifiedDatabaseConnectionConfig(migrationConnectionString,"contracttwin-anchor-pristine-reader"));
  try{
    await pristineReader.connect();
    await pristineReader.query("begin transaction read only");
    await assertPristineProductionBootstrapTarget(pristineReader,"Anchored pristine integration target",{requireExternalAnchor:true});
    await pristineReader.query("rollback");
  }finally{await pristineReader.end();}

  const expectedIdentityMigrator=new Client(verifiedDatabaseConnectionConfig(migrationConnectionString,"contracttwin-anchor-expected-id-fixture"));
  let expectedIdentityTransactionOpen=false;
  try{
    await expectedIdentityMigrator.connect();
    await expectedIdentityMigrator.query("begin");
    expectedIdentityTransactionOpen=true;
    await expectedIdentityMigrator.query("select pg_catalog.set_config('contracttwin.expected_database_id',$1,true)",[databaseId]);
    for(const migration of await loadCanonicalMigrationSources(process.cwd())){
      await expectedIdentityMigrator.query(migration.sql);
    }
    const insertedIdentity=(await expectedIdentityMigrator.query(`
      select external_identity.external_database_id::text external_database_id,
             external_identity.release_database_id::text release_database_id,
             physical_identity.database_id::text physical_database_id
        from public.release_database_external_identity external_identity
        join public.release_database_identity physical_identity
          on physical_identity.database_id=external_identity.release_database_id
       where external_identity.singleton=true and physical_identity.singleton=true
    `)).rows;
    assert.equal(insertedIdentity.length,1,"forward external identity mapping must contain exactly one physical database binding");
    assert.equal(insertedIdentity[0].external_database_id,databaseId,"migration 014 must bind the externally approved logical database UUID");
    assert.equal(insertedIdentity[0].release_database_id,insertedIdentity[0].physical_database_id,"the external mapping must preserve migration 010's immutable physical receipt identity");
    const healthNonceSha256=randomBytes(32).toString("hex");
    const healthSourceSha=randomBytes(20).toString("hex");
    await expectedIdentityMigrator.query(
      "insert into public.release_target_receipts(nonce_sha256,database_id,source_sha) values($1,$2,$3)",
      [healthNonceSha256,insertedIdentity[0].physical_database_id,healthSourceSha]
    );
    const loadHealthIdentityChain=()=>expectedIdentityMigrator.query(`
      select receipt.source_sha,receipt.nonce_sha256,
             (receipt.database_id=physical.database_id and external.release_database_id=physical.database_id and external.external_database_id=anchor.database_id) identity_chain_matches
        from public.release_database_identity physical
        join public.release_database_external_identity external on external.singleton=true
        join contracttwin_control.production_target_binding anchor on anchor.singleton=true
        join public.release_target_receipts receipt on true
       where physical.singleton=true and receipt.source_sha=$1 and receipt.nonce_sha256=$2
    `,[healthSourceSha,healthNonceSha256]);
    const healthyChain=(await loadHealthIdentityChain()).rows;
    assert.equal(healthyChain.length,1);
    assert.equal(healthyChain[0].identity_chain_matches,true,"live release health must prove physical receipt -> external mapping -> separately owned anchor identity");
    await expectedIdentityMigrator.query("savepoint sp_wrong_external_identity");
    await expectedIdentityMigrator.query("alter table public.release_database_external_identity disable trigger trg_release_database_external_identity_immutable");
    await expectedIdentityMigrator.query("update public.release_database_external_identity set external_database_id=$1 where singleton=true",[randomUUID()]);
    const brokenChain=(await loadHealthIdentityChain()).rows;
    assert.equal(brokenChain.length,1);
    assert.equal(brokenChain[0].identity_chain_matches,false,"live release health must fail when the external identity mapping no longer matches the separately owned anchor");
    await expectedIdentityMigrator.query("rollback to savepoint sp_wrong_external_identity");
    await expectedIdentityMigrator.query("release savepoint sp_wrong_external_identity");
    await expectedIdentityMigrator.query("rollback");
    expectedIdentityTransactionOpen=false;
  }finally{
    if(expectedIdentityTransactionOpen){try{await expectedIdentityMigrator.query("rollback");}catch{}}
    await expectedIdentityMigrator.end();
  }

  console.log("Production target-anchor integration passed on a disposable PostgreSQL database: absent/mismatched anchors fail, exact bootstrap retries pass without mutation, NOINHERIT owner/cross-reader SET ROLE escalation is rejected, routine roles are read-only, and migration 014 maps the approved logical UUID to migration 010's immutable physical identity.");
}finally{
  if(databaseCreated){
    await adminClient.query("select pg_catalog.pg_terminate_backend(pid) from pg_catalog.pg_stat_activity where datname=$1 and pid<>pg_catalog.pg_backend_pid()",[databaseName]);
    await adminClient.query(`drop database ${quoteIdentifier(databaseName)}`);
  }
  for(const role of createdRoles.reverse()){
    await adminClient.query(`drop role ${quoteIdentifier(role)}`);
  }
  await adminClient.end();
}
