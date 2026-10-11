import assert from "node:assert/strict";
import { readFileSync, writeFileSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { createRequire } from "node:module";
import ts from "typescript";
import { PDFDocument, PDFName, PDFDict, PDFString, rgb } from "pdf-lib";

const require = createRequire(import.meta.url);
const root = process.cwd();
function load(path, mocks = {}) {
  const code = ts.transpileModule(readFileSync(join(root, path), "utf8"), { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, esModuleInterop: true } }).outputText;
  const module = { exports: {} };
  new Function("require", "module", "exports", code)(id => Object.hasOwn(mocks, id) ? mocks[id] : require(id), module, module.exports);
  return module.exports;
}
let count = 0;
async function check(name, fn) { await fn(); count++; console.log(`PASS ${name}`); }
const engine = load("lib/pdfPreparation.ts");
const service = load("lib/pdfPreparationService.ts", { "@/lib/pdfPreparation": engine });
const storageModule = load("lib/pdfPreparationStorage.ts", { "@/lib/pdfPreparation": engine, "@vercel/blob": {} });
const matterId = "11111111-1111-4111-8111-111111111111";
const id1 = "22222222-2222-4222-8222-222222222222";
const id2 = "33333333-3333-4333-8333-333333333333";
const preparationId = "44444444-4444-4444-8444-444444444444";
const request = new Request("https://contracttwin.test/api/preparation");
const source = await PDFDocument.create();
for (let index = 0; index < 2; index++) {
  const page = source.addPage([612, 792]);
  page.drawText(index ? "NCNR approved commitments" : "PRICING 60 days notice", { x: 72, y: 692, size: 12 });
  for (let row = 0; row < 4; row++) page.drawRectangle({ x: 72, y: 500 + row * 25, width: 200, height: 25, borderColor: rgb(0, 0, 0), borderWidth: 1 });
  const image = await source.embedPng(Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAusB9Y9Zl1sAAAAASUVORK5CYII=", "base64"));
  page.drawImage(image, { x: 350, y: 400, width: 70, height: 70 });
  if (index) { page.setCropBox(20, 30, 560, 720); page.setRotation({ angle: 90, type: "degrees" }); }
}
const bytes = await source.save();
const splitRequest = engine.parsePdfPreparationRequest({ operation: "SPLIT", documentIds: [id1], firstPage: 2, lastPage: 2 });
const split = await engine.preparePdf(splitRequest, [bytes]);
const merged = await engine.preparePdf({ operation: "MERGE", documentIds: [id2, id1] }, [split.bytes, bytes]);
await check("split and merge page count, order, and page lineage", async () => {
  assert.equal(split.pageCount, 1); assert.equal(merged.pageCount, 3);
  assert.deepEqual(split.pageMap, [{ outputPage: 1, sourceDocumentId: id1, sourcePage: 2 }]);
  assert.deepEqual(merged.pageMap.map(page => page.sourceDocumentId), [id2, id1, id1]);
});
await check("source bytes remain unchanged", async () => assert.equal(engine.pdfBytesHash(bytes), engine.pdfBytesHash(await source.save())));
await check("invalid operations, IDs, duplicates, and ranges rejected", async () => {
  for (const value of [null, {}, { operation: "STAMP", documentIds: [id1] }, { operation: "MERGE", documentIds: [id1, id1] }, { operation: "MERGE", documentIds: ["../file"] }, { operation: "SPLIT", documentIds: [id1], firstPage: 0, lastPage: 1 }]) assert.throws(() => engine.parsePdfPreparationRequest(value), engine.PdfPreparationError);
  await assert.rejects(() => engine.preparePdf({ ...splitRequest, lastPage: 3 }, [bytes]), /page count/);
});
await check("invalid and oversized PDF bytes rejected", async () => {
  await assert.rejects(() => engine.preparePdf(splitRequest, [Buffer.from("not PDF")]), /invalid/);
  await assert.rejects(() => engine.preparePdf(splitRequest, [Buffer.alloc(engine.PDF_PREPARATION_MAX_BYTES + 1)]), /25 MiB/);
});
await check("encrypted PDFs and over-200-page inputs refused", async () => {
  const folder = mkdtempSync(join(tmpdir(), "pdf-prep-encrypted-"));
  writeFileSync(join(folder, "plain.pdf"), bytes);
  const result = spawnSync("python", ["-c", "import fitz,sys;d=fitz.open(sys.argv[1]);d.save(sys.argv[2],encryption=fitz.PDF_ENCRYPT_AES_256,owner_pw='owner',user_pw='user')", join(folder, "plain.pdf"), join(folder, "encrypted.pdf")], { encoding: "utf8" });
  assert.equal(result.status, 0, result.stderr);
  await assert.rejects(() => engine.preparePdf(splitRequest, [readFileSync(join(folder, "encrypted.pdf"))]), /Encrypted/);
  const long = await PDFDocument.create(); for (let i = 0; i < 201; i++) long.addPage();
  await assert.rejects(async () => engine.preparePdf(splitRequest, [await long.save()]), /200 pages/);
});
await check("request parser limits streamed bytes and rejects malformed JSON", async () => {
  await assert.rejects(() => storageModule.readPreparationJson(new Request(request.url, { method: "POST", body: "x".repeat(8193) })), error => error.status === 413);
  await assert.rejects(() => storageModule.readPreparationJson(new Request(request.url, { method: "POST", body: "{" })), error => error.status === 400);
  assert.deepEqual(await storageModule.readPreparationJson(new Request(request.url, { method: "POST", body: JSON.stringify(splitRequest) })), splitRequest);
});
await check("forms, signatures, annotations, bookmarks, attachments and layered PDFs refused", async () => {
  for (const key of ["AcroForm", "Outlines", "Names", "OpenAction", "StructTreeRoot", "OCProperties"]) {
    const doc = await PDFDocument.load(bytes);
    doc.catalog.set(PDFName.of(key), doc.context.obj({}));
    await assert.rejects(async () => engine.preparePdf(splitRequest, [await doc.save()]), /unsupported/);
  }
  const doc = await PDFDocument.load(bytes);
  doc.getPage(0).node.set(PDFName.of("Annots"), doc.context.obj([{ Type: "Annot", Subtype: "Text", Rect: [0, 0, 20, 20] }]));
  await assert.rejects(async () => engine.preparePdf(splitRequest, [await doc.save()]), /annotations/);
  const signed = await PDFDocument.load(bytes);
  signed.context.register(signed.context.obj({ Type: "Sig", ByteRange: [0, 1, 2, 3] }));
  await assert.rejects(async () => engine.preparePdf(splitRequest, [await signed.save()]), /Signed/);
});
await check("rendered tables, images, crop boxes and rotation preserved", async () => {
  const folder = mkdtempSync(join(tmpdir(), "pdf-prep-fidelity-"));
  writeFileSync(join(folder, "source.pdf"), bytes); writeFileSync(join(folder, "split.pdf"), split.bytes); writeFileSync(join(folder, "merge.pdf"), merged.bytes);
  const script = `import fitz,sys\nfrom pathlib import Path\np=Path(sys.argv[1])\na=fitz.open(p/'source.pdf');b=fitz.open(p/'split.pdf');c=fitz.open(p/'merge.pdf')\nfor doc,index,source_index in [(b,0,1),(c,0,1),(c,1,0),(c,2,1)]:\n x=a[source_index].get_pixmap();y=doc[index].get_pixmap()\n assert (x.width,x.height,x.samples)==(y.width,y.height,y.samples)\n assert a[source_index].get_text()==doc[index].get_text()\nprint('Four page comparisons: identical rendered pixels and extracted text')\n`;
  const result = spawnSync("python", ["-c", script, folder], { encoding: "utf8" });
  assert.equal(result.status, 0, result.stderr); console.log(result.stdout.trim());
});

const accessState = { role: "LAWYER", session: { user: { id: "lawyer", name: "Counsel" } }, matter: { owner_user_id: "owner", restricted: true, member_access: "EDIT" } };
const access = load("lib/access.ts", {
  "@/lib/auth": { auth: { api: { getSession: async () => accessState.session } }, authenticationRequired: () => true },
  "@/lib/db": { databaseConfigured: () => true, query: async sql => ({ rows: sql.includes("app_user_roles") ? [{ role: accessState.role }] : accessState.matter ? [accessState.matter] : [] }) }
});
function readySource(id, data) { return { id, matter_id: matterId, mime_type: "application/pdf", blob_pathname: `contracts/${matterId}/${id}.pdf`, sha256: engine.pdfBytesHash(data), server_sha256: engine.pdfBytesHash(data), size_bytes: data.length, integrity_status: "SERVER_VERIFIED", security_scan_status: "CLEAN", deletion_status: "ACTIVE" }; }
let state;
function reset() {
  state = { sources: [readySource(id1, bytes)], data: bytes, scanned: true, reads: 0, loads: 0, persisted: 0, failPersist: false };
  accessState.role = "LAWYER"; accessState.session = { user: { id: "lawyer", name: "Counsel" } }; accessState.matter = { owner_user_id: "owner", restricted: true, member_access: "EDIT" };
}
const deps = {
  authorize: access.requireMatterAccess, rateLimit: async () => {},
  loadSources: async () => { state.loads++; return state.sources; },
  readPrivateBytes: async () => { state.reads++; return state.data; },
  scanOutput: async () => state.scanned,
  persist: async (matter, principal, data, receipt) => { if (state.failPersist) throw new Error("Persistence unavailable"); state.persisted++; state.receipt = receipt; }
};
const run = () => service.executePdfPreparation(request, matterId, splitRequest, preparationId, deps);
await check("authenticated matter editor can prepare; receipt includes parent/output hashes", async () => {
  reset(); const result = await run(); assert.equal(result.sourceAuthority, "PREPARATION_COPY_ONLY"); assert.equal(state.persisted, 1); assert.equal(state.receipt.parents[0].sha256, engine.pdfBytesHash(bytes));
});
await check("unauthenticated caller cannot access metadata or bytes", async () => {
  reset(); accessState.session = null; await assert.rejects(run, error => error.status === 401); assert.equal(state.loads, 0); assert.equal(state.reads, 0);
});
await check("viewer cannot prepare even with matter membership", async () => {
  reset(); accessState.role = "VIEWER"; await assert.rejects(run, error => error.status === 403); assert.equal(state.loads, 0);
});
await check("restricted-matter outsider cannot access source metadata", async () => {
  reset(); accessState.matter.member_access = null; await assert.rejects(run, error => error.status === 404); assert.equal(state.loads, 0);
});
await check("VIEW membership cannot edit restricted matter", async () => {
  reset(); accessState.matter.member_access = "VIEW"; await assert.rejects(run, error => error.status === 404); assert.equal(state.loads, 0);
});
await check("cross-matter source blocked before file read", async () => {
  reset(); state.sources[0].matter_id = id2; await assert.rejects(run, /authorized matter/); assert.equal(state.reads, 0);
});
await check("missing source blocked before file read", async () => {
  reset(); state.sources = []; await assert.rejects(run, error => error.status === 404); assert.equal(state.reads, 0);
});
await check("quarantined, purged, pending and unverified sources blocked", async () => {
  for (const [key, value] of [["security_scan_status", "QUARANTINED"], ["deletion_status", "PURGED"], ["integrity_status", "CLIENT_HASHED"], ["server_sha256", "0".repeat(64)]]) {
    reset(); state.sources[0][key] = value; await assert.rejects(run, error => error.status === 409); assert.equal(state.reads, 0);
  }
});
await check("source byte tampering blocked before persistence", async () => {
  reset(); state.data = Buffer.from(bytes); state.data[100] ^= 1; await assert.rejects(run, /integrity/); assert.equal(state.persisted, 0);
});
await check("output malware result blocks persistence", async () => {
  reset(); state.scanned = false; await assert.rejects(run, error => error.status === 423); assert.equal(state.persisted, 0);
});
await check("persistence failure never returns success", async () => {
  reset(); state.failPersist = true; await assert.rejects(run, /Persistence unavailable/); assert.equal(state.persisted, 0);
});

reset();
const audit = [];
const stored = new Map();
let writes = 0;
let mutateAfterPut = false;
const db = {
  databaseConfigured: () => true,
  query: async sql => ({ rows: sql.includes("audit_events") ? audit.filter(event => event.action === "PDF_PREPARATION_COMPLETED") : state.sources }),
  withTransaction: async fn => fn({ query: async (sql, values) => {
    if (sql.includes("insert into audit_events")) { audit.push({ action: sql.includes("PDF_PREPARATION_COMPLETED") ? "PDF_PREPARATION_COMPLETED" : "PDF_PREPARATION_STARTED", metadata: JSON.parse(values[4]) }); return { rows: [] }; }
    return { rows: state.sources };
  } })
};
let enabled = true;
const storage = { pdfPreparationEnabled: () => enabled, readPreparationJson: storageModule.readPreparationJson, readPrivatePdfBytes: async pathname => stored.get(pathname) || bytes };
const mocks = { "@/lib/access": access, "@/lib/db": db, "@/lib/pdfPreparation": engine, "@/lib/pdfPreparationService": service, "@/lib/pdfPreparationStorage": storage,
  "@/lib/malwareScan": { malwareScannerConfigured: () => true, scanBuffer: async () => ({ clean: true }) },
  "@/lib/rateLimit": { enforceRateLimit: async () => {}, rateLimitResponse: () => null },
  "@/lib/safeErrors": { internalErrorResponse: () => Response.json({ ok: false }, { status: 500 }) },
  "@vercel/blob": { put: async (pathname, data, options) => { assert.equal(options.access, "private"); assert.equal(options.allowOverwrite, false); stored.set(pathname, data); writes++; if (mutateAfterPut) state.sources[0].deletion_status = "PURGED"; } }
};
const post = load("app/api/matters/[id]/pdf-preparations/route.ts", mocks).POST;
const get = load("app/api/matters/[id]/pdf-preparations/[preparationId]/content/route.ts", mocks).GET;
const oldToken = process.env.BLOB_READ_WRITE_TOKEN;
process.env.BLOB_READ_WRITE_TOKEN = "fake-test-token";
try {
  const bodyRequest = () => new Request(request.url, { method: "POST", body: JSON.stringify(splitRequest) });
  await check("feature gate blocks processing and retrieval", async () => {
    enabled = false;
    assert.equal((await post(bodyRequest(), { params: Promise.resolve({ id: matterId }) })).status, 503);
    assert.equal((await get(request, { params: Promise.resolve({ id: matterId, preparationId }) })).status, 503);
    assert.equal(writes, 0); enabled = true;
  });
  await check("API persistence records intent then completion without source registration", async () => {
    const response = await post(bodyRequest(), { params: Promise.resolve({ id: matterId }) });
    assert.equal(response.status, 201); assert.equal(writes, 1); assert.deepEqual(audit.map(event => event.action), ["PDF_PREPARATION_STARTED", "PDF_PREPARATION_COMPLETED"]);
  });
  const receipt = audit.find(event => event.action === "PDF_PREPARATION_COMPLETED").metadata;
  const context = { params: Promise.resolve({ id: matterId, preparationId: receipt.preparationId }) };
  await check("authenticated content retrieval verifies hash and prevents caching", async () => {
    const response = await get(request, context); assert.equal(response.status, 200); assert.match(response.headers.get("Cache-Control"), /no-store/); assert.match(response.headers.get("Content-Disposition"), /attachment/);
  });
  await check("tampered prepared output is not downloadable", async () => {
    const previous = stored.get(receipt.output.blobPathname); stored.set(receipt.output.blobPathname, Buffer.from("changed")); assert.equal((await get(request, context)).status, 409); stored.set(receipt.output.blobPathname, previous);
  });
  await check("purged parent blocks prepared-copy retrieval", async () => {
    state.sources[0].deletion_status = "PURGED"; assert.equal((await get(request, context)).status, 409); state.sources[0].deletion_status = "ACTIVE";
  });
  await check("restricted-matter outsider cannot download prepared output", async () => {
    accessState.matter.member_access = null; assert.equal((await get(request, context)).status, 404); accessState.matter.member_access = "EDIT";
  });
  await check("source revocation during write prevents completed receipt", async () => {
    const prior = audit.filter(event => event.action === "PDF_PREPARATION_COMPLETED").length; mutateAfterPut = true;
    assert.equal((await post(bodyRequest(), { params: Promise.resolve({ id: matterId }) })).status, 409);
    assert.equal(audit.filter(event => event.action === "PDF_PREPARATION_COMPLETED").length, prior);
    assert.equal(audit.at(-1).action, "PDF_PREPARATION_STARTED");
  });
} finally { if (oldToken === undefined) delete process.env.BLOB_READ_WRITE_TOKEN; else process.env.BLOB_READ_WRITE_TOKEN = oldToken; }
console.log(`${count} PDF preparation acceptance checks passed. Provider and DB calls are mocked; PDF parsing and rendering are real.`);
