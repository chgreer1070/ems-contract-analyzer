import { authenticationRequired, isMicrosoftConfigured } from "@/lib/auth";
import { databaseConfigured, query } from "@/lib/db";
import { azureOcrConfigured } from "@/lib/ocr";
import { PROMPT_VERSION } from "@/lib/analysisEngine";
import { getFrozenCorpus, MIN_FAMILY_RECALL, REQUIRED_GROUNDED_PRECISION, VALIDATION_GATE_VERSION } from "@/lib/validation";
import { REQUIRED_STANDARD_FAMILIES, standardGovernanceIssues, standardIsRelianceEligible, type GovernedStandard } from "@/lib/standards";
import { currentEngineManifest } from "@/lib/engineManifest";
import { canonicalStateHash } from "@/lib/stateHash";
import evidenceKernelPolicy from "@/lib/evidence-kernel-blockers.json";

export { REQUIRED_STANDARD_FAMILIES } from "@/lib/standards";

// These are implemented-capability blockers, not deployment configuration.
// Keep legal reliance fail-closed until each item is replaced by verifiable,
// release-bound evidence and its corresponding acceptance suite.
export const EVIDENCE_KERNEL_BLOCKERS: readonly string[] = Object.freeze([...evidenceKernelPolicy.blockers]);

type ValidationEvidence={
  id:string;status:string;model_name:string|null;prompt_version:string;corpus_version:string;
  total_cases:number;passed_cases:number;grounded_precision:number|string|null;family_recall:number|string|null;
  unsafe_policy_invention_count:number;exact_quote_failure_count:number;finished_at:string|Date|null;summary:unknown;
  result_manifest_verified?:boolean;
};
type EnginePolicyEvidence={id:string;scope_type:string;policy_version:string;model_name:string;prompt_version:string;schema_version:string;graph_version:string|null;economics_formula_version:string;approved_by:string;approved_at:string|Date};

function enginePoliciesMatch(policies:EnginePolicyEvidence[],manifest:ReturnType<typeof currentEngineManifest>){
  const expected=new Map([
    ["CLAUSE_RISK",{...manifest.clauseRisk,graphVersion:null}],
    ["TERM_EXTRACTION",{...manifest.termExtraction,graphVersion:null}],
    ["DEPENDENCY",{...manifest.dependency,graphVersion:manifest.agreementGraphVersion}],
    ["PRECEDENCE",{...manifest.precedence,graphVersion:manifest.agreementGraphVersion}]
  ]);
  return policies.length===expected.size&&policies.every(policy=>{const stage=expected.get(policy.scope_type);return Boolean(stage&&policy.model_name===manifest.modelName&&policy.prompt_version===stage.promptVersion&&policy.schema_version===stage.schemaVersion&&policy.graph_version===stage.graphVersion&&policy.economics_formula_version===manifest.economicsFormulaVersion);});
}

function summaryRecord(value:unknown):Record<string,unknown>{
  if(value&&typeof value==="object"&&!Array.isArray(value))return value as Record<string,unknown>;
  if(typeof value==="string")try{const parsed=JSON.parse(value);if(parsed&&typeof parsed==="object"&&!Array.isArray(parsed))return parsed;}catch{}
  return {};
}

function summaryNumberIs(summary:Record<string,unknown>,field:string,expected:number){
  const value=summary[field];
  return typeof value==="number"&&Number.isFinite(value)&&value===expected;
}

export function validationEvidencePasses(evidence:ValidationEvidence|null,expected:{model:string;promptVersion:string;corpusVersion:string;totalCases:number}){
  if(!evidence)return false;
  const summary=summaryRecord(evidence.summary);
  return evidence.status==="PASSED"&&Boolean(evidence.finished_at)&&
    evidence.model_name===expected.model&&evidence.prompt_version===expected.promptVersion&&evidence.corpus_version===expected.corpusVersion&&
    Number(evidence.total_cases)===expected.totalCases&&Number(evidence.passed_cases)===expected.totalCases&&
    summary.gateVersion===VALIDATION_GATE_VERSION&&summaryNumberIs(summary,"totalCases",expected.totalCases)&&
    summary.passed===true&&summaryNumberIs(summary,"passedCases",expected.totalCases)&&summaryNumberIs(summary,"failedCases",0)&&summary.allCasesPassed===true&&
    summaryNumberIs(summary,"missingCaseCount",0)&&summaryNumberIs(summary,"unexpectedCaseCount",0)&&summaryNumberIs(summary,"duplicateCaseCount",0)&&
    summaryNumberIs(summary,"rejectedUngroundedFindingCount",0)&&
    summaryNumberIs(summary,"resultCount",expected.totalCases)&&evidence.result_manifest_verified===true&&
    Number(evidence.family_recall)>=MIN_FAMILY_RECALL&&Number(evidence.grounded_precision)===REQUIRED_GROUNDED_PRECISION&&
    Number(evidence.unsafe_policy_invention_count)===0&&Number(evidence.exact_quote_failure_count)===0;
}

export async function getSystemReadiness(options:{includePersistentEvidence?:boolean}={}){
  const includePersistentEvidence=options.includePersistentEvidence===true;
  const configured={
    authenticationRequired:authenticationRequired(),
    microsoftConfigured:isMicrosoftConfigured(),
    databaseConfigured:databaseConfigured(),
    privateBlobConfigured:Boolean(process.env.BLOB_READ_WRITE_TOKEN),
    malwareScannerConfigured:Boolean(process.env.CLAMAV_HOST?.trim()),
    aiConfigured:Boolean(process.env.OPENAI_API_KEY),
    ocrConfigured:azureOcrConfigured(),
    legalRelianceEnabled:process.env.LEGAL_RELIANCE_ENABLED==="true"
  };

  let activeStandards:string[]=[];
  let activeStandardEvidence:GovernedStandard[]=[];
  let invalidActiveStandards:{clauseFamily:string|null;version:string|null;issues:string[]}[]=[];
  let latestValidation:ValidationEvidence|null=null;
  let activeEnginePolicies:EnginePolicyEvidence[]=[];
  if(includePersistentEvidence&&configured.databaseConfigured){
    const standards=await query<GovernedStandard>(`select clause_family,title,standard_position,fallback_position,no_go_position,approval_authority,business_rationale,provenance_source,approval_role,version,effective_date,created_by from negotiation_standards where active=true order by clause_family`);
    activeStandardEvidence=standards.rows.filter(standardIsRelianceEligible);
    activeStandards=[...new Set(activeStandardEvidence.map(r=>r.clause_family!))];
    invalidActiveStandards=standards.rows.filter(r=>!standardIsRelianceEligible(r)).map(r=>({clauseFamily:r.clause_family,version:r.version,issues:standardGovernanceIssues(r)}));
    const model=process.env.OPENAI_MODEL||"gpt-5.6";
    const corpusVersion=getFrozenCorpus().version;
    const validation=await query<ValidationEvidence>(`select id,status,model_name,prompt_version,corpus_version,total_cases,passed_cases,grounded_precision,family_recall,unsafe_policy_invention_count,exact_quote_failure_count,finished_at,summary from validation_runs where model_name=$1 and prompt_version=$2 and corpus_version=$3 order by started_at desc limit 1`,[model,PROMPT_VERSION,corpusVersion]);
    latestValidation=validation.rows[0]??null;
    if(latestValidation){
      const results=await query(`select validation_case_id,passed,detected_families,missing_families,prohibited_detected,grounded,notes,raw_result from validation_results where validation_run_id=$1 order by validation_case_id`,[latestValidation.id]);
      const summary=summaryRecord(latestValidation.summary);
      latestValidation.result_manifest_verified=results.rows.length===Number(latestValidation.total_cases)&&summary.resultCount===results.rows.length&&summary.resultManifestHash===canonicalStateHash(results.rows);
    }
    const policies=await query<EnginePolicyEvidence>(`select id,scope_type,policy_version,model_name,prompt_version,schema_version,graph_version,economics_formula_version,approved_by,approved_at from analysis_engine_policies where active=true order by scope_type`);
    activeEnginePolicies=policies.rows;
  }
  const missingStandards=REQUIRED_STANDARD_FAMILIES.filter(f=>!activeStandards.includes(f));
  const engineManifest=currentEngineManifest();
  const current={model:engineManifest.modelName,promptVersion:PROMPT_VERSION,corpusVersion:getFrozenCorpus().version,gateVersion:VALIDATION_GATE_VERSION,engineManifest};
  const validationPassed=validationEvidencePasses(latestValidation,{...current,totalCases:getFrozenCorpus().cases.length});
  const enginePoliciesReady=enginePoliciesMatch(activeEnginePolicies,engineManifest);
  const infrastructureReady=configured.authenticationRequired&&configured.microsoftConfigured&&configured.databaseConfigured&&configured.privateBlobConfigured&&configured.malwareScannerConfigured&&configured.aiConfigured&&configured.ocrConfigured;
  const standardsReady=missingStandards.length===0;
  const evidenceKernelReady=EVIDENCE_KERNEL_BLOCKERS.length===0;
  const legalRelianceReady=infrastructureReady&&validationPassed&&standardsReady&&enginePoliciesReady&&evidenceKernelReady;
  return {configured,infrastructureReady,evidenceKernelReady,evidenceKernelBlockers:[...EVIDENCE_KERNEL_BLOCKERS],legalRelianceReady,persistentEvidenceQueried:includePersistentEvidence&&configured.databaseConfigured,activeStandards,activeStandardEvidence,invalidActiveStandards,missingStandards,standardsReady,validationPassed,latestValidation,current,activeEnginePolicies,enginePoliciesReady,thresholds:{allCasesPass:true,missingCaseCount:0,unexpectedCaseCount:0,duplicateCaseCount:0,rejectedUngroundedFindingCount:0,familyRecall:MIN_FAMILY_RECALL,groundedPrecision:REQUIRED_GROUNDED_PRECISION,unsafePolicyInventionCount:0,exactQuoteFailureCount:0}};
}

export function legalRelianceEvidence(readiness:Awaited<ReturnType<typeof getSystemReadiness>>){
  const validation=readiness.latestValidation;
  return {
    legalRelianceEnabled:readiness.configured.legalRelianceEnabled,
    legalRelianceReady:readiness.legalRelianceReady,
    evidenceKernelReady:readiness.evidenceKernelReady,
    evidenceKernelBlockers:readiness.evidenceKernelBlockers,
    current:readiness.current,
    activeEnginePolicies:[...readiness.activeEnginePolicies].sort((a,b)=>a.scope_type.localeCompare(b.scope_type)),
    enginePoliciesReady:readiness.enginePoliciesReady,
    activeStandards:[...readiness.activeStandards].sort(),
    activeStandardEvidence:[...readiness.activeStandardEvidence].sort((a,b)=>`${a.clause_family}:${a.version}`.localeCompare(`${b.clause_family}:${b.version}`)),
    validation:validation?{
      id:validation.id,
      status:validation.status,
      modelName:validation.model_name,
      promptVersion:validation.prompt_version,
      corpusVersion:validation.corpus_version,
      totalCases:Number(validation.total_cases),
      passedCases:Number(validation.passed_cases),
      groundedPrecision:Number(validation.grounded_precision),
      familyRecall:Number(validation.family_recall),
      unsafePolicyInventionCount:Number(validation.unsafe_policy_invention_count),
      exactQuoteFailureCount:Number(validation.exact_quote_failure_count),
      finishedAt:validation.finished_at,
      summary:validation.summary
      ,resultManifestVerified:validation.result_manifest_verified===true
    }:null,
    thresholds:readiness.thresholds
  };
}

export async function assertLegalRelianceReady(options:{requireEnabled?:boolean}={}){
  if(process.env.LEGAL_RELIANCE_ENABLED!=="true"){
    if(options.requireEnabled)throw new Error("Frozen or governing legal state requires LEGAL_RELIANCE_ENABLED=true and a fully passing readiness gate.");
    return null;
  }
  const readiness=await getSystemReadiness({includePersistentEvidence:true});
  if(!readiness.legalRelianceReady){
    const blockers:string[]=[];
    if(!readiness.infrastructureReady)blockers.push("production infrastructure is incomplete");
    if(!readiness.validationPassed)blockers.push("current model/prompt/corpus validation has not passed");
    if(!readiness.enginePoliciesReady)blockers.push("the active database engine policies do not exactly match the application engine manifest");
    if(readiness.missingStandards.length)blockers.push(`${readiness.missingStandards.length} required negotiation standards lack a complete governed active version`);
    if(!readiness.evidenceKernelReady)blockers.push(`the production evidence kernel is incomplete (${readiness.evidenceKernelBlockers.join("; ")})`);
    throw new Error(`LEGAL_RELIANCE_ENABLED is blocked: ${blockers.join("; ")}.`);
  }
  return readiness;
}
