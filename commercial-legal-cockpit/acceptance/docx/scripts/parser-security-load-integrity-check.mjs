import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
const worker='acceptance/docx/scripts/parser-security-load-worker.mjs';
const cases=['local_crc_mismatch','local_size_mismatch','local_expanded_size_mismatch','signed_descriptor','unsigned_descriptor','bad_descriptor_crc','bad_descriptor_size','missing_descriptor','bad_descriptor_local_metadata','overlapping_comments'];
const results=[];
for(const name of cases){
  const result=JSON.parse(execFileSync(process.execPath,['--expose-gc','--max-old-space-size=512',worker,name],{cwd:process.cwd(),timeout:30000,maxBuffer:2*1024*1024,env:{...process.env,DOCX_BASELINE_REVISION:'',COMMENT_COUNT:'1500',RUN_COUNT:'2000'}}).toString().trim());
  assert(result.expectationMet,`${name}: independent expected eligibility mismatch`);
  if(!result.actualEligible)assert.equal(result.chunks,0,`${name}: denied package exposed chunks`);
  if(result.actualEligible)assert(result.receiptVerified,`${name}: complete receipt failed`);
  if(name==='overlapping_comments')assert(result.issueCodes.includes('INVALID_OR_UNSUPPORTED_PACKAGE'),'Amplification must fail before full evidence serialization');
  results.push(result);
}
fs.writeFileSync('acceptance/docx/evidence/parser-security-load-integrity-check.json',JSON.stringify({date:new Date().toISOString(),results},null,2)+'\n');
console.log(`PASS: ${results.length} independent ZIP integrity/early-allocation repair checks.`);
