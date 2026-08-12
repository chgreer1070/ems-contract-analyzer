import { Client } from "pg";
import { assertCriticalDatabaseControls, inspectCriticalDatabaseControls } from "./critical-database-controls.mjs";
import {verifiedDatabaseConnectionConfig} from "./database-connection-config.mjs";
import {
  assertExactSchemaMigrationReceipts,
  assertSchemaMigrationManifestMatchesRepository
} from "./schema-migration-manifest.mjs";

if(!process.env.DATABASE_URL)throw new Error("DATABASE_URL is required for target-schema verification.");
const expectedPublicTables=[
  "account","agreement_version_documents","agreement_versions","analysis_engine_policies","analysis_review_attestations",
  "analysis_runs","api_rate_events","app_user_capabilities","app_user_roles","audit_events","contract_terms","customers",
  "decision_conditions","decisions","document_chunks","document_relations","documents","economics_runs","executive_snapshots",
  "findings","legal_hold_events","matter_members","matters","negotiation_standards","processing_jobs","purge_requests",
  "release_database_identity","release_database_external_identity","release_target_receipts","schema_migrations","session","term_dependencies","user",
  "validation_cases","validation_results","validation_runs","verification"
];
const manifest=await assertSchemaMigrationManifestMatchesRepository();
const client=new Client(verifiedDatabaseConnectionConfig(process.env.DATABASE_URL,"contracttwin-target-schema-verifier",{requireVerifiedTls:process.env.APP_ENV==="production"}));
let criticalControls;
try{
  await client.connect();
  const result=await client.query("select filename,sha256 from public.schema_migrations order by filename");
  assertExactSchemaMigrationReceipts(result.rows,manifest,"Target");
  const placement=(await client.query(`
    select 'pg_catalog relation' kind,c.relname object_name
      from pg_catalog.pg_class c join pg_catalog.pg_namespace n on n.oid=c.relnamespace
     where n.nspname='pg_catalog' and c.oid>=16384
    union all
    select 'pg_catalog function',p.proname
      from pg_catalog.pg_proc p join pg_catalog.pg_namespace n on n.oid=p.pronamespace
     where n.nspname='pg_catalog' and p.oid>=16384
    union all
    select 'public table',c.relname
      from pg_catalog.pg_class c join pg_catalog.pg_namespace n on n.oid=c.relnamespace
     where n.nspname='public' and c.relkind in ('r','p')
  `)).rows;
  const misplaced=placement.filter(row=>row.kind!=="public table");
  if(misplaced.length)throw new Error(`Target schema contains normal-OID objects in pg_catalog: ${misplaced.map(row=>`${row.kind} ${row.object_name}`).join(", ")}`);
  const actualPublicTables=new Set(placement.filter(row=>row.kind==="public table").map(row=>row.object_name));
  const missingPublicTables=expectedPublicTables.filter(table=>!actualPublicTables.has(table));
  if(missingPublicTables.length)throw new Error(`Target schema is missing expected public table(s): ${missingPublicTables.join(", ")}`);
  const expectedPublicTableSet=new Set(expectedPublicTables);
  const unexpectedPublicTables=[...actualPublicTables].filter(table=>!expectedPublicTableSet.has(table)).sort();
  if(unexpectedPublicTables.length)throw new Error(`Target schema contains unexpected public table(s): ${unexpectedPublicTables.join(", ")}`);
  criticalControls=assertCriticalDatabaseControls(await inspectCriticalDatabaseControls(client));
}finally{await client.end();}
console.log(`Target schema verification passed for ${manifest.migrations.length} exact migration receipt(s) and ${criticalControls.checkedCount} enabled critical database control(s) from manifest v${criticalControls.manifestVersion}.`);
