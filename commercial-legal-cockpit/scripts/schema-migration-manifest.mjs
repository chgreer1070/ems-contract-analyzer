import crypto from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";

const manifestUrl=new URL("../lib/schema-migration-manifest.json",import.meta.url);

export async function loadSchemaMigrationManifest(){
  return JSON.parse(await fs.readFile(manifestUrl,"utf8"));
}

export async function calculateRepositoryMigrationReceipts(root=process.cwd()){
  const migrationDir=path.join(root,"db","migrations");
  const files=(await fs.readdir(migrationDir)).filter(file=>/^\d+.*\.sql$/u.test(file)).sort();
  const rows=[];
  for(const filename of files){
    const sql=await fs.readFile(path.join(migrationDir,filename),"utf8");
    rows.push({filename,sha256:crypto.createHash("sha256").update(sql,"utf8").digest("hex")});
  }
  return rows;
}

export function evaluateExactSchemaMigrationReceipts(rows,manifest){
  const expected=manifest.migrations;
  const errors=[];
  if(rows.length!==expected.length)errors.push(`migration receipt count ${rows.length} does not match ${expected.length}`);
  const length=Math.max(rows.length,expected.length);
  for(let index=0;index<length;index++){
    const actual=rows[index];
    const required=expected[index];
    if(!actual||!required||actual.filename!==required.filename||actual.sha256!==required.sha256){
      errors.push(`migration receipt mismatch at position ${index+1}`);
    }
  }
  return {ok:errors.length===0,errors,checkedCount:expected.length,manifestVersion:manifest.version};
}

export function assertExactSchemaMigrationReceipts(rows,manifest,label="Target"){
  const result=evaluateExactSchemaMigrationReceipts(rows,manifest);
  if(!result.ok)throw new Error(`${label} migration receipts are not exact: ${result.errors.join("; ")}`);
  return result;
}

export async function assertSchemaMigrationManifestMatchesRepository(root=process.cwd()){
  const manifest=await loadSchemaMigrationManifest();
  const calculated=await calculateRepositoryMigrationReceipts(root);
  assertExactSchemaMigrationReceipts(calculated,manifest,"Repository");
  return manifest;
}
