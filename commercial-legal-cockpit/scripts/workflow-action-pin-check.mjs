import assert from "node:assert/strict";
import {readdir,readFile} from "node:fs/promises";
import path from "node:path";

const workflowRoot=path.resolve("../.github/workflows");
const workflowFiles=(await readdir(workflowRoot,{withFileTypes:true}))
  .filter(entry=>entry.isFile()&&/\.ya?ml$/u.test(entry.name))
  .map(entry=>path.join(workflowRoot,entry.name))
  .sort();

assert.ok(workflowFiles.length>0,"workflow pin regression must inspect at least one workflow");

const approvedPins=new Map([
  ["actions/checkout","11d5960a326750d5838078e36cf38b85af677262"],
  ["actions/setup-node","49933ea5288caeca8642d1e84afbd3f7d6820020"],
  ["actions/setup-python","a26af69be951a213d495a4c3e4e4022e16d87065"],
  ["actions/upload-artifact","ea165f8d65b6e75b540449e92b4886f43607fa02"],
  ["github/codeql-action/init","5595ccaf912efad79be6eef63a5619ff05969be3"],
  ["github/codeql-action/analyze","5595ccaf912efad79be6eef63a5619ff05969be3"],
]);

let actionReferenceCount=0;
for(const workflowFile of workflowFiles){
  const source=await readFile(workflowFile,"utf8");
  const relativeWorkflow=path.relative(process.cwd(),workflowFile);
  assert.doesNotMatch(source,/^\s*contents:\s*write\s*$/mu,`${relativeWorkflow} must not grant repository write access`);
  assert.doesNotMatch(source,/\bgit\s+(?:commit|push)\b/u,`${relativeWorkflow} must not advance a source branch from CI`);
  for(const [index,line] of source.split(/\r?\n/u).entries()){
    const match=line.match(/^\s*(?:-\s*)?uses:\s*([^\s#]+)/u);
    if(!match)continue;
    actionReferenceCount+=1;
    const reference=match[1];
    if(reference.startsWith("./"))continue;
    const referenceMatch=reference.match(/^([^@\s]+)@([0-9a-f]{40})$/u);
    const location=`${relativeWorkflow}:${index+1}`;
    assert.ok(referenceMatch,`${location} must pin every remote action to an exact lowercase 40-character commit SHA`);
    const [,action,sha]=referenceMatch;
    assert.ok(approvedPins.has(action),`${location} uses an unreviewed remote action: ${action}`);
    assert.equal(sha,approvedPins.get(action),`${location} does not use the reviewed commit for ${action}`);
  }
}

assert.ok(actionReferenceCount>0,"workflow pin regression must inspect at least one action reference");
console.log(`Workflow action pin checks passed across ${workflowFiles.length} workflows and ${actionReferenceCount} action references.`);
