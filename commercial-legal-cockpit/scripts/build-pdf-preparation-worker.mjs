import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import ts from "typescript";

const source = readFileSync("lib/pdfPreparation.ts", "utf8");
const compiled = "// Generated from lib/pdfPreparation.ts. Run node scripts/build-pdf-preparation-worker.mjs.\n" +
  ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, esModuleInterop: true } }).outputText;
const destination = "runtime/pdfPreparationEngine.cjs";
if (process.argv.includes("--check")) {
  if (readFileSync(destination, "utf8") !== compiled) throw new Error("PDF worker engine is stale; regenerate it before review or build.");
  console.log("PDF worker engine matches its TypeScript source.");
} else {
  mkdirSync("runtime", { recursive: true });
  writeFileSync(destination, compiled);
  console.log("Generated PDF worker engine.");
}
