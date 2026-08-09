import fs from "node:fs/promises";

const policy=JSON.parse(await fs.readFile(new URL("../lib/evidence-kernel-blockers.json",import.meta.url),"utf8"));
if(!Number.isInteger(policy?.version)||policy.version<1||!Array.isArray(policy?.blockers)||policy.blockers.some(blocker=>typeof blocker!=="string"||!blocker.trim())){
  throw new Error("Evidence-kernel blocker policy is malformed.");
}
if(policy.blockers.length){
  throw new Error(`Production mutation is blocked by ${policy.blockers.length} source-code completion gate(s): ${policy.blockers.join("; ")}`);
}
console.log(`Production source eligibility passed evidence-kernel policy v${policy.version}.`);
