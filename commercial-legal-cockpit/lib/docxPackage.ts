import { inflateRawSync } from "node:zlib";

// Deliberately bounded classic-ZIP reader. ZIP64, encryption and exotic filename
// encodings require another validated adapter; never guess or partially unzip.
export const DOCX_LIMITS = { compressedBytes:75*1024*1024, entries:2048, partBytes:8*1024*1024, expandedBytes:32*1024*1024, xmlNodes:100_000, xmlDepth:128, xmlNameChars:256, xmlAttributes:512, xmlPathChars:8192, receiptBytes:24*1024*1024, runMetadataBytes:4*1024*1024 } as const;

const crcTable = Array.from({length:256},(_,value)=>{
  for(let bit=0;bit<8;bit++)value=(value&1)?0xedb88320^(value>>>1):value>>>1;
  return value>>>0;
});
function crc32(bytes:Buffer){let crc=0xffffffff;for(const byte of bytes)crc=crcTable[(crc^byte)&255]^(crc>>>8);return (crc^0xffffffff)>>>0;}
function assert(value:unknown,message:string):asserts value {if(!value)throw new Error(message);}

export function readDocxPackage(input:ArrayBuffer):Map<string,Buffer>{
  const bytes=Buffer.from(input);
  assert(bytes.length>=22&&bytes.length<=DOCX_LIMITS.compressedBytes,"DOCX package size is outside the supported limits.");
  let end=-1;
  for(let offset=bytes.length-22;offset>=Math.max(0,bytes.length-65557);offset--){
    if(bytes.readUInt32LE(offset)===0x06054b50&&offset+22+bytes.readUInt16LE(offset+20)===bytes.length){end=offset;break;}
  }
  assert(end>=0,"DOCX ZIP end record is missing.");
  const count=bytes.readUInt16LE(end+10),size=bytes.readUInt32LE(end+12),start=bytes.readUInt32LE(end+16);
  assert(bytes.readUInt16LE(end+4)===0&&bytes.readUInt16LE(end+6)===0&&bytes.readUInt16LE(end+8)===count,"Multi-disk DOCX packages are unsupported.");
  assert(count!==65535&&size!==0xffffffff&&start!==0xffffffff,"ZIP64 DOCX packages are unsupported.");
  assert(count>0&&count<=DOCX_LIMITS.entries&&start+size===end,"DOCX ZIP directory exceeds supported limits or is inconsistent.");
  const parts=new Map<string,Buffer>(),names=new Set<string>(),ranges:Array<[number,number]>=[];
  let cursor=start,expanded=0;
  for(let index=0;index<count;index++){
    assert(cursor+46<=end&&bytes.readUInt32LE(cursor)===0x02014b50,"DOCX ZIP directory entry is invalid.");
    const flags=bytes.readUInt16LE(cursor+8),method=bytes.readUInt16LE(cursor+10),crc=bytes.readUInt32LE(cursor+16);
    const compressed=bytes.readUInt32LE(cursor+20),length=bytes.readUInt32LE(cursor+24),nameLength=bytes.readUInt16LE(cursor+28),extraLength=bytes.readUInt16LE(cursor+30),commentLength=bytes.readUInt16LE(cursor+32),local=bytes.readUInt32LE(cursor+42);
    assert(!(flags&0x2041)&&[0,8].includes(method),"Encrypted or unsupported-compression DOCX entries are blocked.");
    assert(bytes.readUInt16LE(cursor+34)===0&&compressed!==0xffffffff&&length!==0xffffffff&&local!==0xffffffff,"ZIP64/multi-disk DOCX entries are unsupported.");
    assert(cursor+46+nameLength+extraLength+commentLength<=end,"DOCX ZIP directory entry is truncated.");
    const nameBytes=bytes.subarray(cursor+46,cursor+46+nameLength);
    assert((flags&0x800)||nameBytes.every(byte=>byte<128),"Non-UTF-8 DOCX part names are unsupported.");
    const name=new TextDecoder("utf-8",{fatal:true}).decode(nameBytes);
    assert(name.length>0&&!/[\\\u0000-\u001f\u007f%?#]/.test(name)&&!name.startsWith("/")&&name.split("/").every((part,i,all)=>part!==".."&&part!=="."&&(Boolean(part)||i===all.length-1)),"Unsafe or ambiguous DOCX part name.");
    assert(!names.has(name.toLowerCase()),"Duplicate DOCX part name.");names.add(name.toLowerCase());
    assert(length<=DOCX_LIMITS.partBytes&&(expanded+=length)<=DOCX_LIMITS.expandedBytes,"Expanded DOCX exceeds supported limits.");
    assert(method!==0||compressed===length,"Stored DOCX ZIP entry has inconsistent sizes.");
    assert(local+30<=start&&bytes.readUInt32LE(local)===0x04034b50,"DOCX local ZIP header is invalid.");
    const localNameLength=bytes.readUInt16LE(local+26),localExtraLength=bytes.readUInt16LE(local+28),dataStart=local+30+localNameLength+localExtraLength;
    assert(bytes.readUInt16LE(local+6)===flags&&bytes.readUInt16LE(local+8)===method&&bytes.subarray(local+30,local+30+localNameLength).equals(nameBytes)&&dataStart+compressed<=start,"DOCX local/central ZIP headers disagree.");
    const localCrc=bytes.readUInt32LE(local+14),localCompressed=bytes.readUInt32LE(local+18),localLength=bytes.readUInt32LE(local+22);let entryEnd=dataStart+compressed;
    if(flags&8){
      assert((localCrc===0||localCrc===crc)&&(localCompressed===0||localCompressed===compressed)&&(localLength===0||localLength===length),"DOCX local/central ZIP descriptor metadata disagree.");
      let descriptor=entryEnd;
      assert(descriptor+12<=start,"DOCX ZIP data descriptor is missing.");
      if(bytes.readUInt32LE(descriptor)===0x08074b50)descriptor+=4;
      assert(descriptor+12<=start&&bytes.readUInt32LE(descriptor)===crc&&bytes.readUInt32LE(descriptor+4)===compressed&&bytes.readUInt32LE(descriptor+8)===length,"DOCX ZIP data descriptor disagrees with directory metadata.");entryEnd=descriptor+12;
    }else assert(localCrc===crc&&localCompressed===compressed&&localLength===length,"DOCX local/central ZIP sizes or CRC disagree.");
    assert(ranges.every(([from,to])=>local>=to||entryEnd<=from),"Overlapping DOCX ZIP entries are blocked.");ranges.push([local,entryEnd]);
    const data=bytes.subarray(dataStart,dataStart+compressed);
    const decoded=method===0?Buffer.from(data):inflateRawSync(data,{maxOutputLength:Math.min(DOCX_LIMITS.partBytes,length+1)});
    assert(decoded.length===length&&crc32(decoded)===crc,"DOCX ZIP size or CRC integrity check failed.");
    if(name.endsWith("/"))assert(length===0,"DOCX directory entry contains data.");else parts.set(name,decoded);
    cursor+=46+nameLength+extraLength+commentLength;
  }
  assert(cursor===end,"DOCX ZIP directory count/size mismatch.");
  return parts;
}
