import { createHash } from "node:crypto";

export function canonicalize(value:unknown):unknown{
  if(value===undefined)throw new TypeError("Canonical state cannot contain undefined values.");
  if(typeof value==="number"&&!Number.isFinite(value))throw new TypeError("Canonical state cannot contain non-finite numbers.");
  if(typeof value==="bigint"||typeof value==="function"||typeof value==="symbol")throw new TypeError(`Canonical state cannot contain ${typeof value} values.`);
  if(value instanceof Date){if(Number.isNaN(value.getTime()))throw new TypeError("Canonical state cannot contain an invalid date.");return value.toISOString();}
  if(Array.isArray(value))return value.map(canonicalize);
  if(value&&typeof value==="object"){
    const prototype=Object.getPrototypeOf(value);
    if(prototype!==Object.prototype&&prototype!==null)throw new TypeError("Canonical state can contain only plain objects, arrays, dates, and JSON primitives.");
    return Object.fromEntries(Object.entries(value as Record<string,unknown>).sort(([a],[b])=>a<b?-1:a>b?1:0).map(([key,item])=>[key,canonicalize(item)]));
  }
  return value;
}

export function canonicalStateJson(value:unknown){
  return JSON.stringify(canonicalize(value));
}

export function canonicalStateHash(value:unknown){
  return createHash("sha256").update(canonicalStateJson(value),"utf8").digest("hex");
}
