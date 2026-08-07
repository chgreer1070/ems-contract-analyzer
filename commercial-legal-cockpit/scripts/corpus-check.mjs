import fs from "node:fs";
import path from "node:path";

const file=path.join(process.cwd(),"validation","frozen-ems-regression.json");
const corpus=JSON.parse(fs.readFileSync(file,"utf8"));
if(corpus.syntheticOnly!==true)throw new Error("Frozen regression corpus must be syntheticOnly=true.");
if(!Array.isArray(corpus.cases)||corpus.cases.length<24)throw new Error("Frozen regression corpus must contain at least 24 cases.");
const ids=new Set();
for(const c of corpus.cases){
  if(!c.id||ids.has(c.id))throw new Error(`Missing or duplicate case id: ${c.id}`);ids.add(c.id);
  if(!c.category||!c.title||typeof c.text!=="string"||c.text.length<20)throw new Error(`Invalid case ${c.id}`);
  if(!Array.isArray(c.expectedFamilies)||!Array.isArray(c.prohibitedFamilies)||!Array.isArray(c.mustFlag)||!Array.isArray(c.mustNotConclude))throw new Error(`Case arrays missing for ${c.id}`);
}
console.log(`Corpus check passed: ${corpus.cases.length} frozen synthetic EMS cases (${corpus.version}).`);
