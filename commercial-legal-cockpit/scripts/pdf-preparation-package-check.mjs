import assert from "node:assert/strict";
import { readFileSync, copyFileSync, mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { createRequire } from "node:module";
import { join, dirname, resolve, relative, isAbsolute } from "node:path";
import { tmpdir } from "node:os";
import { PDFDocument } from "pdf-lib";
import ts from "typescript";

const require = createRequire(import.meta.url);
function load(path, mocks = {}) {
  const code = ts.transpileModule(readFileSync(path, "utf8"), { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, esModuleInterop: true } }).outputText;
  const module = { exports: {} };
  new Function("require", "module", "exports", code)(id => Object.hasOwn(mocks, id) ? mocks[id] : require(id), module, module.exports);
  return module.exports;
}
const root = process.cwd();
const manifest = join(root, ".next/server/app/api/matters/[id]/pdf-preparations/route.js.nft.json");
const traced = new Set(JSON.parse(readFileSync(manifest, "utf8")).files.map(file => resolve(dirname(manifest), file)));
for (const file of ["runtime/pdfPreparationEngine.cjs", "runtime/pdfPreparationWorker.cjs", "node_modules/pdf-lib/package.json", "node_modules/pdf-lib/cjs/index.js"]) assert.ok(traced.has(join(root, file)), `Missing traced dependency: ${file}`);
const capsule = mkdtempSync(join(tmpdir(), "pdf-worker-package-"));
try {
  // The worker can resolve only the dependency files listed by the actual build,
  // from this isolated directory outside the application's node_modules tree.
  let copied = 0;
  for (const source of traced) {
    const name = relative(root, source);
    if (isAbsolute(name) || name.startsWith("..") || (!name.startsWith("runtime/") && !name.startsWith("node_modules/"))) continue;
    const destination = join(capsule, name); mkdirSync(dirname(destination), { recursive: true }); copyFileSync(source, destination); copied++;
  }
  const engine = load("lib/pdfPreparation.ts");
  const { createPdfPreparationRunner } = load("lib/pdfPreparationWorker.ts", { "@/lib/pdfPreparation": engine });
  const run = createPdfPreparationRunner({ filename: join(capsule, "runtime/pdfPreparationWorker.cjs"), timeoutMs: 15000, concurrency: 1 });
  const doc = await PDFDocument.create(); doc.addPage().drawText("Synthetic package smoke check");
  const id = "22222222-2222-4222-8222-222222222222";
  const result = await run({ operation: "SPLIT", documentIds: [id], firstPage: 1, lastPage: 1 }, [await doc.save()]);
  assert.equal(result.pageCount, 1); assert.equal((await PDFDocument.load(result.bytes)).getPageCount(), 1);
  console.log(`PASS isolated traced package executes PDF worker (${copied} traced dependency files). Hosted deployment remains unvalidated.`);
} finally { rmSync(capsule, { recursive: true, force: true }); }
