import {appendFile} from "node:fs/promises";
import {randomBytes} from "node:crypto";
import pg from "pg";
import {verifiedDatabaseConnectionConfig} from "./database-connection-config.mjs";

const {Client}=pg;
const ownerConnectionString=process.env.DATABASE_URL||"";
const outputFile=process.env.GITHUB_OUTPUT||"";
if(process.env.CI!=="true"||process.env.GITHUB_ACTIONS!=="true"||process.env.CI_RUNTIME_ROLE_PROVISIONING!=="disposable-postgres-service"){
  throw new Error("CI runtime-role provisioning is restricted to the explicitly marked disposable GitHub Actions PostgreSQL service.");
}
if(!ownerConnectionString||!outputFile)throw new Error("Disposable CI owner DATABASE_URL and GITHUB_OUTPUT are required.");
const ownerUrl=new URL(ownerConnectionString);
const databaseName=decodeURIComponent(ownerUrl.pathname.replace(/^\//,""));
if(!["localhost","127.0.0.1","[::1]"].includes(ownerUrl.hostname)||databaseName!=="contracttwin"){
  throw new Error("CI runtime-role provisioning refused a non-loopback or non-ephemeral database target.");
}

function quoteIdentifier(value){return `"${String(value).replaceAll('"','""')}"`;}
function quoteLiteral(value){return `'${String(value).replaceAll("'","''")}'`;}

const runtimeRole=`contracttwin_runtime_ci_${randomBytes(8).toString("hex")}`;
const runtimePassword=randomBytes(36).toString("base64url");
const roleIdentifier=quoteIdentifier(runtimeRole);
const databaseIdentifier=quoteIdentifier(databaseName);
const client=new Client(verifiedDatabaseConnectionConfig(ownerConnectionString,"contracttwin-ci-runtime-role-provisioner"));
try{
  await client.connect();
  await client.query("begin");
  try{
    const target=(await client.query("select current_database() database_name,rolsuper from pg_roles where rolname=current_user")).rows[0];
    if(target?.database_name!=="contracttwin"||target?.rolsuper!==true){
      throw new Error("CI runtime-role provisioning refused a database that is not owned by the disposable PostgreSQL service identity.");
    }
    await client.query(`revoke temporary on database ${databaseIdentifier} from public`);
    await client.query(`create role ${roleIdentifier} login password ${quoteLiteral(runtimePassword)} nosuperuser nocreatedb nocreaterole noinherit noreplication nobypassrls`);
    await client.query(`grant connect on database ${databaseIdentifier} to ${roleIdentifier}`);
    await client.query(`revoke create,temporary on database ${databaseIdentifier} from ${roleIdentifier}`);
    await client.query(`grant usage on schema public to ${roleIdentifier}`);
    await client.query(`revoke create on schema public from ${roleIdentifier}`);
    await client.query(`grant select,insert,update,delete on all tables in schema public to ${roleIdentifier}`);
    await client.query(`revoke truncate,references,trigger,maintain on all tables in schema public from public,${roleIdentifier}`);
    await client.query(`revoke all privileges on table public.schema_migrations from ${roleIdentifier}`);
    await client.query(`grant select on table public.schema_migrations to ${roleIdentifier}`);
    await client.query(`revoke all privileges on table public.release_database_identity,public.release_database_external_identity,public.release_target_receipts from ${roleIdentifier}`);
    await client.query(`grant select on table public.release_database_identity,public.release_database_external_identity,public.release_target_receipts to ${roleIdentifier}`);
    await client.query(`grant usage,select on all sequences in schema public to ${roleIdentifier}`);
    await client.query(`revoke update on all sequences in schema public from public,${roleIdentifier}`);
    const runtimeFunctions=(await client.query(`
      select p.oid::regprocedure::text signature
        from pg_proc p join pg_namespace n on n.oid=p.pronamespace
       where n.nspname='public'
    `)).rows;
    for(const {signature} of runtimeFunctions)await client.query(`revoke execute on function ${signature} from public`);
    await client.query(`grant execute on function public.canonical_jsonb_text(jsonb) to ${roleIdentifier}`);
    await client.query(`grant execute on function public.lock_documents_for_legal_publication(uuid[]) to ${roleIdentifier}`);
    await client.query(`grant execute on function public.executive_snapshot_receipt_verified(uuid) to ${roleIdentifier}`);
    await client.query(`grant execute on function public.digest(bytea,text) to ${roleIdentifier}`);
    await client.query("commit");
  }catch(error){
    await client.query("rollback");
    throw error;
  }
}finally{
  await client.end();
}

const runtimeUrl=new URL(ownerConnectionString);
runtimeUrl.username=runtimeRole;
runtimeUrl.password=runtimePassword;
const runtimeConnectionString=runtimeUrl.toString();
process.stdout.write(`::add-mask::${runtimePassword}\n::add-mask::${runtimeConnectionString}\n`);
await appendFile(outputFile,`runtime_database_url=${runtimeConnectionString}\n`,{encoding:"utf8",mode:0o600});
console.log("Provisioned a disposable, directly granted restricted runtime role for CI database controls.");
