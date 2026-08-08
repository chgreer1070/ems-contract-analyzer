import {spawn} from "node:child_process";
import {resolve} from "node:path";

if(!process.env.DATABASE_URL)throw new Error("DATABASE_URL is required for owner-only database-control fixtures.");
if(!process.env.RUNTIME_DATABASE_URL)throw new Error("RUNTIME_DATABASE_URL is required for restricted-runtime fixtures.");

function isolatedEnvironment(allowedDatabaseVariable){
  const environment={...process.env};
  for(const name of ["DATABASE_URL","MIGRATION_DATABASE_URL","RUNTIME_DATABASE_URL"]){
    if(name!==allowedDatabaseVariable)delete environment[name];
  }
  return environment;
}

function run(script,environment){
  return new Promise((resolveRun,reject)=>{
    const child=spawn(process.execPath,[resolve(script)],{
      cwd:process.cwd(),
      env:environment,
      stdio:"inherit",
      shell:false
    });
    child.on("error",reject);
    child.on("exit",(code,signal)=>{
      if(code===0)resolveRun();
      else reject(new Error(`${script} failed with ${signal?`signal ${signal}`:`exit code ${code}`}.`));
    });
  });
}

const ownerEnvironment=isolatedEnvironment("DATABASE_URL");
const runtimeEnvironment=isolatedEnvironment("RUNTIME_DATABASE_URL");
await run("scripts/db-integration-check.mjs",ownerEnvironment);
await run("scripts/target-schema-drift-check.mjs",ownerEnvironment);
await run("scripts/runtime-database-principal-integration-check.mjs",runtimeEnvironment);
console.log("Database-control acceptance passed with isolated owner and restricted-runtime credentials.");
