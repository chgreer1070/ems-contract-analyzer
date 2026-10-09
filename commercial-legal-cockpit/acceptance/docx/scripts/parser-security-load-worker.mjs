import assert from 'node:assert/strict';
import { deflateRawSync } from 'node:zlib';
import { performance } from 'node:perf_hooks';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { createTypeScriptLoader } from '../../../scripts/ts-test-loader.mjs';

// Independent classic ZIP and OOXML inputs. Does not use the implementation's
// fixture generator, and no customer documents or provider calls are involved.
const W='http://schemas.openxmlformats.org/wordprocessingml/2006/main';
const R='http://schemas.openxmlformats.org/officeDocument/2006/relationships';
const REL='http://schemas.openxmlformats.org/package/2006/relationships';
const p=t=>`<w:p><w:r><w:t>${t}</w:t></w:r></w:p>`;
const doc=b=>`<w:document xmlns:w="${W}" xmlns:r="${R}"><w:body>${b}<w:sectPr/></w:body></w:document>`;
const crcTable=Array.from({length:256},(_,i)=>{for(let j=0;j<8;j++)i=(i&1)?(i>>>1)^0xedb88320:i>>>1;return i>>>0;});
const crc=b=>{let c=0xffffffff;for(const v of b)c=crcTable[(c^v)&255]^(c>>>8);return(c^0xffffffff)>>>0;};
function zip(parts,{badLocalCrc=false,badLocalSize=false,badLocalExpandedSize=false,descriptor=false,descriptorSignature=true,missingDescriptor=false,badDescriptorCrc=false,badDescriptorSize=false}={}) {
  const local=[],central=[];let offset=0;
  for(const [name,value] of parts){
    const nameBytes=Buffer.from(name),data=Buffer.from(value),compressed=deflateRawSync(data),checksum=crc(data);
    const l=Buffer.alloc(30);l.writeUInt32LE(0x04034b50);l.writeUInt16LE(20,4);l.writeUInt16LE(descriptor?8:0,6);l.writeUInt16LE(8,8);l.writeUInt32LE(badLocalCrc?(checksum^1)>>>0:descriptor?0:checksum,14);l.writeUInt32LE(badLocalSize?compressed.length+1:descriptor?0:compressed.length,18);l.writeUInt32LE(badLocalExpandedSize?data.length+1:descriptor?0:data.length,22);l.writeUInt16LE(nameBytes.length,26);
    const c=Buffer.alloc(46);c.writeUInt32LE(0x02014b50);c.writeUInt16LE(20,4);c.writeUInt16LE(20,6);c.writeUInt16LE(descriptor?8:0,8);c.writeUInt16LE(8,10);c.writeUInt32LE(checksum,16);c.writeUInt32LE(compressed.length,20);c.writeUInt32LE(data.length,24);c.writeUInt16LE(nameBytes.length,28);c.writeUInt32LE(offset,42);
    const tail=descriptor&&!missingDescriptor?Buffer.alloc(descriptorSignature?16:12):Buffer.alloc(0);
    if(tail.length){const base=descriptorSignature?4:0;if(base)tail.writeUInt32LE(0x08074b50);tail.writeUInt32LE(badDescriptorCrc?(checksum^1)>>>0:checksum,base);tail.writeUInt32LE(badDescriptorSize?compressed.length+1:compressed.length,base+4);tail.writeUInt32LE(data.length,base+8);}
    local.push(l,nameBytes,compressed,tail);central.push(c,nameBytes);offset+=l.length+nameBytes.length+compressed.length+tail.length;
  }
  const directory=Buffer.concat(central),end=Buffer.alloc(22);end.writeUInt32LE(0x06054b50);end.writeUInt16LE(parts.length,8);end.writeUInt16LE(parts.length,10);end.writeUInt32LE(directory.length,12);end.writeUInt32LE(offset,16);
  const bytes=Buffer.concat([...local,directory,end]);return bytes.buffer.slice(bytes.byteOffset,bytes.byteOffset+bytes.byteLength);
}
function packageFor(body,extra=[],options={}){
  const overrides=extra.map(([name,,kind])=>`<Override PartName="/${name}" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.${kind}+xml"/>`).join('');
  const parts=[['word/document.xml',doc(body)],['[Content_Types].xml',`<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/>${overrides}</Types>`],['_rels/.rels',`<Relationships xmlns="${REL}"><Relationship Id="main" Type="${R}/officeDocument" Target="word/document.xml"/></Relationships>`],...extra.map(([name,data])=>[name,data])];
  if(extra.length)parts.push(['word/_rels/document.xml.rels',`<Relationships xmlns="${REL}">${extra.map(([name,,kind],i)=>`<Relationship Id="x${i}" Type="${R}/${kind}" Target="${name.slice(5)}"/>`).join('')}</Relationships>`]);
  return {bytes:zip(parts,options),expandedBytes:parts.reduce((n,[,data])=>n+Buffer.byteLength(data),0)};
}
const cases={
  ordinary:()=>({input:packageFor(Array.from({length:500},(_,i)=>p(`Clause ${i}. Customer pays valid invoices within 30 days. Supplier shall preserve source evidence.`)).join('')),expectedEligible:true}),
  negotiated:()=>({input:packageFor(Array.from({length:300},(_,i)=>`<w:p><w:r><w:t>Payment clause ${i}: </w:t></w:r><w:del w:id="${i*2}" w:author="Synthetic seller" w:date="2026-10-09T12:00:00Z"><w:r><w:delText>30 days</w:delText></w:r></w:del><w:ins w:id="${i*2+1}" w:author="Synthetic buyer" w:date="2026-10-09T12:00:00Z"><w:r><w:t>60 days</w:t></w:r></w:ins></w:p>`).join('')),expectedEligible:true}),
  many_paragraphs:()=>({input:packageFor(p('x').repeat(6000)),expectedEligible:true,expectedChunks:6000}),
  near_xml_token_limit:()=>({input:packageFor(p('x').repeat(16000)),expectedEligible:true,expectedChunks:16000}),
  over_xml_token_limit:()=>({input:packageFor(p('x').repeat(17000)),expectedEligible:false}),
  near_part_limit:()=>({input:packageFor(p('x'.repeat(8*1024*1024-600))),expectedEligible:false}),
  over_part_limit:()=>({input:packageFor(p('x'.repeat(8*1024*1024))),expectedEligible:false}),
  near_expanded_limit:()=>({input:packageFor(p('Synthetic terms.'),Array.from({length:4},(_,i)=>[`word/blob${i}.bin`,'x'.repeat(8*1024*1024-8192),'syntheticBinary'])),expectedEligible:false}),
  overlapping_comments:()=>{
    const count=Number(process.env.COMMENT_COUNT??1000),runs=Number(process.env.RUN_COUNT??2000);
    const body=`<w:p>${Array.from({length:count},(_,i)=>`<w:commentRangeStart w:id="${i}"/>`).join('')}${'<w:r><w:t>x</w:t></w:r>'.repeat(runs)}${Array.from({length:count},(_,i)=>`<w:commentRangeEnd w:id="${i}"/>`).join('')}</w:p>`;
    const comments=`<w:comments xmlns:w="${W}">${Array.from({length:count},(_,i)=>`<w:comment w:id="${i}" w:author="Synthetic reviewer">${p('Scope clarification.')}</w:comment>`).join('')}</w:comments>`;
    return {input:packageFor(body,[['word/comments.xml',comments,'comments']]),expectedEligible:false,parameters:{comments:count,runs,runCommentMemberships:count*runs}};
  },
  excessive_attributes:()=>({input:packageFor(`<w:p ${Array.from({length:150000},(_,i)=>`a${i}="x"`).join(' ')}><w:r><w:t>Terms</w:t></w:r></w:p>`),expectedEligible:false}),
  local_crc_mismatch:()=>({input:packageFor(p('Valid synthetic terms.'),[],{badLocalCrc:true}),expectedEligible:false}),
  local_size_mismatch:()=>({input:packageFor(p('Valid synthetic terms.'),[],{badLocalSize:true}),expectedEligible:false}),
  local_expanded_size_mismatch:()=>({input:packageFor(p('Valid synthetic terms.'),[],{badLocalExpandedSize:true}),expectedEligible:false}),
  signed_descriptor:()=>({input:packageFor(p('Valid synthetic terms.'),[],{descriptor:true}),expectedEligible:true}),
  unsigned_descriptor:()=>({input:packageFor(p('Valid synthetic terms.'),[],{descriptor:true,descriptorSignature:false}),expectedEligible:true}),
  bad_descriptor_crc:()=>({input:packageFor(p('Valid synthetic terms.'),[],{descriptor:true,badDescriptorCrc:true}),expectedEligible:false}),
  bad_descriptor_size:()=>({input:packageFor(p('Valid synthetic terms.'),[],{descriptor:true,badDescriptorSize:true}),expectedEligible:false}),
  missing_descriptor:()=>({input:packageFor(p('Valid synthetic terms.'),[],{descriptor:true,missingDescriptor:true}),expectedEligible:false}),
  bad_descriptor_local_metadata:()=>({input:packageFor(p('Valid synthetic terms.'),[],{descriptor:true,badLocalSize:true}),expectedEligible:false}),
};
const name=process.argv[2];assert(cases[name],`Unknown case ${name}`);
const sourceFiles=['lib/docxPackage.ts','lib/docxExtraction.ts','lib/docxEvidence.ts','lib/docxReceipt.ts','lib/stateHash.ts'];
let moduleRoot=process.cwd(),temporaryRoot=null;
if(process.env.DOCX_BASELINE_REVISION){
  temporaryRoot=fs.mkdtempSync(path.join(os.tmpdir(),'contracttwin-docx-load-'));moduleRoot=temporaryRoot;fs.mkdirSync(path.join(moduleRoot,'lib'));
  for(const file of sourceFiles)fs.writeFileSync(path.join(moduleRoot,file),execFileSync('git',['show',`${process.env.DOCX_BASELINE_REVISION}:commercial-legal-cockpit/${file}`]));
}
const sourceHashes=Object.fromEntries(sourceFiles.map(file=>[file,createHash('sha256').update(fs.readFileSync(path.join(moduleRoot,file))).digest('hex')]));
const load=createTypeScriptLoader(),{extractDocx}=load(path.join(moduleRoot,'lib/docxExtraction.ts')),{createDocxReceipt,assertDocxReceipt}=load(path.join(moduleRoot,'lib/docxReceipt.ts'));
const generated=cases[name]();global.gc?.();
const before=process.memoryUsage(),begin=performance.now(),result=extractDocx(generated.input.bytes),extractMs=performance.now()-begin;
const receiptBegin=performance.now();let receiptVerified=false,receiptMs=null;
if(result.evidence.analysisEligible){const receipt=createDocxReceipt(result.evidence,result.chunks);assertDocxReceipt(receipt,result.evidence.sourceSha256,result.chunks.map(c=>({chunk_index:c.chunkIndex,content:c.text,content_sha256:c.sha256})));receiptVerified=true;receiptMs=performance.now()-receiptBegin;}
if(generated.expectedChunks!==undefined)assert.equal(result.chunks.length,generated.expectedChunks);
if(!result.evidence.analysisEligible)assert.equal(result.chunks.length,0,'Denied input must expose no analysis chunks');
const evidenceSerializedBytes=Buffer.byteLength(JSON.stringify(result.evidence));
const after=process.memoryUsage(),usage=process.resourceUsage();
for(const file of sourceFiles)assert.equal(createHash('sha256').update(fs.readFileSync(path.join(moduleRoot,file))).digest('hex'),sourceHashes[file],`Source changed during sample: ${file}`);
const measured={case:name,runtime:process.version,baselineRevision:process.env.DOCX_BASELINE_REVISION??null,extractorVersion:result.evidence.extractorVersion,syntheticSourceSha256:result.evidence.sourceSha256,compressedBytes:generated.input.bytes.byteLength,expandedBytes:generated.input.expandedBytes,evidenceSerializedBytes,parameters:generated.parameters??null,expectedEligible:generated.expectedEligible,actualEligible:result.evidence.analysisEligible,expectationMet:result.evidence.analysisEligible===generated.expectedEligible,chunks:result.chunks.length,issueCodes:[...new Set(result.evidence.issues.map(i=>i.code))],extractMs,receiptMs,receiptVerified,before,after,processPeakRssKiB:usage.maxRSS,userCpuMs:usage.userCPUTime/1000,systemCpuMs:usage.systemCPUTime/1000,sourceHashes};
console.log(JSON.stringify(measured));
if(temporaryRoot)fs.rmSync(temporaryRoot,{recursive:true,force:true});
// Report mismatches instead of stopping the orchestrator; independently defined
// expected rejection remains visible in raw evidence and the acceptance report.
