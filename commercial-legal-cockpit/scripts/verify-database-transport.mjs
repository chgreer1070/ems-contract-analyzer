import pg from "pg";
import {verifiedDatabaseConnectionConfig} from "./database-connection-config.mjs";

const {Client}=pg;
const variableName=process.argv[2];
if(process.argv.length!==3||!["DATABASE_URL","RUNTIME_DATABASE_URL"].includes(variableName)){
  throw new Error("Usage: node scripts/verify-database-transport.mjs DATABASE_URL|RUNTIME_DATABASE_URL");
}
if(process.env.APP_ENV!=="production")throw new Error("Encrypted database transport verification is production-only.");
const connectionString=process.env[variableName]||"";
if(!connectionString)throw new Error(`${variableName} is required for encrypted database transport verification.`);
const client=new Client(verifiedDatabaseConnectionConfig(connectionString,"contracttwin-database-transport-verifier",{requireVerifiedTls:true}));
try{
  await client.connect();
  const evidence=(await client.query(`
    select s.ssl,s.version,s.cipher,s.bits
      from pg_catalog.pg_stat_ssl s
     where s.pid=pg_catalog.pg_backend_pid()
  `)).rows[0];
  if(evidence?.ssl!==true||!["TLSv1.2","TLSv1.3"].includes(String(evidence.version||""))||!String(evidence.cipher||"")||Number(evidence.bits)<128){
    throw new Error("Database connection did not prove a TLS 1.2 or TLS 1.3 transport of at least 128 bits.");
  }
}finally{await client.end();}
console.log("Database transport verification passed with certificate-verifying TLS and live encrypted-session evidence.");
