import { deflateRawSync } from "node:zlib";

// Synthetic-only source fixtures. Bytes are generated in memory, never customer
// documents, and include actual OOXML revisions/anchors rather than text mocks.
// The ZIP writer is local so this check does not add or replace dependencies.
export const W="http://schemas.openxmlformats.org/wordprocessingml/2006/main";
export const R="http://schemas.openxmlformats.org/officeDocument/2006/relationships";
export const REL="http://schemas.openxmlformats.org/package/2006/relationships";
export const escapeXml=value=>String(value).replaceAll("&","&amp;").replaceAll("<","&lt;").replaceAll('"',"&quot;");
export const text=value=>`<w:r><w:t xml:space="preserve">${escapeXml(value)}</w:t></w:r>`;
export const p=value=>`<w:p>${value}</w:p>`;
export const revision=(kind,id,author,value)=>`<w:${kind} w:id="${id}" w:author="${escapeXml(author)}" w:date="2026-10-08T12:00:00Z"><w:r><w:${kind==="del"?"delText":"t"} xml:space="preserve">${escapeXml(value)}</w:${kind==="del"?"delText":"t"}></w:r></w:${kind}>`;
export const replacement=p(text("Customer shall pay within ")+revision("del","10","Synthetic Flex Counsel","30 days")+revision("ins","11","Synthetic Customer Counsel","60 days")+text(" of invoice."));
export const comment=(id,value)=>`<w:comment w:id="${id}" w:author="Synthetic Reviewer" w:initials="SR" w:date="2026-10-08T12:30:00Z">${p(text(value))}</w:comment>`;
export const relationship=(id,type,target,external=false)=>`<Relationship Id="${id}" Type="${R}/${type}" Target="${escapeXml(target)}"${external?' TargetMode="External"':''}/>`;
export const document=(body,attributes="")=>`<?xml version="1.0" encoding="UTF-8"?><w:document xmlns:w="${W}" xmlns:r="${R}" ${attributes}><w:body>${body}<w:sectPr/></w:body></w:document>`;
const mainType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml";
const types={comments:"application/vnd.openxmlformats-officedocument.wordprocessingml.comments+xml",header:"application/vnd.openxmlformats-officedocument.wordprocessingml.header+xml",footer:"application/vnd.openxmlformats-officedocument.wordprocessingml.footer+xml",footnotes:"application/vnd.openxmlformats-officedocument.wordprocessingml.footnotes+xml",endnotes:"application/vnd.openxmlformats-officedocument.wordprocessingml.endnotes+xml",styles:"application/vnd.openxmlformats-officedocument.wordprocessingml.styles+xml",numbering:"application/vnd.openxmlformats-officedocument.wordprocessingml.numbering+xml"};

const crcTable=Array.from({length:256},(_,value)=>{for(let bit=0;bit<8;bit++)value=(value&1)?0xedb88320^(value>>>1):value>>>1;return value>>>0;});
function crc32(bytes){let crc=0xffffffff;for(const byte of bytes)crc=crcTable[(crc^byte)&255]^(crc>>>8);return (crc^0xffffffff)>>>0;}
function zipBytes(entries,methodName){
  const method=methodName==="STORE"?0:8;
  const locals=[];const central=[];
  let offset=0;
  for(const entry of entries){
    const name=Buffer.from(entry.name,"utf8");
    const data=Buffer.isBuffer(entry.data)?entry.data:Buffer.from(String(entry.data),"utf8");
    const compressed=method===0?data:deflateRawSync(data);
    const local=Buffer.alloc(30+name.length);
    local.writeUInt32LE(0x04034b50,0);
    local.writeUInt16LE(20,4);
    local.writeUInt16LE(0x0800,6);
    local.writeUInt16LE(method,8);
    local.writeUInt32LE(crc32(data),14);
    local.writeUInt32LE(compressed.length,18);
    local.writeUInt32LE(data.length,22);
    local.writeUInt16LE(name.length,26);
    name.copy(local,30);
    locals.push(local,compressed);
    const header=Buffer.alloc(46+name.length);
    header.writeUInt32LE(0x02014b50,0);
    header.writeUInt16LE(20,4);
    header.writeUInt16LE(20,6);
    header.writeUInt16LE(0x0800,8);
    header.writeUInt16LE(method,10);
    header.writeUInt32LE(crc32(data),16);
    header.writeUInt32LE(compressed.length,20);
    header.writeUInt32LE(data.length,24);
    header.writeUInt16LE(name.length,28);
    header.writeUInt32LE(offset,42);
    name.copy(header,46);
    central.push(header);
    offset+=local.length+compressed.length;
  }
  const directory=Buffer.concat(central);
  const end=Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50,0);
  end.writeUInt16LE(entries.length,8);
  end.writeUInt16LE(entries.length,10);
  end.writeUInt32LE(directory.length,12);
  end.writeUInt32LE(offset,16);
  return Buffer.concat([...locals,directory,end]);
}

export async function fixture({body=replacement,main=document(body),parts={},rels=[],rootRels=relationship("main","officeDocument","word/document.xml"),contentTypes=null,compression="DEFLATE"}={}){
  const files=[{name:"word/document.xml",data:main}];
  const overrides=[`<Override PartName="/word/document.xml" ContentType="${mainType}"/>`];
  for(const [name,part] of Object.entries(parts)){
    const value=typeof part==="string"?{xml:part}:part;
    files.push({name,data:value.xml});
    const type=value.type??types[value.kind]??"application/xml";
    overrides.push(`<Override PartName="/${name}" ContentType="${type}"/>`);
    if(value.kind)rels=[...rels,relationship(`part-${rels.length}`,value.kind,name.replace(/^word\//,""))];
  }
  files.push({name:"[Content_Types].xml",data:contentTypes??`<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/>${overrides.join("")}</Types>`});
  files.push({name:"_rels/.rels",data:`<Relationships xmlns="${REL}">${rootRels}</Relationships>`});
  if(rels.length)files.push({name:"word/_rels/document.xml.rels",data:`<Relationships xmlns="${REL}">${rels.join("")}</Relationships>`});
  const buffer=zipBytes(files,compression);
  return buffer.buffer.slice(buffer.byteOffset,buffer.byteOffset+buffer.byteLength);
}
export const story=(name,body)=>`<w:${name} xmlns:w="${W}" xmlns:r="${R}">${body}</w:${name}>`;
