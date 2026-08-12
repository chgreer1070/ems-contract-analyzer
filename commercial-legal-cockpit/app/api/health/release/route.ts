import { createHash, timingSafeEqual } from "node:crypto";
import { query } from "@/lib/db";
import { getSystemReadiness } from "@/lib/readiness";
import { calculateEconomics } from "@/lib/economics";
import {
  CRITICAL_DATABASE_CONTROLS_QUERY,
  evaluateCriticalDatabaseControls,
  type CriticalDatabaseControlRow
} from "@/lib/databaseControls";
import {
  RUNTIME_DATABASE_PRINCIPAL_QUERY,
  evaluateRuntimeDatabasePrincipal,
  type RuntimeDatabasePrincipalRow
} from "@/lib/runtimeDatabasePrincipal";
import {
  evaluateExactSchemaMigrationReceipts,
  type SchemaMigrationReceipt
} from "@/lib/schemaMigrationManifest";

export const dynamic="force-dynamic";
export const revalidate=0;

const RELEASE_SOURCE_SHA_PATTERN=/^[0-9a-f]{40}$/u;
const RELEASE_TARGET_NONCE_PATTERN=/^[0-9a-f]{64}$/u;
const BUILD_RELEASE_SOURCE_SHA=process.env.CONTRACTTWIN_RELEASE_SHA||"";
const PLATFORM_RELEASE_SOURCE_SHA=process.env.VERCEL_GIT_COMMIT_SHA||"";

type ReleaseTargetReceiptRow={source_sha:string;nonce_sha256:string;identity_chain_matches:boolean};
type DatabaseTransportRow={ssl:boolean;version:string|null;cipher:string|null;bits:number|null};

function json(body:unknown,status:number){
  return Response.json(body,{status,headers:{"Cache-Control":"no-store, max-age=0","Pragma":"no-cache"}});
}

function authorized(request:Request){
  const expected=process.env.RELEASE_ATTESTATION_TOKEN||"";const supplied=request.headers.get("authorization")?.replace(/^Bearer\s+/i,"")||"";
  if(expected.length<32||!supplied)return false;
  const expectedHash=createHash("sha256").update(expected).digest();const suppliedHash=createHash("sha256").update(supplied).digest();
  return timingSafeEqual(expectedHash,suppliedHash);
}

export async function GET(request:Request){
  if(!authorized(request))return json({ok:false,error:"Release attestation authorization failed."},401);
  try{
    const nonce=request.headers.get("x-contracttwin-release-target-nonce")||"";
    const sourceSha=RELEASE_SOURCE_SHA_PATTERN.test(BUILD_RELEASE_SOURCE_SHA)&&
      (!PLATFORM_RELEASE_SOURCE_SHA||PLATFORM_RELEASE_SOURCE_SHA===BUILD_RELEASE_SOURCE_SHA)?BUILD_RELEASE_SOURCE_SHA:"";
    const nonceSha256=RELEASE_TARGET_NONCE_PATTERN.test(nonce)?createHash("sha256").update(nonce,"utf8").digest("hex"):"";
    const [readiness,migrations,controlObjects,runtimePrincipalEvidence,targetReceipts,transportEvidence]=await Promise.all([
      getSystemReadiness({includePersistentEvidence:true}),
      query<SchemaMigrationReceipt>("select filename,sha256 from public.schema_migrations order by filename"),
      query<CriticalDatabaseControlRow>(CRITICAL_DATABASE_CONTROLS_QUERY),
      query<RuntimeDatabasePrincipalRow>(RUNTIME_DATABASE_PRINCIPAL_QUERY),
      query<ReleaseTargetReceiptRow>(`
        select r.source_sha,r.nonce_sha256,
               (r.database_id=i.database_id and e.release_database_id=i.database_id and e.external_database_id=b.database_id) identity_chain_matches
          from public.release_database_identity i
          join public.release_database_external_identity e
            on e.singleton=true
          join contracttwin_control.production_target_binding b
            on b.singleton=true
          join public.release_target_receipts r on true
         where i.singleton=true and r.source_sha=$1 and r.nonce_sha256=$2
      `,[sourceSha,nonceSha256]),
      query<DatabaseTransportRow>(`
        select s.ssl,s.version,s.cipher,s.bits
          from pg_catalog.pg_stat_ssl s
         where s.pid=pg_catalog.pg_backend_pid()
      `)
    ]);
    const criticalControls=evaluateCriticalDatabaseControls(controlObjects.rows);
    const runtimePrincipal=evaluateRuntimeDatabasePrincipal(runtimePrincipalEvidence.rows[0]);
    const exactMigrationReceipts=evaluateExactSchemaMigrationReceipts(migrations.rows);
    const targetReceipt=targetReceipts.rows[0];
    const releaseTargetBindingPassed=Boolean(
      sourceSha&&nonceSha256&&targetReceipts.rows.length===1&&targetReceipt?.identity_chain_matches===true&&
      targetReceipt.source_sha===sourceSha&&targetReceipt.nonce_sha256===nonceSha256
    );
    const transport=transportEvidence.rows[0];
    const runtimeDatabaseTransportPassed=Boolean(
      transportEvidence.rows.length===1&&transport?.ssl===true&&
      ["TLSv1.2","TLSv1.3"].includes(String(transport.version||""))&&String(transport.cipher||"")&&Number(transport.bits)>=128
    );
    const zeroEconomics=calculateEconomics({annualRevenue:0,grossMarginPct:0,paymentDays:0,baselinePaymentDays:0,carryingCostPct:0,inventoryOnHand:0,ncnrExposure:0,forecastReductionPct:0,warrantyRatePct:0,terminationCoveragePct:0,liabilityCap:0,modeledClaim:0});
    const syntheticEconomicsPassed=Object.values(zeroEconomics).every(value=>value===0);
    const latestMigration=migrations.rows.at(-1)?.filename??null;
    const flagsPassed=process.env.APP_ENV==="production"&&process.env.AUTH_REQUIRED==="true"&&process.env.ALLOW_DEMO_ACCESS==="false"&&process.env.LEGAL_RELIANCE_ENABLED==="true"&&process.env.ALLOW_SOURCE_PURGE==="false";
    const schemaPassed=exactMigrationReceipts.ok&&criticalControls.ok;
    const ok=flagsPassed&&schemaPassed&&runtimePrincipal.ok&&runtimeDatabaseTransportPassed&&releaseTargetBindingPassed&&readiness.legalRelianceReady&&syntheticEconomicsPassed;
    return json({ok,service:"ems-commercial-legal-cockpit",sourceSha:sourceSha||null,flagsPassed,schemaPassed,migrationCount:migrations.rows.length,latestMigration,exactMigrationReceiptsPassed:exactMigrationReceipts.ok,migrationReceiptManifestVersion:exactMigrationReceipts.manifestVersion,criticalDatabaseControlsPassed:criticalControls.ok,criticalDatabaseControlCount:criticalControls.checkedCount,criticalDatabaseControlManifestVersion:criticalControls.manifestVersion,runtimeDatabasePrincipalPassed:runtimePrincipal.ok,runtimeDatabasePrincipalControlCount:runtimePrincipal.checkedCount,runtimeDatabaseTransportPassed,releaseTargetBindingPassed,legalRelianceReady:readiness.legalRelianceReady,syntheticEconomicsPassed,checkedAt:new Date().toISOString()},ok?200:503);
  }catch{
    return json({ok:false,error:"Release attestation could not verify live controls."},503);
  }
}
