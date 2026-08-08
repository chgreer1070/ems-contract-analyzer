import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { parseEnvironmentFile } from "./production-env-check.mjs";
import {loadSchemaMigrationManifest} from "./schema-migration-manifest.mjs";

const [environmentFile,deploymentUrl,expectedSha,...unexpected]=process.argv.slice(2);
if(!environmentFile||!deploymentUrl||!expectedSha||unexpected.length)throw new Error("Usage: node scripts/production-postdeploy-check.mjs <validated-env-file> <candidate-url> <expected-sha>");
if(!/^[0-9a-f]{40}$/u.test(expectedSha))throw new Error("Expected release SHA must be exactly 40 lowercase hexadecimal characters.");
if(!/^https:\/\/[a-z0-9](?:[a-z0-9.-]*[a-z0-9])?\.vercel\.app\/?$/u.test(deploymentUrl))throw new Error("Candidate deployment must be an origin-only non-apex vercel.app HTTPS URL.");
const candidate=new URL(deploymentUrl);
if(candidate.protocol!=="https:"||candidate.username||candidate.password||candidate.port||candidate.pathname!=="/"||candidate.search||candidate.hash||candidate.hostname==="vercel.app"||!candidate.hostname.endsWith(".vercel.app")){
  throw new Error("Candidate deployment must be an origin-only non-apex vercel.app HTTPS URL.");
}
const variables=parseEnvironmentFile(await readFile(resolve(environmentFile),"utf8"));
const token=variables.get("RELEASE_ATTESTATION_TOKEN");
if(!token||token.length<32)throw new Error("RELEASE_ATTESTATION_TOKEN must contain at least 32 characters.");
const bypassSecret=variables.get("VERCEL_AUTOMATION_BYPASS_SECRET");
if(!bypassSecret)throw new Error("VERCEL_AUTOMATION_BYPASS_SECRET is required for staged release verification.");
const releaseTargetNonce=process.env.RELEASE_TARGET_NONCE||"";
if(!/^[0-9a-f]{64}$/u.test(releaseTargetNonce))throw new Error("Protected release target nonce is required for staged verification.");
const response=await fetch(new URL("/api/health/release",candidate),{
  headers:{
    Authorization:`Bearer ${token}`,
    "x-vercel-protection-bypass":bypassSecret,
    "x-contracttwin-release-target-nonce":releaseTargetNonce,
    "Cache-Control":"no-cache",
    "Pragma":"no-cache"
  },
  redirect:"error",
  cache:"no-store",
  signal:AbortSignal.timeout(30_000)
});
if(!/^application\/json(?:\s*;|$)/iu.test(response.headers.get("content-type")||""))throw new Error("Candidate release attestation did not return JSON.");
const body=await response.json().catch(()=>null);
if(!body||typeof body!=="object"||Array.isArray(body))throw new Error("Candidate release attestation body is invalid.");
if(!response.ok||body.ok!==true)throw new Error("Candidate release attestation failed.");
if(body.sourceSha!==expectedSha)throw new Error("Candidate source SHA does not match the approved release SHA.");
const requiredTrueFields=["flagsPassed","schemaPassed","exactMigrationReceiptsPassed","criticalDatabaseControlsPassed","runtimeDatabasePrincipalPassed","runtimeDatabaseTransportPassed","releaseTargetBindingPassed","legalRelianceReady","syntheticEconomicsPassed"];
if(requiredTrueFields.some(field=>body[field]!==true))throw new Error("Candidate did not prove every production, database, transport, and release-target control.");
const manifest=await loadSchemaMigrationManifest();
if(body.migrationCount!==manifest.migrations.length||body.migrationReceiptManifestVersion!==manifest.version){
  throw new Error("Candidate migration receipt manifest metadata does not match the approved artifact.");
}
if(!(response.headers.get("cache-control")||"").toLowerCase().includes("no-store"))throw new Error("Candidate release attestation is not explicitly non-cacheable.");
console.log(`Candidate release attestation passed for source SHA ${expectedSha.slice(0,12)} and ${body.migrationCount} migration receipt(s).`);
