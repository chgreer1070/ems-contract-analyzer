import { sourceContainsExcerpt } from "@/lib/analysisEngine";

export { PRECEDENCE_PROMPT_VERSION, PRECEDENCE_SCHEMA_VERSION } from "@/lib/engineVersions";
import { PRECEDENCE_PROMPT_VERSION } from "@/lib/engineVersions";
export type PrecedenceRelation = {
  sourceDocumentId:string;
  targetDocumentId:string;
  relationType:"AMENDS"|"SUPERSEDES"|"INCORPORATES"|"CONTROLS"|"CONFLICTS_WITH"|"IMPLEMENTS"|"REFERENCES";
  sourceExcerpt:string;
  rationale:string;
  confidence:number;
};
const types=["AMENDS","SUPERSEDES","INCORPORATES","CONTROLS","CONFLICTS_WITH","IMPLEMENTS","REFERENCES"];
const schema={type:"object",additionalProperties:false,required:["relations"],properties:{relations:{type:"array",items:{type:"object",additionalProperties:false,required:["sourceDocumentId","targetDocumentId","relationType","sourceExcerpt","rationale","confidence"],properties:{sourceDocumentId:{type:"string"},targetDocumentId:{type:"string"},relationType:{type:"string",enum:types},sourceExcerpt:{type:"string"},rationale:{type:"string"},confidence:{type:"number",minimum:0,maximum:1}}}}}};
function outputText(payload:any):string|null{for(const item of payload?.output??[])for(const c of item?.content??[])if(c?.type==="output_text"&&typeof c.text==="string")return c.text;return null;}

export async function analyzePrecedence(documents:Array<{id:string;filename:string;documentType:string;text:string}>){
  if(!process.env.OPENAI_API_KEY) throw new Error("OPENAI_API_KEY is required for precedence analysis.");
  const byId=new Map(documents.map(d=>[d.id,d]));
  const input=documents.map(d=>({id:d.id,filename:d.filename,documentType:d.documentType,text:d.text}));
  const response=await fetch("https://api.openai.com/v1/responses",{method:"POST",headers:{Authorization:`Bearer ${process.env.OPENAI_API_KEY}`,"Content-Type":"application/json"},body:JSON.stringify({
    model:process.env.OPENAI_MODEL||"gpt-5.6",store:false,
    instructions:[
      "Analyze explicit relationships among the supplied agreement documents.",
      "Only create AMENDS, SUPERSEDES, INCORPORATES, CONTROLS, IMPLEMENTS, REFERENCES, or CONFLICTS_WITH relations when supported by supplied text.",
      "Never infer that an amendment controls merely because it is newer, or that a SOW controls an MSA merely because it is more specific.",
      "sourceExcerpt must be an exact contiguous quote from the sourceDocumentId text supporting the relation.",
      "Use only document IDs supplied in the input. Every relation is UNREVIEWED until validated by counsel."
    ].join(" "),input:JSON.stringify(input),text:{format:{type:"json_schema",name:"document_precedence",strict:true,schema}}
  })});
  if(!response.ok) throw new Error(`OpenAI precedence analysis failed: ${response.status}`);
  const text=outputText(await response.json());if(!text)throw new Error("No precedence output returned.");
  const raw=(JSON.parse(text) as {relations?:PrecedenceRelation[]}).relations??[];
  const valid=raw.filter(r=>{
    const source=byId.get(r.sourceDocumentId);const target=byId.get(r.targetDocumentId);
    return Boolean(source&&target&&source.id!==target.id&&r.sourceExcerpt.length>=8&&sourceContainsExcerpt(source.text,r.sourceExcerpt));
  }).map(r=>({...r,confidence:Math.max(0,Math.min(1,Number(r.confidence)||0))}));
  const seen=new Set<string>();const relations=valid.filter(r=>{const key=`${r.sourceDocumentId}|${r.targetDocumentId}|${r.relationType}`;if(seen.has(key))return false;seen.add(key);return true;});
  const invalidCount=raw.length-valid.length;const duplicateCount=valid.length-relations.length;
  return {relations,rawCount:raw.length,invalidCount,duplicateCount,rejectedCount:invalidCount+duplicateCount};
}
