import crypto from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import {TextDecoder} from "node:util";

export const MIGRATION_RECEIPT_ALGORITHM="sha256-utf8-canonical-lf-v1";
const MIGRATION_FILENAME_PATTERN=/^(\d{3})_[a-z0-9_]+\.sql$/u;
const UTF8_BOM=Buffer.from([0xef,0xbb,0xbf]);

export function canonicalizeMigrationSource(source,label="Migration source"){
  if(!Buffer.isBuffer(source)&&!(source instanceof Uint8Array))throw new TypeError(`${label} must be supplied as bytes.`);
  const bytes=Buffer.from(source.buffer,source.byteOffset,source.byteLength);
  if(bytes.length===0)throw new Error(`${label} must not be empty.`);
  if(bytes.subarray(0,UTF8_BOM.length).equals(UTF8_BOM))throw new Error(`${label} must be UTF-8 without a byte-order mark.`);
  let decoded;
  try{decoded=new TextDecoder("utf-8",{fatal:true}).decode(bytes);}catch{throw new Error(`${label} must be valid UTF-8 without a byte-order mark.`);}
  if(decoded.includes("\u0000"))throw new Error(`${label} must not contain NUL characters.`);
  const sql=decoded.replace(/\r\n?/gu,"\n");
  const canonicalBytes=Buffer.from(sql,"utf8");
  const sha256=crypto.createHash("sha256").update(canonicalBytes).digest("hex");
  return {sql,sha256};
}

export async function loadCanonicalMigrationSources(root=process.cwd()){
  const migrationDir=path.join(root,"db","migrations");
  const entries=await fs.readdir(migrationDir,{withFileTypes:true});
  const sqlEntries=entries.filter(entry=>/\.sql$/iu.test(entry.name));
  if(sqlEntries.length===0)throw new Error("At least one numbered SQL migration is required.");
  for(const entry of sqlEntries){
    if(!entry.isFile())throw new Error(`Migration ${entry.name} must be a regular file.`);
    if(!MIGRATION_FILENAME_PATTERN.test(entry.name))throw new Error(`Migration ${entry.name} does not use the required NNN_name.sql filename.`);
  }
  sqlEntries.sort((left,right)=>left.name<right.name?-1:left.name>right.name?1:0);
  return Promise.all(sqlEntries.map(async(entry,index)=>{
    const ordinal=Number(MIGRATION_FILENAME_PATTERN.exec(entry.name)?.[1]);
    if(ordinal!==index+1)throw new Error(`Migration sequence is not contiguous at position ${index+1}.`);
    const source=await fs.readFile(path.join(migrationDir,entry.name));
    return {filename:entry.name,...canonicalizeMigrationSource(source,`Migration ${entry.name}`)};
  }));
}
