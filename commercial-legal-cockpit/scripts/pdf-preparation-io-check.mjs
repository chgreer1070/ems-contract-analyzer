import assert from "node:assert/strict";
import net from "node:net";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import ts from "typescript";

const require = createRequire(import.meta.url);
function load(path, mocks = {}) {
  const code = ts.transpileModule(readFileSync(path, "utf8"), { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, esModuleInterop: true } }).outputText;
  const module = { exports: {} };
  new Function("require", "module", "exports", code)(id => Object.hasOwn(mocks, id) ? mocks[id] : require(id), module, module.exports);
  return module.exports;
}
let count = 0;
async function check(name, fn) { await fn(); count++; console.log(`PASS ${name}`); }
const engine = load("lib/pdfPreparation.ts");
let getResult;
let requestedOptions;
const storage = load("lib/pdfPreparationStorage.ts", {
  "@/lib/pdfPreparation": engine,
  "@vercel/blob": { get: async (_, options) => { requestedOptions = options; return getResult; } }
});
await check("private reads bypass cache and carry an abort deadline", async () => {
  getResult = { statusCode: 200, stream: new ReadableStream({ start(controller) { controller.enqueue(Buffer.from("abc")); controller.enqueue(Buffer.from("def")); controller.close(); } }) };
  assert.equal((await storage.readPrivatePdfBytes("test", 10)).toString(), "abcdef");
  assert.equal(requestedOptions.access, "private"); assert.equal(requestedOptions.useCache, false); assert.ok(requestedOptions.abortSignal instanceof AbortSignal);
});
await check("missing objects and conditional responses cannot masquerade as PDF bytes", async () => {
  for (const value of [null, { statusCode: 304, stream: null }, { statusCode: 200, stream: null }]) {
    getResult = value; await assert.rejects(() => storage.readPrivatePdfBytes("test", 10), /unavailable/);
  }
});
await check("oversized streams are canceled before returning bytes", async () => {
  let canceled = false;
  const stream = new ReadableStream({ start(controller) { controller.enqueue(Buffer.alloc(11)); }, cancel() { canceled = true; } });
  await assert.rejects(() => storage.readBoundedPreparationStream(stream, 10), /size limit/);
  assert.equal(canceled, true);
});
await check("stalled streams time out even if provider cancellation stalls", async () => {
  let canceled = false;
  const stream = new ReadableStream({ pull() {}, cancel() { canceled = true; return new Promise(() => {}); } });
  await assert.rejects(() => storage.readBoundedPreparationStream(stream, 10, 30), error => error.status === 408);
  assert.equal(canceled, true);
});
await check("stream errors and invalid limits fail closed", async () => {
  const broken = new ReadableStream({ start(controller) { controller.error(new Error("provider disconnected")); } });
  await assert.rejects(() => storage.readBoundedPreparationStream(broken, 10), /disconnected/);
  await assert.rejects(() => storage.readBoundedPreparationStream(new ReadableStream(), 0), /Invalid/);
});

const malware = load("lib/malwareScan.ts");
async function withDaemon(mode, bytes, fn) {
  const prior = Object.fromEntries(["CLAMAV_HOST", "CLAMAV_PORT", "CLAMAV_TIMEOUT_MS"].map(name => [name, process.env[name]]));
  const sockets = new Set(); let received; let frames;
  const server = net.createServer({ allowHalfOpen: true }, socket => {
    sockets.add(socket); socket.on("close", () => sockets.delete(socket)); socket.on("error", () => {});
    const chunks = [];
    socket.on("data", data => chunks.push(data));
    socket.on("end", () => {
      received = Buffer.concat(chunks);
      if (mode === "stall") return;
      if (mode === "close") { socket.destroy(); return; }
      socket.end(mode === "threat" ? "stream: Test-Signature FOUND\0" : mode === "malformed" ? "stream: ERROR\0" : mode === "huge" ? "x".repeat(20 * 1024) : "stream: OK\0");
    });
  });
  await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
  Object.assign(process.env, { CLAMAV_HOST: "127.0.0.1", CLAMAV_PORT: String(server.address().port), CLAMAV_TIMEOUT_MS: "1000" });
  try {
    await fn(() => malware.scanBuffer(bytes));
    if (received) {
      assert.equal(received.subarray(0, 10).toString(), "zINSTREAM\0");
      let offset = 10; const data = []; frames = [];
      while (offset < received.length) {
        const size = received.readUInt32BE(offset); offset += 4;
        if (!size) break;
        assert.ok(size <= 64 * 1024); frames.push(size); data.push(received.subarray(offset, offset + size)); offset += size;
      }
      assert.equal(offset, received.length); assert.deepEqual(Buffer.concat(data), bytes);
    }
    return frames;
  } finally {
    for (const socket of sockets) socket.destroy();
    await new Promise(resolve => server.close(resolve));
    for (const [name, value] of Object.entries(prior)) { if (value === undefined) delete process.env[name]; else process.env[name] = value; }
  }
}
await check("real TCP scanner protocol sends exact chunk framing and receives clean result", async () => {
  const frames = await withDaemon("clean", Buffer.alloc(150_000, 65), async scan => assert.equal((await scan()).clean, true));
  assert.deepEqual(frames, [65536, 65536, 18928]);
});
await check("real TCP scanner threat response never becomes clean", async () => {
  await withDaemon("threat", Buffer.from("synthetic PDF data"), async scan => assert.equal((await scan()).clean, false));
});
await check("real TCP scanner malformed response rejects", async () => {
  await withDaemon("malformed", Buffer.from("test"), async scan => assert.rejects(scan, /unrecognized/));
});
await check("real TCP scanner oversized response rejects", async () => {
  await withDaemon("huge", Buffer.from("test"), async scan => assert.rejects(scan, /safety limit/));
});
await check("real TCP scanner timeout rejects", async () => {
  await withDaemon("stall", Buffer.from("test"), async scan => assert.rejects(scan, /timed out/));
});
await check("real TCP scanner disconnect rejects", async () => {
  await withDaemon("close", Buffer.from("test"), async scan => assert.rejects(scan));
});

let authorized = true; let queries = 0;
const rows = [{ preparation_id: "synthetic", status: "PENDING_OR_INTERRUPTED", size_bytes: "123", page_count: "2" }];
const reconciliation = load("app/api/matters/[id]/pdf-preparations/route.ts", {
  "@/lib/access": { requireMatterAccess: async (_, matter, level) => { assert.equal(level, "EDIT"); if (!authorized) throw Object.assign(new Error("denied"), { status: 404 }); }, accessErrorResponse: error => error.status === 404 ? Response.json({ ok: false }, { status: 404 }) : null },
  "@/lib/db": { databaseConfigured: () => true, query: async (sql, values) => { queries++; assert.match(sql, /started.matter_id=\$1/); assert.match(sql, /limit 100/); assert.equal(values[0], "matter"); return { rows }; } },
  "@/lib/malwareScan": {}, "@/lib/pdfPreparation": engine, "@/lib/pdfPreparationService": {},
  "@/lib/pdfPreparationStorage": { pdfPreparationEnabled: () => true },
  "@/lib/rateLimit": {}, "@vercel/blob": {},
  "@/lib/safeErrors": { internalErrorResponse: () => Response.json({ ok: false }, { status: 500 }) }
}).GET;
const request = new Request("https://contracttwin.test/api/reconciliation");
const context = { params: Promise.resolve({ id: "matter" }) };
await check("unfinished requests are visible without storage URLs or automatic mutation", async () => {
  const response = await reconciliation(request, context); assert.equal(response.status, 200);
  const data = await response.json(); assert.equal(data.automaticRecovery, false); assert.equal(data.preparations[0].status, "PENDING_OR_INTERRUPTED"); assert.match(response.headers.get("Cache-Control"), /no-store/);
});
await check("reconciliation authorization precedes audit reads", async () => {
  authorized = false; const prior = queries; assert.equal((await reconciliation(request, context)).status, 404); assert.equal(queries, prior);
});
console.log(`${count} storage/scanner/reconciliation checks passed. Scanner is a local protocol emulator, not ClamAV malware detection. Blob and DB calls are mocked.`);
