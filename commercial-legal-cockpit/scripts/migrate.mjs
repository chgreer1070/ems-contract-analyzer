import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import pg from "pg";

const { Client }=pg;
if(!process.env.DATABASE_URL)throw new Error("DATABASE_URL is required.");
const client=new Client({connectionString:process.env.DATABASE_URL,application_name:"contracttwin-migrator"});
const migrationDir=path.join(process.cwd(),"db","migrations");
const files=fs.readdirSync(migrationDir).filter(f=>/^\d+.*\.sql$/.test(f)).sort();
await client.connect();
try{
  await client.query(`create table if not exists schema_migrations(filename text primary key,sha256 text not null,applied_at timestamptz not null default now())`);
  await client.query(`select pg_advisory_lock(hashtext('contracttwin-schema-migrations'))`);
  const applied=await client.query("select filename,sha256 from schema_migrations");
  const map=new Map(applied.rows.map(r=>[r.filename,r.sha256]));
  for(const filename of files){
    const sql=fs.readFileSync(path.join(migrationDir,filename),"utf8");
    const sha=crypto.createHash("sha256").update(sql,"utf8").digest("hex");
    if(map.has(filename)){
      if(map.get(filename)!==sha)throw new Error(`Applied migration ${filename} has changed. Create a new migration instead of editing history.`);
      console.log(`skip ${filename} (already applied)`);continue;
    }
    console.log(`apply ${filename}`);
    await client.query("BEGIN");
    try{await client.query(sql);await client.query("insert into schema_migrations(filename,sha256) values($1,$2)",[filename,sha]);await client.query("COMMIT");}
    catch(error){await client.query("ROLLBACK");throw error;}
  }
  console.log(`Migration complete: ${files.length} migration files verified.`);
}finally{
  try{await client.query(`select pg_advisory_unlock(hashtext('contracttwin-schema-migrations'))`);}catch{}
  await client.end();
}
