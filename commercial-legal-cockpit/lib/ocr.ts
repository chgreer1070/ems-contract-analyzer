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
  return value;
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
  if (!operationLocation.startsWith(endpoint())) throw new Error("Azure OCR returned an unexpected operation host.");
  return operationLocation;
}

export async function pollAzureOcr(operationLocation: string): Promise<OcrPollResult> {
  if (!operationLocation.startsWith(endpoint())) throw new Error("Refusing to poll an untrusted OCR operation URL.");
  const response = await fetch(operationLocation, {
    headers: { "Ocp-Apim-Subscription-Key": apiKey() },
    cache: "no-store"
  });
  if (!response.ok) throw new Error(`Azure OCR polling failed (${response.status}).`);
  const payload = await response.json() as any;
  const status = String(payload?.status ?? "").toLowerCase();
  if (status === "running" || status === "notstarted") return { status: "running" };
  if (status !== "succeeded") {
    return { status: "failed", error: payload?.error?.message || `Azure OCR status: ${status || "unknown"}` };
  }

  const pages: any[] = payload?.analyzeResult?.pages ?? [];
  const chunks = pages.flatMap((page, pageIndex) => {
    const text = (page?.lines ?? []).map((line: any) => String(line?.content ?? "")).filter(Boolean).join("\n");
    return chunkText(text, { pageNumber: Number(page?.pageNumber) || pageIndex + 1 });
  });
  if (!chunks.length) return { status: "failed", error: "OCR completed but returned no readable text." };
  return { status: "succeeded", pageCount: pages.length, chunks };
}
