import rawManifest from "@/lib/schema-migration-manifest.json";

export type SchemaMigrationReceipt = {
  filename: string;
  sha256: string;
};

type SchemaMigrationManifest = {
  version: number;
  receiptAlgorithm: "sha256-utf8-canonical-lf-v1";
  migrations: SchemaMigrationReceipt[];
};

export const schemaMigrationManifest = rawManifest as SchemaMigrationManifest;
export const expectedSchemaMigrationReceipts = schemaMigrationManifest.migrations;

export function evaluateExactSchemaMigrationReceipts(rows:SchemaMigrationReceipt[]){
  const errors:string[]=[];
  if(schemaMigrationManifest.version!==2||schemaMigrationManifest.receiptAlgorithm!=="sha256-utf8-canonical-lf-v1"){
    errors.push("migration receipt manifest does not use canonical LF v1");
  }
  if(rows.length!==expectedSchemaMigrationReceipts.length){
    errors.push(`migration receipt count ${rows.length} does not match ${expectedSchemaMigrationReceipts.length}`);
  }
  const length=Math.max(rows.length,expectedSchemaMigrationReceipts.length);
  for(let index=0;index<length;index++){
    const actual=rows[index];
    const expected=expectedSchemaMigrationReceipts[index];
    if(!actual||!expected||actual.filename!==expected.filename||actual.sha256!==expected.sha256){
      errors.push(`migration receipt mismatch at position ${index+1}`);
    }
  }
  return {
    ok:errors.length===0,
    errors,
    checkedCount:expectedSchemaMigrationReceipts.length,
    manifestVersion:schemaMigrationManifest.version
  };
}
