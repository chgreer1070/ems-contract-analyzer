import { getFrozenCorpus, evaluateValidationCase, summarizeValidation, VALIDATION_GATE_VERSION, type CaseResult, type ValidationCase } from "@/lib/validation";
import { PROMPT_VERSION } from "@/lib/analysisEngine";
import { query } from "@/lib/db";
import { canonicalStateHash } from "@/lib/stateHash";
import { safeOperationalFailure } from "@/lib/safeErrors";

async function resultManifest(runId:string){
  const results=await query(`select validation_case_id,passed,detected_families,missing_families,prohibited_detected,grounded,notes,raw_result from validation_results where validation_run_id=$1 order by validation_case_id`,[runId]);
  return {resultCount:results.rows.length,resultManifestHash:canonicalStateHash(results.rows)};
}

async function initializeRun(startedBy:string,modelName:string){
  "use step";
  const corpus=getFrozenCorpus();
  for(const c of corpus.cases){
    await query(`insert into validation_cases(id,category,title,source_text,expected_families,prohibited_families,active) values($1,$2,$3,$4,$5::jsonb,$6::jsonb,true) on conflict(id) do update set category=excluded.category,title=excluded.title,source_text=excluded.source_text,expected_families=excluded.expected_families,prohibited_families=excluded.prohibited_families,active=true`,[c.id,c.category,c.title,c.text,JSON.stringify(c.expectedFamilies),JSON.stringify(c.prohibitedFamilies)]);
  }
  const run=await query<{id:string}>(`insert into validation_runs(run_label,model_name,prompt_version,corpus_version,status,total_cases,started_by,summary) values($1,$2,$3,$4,'RUNNING',$5,$6,$7::jsonb) returning id`,[`Production legal validation ${new Date().toISOString()}`,modelName,PROMPT_VERSION,corpus.version,corpus.cases.length,startedBy,JSON.stringify({gateVersion:VALIDATION_GATE_VERSION})]);
  return {runId:run.rows[0].id,cases:corpus.cases};
}

async function evaluateCaseStep(runId:string,testCase:ValidationCase){
  "use step";
  const result=await evaluateValidationCase(testCase);
  await query(`insert into validation_results(validation_run_id,validation_case_id,passed,detected_families,missing_families,prohibited_detected,grounded,notes,raw_result) values($1,$2,$3,$4::jsonb,$5::jsonb,$6::jsonb,$7,$8,$9::jsonb) on conflict(validation_run_id,validation_case_id) do update set passed=excluded.passed,detected_families=excluded.detected_families,missing_families=excluded.missing_families,prohibited_detected=excluded.prohibited_detected,grounded=excluded.grounded,notes=excluded.notes,raw_result=excluded.raw_result`,[runId,testCase.id,result.passed,JSON.stringify(result.detectedFamilies),JSON.stringify(result.missingFamilies),JSON.stringify(result.prohibitedDetected),result.grounded,JSON.stringify({mustFlagMissing:result.mustFlagMissing,unsafeConclusions:result.unsafeConclusions}),JSON.stringify(result.rawResult)]);
  return result;
}

async function finalizeRun(runId:string,results:CaseResult[]){
  "use step";
  const summary={...summarizeValidation(results),...await resultManifest(runId)};
  await query(`update validation_runs set status=$2,passed_cases=$3,grounded_precision=$4,family_recall=$5,unsafe_policy_invention_count=$6,exact_quote_failure_count=$7,finished_at=now(),summary=$8::jsonb where id=$1`,[runId,summary.passed?"PASSED":"FAILED",summary.passedCases,summary.groundedPrecision,summary.familyRecall,summary.unsafePolicyInventionCount,summary.exactQuoteFailureCount,JSON.stringify(summary)]);
  return summary;
}

async function finalizeFailedRun(runId:string,results:CaseResult[],failureMessage:string){
  "use step";
  const summary={...summarizeValidation(results),...await resultManifest(runId),passed:false,workflowFailure:failureMessage.slice(0,500)};
  await query(`update validation_runs set status='FAILED',passed_cases=$2,grounded_precision=$3,family_recall=$4,unsafe_policy_invention_count=$5,exact_quote_failure_count=$6,finished_at=now(),summary=$7::jsonb where id=$1`,[runId,summary.passedCases,summary.groundedPrecision,summary.familyRecall,summary.unsafePolicyInventionCount,summary.exactQuoteFailureCount,JSON.stringify(summary)]);
  return summary;
}

export async function legalValidationWorkflow(startedBy:string){
  "use workflow";
  const modelName=process.env.OPENAI_MODEL||"gpt-5.6";
  const initialized=await initializeRun(startedBy,modelName);
  const results:CaseResult[]=[];
  try{
    for(const testCase of initialized.cases)results.push(await evaluateCaseStep(initialized.runId,testCase));
    const summary=await finalizeRun(initialized.runId,results);
    return {runId:initialized.runId,modelName,promptVersion:PROMPT_VERSION,corpusVersion:getFrozenCorpus().version,gateVersion:VALIDATION_GATE_VERSION,summary};
  }catch(error){
    const failure=safeOperationalFailure(error,"The validation workflow failed because an internal or provider dependency was unavailable.");
    await finalizeFailedRun(initialized.runId,results,failure.message);
    throw new Error(failure.message);
  }
}
