import corpus from "@/validation/frozen-ems-regression.json";
import { analyzeContractText, sourceContainsExcerpt } from "@/lib/analysisEngine";

export const VALIDATION_GATE_VERSION = "legal-validation-gate-2026-08-08.v2";
export const MIN_FAMILY_RECALL = 0.95;
export const REQUIRED_GROUNDED_PRECISION = 1;

export type ValidationCase = (typeof corpus.cases)[number];
export type CaseResult = {
  caseId:string;
  passed:boolean;
  detectedFamilies:string[];
  missingFamilies:string[];
  prohibitedDetected:string[];
  grounded:boolean;
  mustFlagMissing:string[];
  unsafeConclusions:string[];
  findingCount:number;
  rejectedUngroundedFindings:number;
  rawResult:unknown;
};

function norm(value:string){return value.toLowerCase().replace(/\s+/g," ").trim();}

export async function evaluateValidationCase(testCase:ValidationCase):Promise<CaseResult>{
  if(!process.env.OPENAI_API_KEY)throw new Error("OPENAI_API_KEY is required for production legal validation.");
  const analysis=await analyzeContractText(testCase.text);
  if(analysis.mode!=="ai")throw new Error(`Validation requires AI mode; received ${analysis.mode}.`);
  const detectedFamilies=[...new Set(analysis.findings.map(f=>f.clauseFamily))];
  const missingFamilies=testCase.expectedFamilies.filter(f=>!detectedFamilies.includes(f));
  const prohibitedDetected=testCase.prohibitedFamilies.filter(f=>detectedFamilies.includes(f));
  const grounded=analysis.findings.every(f=>sourceContainsExcerpt(testCase.text,f.sourceExcerpt));
  const analysisText=norm(analysis.findings.map(f=>[f.issue,f.rationale,f.operationalConsequence,f.uncertainty].join(" ")).join(" "));
  const mustFlagMissing=testCase.mustFlag.filter(term=>!analysisText.includes(norm(term)));
  const unsafeConclusions=testCase.mustNotConclude.filter(term=>analysisText.includes(norm(term)));
  const passed=missingFamilies.length===0&&prohibitedDetected.length===0&&grounded&&mustFlagMissing.length===0&&unsafeConclusions.length===0&&analysis.rejectedUngroundedFindings===0;
  return {caseId:testCase.id,passed,detectedFamilies,missingFamilies,prohibitedDetected,grounded,mustFlagMissing,unsafeConclusions,findingCount:analysis.findings.length,rejectedUngroundedFindings:analysis.rejectedUngroundedFindings,rawResult:{mode:analysis.mode,modelName:analysis.modelName,rejectedUngroundedFindings:analysis.rejectedUngroundedFindings,findings:analysis.findings}};
}

export function getFrozenCorpus(){return corpus;}

export function summarizeValidation(results:CaseResult[]){
  const totalCases=corpus.cases.length;
  const expectedIds=new Set(corpus.cases.map(c=>c.id));
  const resultByCaseId=new Map(results.filter(r=>expectedIds.has(r.caseId)).map(r=>[r.caseId,r]));
  const passedCases=corpus.cases.filter(c=>resultByCaseId.get(c.id)?.passed===true).length;
  const failedCases=totalCases-passedCases;
  const expectedCount=corpus.cases.reduce((s,c)=>s+c.expectedFamilies.length,0);
  const evaluatedResults=[...resultByCaseId.values()];
  const foundExpected=corpus.cases.reduce((s,c)=>s+c.expectedFamilies.length-(resultByCaseId.get(c.id)?.missingFamilies.length??c.expectedFamilies.length),0);
  const totalFindings=evaluatedResults.reduce((s,r)=>s+r.findingCount,0);
  const groundedFindings=evaluatedResults.reduce((s,r)=>s+(r.grounded?r.findingCount:0),0);
  const familyRecall=expectedCount?foundExpected/expectedCount:1;
  const groundedPrecision=totalFindings?groundedFindings/totalFindings:1;
  const unsafePolicyInventionCount=evaluatedResults.reduce((s,r)=>s+r.unsafeConclusions.length,0);
  const exactQuoteFailureCount=evaluatedResults.filter(r=>!r.grounded).length;
  const prohibitedFamilyCount=evaluatedResults.reduce((s,r)=>s+r.prohibitedDetected.length,0);
  const mustFlagMissCount=evaluatedResults.reduce((s,r)=>s+r.mustFlagMissing.length,0);
  const rejectedUngroundedFindingCount=evaluatedResults.reduce((s,r)=>s+r.rejectedUngroundedFindings,0);
  const missingCaseCount=corpus.cases.filter(c=>!resultByCaseId.has(c.id)).length;
  const unexpectedCaseCount=results.filter(r=>!expectedIds.has(r.caseId)).length;
  const duplicateCaseCount=results.length-new Set(results.map(r=>r.caseId)).size;
  const allCasesPassed=missingCaseCount===0&&unexpectedCaseCount===0&&duplicateCaseCount===0&&passedCases===totalCases;
  const passed=allCasesPassed&&rejectedUngroundedFindingCount===0&&familyRecall>=MIN_FAMILY_RECALL&&groundedPrecision===REQUIRED_GROUNDED_PRECISION&&unsafePolicyInventionCount===0&&exactQuoteFailureCount===0&&prohibitedFamilyCount===0&&mustFlagMissCount===0;
  return {passed,totalCases,passedCases,failedCases,allCasesPassed,missingCaseCount,unexpectedCaseCount,duplicateCaseCount,rejectedUngroundedFindingCount,familyRecall,groundedPrecision,unsafePolicyInventionCount,exactQuoteFailureCount,prohibitedFamilyCount,mustFlagMissCount,gateVersion:VALIDATION_GATE_VERSION};
}
