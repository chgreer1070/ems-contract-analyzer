import assert from "node:assert/strict";
import {readdir,readFile} from "node:fs/promises";
import path from "node:path";

async function filesBelow(root,name){
  const found=[];
  for(const entry of await readdir(root,{withFileTypes:true})){
    const target=path.join(root,entry.name);
    if(entry.isDirectory())found.push(...await filesBelow(target,name));
    else if(entry.isFile()&&entry.name===name)found.push(target);
  }
  return found;
}

const routeFiles=await filesBelow(path.resolve("app/api"),"route.ts");
assert.ok(routeFiles.length>=35,"error-boundary regression must inspect the complete API route surface");
for(const routeFile of routeFiles){
  const source=await readFile(routeFile,"utf8");
  const relative=path.relative(process.cwd(),routeFile);
  if(/catch\s*\(\s*error\s*\)/u.test(source)){
    assert.ok(source.includes("internalErrorResponse"),`${relative} must route unknown catch failures through the central safe boundary`);
  }
  assert.doesNotMatch(source,/status\s*:\s*(?:500|502)\b/u,`${relative} must not construct an ad hoc unknown 5xx response`);
  assert.doesNotMatch(source,/error\s+instanceof\s+Error\s*\?\s*error\.message|String\(error\)/u,`${relative} must not expose an unknown error value`);
  for(const line of source.split(/\r?\n/u).filter(value=>value.includes("error.message"))){
    assert.match(line,/if\s*\(\s*error\s+instanceof\s+[A-Za-z][A-Za-z0-9]*Error\s*\)/u,`${relative} may expose messages only from an explicit, route-local public error class`);
  }
}

const safeErrors=await readFile(path.resolve("lib/safeErrors.ts"),"utf8");
for(const required of ["globalThis.crypto.randomUUID()","errorClass","errorCode","correlationId","Cache-Control","X-Correlation-ID"]){
  assert.ok(safeErrors.includes(required),`safe error boundary must include ${required}`);
}
assert.doesNotMatch(safeErrors,/error\.message|error\.stack|String\(error\)|cause\s*:/u,"safe logging must not read or record sensitive error detail");

const analysisEngine=await readFile(path.resolve("lib/analysisEngine.ts"),"utf8");
assert.ok(analysisEngine.includes("AI analysis was unavailable; illustrative deterministic triage was used instead."),"AI fallback warning must be fixed and non-sensitive");
assert.doesNotMatch(analysisEngine,/warning\s*:\s*error|warning\s*:\s*String\(error\)/u,"AI provider detail must not become a response warning");

for(const relative of ["lib/jobs.ts","lib/jobProcessor.ts","workflows/legal-validation.ts"]){
  const source=await readFile(path.resolve(relative),"utf8");
  assert.ok(source.includes("safeOperationalFailure"),`${relative} must classify and sanitize persisted worker failures`);
  assert.doesNotMatch(source,/error\s+instanceof\s+Error\s*\?[^:\n]*\.message|String\(error\)/u,`${relative} must not persist raw error detail`);
}
const ocr=await readFile(path.resolve("lib/ocr.ts"),"utf8");
assert.doesNotMatch(ocr,/payload\?\.error\?\.message/u,"OCR provider payload detail must not be persisted");
const extraction=await readFile(path.resolve("lib/documentExtraction.ts"),"utf8");
assert.doesNotMatch(extraction,/result\.messages\.map/u,"document parser details must not be persisted or returned");
const workspace=await readFile(path.resolve("app/api/matters/[id]/workspace/route.ts"),"utf8");
const validationLatest=await readFile(path.resolve("app/api/validation/latest/route.ts"),"utf8");
assert.ok(workspace.includes("safePersistedFailureForDisplay(row.error_message)"),"workspace must redact legacy raw job failures on read");
assert.ok(validationLatest.includes("safePersistedFailureForDisplay(storedSummary.workflowFailure"),"validation API must redact legacy raw workflow failures on read");

console.log(`Safe error-boundary regression passed across ${routeFiles.length} API route handlers and every persisted worker/provider failure surface.`);
