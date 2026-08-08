import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import ts from "typescript";

const repo=process.cwd();

function loadTypeScriptModule(relativePath,mocks){
  const filename=path.join(repo,relativePath);
  const source=fs.readFileSync(filename,"utf8");
  const output=ts.transpileModule(source,{compilerOptions:{module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2022,esModuleInterop:true,resolveJsonModule:true},fileName:filename}).outputText;
  const module={exports:{}};
  const localRequire=(id)=>{
    if(Object.hasOwn(mocks,id))return mocks[id];
    if(id==="@/lib/safeErrors")return {
      internalErrorResponse:(_error,message="The request could not be completed.",status=500)=>Response.json({ok:false,error:message,correlationId:"00000000-0000-4000-8000-000000000000"},{status}),
      safeErrorCode:()=>"UNCLASSIFIED",
      safeOperationalFailure:(_error,message)=>({correlationId:"00000000-0000-4000-8000-000000000000",message:`${message} Reference: 00000000-0000-4000-8000-000000000000.`}),
      safePersistedFailureForDisplay:(_value,message="Processing failed.")=>message
    };
    throw new Error(`Unexpected import ${id} while loading ${relativePath}`);
  };
  new Function("require","module","exports",output)(localRequire,module,module.exports);
  return module.exports;
}

const corpus=JSON.parse(fs.readFileSync(path.join(repo,"validation/frozen-ems-regression.json"),"utf8"));
const validation=loadTypeScriptModule("lib/validation.ts",{
  "@/validation/frozen-ems-regression.json":corpus,
  "@/lib/analysisEngine":{analyzeContractText:async()=>{throw new Error("not used");},sourceContainsExcerpt:()=>true}
});

const passingResults=corpus.cases.map((testCase)=>({
  caseId:testCase.id,passed:true,detectedFamilies:[...testCase.expectedFamilies],missingFamilies:[],prohibitedDetected:[],grounded:true,
  mustFlagMissing:[],unsafeConclusions:[],findingCount:testCase.expectedFamilies.length,rejectedUngroundedFindings:0,rawResult:{}
}));
assert.equal(validation.summarizeValidation(passingResults).passed,true,"all current cases should pass");

const failedCase=structuredClone(passingResults);failedCase[0].passed=false;
const failedSummary=validation.summarizeValidation(failedCase);
assert.equal(failedSummary.passed,false,"one failed case must fail the gate");
assert.equal(failedSummary.failedCases,1);

const rejectedFinding=structuredClone(passingResults);rejectedFinding[0].rejectedUngroundedFindings=1;
const rejectedSummary=validation.summarizeValidation(rejectedFinding);
assert.equal(rejectedSummary.passed,false,"one rejected ungrounded finding must fail the gate");
assert.equal(rejectedSummary.rejectedUngroundedFindingCount,1);

const incompleteSummary=validation.summarizeValidation(passingResults.slice(1));
assert.equal(incompleteSummary.passed,false,"missing validation cases must fail closed");
assert.equal(incompleteSummary.missingCaseCount,1);

let standardsQueryCount=0;
const standards=loadTypeScriptModule("lib/standards.ts",{
  "@/lib/db":{databaseConfigured:()=>true,query:async()=>{standardsQueryCount+=1;return {rows:[]};}}
});
const governedStandard={
  clause_family:"payment_terms",title:"Payment terms",standard_position:"Primary",fallback_position:"Fallback",no_go_position:"No-go",
  approval_authority:"Finance and Legal",business_rationale:"Working-capital policy",provenance_source:"POLICY-2026-04",
  approval_role:"APPROVER",version:"1.0",effective_date:"2020-01-01",created_by:"user-123"
};
assert.deepEqual(standards.standardGovernanceIssues(governedStandard),[],"complete governed standard should be eligible");
assert.equal(standards.standardIsRelianceEligible({...governedStandard,provenance_source:"DEMO"}),false,"DEMO provenance must be excluded");
assert.equal(standards.standardIsRelianceEligible({...governedStandard,provenance_source:"POLICY-DEMO"}),false,"embedded DEMO provenance markers must be excluded");
assert.equal(standards.standardIsRelianceEligible({...governedStandard,fallback_position:""}),false,"incomplete standards must be excluded");
assert.equal(standards.standardIsRelianceEligible({...governedStandard,approval_role:"LAWYER"}),false,"approval role must be governed");
assert.equal(standards.standardIsRelianceEligible({...governedStandard,effective_date:"2020-02-31"}),false,"invalid effective dates must fail closed");
const demoPositions=await standards.loadNegotiationPositions([{clauseFamily:"payment_terms",issue:"demo"}],true);
assert.equal(standardsQueryCount,0,"demo enrichment must not query the persistent registry");
assert.equal(demoPositions[0].standardStatus,"ILLUSTRATIVE");

let standardApiQueries=0;
const standardsRoute=loadTypeScriptModule("app/api/standards/route.ts",{
  "@/lib/access":{
    getPrincipal:async()=>({userId:"demo-user",name:"Demo",role:"ADMIN",demo:true}),
    requireRole:async()=>({userId:"admin-1",name:"Admin",role:"ADMIN",demo:false}),accessErrorResponse:()=>null
  },
  "@/lib/db":{databaseConfigured:()=>true,query:async()=>{standardApiQueries+=1;return {rows:[{id:"standard-1"}]};},withTransaction:async(fn)=>fn({query:async(text)=>{standardApiQueries+=1;return /insert into negotiation_standards/i.test(text)?{rows:[{id:"standard-1"}]}:{rows:[]};}})},
  "@/lib/standards":{standardGovernanceIssues:standards.standardGovernanceIssues,standardIsRelianceEligible:standards.standardIsRelianceEligible}
});
const demoStandardsResponse=await standardsRoute.GET(new Request("http://localhost/api/standards"));
assert.equal(demoStandardsResponse.status,200);
assert.equal(standardApiQueries,0,"demo standards listing must not query the registry");
const incompleteStandardResponse=await standardsRoute.POST(new Request("http://localhost/api/standards",{method:"POST",headers:{"content-type":"application/json"},body:JSON.stringify({clauseFamily:"payment_terms",title:"Title",standardPosition:"Primary",fallbackPosition:"Fallback",noGoPosition:"No-go",approvalAuthority:"Finance",businessRationale:"Rationale",version:"1",effectiveDate:"2020-01-01"})}));
assert.equal(incompleteStandardResponse.status,400,"missing provenance and approval role must reject creation");
assert.equal(standardApiQueries,0);
const completeStandardResponse=await standardsRoute.POST(new Request("http://localhost/api/standards",{method:"POST",headers:{"content-type":"application/json"},body:JSON.stringify({clauseFamily:"payment_terms",title:"Title",standardPosition:"Primary",fallbackPosition:"Fallback",noGoPosition:"No-go",approvalAuthority:"Finance",businessRationale:"Rationale",provenanceSource:"POLICY-1",approvalRole:"ADMIN",version:"1",effectiveDate:"2020-01-01"})}));
assert.equal(completeStandardResponse.status,201,"complete governed standard should remain creatable");
assert.equal(standardApiQueries,2,"standard creation and its immutable audit event must share the transaction");
const completeStandardBody=await completeStandardResponse.json();
assert.equal(completeStandardBody.provenanceSource,"POLICY-1");
assert.equal(completeStandardBody.approvalRole,"ADMIN");

const activationSql=[];
const invalidActivationRoute=loadTypeScriptModule("app/api/standards/[id]/activate/route.ts",{
  "@/lib/access":{requireRole:async()=>({userId:"admin-1",role:"ADMIN",demo:false}),accessErrorResponse:()=>null},
  "@/lib/audit":{writeAuditEvent:async()=>{}},
  "@/lib/db":{databaseConfigured:()=>true,withTransaction:async(fn)=>fn({query:async(text)=>{activationSql.push(text);return {rows:[{...governedStandard,fallback_position:""}]};}})},
  "@/lib/standards":{standardGovernanceIssues:standards.standardGovernanceIssues}
});
const invalidActivationResponse=await invalidActivationRoute.PATCH(new Request("http://localhost/api/standards/standard-1/activate",{method:"PATCH",headers:{"content-type":"application/json"},body:JSON.stringify({confirm:true})}),{params:Promise.resolve({id:"standard-1"})});
assert.equal(invalidActivationResponse.status,409,"incomplete stored standards must not activate");
assert.equal(activationSql.length,1,"activation must stop before mutating sibling or target rows");

const engineManifest={modelName:"model-current",clauseRisk:{promptVersion:"clause-prompt",schemaVersion:"clause-schema"},termExtraction:{promptVersion:"term-prompt",schemaVersion:"term-schema"},dependency:{promptVersion:"dependency-prompt",schemaVersion:"dependency-schema"},precedence:{promptVersion:"precedence-prompt",schemaVersion:"precedence-schema"},agreementGraphVersion:"graph-v1",economicsFormulaVersion:"economics-v1",pipelineVersion:"pipeline-v1"};
const readiness=loadTypeScriptModule("lib/readiness.ts",{
  "@/lib/auth":{authenticationRequired:()=>true,isMicrosoftConfigured:()=>true},
  "@/lib/db":{databaseConfigured:()=>true,query:async()=>({rows:[]})},
  "@/lib/ocr":{azureOcrConfigured:()=>true},
  "@/lib/analysisEngine":{PROMPT_VERSION:"prompt-current"},
  "@/lib/engineManifest":{currentEngineManifest:()=>engineManifest},
  "@/lib/stateHash":{canonicalStateHash:()=>"manifest-hash"},
  "@/lib/validation":{getFrozenCorpus:()=>corpus,MIN_FAMILY_RECALL:0.95,REQUIRED_GROUNDED_PRECISION:1,VALIDATION_GATE_VERSION:validation.VALIDATION_GATE_VERSION},
  "@/lib/standards":{REQUIRED_STANDARD_FAMILIES:standards.REQUIRED_STANDARD_FAMILIES,standardGovernanceIssues:standards.standardGovernanceIssues,standardIsRelianceEligible:standards.standardIsRelianceEligible}
});
const current={model:"model-current",promptVersion:"prompt-current",corpusVersion:corpus.version,totalCases:corpus.cases.length};
const passingEvidence={
  id:"run",status:"PASSED",model_name:current.model,prompt_version:current.promptVersion,corpus_version:current.corpusVersion,
  total_cases:current.totalCases,passed_cases:current.totalCases,grounded_precision:1,family_recall:1,
  unsafe_policy_invention_count:0,exact_quote_failure_count:0,finished_at:new Date().toISOString(),result_manifest_verified:true,
  summary:{passed:true,gateVersion:validation.VALIDATION_GATE_VERSION,totalCases:current.totalCases,passedCases:current.totalCases,failedCases:0,allCasesPassed:true,missingCaseCount:0,unexpectedCaseCount:0,duplicateCaseCount:0,rejectedUngroundedFindingCount:0,resultCount:current.totalCases,resultManifestHash:"manifest-hash"}
};
assert.equal(readiness.validationEvidencePasses(passingEvidence,current),true,"complete current evidence should pass");
assert.equal(readiness.validationEvidencePasses({...passingEvidence,summary:{...passingEvidence.summary,rejectedUngroundedFindingCount:1}},current),false,"rejected findings must invalidate readiness");
assert.equal(readiness.validationEvidencePasses({...passingEvidence,summary:{...passingEvidence.summary,rejectedUngroundedFindingCount:null}},current),false,"malformed summary counts must fail closed");
assert.equal(readiness.validationEvidencePasses({...passingEvidence,summary:{...passingEvidence.summary,gateVersion:"old-gate"}},current),false,"stale gate evidence must not satisfy readiness");
assert.equal(readiness.validationEvidencePasses({...passingEvidence,passed_cases:current.totalCases-1},current),false,"every persisted case must pass");

const savedEnvironment={BLOB_READ_WRITE_TOKEN:process.env.BLOB_READ_WRITE_TOKEN,CLAMAV_HOST:process.env.CLAMAV_HOST,OPENAI_API_KEY:process.env.OPENAI_API_KEY,OPENAI_MODEL:process.env.OPENAI_MODEL,LEGAL_RELIANCE_ENABLED:process.env.LEGAL_RELIANCE_ENABLED};
try{
  Object.assign(process.env,{BLOB_READ_WRITE_TOKEN:"test-blob",CLAMAV_HOST:"scanner.internal",OPENAI_API_KEY:"test-key",OPENAI_MODEL:current.model,LEGAL_RELIANCE_ENABLED:"true"});
  const governedRows=standards.REQUIRED_STANDARD_FAMILIES.map((clauseFamily,index)=>({...governedStandard,clause_family:clauseFamily,version:`1.${index}`,provenance_source:`POLICY-${index}`}));
  const policyRows=[["CLAUSE_RISK",engineManifest.clauseRisk,null],["TERM_EXTRACTION",engineManifest.termExtraction,null],["DEPENDENCY",engineManifest.dependency,engineManifest.agreementGraphVersion],["PRECEDENCE",engineManifest.precedence,engineManifest.agreementGraphVersion]].map(([scope,stage,graphVersion],index)=>({id:`policy-${index}`,scope_type:scope,policy_version:"policy-v1",model_name:engineManifest.modelName,prompt_version:stage.promptVersion,schema_version:stage.schemaVersion,graph_version:graphVersion,economics_formula_version:engineManifest.economicsFormulaVersion,approved_by:"admin",approved_at:new Date().toISOString()}));
  let readinessQueryCount=0;
  const readinessWithEvidence=loadTypeScriptModule("lib/readiness.ts",{
    "@/lib/auth":{authenticationRequired:()=>true,isMicrosoftConfigured:()=>true},
    "@/lib/db":{databaseConfigured:()=>true,query:async(text)=>{readinessQueryCount+=1;if(/negotiation_standards/i.test(text))return {rows:governedRows};if(/validation_results/i.test(text))return {rows:Array.from({length:current.totalCases},(_,index)=>({validation_case_id:`case-${index}`}))};if(/analysis_engine_policies/i.test(text))return {rows:policyRows};return {rows:[passingEvidence]};}},
    "@/lib/ocr":{azureOcrConfigured:()=>true},
    "@/lib/analysisEngine":{PROMPT_VERSION:current.promptVersion},
    "@/lib/engineManifest":{currentEngineManifest:()=>engineManifest},
    "@/lib/stateHash":{canonicalStateHash:()=>"manifest-hash"},
    "@/lib/validation":{getFrozenCorpus:()=>corpus,MIN_FAMILY_RECALL:0.95,REQUIRED_GROUNDED_PRECISION:1,VALIDATION_GATE_VERSION:validation.VALIDATION_GATE_VERSION},
    "@/lib/standards":{REQUIRED_STANDARD_FAMILIES:standards.REQUIRED_STANDARD_FAMILIES,standardGovernanceIssues:standards.standardGovernanceIssues,standardIsRelianceEligible:standards.standardIsRelianceEligible}
  });
  const localOnlyReadiness=await readinessWithEvidence.getSystemReadiness();
  assert.equal(readinessQueryCount,0,"persistent readiness evidence must require an explicit opt-in");
  assert.equal(localOnlyReadiness.legalRelianceReady,false);
  const productionReadiness=await readinessWithEvidence.getSystemReadiness({includePersistentEvidence:true});
  assert.equal(readinessQueryCount,4);
  assert.equal(productionReadiness.validationPassed,true);
  assert.equal(productionReadiness.standardsReady,true);
  assert.equal(productionReadiness.legalRelianceReady,true,"complete current evidence and governed standards should remain reliance-ready");
  const originalPolicy=policyRows[0];
  policyRows[0]={...originalPolicy,model_name:"unapproved-model"};
  const policyMismatchBlocked=await readinessWithEvidence.getSystemReadiness({includePersistentEvidence:true});
  assert.equal(policyMismatchBlocked.enginePoliciesReady,false);
  assert.equal(policyMismatchBlocked.legalRelianceReady,false,"database engine policy must exactly match the application manifest");
  policyRows[0]=originalPolicy;
  const originalStandard=governedRows[0];
  governedRows[0]={...originalStandard,provenance_source:"DEMO"};
  const demoStandardBlocked=await readinessWithEvidence.getSystemReadiness({includePersistentEvidence:true});
  assert.equal(demoStandardBlocked.standardsReady,false);
  assert.equal(demoStandardBlocked.missingStandards.includes(originalStandard.clause_family),true);
  assert.equal(demoStandardBlocked.legalRelianceReady,false,"DEMO standards must not satisfy reliance coverage");
  governedRows[0]=originalStandard;
  delete process.env.CLAMAV_HOST;
  const scannerBlocked=await readinessWithEvidence.getSystemReadiness({includePersistentEvidence:true});
  assert.equal(scannerBlocked.infrastructureReady,false);
  assert.equal(scannerBlocked.legalRelianceReady,false,"malware scanner configuration is required for legal reliance");
}finally{
  for(const [name,value] of Object.entries(savedEnvironment)){if(value===undefined)delete process.env[name];else process.env[name]=value;}
}

let demoReadinessCalls=0;
const readinessRoute=loadTypeScriptModule("app/api/readiness/route.ts",{
  "@/lib/access":{getPrincipal:async()=>({userId:"demo-user",name:"Demo",role:"ADMIN",demo:true}),accessErrorResponse:()=>null},
  "@/lib/readiness":{getSystemReadiness:async()=>{demoReadinessCalls+=1;throw new Error("demo queried readiness");}}
});
const demoResponse=await readinessRoute.GET(new Request("http://localhost/api/readiness"));
assert.equal(demoResponse.status,200);
assert.equal(demoReadinessCalls,0,"demo readiness must not touch persistent readiness state");
const demoBody=await demoResponse.json();
assert.equal(Object.values(demoBody.readiness.configured).every((value)=>typeof value==="boolean"&&value===false),true,"demo infrastructure flags must be sanitized");

let validationQueryCount=0;let requiredRole="";
const validationLatestRoute=loadTypeScriptModule("app/api/validation/latest/route.ts",{
  "@/lib/access":{requireRole:async(_request,role)=>{requiredRole=role;return {demo:true};},accessErrorResponse:()=>null},
  "@/lib/db":{databaseConfigured:()=>true,query:async()=>{validationQueryCount+=1;return {rows:[]};}}
});
const validationResponse=await validationLatestRoute.GET(new Request("http://localhost/api/validation/latest"));
assert.equal(requiredRole,"ADMIN");
assert.equal(validationResponse.status,503);
assert.equal(validationQueryCount,0,"demo validation evidence must not query the database");

async function exerciseWorkflow(evaluateValidationCase){
  const sql=[];
  const workflow=loadTypeScriptModule("workflows/legal-validation.ts",{
    "@/lib/validation":{
      getFrozenCorpus:()=>({version:"test-corpus",cases:[{id:"case-1",category:"test",title:"Case",text:"source",expectedFamilies:[],prohibitedFamilies:[]}]}),
      evaluateValidationCase,
      summarizeValidation:(results)=>({passed:results.length===1,totalCases:1,passedCases:results.length,failedCases:1-results.length,allCasesPassed:results.length===1,missingCaseCount:1-results.length,unexpectedCaseCount:0,duplicateCaseCount:0,rejectedUngroundedFindingCount:0,familyRecall:1,groundedPrecision:1,unsafePolicyInventionCount:0,exactQuoteFailureCount:0,prohibitedFamilyCount:0,mustFlagMissCount:0,gateVersion:"test-gate"}),
      VALIDATION_GATE_VERSION:"test-gate"
    },
    "@/lib/analysisEngine":{PROMPT_VERSION:"test-prompt"},
    "@/lib/stateHash":{canonicalStateHash:()=>"result-manifest-hash"},
    "@/lib/db":{query:async(text,values=[])=>{sql.push({text,values});return /returning id/i.test(text)?{rows:[{id:"run-1"}]}:{rows:[]};}}
  });
  return {workflow,sql};
}

const failedWorkflow=await exerciseWorkflow(async()=>{throw new Error("model failed");});
await assert.rejects(()=>failedWorkflow.workflow.legalValidationWorkflow("admin"),/internal or provider dependency was unavailable\. Reference:/);
assert.equal(failedWorkflow.sql.some(({text})=>/set status='FAILED'/i.test(text)),true,"workflow errors must finalize the validation run as FAILED");
assert.equal(JSON.stringify(failedWorkflow.sql).includes("model failed"),false,"raw provider failure detail must not be persisted");
assert.match(JSON.stringify(failedWorkflow.sql),/Reference: 00000000-0000-4000-8000-000000000000\./,"persisted workflow failure must carry only the safe correlation reference");

const successfulResult={caseId:"case-1",passed:true,detectedFamilies:[],missingFamilies:[],prohibitedDetected:[],grounded:true,mustFlagMissing:[],unsafeConclusions:[],findingCount:0,rejectedUngroundedFindings:0,rawResult:{}};
const successfulWorkflow=await exerciseWorkflow(async()=>successfulResult);
const workflowResult=await successfulWorkflow.workflow.legalValidationWorkflow("admin");
assert.equal(workflowResult.summary.passed,true,"successful validation workflow behavior must remain intact");
assert.equal(successfulWorkflow.sql.some(({text,values})=>/set status=\$2/i.test(text)&&values[1]==="PASSED"),true);

console.log("Validation/readiness hardening checks passed.");
