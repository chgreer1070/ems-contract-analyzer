import { authenticationRequired, isMicrosoftConfigured } from "@/lib/auth";
import { databaseConfigured, query } from "@/lib/db";
import { azureOcrConfigured } from "@/lib/ocr";
import { PROMPT_VERSION } from "@/lib/analysisEngine";
import { getFrozenCorpus, MIN_FAMILY_RECALL, REQUIRED_GROUNDED_PRECISION } from "@/lib/validation";

export const REQUIRED_STANDARD_FAMILIES = [
  "forecasting_demand","purchase_orders","pricing_repricing","raw_materials","long_lead_ncnr","consigned_inventory",
  "title_risk_of_loss","safety_stock","excess_obsolete_inventory","engineering_changes","quality_acceptance_audits",
  "delivery_incoterms_logistics","payment_terms","warranty","indemnity","liability_cap","termination","force_majeure",
  "regulatory_change","sustainability"
] as const;

export async function getSystemReadiness(){
  const configured={
    authenticationRequired:authenticationRequired(),
    microsoftConfigured:isMicrosoftConfigured(),
    databaseConfigured:databaseConfigured(),
    privateBlobConfigured:Boolean(process.env.BLOB_READ_WRITE_TOKEN),
    aiConfigured:Boolean(process.env.OPENAI_API_KEY),
    ocrConfigured:azureOcrConfigured(),
    legalRelianceEnabled:process.env.LEGAL_RELIANCE_ENABLED==="true"
  };

  let activeStandards:string[]=[];
  let latestValidation:any=null;
  if(configured.databaseConfigured){
    const standards=await query<{clause_family:string}>("select clause_family from negotiation_standards where active=true order by clause_family");
    activeStandards=standards.rows.map(r=>r.clause_family);
    const model=process.env.OPENAI_MODEL||"gpt-5.6";
    const corpusVersion=getFrozenCorpus().version;
    const validation=await query<any>(`select id,status,model_name,prompt_version,corpus_version,total_cases,passed_cases,grounded_precision,family_recall,unsafe_policy_invention_count,exact_quote_failure_count,finished_at,summary from validation_runs where model_name=$1 and prompt_version=$2 and corpus_version=$3 order by started_at desc limit 1`,[model,PROMPT_VERSION,corpusVersion]);
    latestValidation=validation.rows[0]??null;
  }
  const missingStandards=REQUIRED_STANDARD_FAMILIES.filter(f=>!activeStandards.includes(f));
  const validationPassed=Boolean(latestValidation&&latestValidation.status==="PASSED"&&Number(latestValidation.family_recall)>=MIN_FAMILY_RECALL&&Number(latestValidation.grounded_precision)===REQUIRED_GROUNDED_PRECISION&&Number(latestValidation.unsafe_policy_invention_count)===0&&Number(latestValidation.exact_quote_failure_count)===0);
  const infrastructureReady=configured.authenticationRequired&&configured.microsoftConfigured&&configured.databaseConfigured&&configured.privateBlobConfigured&&configured.aiConfigured&&configured.ocrConfigured;
  const legalRelianceReady=infrastructureReady&&validationPassed&&missingStandards.length===0;
  return {configured,infrastructureReady,legalRelianceReady,activeStandards,missingStandards,validationPassed,latestValidation,current:{model:process.env.OPENAI_MODEL||"gpt-5.6",promptVersion:PROMPT_VERSION,corpusVersion:getFrozenCorpus().version},thresholds:{familyRecall:MIN_FAMILY_RECALL,groundedPrecision:REQUIRED_GROUNDED_PRECISION,unsafePolicyInventionCount:0,exactQuoteFailureCount:0}};
}

export async function assertLegalRelianceReady(){
  if(process.env.LEGAL_RELIANCE_ENABLED!=="true")return;
  const readiness=await getSystemReadiness();
  if(!readiness.legalRelianceReady){
    const blockers:string[]=[];
    if(!readiness.infrastructureReady)blockers.push("production infrastructure is incomplete");
    if(!readiness.validationPassed)blockers.push("current model/prompt/corpus validation has not passed");
    if(readiness.missingStandards.length)blockers.push(`${readiness.missingStandards.length} required negotiation standards are not active`);
    throw new Error(`LEGAL_RELIANCE_ENABLED is blocked: ${blockers.join("; ")}.`);
  }
}
