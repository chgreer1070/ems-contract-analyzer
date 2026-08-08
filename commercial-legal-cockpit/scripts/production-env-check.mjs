import { lstat, readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";

const requiredExactValues = new Map([
  ["APP_ENV", "production"],
  ["AUTH_REQUIRED", "true"],
  ["ALLOW_DEMO_ACCESS", "false"],
  ["LEGAL_RELIANCE_ENABLED", "true"],
  ["ALLOW_SOURCE_PURGE", "false"],
]);

const requiredNonEmptyValues = [
  "DATABASE_URL",
  "BETTER_AUTH_SECRET",
  "BETTER_AUTH_URL",
  "MICROSOFT_CLIENT_ID",
  "MICROSOFT_CLIENT_SECRET",
  "MICROSOFT_TENANT_ID",
  "BLOB_READ_WRITE_TOKEN",
  "CLAMAV_HOST",
  "OPENAI_API_KEY",
  "OPENAI_MODEL",
  "AZURE_DOCUMENT_INTELLIGENCE_ENDPOINT",
  "AZURE_DOCUMENT_INTELLIGENCE_KEY",
  "RELEASE_ATTESTATION_TOKEN",
  "VERCEL_AUTOMATION_BYPASS_SECRET",
];
const forbiddenDatabaseOverrides=["NODE_TLS_REJECT_UNAUTHORIZED","PGOPTIONS","PGSSLMODE"];

function decodeValue(rawValue) {
  const value = rawValue.trim();
  if (value.length < 2) return value;

  const quote = value[0];
  if ((quote !== '"' && quote !== "'") || value.at(-1) !== quote) {
    return value;
  }

  const inner = value.slice(1, -1);
  if (quote === "'") return inner;

  return inner.replace(/\\(n|r|t|"|\\)/g, (_match, escaped) => {
    if (escaped === "n") return "\n";
    if (escaped === "r") return "\r";
    if (escaped === "t") return "\t";
    return escaped;
  });
}

export function parseEnvironmentFile(source) {
  const variables = new Map();
  const malformedLines = [];

  for (const [index, rawLine] of source.replace(/^\uFEFF/, "").split(/\r?\n/u).entries()) {
    const line = rawLine.trim();
    if (!line || line.startsWith("#")) continue;

    const match = /^(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$/u.exec(line);
    if (!match) {
      malformedLines.push(index + 1);
      continue;
    }

    const [, name, rawValue] = match;
    if (variables.has(name)) {
      throw new Error(`Production environment contains duplicate key ${name}.`);
    }
    variables.set(name, decodeValue(rawValue));
  }

  if (malformedLines.length > 0) {
    throw new Error(`Production environment contains malformed entries on line(s): ${malformedLines.join(", ")}.`);
  }

  return variables;
}

async function main() {
  const [fileArgument, ...unexpectedArguments] = process.argv.slice(2);
  if (!fileArgument || unexpectedArguments.length > 0) {
    throw new Error("Usage: node scripts/production-env-check.mjs <pulled-production-env-file>");
  }

  const environmentPath = resolve(fileArgument);
  const fileMetadata = await lstat(environmentPath);
  if (!fileMetadata.isFile() || fileMetadata.isSymbolicLink()) {
    throw new Error("Production environment input must be a regular, non-symbolic-link file.");
  }

  const variables = parseEnvironmentFile(await readFile(environmentPath, "utf8"));
  const errors = [];

  if(variables.has("MIGRATION_DATABASE_URL")){
    errors.push("MIGRATION_DATABASE_URL must remain a protected CI-only secret and must not be present in Vercel");
  }
  if(variables.has("RUNTIME_DATABASE_URL")){
    errors.push("RUNTIME_DATABASE_URL is a gate-only alias and must not be present in Vercel");
  }
  for(const name of forbiddenDatabaseOverrides){
    if(variables.has(name))errors.push(`${name} must not override the controlled production database transport or search path`);
  }

  for (const [name, requiredValue] of requiredExactValues) {
    if (variables.get(name) !== requiredValue) {
      errors.push(`${name} must be exactly ${requiredValue}`);
    }
  }

  for (const name of requiredNonEmptyValues) {
    const value = variables.get(name);
    if (typeof value !== "string" || value.trim().length === 0) {
      errors.push(`${name} must be configured`);
    }
  }
  if((variables.get("RELEASE_ATTESTATION_TOKEN")||"").length<32){
    errors.push("RELEASE_ATTESTATION_TOKEN must contain at least 32 characters");
  }
  try{
    const databaseUrl=new URL(variables.get("DATABASE_URL")||"");
    if(!["postgres:","postgresql:"].includes(databaseUrl.protocol))errors.push("DATABASE_URL must use PostgreSQL");
    if(databaseUrl.searchParams.has("options"))errors.push("DATABASE_URL may not override the controlled database search path");
    const sslModes=databaseUrl.searchParams.getAll("sslmode").map(value=>value.toLowerCase());
    if(sslModes.length!==1||sslModes[0]!=="verify-full")errors.push("DATABASE_URL must require exactly one sslmode=verify-full");
  }catch{errors.push("DATABASE_URL must be a valid PostgreSQL URL");}

  if (errors.length > 0) {
    throw new Error(`Production environment gate failed:\n- ${errors.join("\n- ")}`);
  }

  console.log(
    `Production environment gate passed for ${requiredExactValues.size + requiredNonEmptyValues.length} required controls.`,
  );
}

if(process.argv[1]&&pathToFileURL(resolve(process.argv[1])).href===import.meta.url){
  main().catch((error) => {
    const message = error instanceof Error ? error.message : "Unknown production environment gate failure.";
    console.error(message);
    process.exitCode = 1;
  });
}
