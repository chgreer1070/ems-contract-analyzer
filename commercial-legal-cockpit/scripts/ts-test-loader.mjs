import fs from "node:fs";
import path from "node:path";
import { createRequire } from "node:module";
import ts from "typescript";

// Execute the actual TypeScript modules with explicit boundary doubles. Each
// loader owns its cache; one test's adapters cannot leak into another test.
export function createTypeScriptLoader(mocks={}){
  const require=createRequire(import.meta.url),cache=new Map();
  function load(relative){
    const filename=path.resolve(relative);
    if(cache.has(filename))return cache.get(filename).exports;
    const module={exports:{}};cache.set(filename,module);
    const code=ts.transpileModule(fs.readFileSync(filename,"utf8"),{compilerOptions:{module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2022,esModuleInterop:true},fileName:filename}).outputText;
    new Function("require","module","exports",code)(specifier=>{
      if(specifier in mocks)return mocks[specifier];
      if(specifier.startsWith("@/"))return load(`${specifier.slice(2)}.ts`);
      if(specifier.startsWith("."))return load(path.resolve(path.dirname(filename),`${specifier}.ts`));
      return require(specifier);
    },module,module.exports);return module.exports;
  }
  return load;
}
