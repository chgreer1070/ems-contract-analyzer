import type { CoreFinding } from "@/lib/analysisEngine";
import { loadNegotiationPositions, type NegotiationPosition } from "@/lib/standards";

export type EnrichedFinding = CoreFinding & NegotiationPosition & { sourceLocator?: string | null; standardVersion: string | null };

export async function enrichFindings(findings: CoreFinding[], allowIllustrative: boolean): Promise<EnrichedFinding[]> {
  const positions = await loadNegotiationPositions(findings, allowIllustrative);
  return findings.map((finding,index)=>({...finding,...positions[index]}));
}
