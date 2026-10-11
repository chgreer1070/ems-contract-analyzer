import assert from "node:assert/strict";
import { readFileSync, writeFileSync, mkdtempSync, rmSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { performance } from "node:perf_hooks";
import { PDFDocument } from "pdf-lib";
import ts from "typescript";

const require = createRequire(import.meta.url);
function load(path, mocks = {}) {
  const code = ts.transpileModule(readFileSync(path, "utf8"), { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, esModuleInterop: true } }).outputText;
  const module = { exports: {} };
  new Function("require", "module", "exports", code)(id => Object.hasOwn(mocks, id) ? mocks[id] : require(id), module, module.exports);
  return module.exports;
}
const engine = load("lib/pdfPreparation.ts");
const worker = load("lib/pdfPreparationWorker.ts", { "@/lib/pdfPreparation": engine });
const folder = mkdtempSync(join(tmpdir(), "pdf-worker-check-"));
let count = 0;
async function check(name, fn) { await fn(); count++; console.log(`PASS ${name}`); }
function fixture(name, body, timeoutMs = 1000, concurrency = 1) {
  const filename = join(folder, `${name}.cjs`); writeFileSync(filename, body);
  return worker.createPdfPreparationRunner({ filename, timeoutMs, concurrency });
}
const id1 = "22222222-2222-4222-8222-222222222222";
const id2 = "33333333-3333-4333-8333-333333333333";
const split = engine.parsePdfPreparationRequest({ operation: "SPLIT", documentIds: [id1], firstPage: 2, lastPage: 2 });
const doc = await PDFDocument.create();
for (let i = 0; i < 2; i++) doc.addPage([612, 792]).drawText(`Synthetic preparation page ${i + 1}`, { x: 70, y: 700 });
const input = Buffer.from(await doc.save()); const before = Buffer.from(input);
const prepareFixture = `const {parentPort,workerData}=require('node:worker_threads');const engine=require(${JSON.stringify(join(process.cwd(), "runtime/pdfPreparationEngine.cjs"))});`;
const responseFixture = `${prepareFixture}engine.preparePdf(workerData.operation,workerData.inputs).then(result=>parentPort.postMessage({ok:true,result}));`;
try {
  await check("real worker split preserves render, text, and page provenance", async () => {
    const result = await worker.preparePdfInWorker(split, [input]);
    const expected = await engine.preparePdf(split, [input]);
    assert.deepEqual(result.pageMap, expected.pageMap); assert.equal(result.pageCount, 1);
    writeFileSync(join(folder, "expected.pdf"), expected.bytes); writeFileSync(join(folder, "actual.pdf"), result.bytes);
    const render = spawnSync("python", ["-c", "import fitz,sys;a=fitz.open(sys.argv[1]);b=fitz.open(sys.argv[2]);assert len(a)==len(b);assert all(x.get_text()==y.get_text() and x.get_pixmap().samples==y.get_pixmap().samples for x,y in zip(a,b))", join(folder, "expected.pdf"), join(folder, "actual.pdf")], { encoding: "utf8" });
    assert.equal(render.status, 0, render.stderr);
  });
  await check("real worker merge does not detach or mutate source buffers", async () => {
    const result = await worker.preparePdfInWorker({ operation: "MERGE", documentIds: [id2, id1] }, [input, input]);
    assert.equal(result.pageCount, 4); assert.deepEqual(result.pageMap.map(x => x.sourceDocumentId), [id2, id2, id1, id1]);
    assert.deepEqual(input, before); assert.equal(input.byteLength, before.byteLength);
  });
  await check("real worker rejects malformed PDFs and preserves expected status", async () => {
    await assert.rejects(() => worker.preparePdfInWorker(split, [Buffer.from("invalid")]), error => error.status === 400);
    await assert.rejects(() => worker.preparePdfInWorker({ ...split, lastPage: 3 }, [input]), error => error.status === 400);
  });
  await check("byte limits reject before transferring oversized input", async () => {
    await assert.rejects(() => worker.preparePdfInWorker(split, [Buffer.alloc(engine.PDF_PREPARATION_MAX_BYTES + 1)]), error => error.status === 400);
  });
  await check("CPU-stalled worker is terminated while parent event loop stays responsive", async () => {
    const run = fixture("cpu", "while(true){}", 150);
    let heartbeats = 0; const heartbeat = setInterval(() => heartbeats++, 10); const started = performance.now();
    try { await assert.rejects(() => run(split, [input]), error => error.status === 408); }
    finally { clearInterval(heartbeat); }
    assert.ok(heartbeats >= 3); assert.ok(performance.now() - started < 1500);
    // A released slot accepts another invocation and terminates it too.
    await assert.rejects(() => run(split, [input]), error => error.status === 408);
  });
  await check("concurrency rejects excess work without queuing or retrying", async () => {
    const run = fixture("capacity", "while(true){}", 200, 2);
    const first = assert.rejects(() => run(split, [input]), error => error.status === 408);
    const second = assert.rejects(() => run(split, [input]), error => error.status === 408);
    await assert.rejects(() => run(split, [input]), error => error.status === 429);
    await Promise.all([first, second]);
  });
  await check("crash and normal exit without output both reject", async () => {
    for (const [name, body] of [["crash", "throw new Error('synthetic internal diagnostic')"], ["exit", "process.exit(0)"]]) {
      const run = fixture(name, body);
      await assert.rejects(() => run(split, [input]), error => error.status === 500 && !error.message.includes("internal diagnostic"));
    }
  });
  await check("invalid worker result and page lineage fail closed", async () => {
    const bad = fixture("invalid", "require('node:worker_threads').parentPort.postMessage({ok:true,result:{bytes:new Uint8Array([1])}})");
    await assert.rejects(() => bad(split, [input]), error => error.status === 500);
    const lineage = fixture("lineage", `${prepareFixture}engine.preparePdf(workerData.operation,workerData.inputs).then(result=>{result.pageMap[0].sourceDocumentId='unrelated';parentPort.postMessage({ok:true,result});});`);
    await assert.rejects(() => lineage(split, [input]), error => error.status === 500);
  });
  await check("worker receives no inherited environment credentials", async () => {
    const prior = process.env.SYNTHETIC_PDF_WORKER_SECRET; process.env.SYNTHETIC_PDF_WORKER_SECRET = "test-marker";
    try {
      const run = fixture("environment", `if(process.env.SYNTHETIC_PDF_WORKER_SECRET)throw new Error('credential inherited');${responseFixture}`);
      assert.equal((await run(split, [input])).pageCount, 1);
    } finally { if (prior === undefined) delete process.env.SYNTHETIC_PDF_WORKER_SECRET; else process.env.SYNTHETIC_PDF_WORKER_SECRET = prior; }
  });
  await check("heap exhaustion kills the worker and releases capacity", async () => {
    const run = fixture("heap", "const allocations=[];while(true)allocations.push(new Array(250000).fill(1));", 5000);
    await assert.rejects(() => run(split, [input]), error => error.status === 500);
    await assert.rejects(() => run(split, [input]), error => error.status === 500);
  });
  await check("worker that posts a result then stalls is stopped before returning", async () => {
    const run = fixture("result-stall", `${responseFixture}setInterval(()=>{},1000);`);
    assert.equal((await run(split, [input])).pageCount, 1);
    assert.equal((await run(split, [input])).pageCount, 1);
  });
  await check("service timeout never reaches malware scan or persistence", async () => {
    let scanned = false; let persisted = false;
    const service = load("lib/pdfPreparationService.ts", { "@/lib/pdfPreparation": engine, "@/lib/pdfPreparationWorker": { preparePdfInWorker: fixture("service-stall", "while(true){}", 100) } });
    const hash = engine.pdfBytesHash(input); const matter = "11111111-1111-4111-8111-111111111111";
    const deps = { authorize: async () => ({ demo: false }), rateLimit: async () => {}, loadSources: async () => [{ id:id1, matter_id:matter, mime_type:"application/pdf", deletion_status:"ACTIVE", security_scan_status:"CLEAN", integrity_status:"SERVER_VERIFIED", sha256:hash, server_sha256:hash, size_bytes:input.length, blob_pathname:`contracts/${matter}/synthetic.pdf` }], readPrivateBytes: async () => input, scanOutput: async () => { scanned=true; return true; }, persist: async () => { persisted=true; } };
    await assert.rejects(() => service.executePdfPreparation(new Request("https://contracttwin.test"), matter, split, "synthetic", deps), error => error.status === 408);
    assert.equal(scanned, false); assert.equal(persisted, false);
  });
  console.log(`${count} real worker checks passed. Cloud providers remain unvalidated.`);
} finally { rmSync(folder, { recursive: true, force: true }); }
