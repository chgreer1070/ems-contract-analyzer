import corpus from "@/validation/frozen-ems-regression.json";
import { analyzeContractText, sourceContainsExcerpt } from "@/lib/analysisEngine";

export const VALIDATION_GATE_VERSION = "legal-validation-gate-2026-08-07.v1";
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
  return {caseId:testCase.id,passed,detectedFamilies,missingFamilies,prohibitedDetected,grounded,mustFlagMissing,unsafeConclusions,findingCount:analysis.findings.length,rawResult:{mode:analysis.mode,modelName:analysis.modelName,rejectedUngroundedFindings:analysis.rejectedUngroundedFindings,findings:analysis.findings}};
}

export function getFrozenCorpus(){return corpus;}

export function summarizeValidation(results:CaseResult[]){
  const expectedCount=corpus.cases.reduce((s,c)=>s+c.expectedFamilies.length,0);
  const foundExpected=results.reduce((s,r)=>s+(corpus.cases.find(c=>c.id===r.caseId)?.expectedFamilies.length??0)-r.missingFamilies.length,0);
  const totalFindings=results.reduce((s,r)=>s+r.findingCount,0);
  const groundedFindings=results.reduce((s,r)=>s+(r.grounded?r.findingCount:0),0);
  const familyRecall=expectedCount?foundExpected/expectedCount:1;
  const groundedPrecision=totalFindings?groundedFindings/totalFindings:1;
  const unsafePolicyInventionCount=results.reduce((s,r)=>s+r.unsafeConclusions.length,0);
  const exactQuoteFailureCount=results.filter(r=>!r.grounded).length;
  const prohibitedFamilyCount=results.reduce((s,r)=>s+r.prohibitedDetected.length,0);
  const mustFlagMissCount=results.reduce((s,r)=>s+r.mustFlagMissing.length,0);
  const passed=familyRecall>=MIN_FAMILY_RECALL&&groundedPrecision===REQUIRED_GROUNDED_PRECISION&&unsafePolicyInventionCount===0&&exactQuoteFailureCount===0&&prohibitedFamilyCount===0&&mustFlagMissCount===0;
  return {passed,totalCases:results.length,passedCases:results.filter(r=>r.passed).length,familyRecall,groundedPrecision,unsafePolicyInventionCount,exactQuoteFailureCount,prohibitedFamilyCount,mustFlagMissCount,gateVersion:VALIDATION_GATE_VERSION};
}
