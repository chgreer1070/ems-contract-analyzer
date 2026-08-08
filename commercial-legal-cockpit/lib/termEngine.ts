import { createHash } from "node:crypto";
import { sourceContainsExcerpt } from "@/lib/analysisEngine";

export { TERM_PROMPT_VERSION, TERM_SCHEMA_VERSION } from "@/lib/engineVersions";
import { TERM_PROMPT_VERSION, TERM_SCHEMA_VERSION } from "@/lib/engineVersions";

const clauseFamilies = [
  "forecasting_demand","purchase_orders","pricing_repricing","raw_materials","long_lead_ncnr","consigned_inventory",
  "title_risk_of_loss","safety_stock","excess_obsolete_inventory","engineering_changes","quality_acceptance_audits",
  "delivery_incoterms_logistics","payment_terms","warranty","indemnity","liability_cap","termination","force_majeure",
  "regulatory_change","sustainability","other"
];
const termTypes = ["OBLIGATION","RIGHT","PROHIBITION","CONDITION","REMEDY","DEFINITION","ALLOCATION"];

export type ExtractedTerm = {
  clauseFamily:string;
  sectionLabel:string;
  termType:string;
  party:string;
  counterparty:string;
  exactText:string;
  normalizedStatement:string;
  triggerEvent:string;
  exceptions:string[];
  operationalOwner:string;
  confidence:number;
};

const schema = {
  type:"object", additionalProperties:false, required:["terms"], properties:{
    terms:{ type:"array", items:{ type:"object", additionalProperties:false,
      required:["clauseFamily","sectionLabel","termType","party","counterparty","exactText","normalizedStatement","triggerEvent","exceptions","operationalOwner","confidence"],
      properties:{
        clauseFamily:{type:"string",enum:clauseFamilies}, sectionLabel:{type:"string"}, termType:{type:"string",enum:termTypes},
        party:{type:"string"}, counterparty:{type:"string"}, exactText:{type:"string"}, normalizedStatement:{type:"string"},
        triggerEvent:{type:"string"}, exceptions:{type:"array",items:{type:"string"}}, operationalOwner:{type:"string"},
        confidence:{type:"number",minimum:0,maximum:1}
      }
    }}
  }
};

function outputText(payload:any):string|null {
  for (const item of payload?.output ?? []) for (const content of item?.content ?? []) if (content?.type === "output_text" && typeof content.text === "string") return content.text;
  return null;
}

export async function extractTerms(source:string):Promise<{terms:ExtractedTerm[];modelName:string;rejectedUngrounded:number}> {
  if (!process.env.OPENAI_API_KEY) throw new Error("OPENAI_API_KEY is required for contract term extraction.");
  const modelName = process.env.OPENAI_MODEL || "gpt-5.6";
  const response = await fetch("https://api.openai.com/v1/responses", {
    method:"POST",
    headers:{Authorization:`Bearer ${process.env.OPENAI_API_KEY}`,"Content-Type":"application/json"},
    body:JSON.stringify({
      model:modelName, store:false,
      instructions:[
        "Extract atomic contract terms from an electronics manufacturing services agreement.",
        "Each term must be directly supported by the supplied source only. Never infer missing definitions, precedence, economics, company policy, or legal conclusions.",
        "exactText must be a verbatim contiguous excerpt from the supplied source. If a term cannot be supported by a verbatim excerpt, omit it.",
        "normalizedStatement should state the legal-operational effect neutrally. Keep separate terms for separate obligations, rights, conditions, remedies, definitions, and allocations.",
        "Use empty strings or empty arrays where the source does not identify a field. Confidence reflects extraction certainty, not legal enforceability."
      ].join(" "),
      input:source,
      text:{format:{type:"json_schema",name:"contract_terms",strict:true,schema}}
    })
  });
  if (!response.ok) throw new Error(`OpenAI term extraction failed: ${response.status}`);
  const text = outputText(await response.json());
  if (!text) throw new Error("No term extraction output returned.");
  const raw = (JSON.parse(text) as {terms?:ExtractedTerm[]}).terms ?? [];
  const terms = raw.filter(t => t.exactText.length >= 8 && sourceContainsExcerpt(source,t.exactText)).map(t => ({...t,confidence:Math.max(0,Math.min(1,Number(t.confidence)||0))}));
  return {terms,modelName,rejectedUngrounded:raw.length-terms.length};
}

export function exactTextHash(text:string) {
  return createHash("sha256").update(text,"utf8").digest("hex");
}
