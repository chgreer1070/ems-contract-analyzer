import fs from 'node:fs';
import os from 'node:os';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { performance } from 'node:perf_hooks';
const run=promisify(execFile),worker='acceptance/docx/scripts/parser-security-load-worker.mjs';
const root='acceptance/docx/evidence/parser-security-load';
const results=[];
async function sample(caseName,env={}){
  const begin=performance.now();
  try{const {stdout,stderr}=await run(process.execPath,['--expose-gc','--max-old-space-size=512',worker,caseName],{cwd:process.cwd(),timeout:30000,maxBuffer:2*1024*1024,env:{...process.env,...env}});const data=JSON.parse(stdout.trim());data.wallMs=performance.now()-begin;data.stderr=stderr;return data;}
  catch(error){return{case:caseName,failedProcess:true,code:error.code,signal:error.signal,killed:error.killed,wallMs:performance.now()-begin,stdout:error.stdout?.slice(0,4096),stderr:error.stderr?.slice(-8192)};}
}
for(const name of ['ordinary','negotiated','many_paragraphs','near_xml_token_limit','over_xml_token_limit','near_part_limit','over_part_limit','near_expanded_limit','overlapping_comments','excessive_attributes','local_crc_mismatch','local_size_mismatch']){
  const result=await sample(name);results.push(result);console.log(`${name}: ${result.failedProcess?'PROCESS FAILURE':`${result.extractMs.toFixed(1)} ms, ${(result.processPeakRssKiB/1024).toFixed(1)} MiB, eligible=${result.actualEligible}, expectation=${result.expectationMet}`}`);
}
for(const count of [500,1500])results.push(await sample('overlapping_comments',{COMMENT_COUNT:String(count),RUN_COUNT:'2000'}));
const batches=[];
for(const concurrency of [1,2,4]){
  const begin=performance.now(),items=await Promise.all(Array.from({length:concurrency},()=>sample('ordinary')));
  const batch={concurrency,wallMs:performance.now()-begin,items,sumProcessPeakRssKiB:items.reduce((n,i)=>n+(i.processPeakRssKiB??0),0)};batches.push(batch);console.log(`concurrency ${concurrency}: ${batch.wallMs.toFixed(1)} ms wall, ${(batch.sumProcessPeakRssKiB/1024).toFixed(1)} MiB summed process high-water marks`);
}
const readLimit=file=>{try{return fs.readFileSync(file,'utf8').trim();}catch{return null;}};
const metadata={date:new Date().toISOString(),runtime:process.version,platform:process.platform,arch:process.arch,cpuCount:os.cpus().length,cpuModel:os.cpus()[0]?.model,totalHostMemoryBytes:os.totalmem(),cgroupMemoryMax:readLimit('/sys/fs/cgroup/memory.max'),cgroupCpuMax:readLimit('/sys/fs/cgroup/cpu.max'),heapCapMiB:512,timeoutMs:30000,notes:'Fresh isolated child per sample; peakRSS includes loader and fixture generation. Batch sum is conservative summed high-water marks, not simultaneous sampled RSS. No performance SLA or production capacity approval supplied.'};
fs.writeFileSync(`${root}-results.json`,JSON.stringify({metadata,results,batches},null,2)+'\n');
