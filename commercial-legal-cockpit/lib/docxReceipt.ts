import { createHash } from "node:crypto";
import { canonicalStateHash } from "./stateHash";
import { DOCX_CHUNK_PREFIX, DOCX_EXTRACTOR_VERSION, projectDocxParagraph, readDocxProjection, type DocxEvidence } from "./docxEvidence";

export function sha256(value:Buffer|string){return createHash("sha256").update(value).digest("hex");}
export type DocxReceipt={docxEvidence:DocxEvidence;docxEvidenceSha256:string;chunkManifest:Array<{chunkIndex:number;sha256:string}>};
export function createDocxReceipt(evidence:DocxEvidence,chunks:Array<{chunkIndex:number;sha256:string}>):DocxReceipt{
  return {docxEvidence:evidence,docxEvidenceSha256:canonicalStateHash(evidence),chunkManifest:chunks.map(({chunkIndex,sha256})=>({chunkIndex,sha256}))};
}
export function assertDocxReceipt(receipt:unknown,sourceSha256:string,chunks:Array<{chunk_index:number;content:string;content_sha256:string}>){
  const value=receipt as Partial<DocxReceipt>|null;
  const evidence=value?.docxEvidence;
  if(!evidence||evidence.version!==1||evidence.extractorVersion!==DOCX_EXTRACTOR_VERSION||evidence.sourceSha256!==sourceSha256||!evidence.analysisEligible||evidence.legalEvidenceReady!==false||evidence.issues.some(issue=>issue.blocking)||value?.docxEvidenceSha256!==canonicalStateHash(evidence))throw new Error("DOCX extraction lacks a complete current evidence receipt; reprocess the preserved source.");
  if(!Array.isArray(value.chunkManifest)||!chunks.length||value.chunkManifest.length!==chunks.length)throw new Error("DOCX source chunk coverage does not match its extraction receipt.");
  const paragraphs=evidence.stories.filter(s=>s.kind!=="comments").flatMap(s=>s.paragraphs).filter(p=>p.runs.some(r=>r.text.length));
  if(paragraphs.length!==chunks.length)throw new Error("DOCX source paragraph coverage is incomplete.");
  for(let index=0;index<chunks.length;index++){
    const chunk=chunks[index],expected=value.chunkManifest[index],projection=readDocxProjection(chunk.content);
    const expectedText=DOCX_CHUNK_PREFIX+JSON.stringify(projectDocxParagraph(evidence,paragraphs[index]));
    if(!projection||projection.sourceSha256!==sourceSha256||expected.chunkIndex!==index||chunk.chunk_index!==index||expected.sha256!==chunk.content_sha256||sha256(chunk.content)!==expected.sha256||chunk.content!==expectedText)throw new Error("DOCX source chunk provenance does not match its extraction receipt.");
  }
}
