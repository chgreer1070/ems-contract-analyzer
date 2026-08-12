import { chunkText, type SourceChunk } from "@/lib/chunking";

const API_VERSION = "2024-11-30";
const MODEL_ID = "prebuilt-layout";

export type OcrPollResult =
  | { status: "running" }
  | { status: "failed"; error: string }
  | { status: "succeeded"; pageCount: number; chunks: SourceChunk[] };

export function azureOcrConfigured() {
  return Boolean(process.env.AZURE_DOCUMENT_INTELLIGENCE_ENDPOINT && process.env.AZURE_DOCUMENT_INTELLIGENCE_KEY);
}

function endpoint() {
  const value = process.env.AZURE_DOCUMENT_INTELLIGENCE_ENDPOINT?.replace(/\/$/, "");
  if (!value) throw new Error("AZURE_DOCUMENT_INTELLIGENCE_ENDPOINT is not configured.");
  let parsed: URL;
  try { parsed = new URL(value); } catch { throw new Error("AZURE_DOCUMENT_INTELLIGENCE_ENDPOINT must be a valid HTTPS URL."); }
  if (parsed.protocol !== "https:" || parsed.username || parsed.password || parsed.search || parsed.hash) throw new Error("AZURE_DOCUMENT_INTELLIGENCE_ENDPOINT must be a credential-free HTTPS origin or base path.");
  return parsed.toString().replace(/\/$/, "");
}

export function trustedOcrOperationUrl(operationLocation:string){
  let configured:URL;let candidate:URL;
  try{configured=new URL(endpoint());candidate=new URL(operationLocation);}catch{throw new Error("Azure OCR returned an invalid operation URL.");}
  const basePath=configured.pathname.replace(/\/$/,"");
  const prefix=`${basePath}/documentintelligence/documentModels/${MODEL_ID}/analyzeResults/`;
  const resultId=candidate.pathname.startsWith(prefix)?candidate.pathname.slice(prefix.length):"";
  if(candidate.protocol!=="https:"||candidate.origin!==configured.origin||candidate.username||candidate.password||candidate.hash||!resultId||resultId.includes("/")||!/^[A-Za-z0-9-]+$/.test(resultId))throw new Error("Azure OCR returned an unexpected operation URL.");
  if(candidate.searchParams.get("api-version")!==API_VERSION)throw new Error("Azure OCR operation URL uses an unexpected API version.");
  return candidate.toString();
}

function apiKey() {
  const value = process.env.AZURE_DOCUMENT_INTELLIGENCE_KEY;
  if (!value) throw new Error("AZURE_DOCUMENT_INTELLIGENCE_KEY is not configured.");
  return value;
}

export async function submitAzureOcr(bytes: ArrayBuffer): Promise<string> {
  if (!azureOcrConfigured()) throw new Error("Azure Document Intelligence OCR is not configured.");
  const url = `${endpoint()}/documentintelligence/documentModels/${MODEL_ID}:analyze?_overload=analyzeDocument&api-version=${API_VERSION}`;
  const response = await fetch(url, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "Ocp-Apim-Subscription-Key": apiKey()
    },
    body: JSON.stringify({ base64Source: Buffer.from(bytes).toString("base64") })
  });
  if (response.status !== 202) {
    const body = await response.text();
    throw new Error(`Azure OCR submission failed (${response.status}): ${body.slice(0, 500)}`);
  }
  const operationLocation = response.headers.get("operation-location");
  if (!operationLocation) throw new Error("Azure OCR did not return Operation-Location.");
  return trustedOcrOperationUrl(operationLocation);
}

export async function pollAzureOcr(operationLocation: string): Promise<OcrPollResult> {
  const trustedLocation=trustedOcrOperationUrl(operationLocation);
  const response = await fetch(trustedLocation, {
    headers: { "Ocp-Apim-Subscription-Key": apiKey() },
    cache: "no-store"
  });
  if (!response.ok) throw new Error(`Azure OCR polling failed (${response.status}).`);
  const payload = await response.json() as any;
  const status = String(payload?.status ?? "").toLowerCase();
  if (status === "running" || status === "notstarted") return { status: "running" };
  if (status !== "succeeded") {
    return { status: "failed", error: "Azure OCR reported a failed operation." };
  }

  const pages: any[] = payload?.analyzeResult?.pages ?? [];
  const chunks = pages.flatMap((page, pageIndex) => {
    const text = (page?.lines ?? []).map((line: any) => String(line?.content ?? "")).filter(Boolean).join("\n");
    return chunkText(text, { pageNumber: Number(page?.pageNumber) || pageIndex + 1 });
  });
  if (!chunks.length) return { status: "failed", error: "OCR completed but returned no readable text." };
  return { status: "succeeded", pageCount: pages.length, chunks };
}
