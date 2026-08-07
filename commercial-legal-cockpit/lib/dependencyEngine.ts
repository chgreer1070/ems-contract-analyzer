export const DEPENDENCY_PROMPT_VERSION = "term-dependency-2026-08-07.v1";

export type DependencyCandidate = {
  sourceTermId:string;
  targetTermId:string;
  dependencyType:"TRIGGERS"|"LIMITS"|"OVERRIDES"|"CONDITIONS"|"PRICES"|"ALLOCATES_RISK"|"REQUIRES"|"TERMINATES"|"CONFLICTS_WITH";
  rationale:string;
  confidence:number;
};

const dependencyTypes = ["TRIGGERS","LIMITS","OVERRIDES","CONDITIONS","PRICES","ALLOCATES_RISK","REQUIRES","TERMINATES","CONFLICTS_WITH"];
const schema = {type:"object",additionalProperties:false,required:["dependencies"],properties:{dependencies:{type:"array",items:{type:"object",additionalProperties:false,required:["sourceTermId","targetTermId","dependencyType","rationale","confidence"],properties:{sourceTermId:{type:"string"},targetTermId:{type:"string"},dependencyType:{type:"string",enum:dependencyTypes},rationale:{type:"string"},confidence:{type:"number",minimum:0,maximum:1}}}}}};

function outputText(payload:any):string|null { for (const item of payload?.output ?? []) for (const c of item?.content ?? []) if (c?.type==="output_text" && typeof c.text==="string") return c.text; return null; }

export async function inferDependencies(terms:Array<{id:string;clauseFamily:string;termType:string;normalizedStatement:string;triggerEvent:string|null}>){
  if (!process.env.OPENAI_API_KEY) throw new Error("OPENAI_API_KEY is required for dependency analysis.");
  const allowed = new Set(terms.map(t=>t.id));
  const input = terms.map(t=>({id:t.id,clauseFamily:t.clauseFamily,termType:t.termType,normalizedStatement:t.normalizedStatement,triggerEvent:t.triggerEvent??""}));
  const response = await fetch("https://api.openai.com/v1/responses",{method:"POST",headers:{Authorization:`Bearer ${process.env.OPENAI_API_KEY}`,"Content-Type":"application/json"},body:JSON.stringify({
    model:process.env.OPENAI_MODEL||"gpt-5.6",store:false,
    instructions:"Identify only material operational dependencies between the supplied contract-term objects. You may only use term IDs from the input. Do not add legal effects not stated in the normalized terms. Use CONFLICTS_WITH only for facial inconsistency and OVERRIDES only when the supplied term itself supports override/control. Every edge requires human review.",
    input:JSON.stringify(input),text:{format:{type:"json_schema",name:"term_dependencies",strict:true,schema}}
  })});
  if(!response.ok) throw new Error(`OpenAI dependency analysis failed: ${response.status}`);
  const text=outputText(await response.json()); if(!text) throw new Error("No dependency output returned.");
  const raw=(JSON.parse(text) as {dependencies?:DependencyCandidate[]}).dependencies??[];
  return raw.filter(d=>d.sourceTermId!==d.targetTermId&&allowed.has(d.sourceTermId)&&allowed.has(d.targetTermId)).map(d=>({...d,confidence:Math.max(0,Math.min(1,Number(d.confidence)||0))}));
}
