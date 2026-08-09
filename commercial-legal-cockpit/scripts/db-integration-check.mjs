import pg from "pg";
import {createHash,randomUUID} from "node:crypto";
import {verifiedDatabaseConnectionConfig} from "./database-connection-config.mjs";

const {Client}=pg;
if(!process.env.DATABASE_URL)throw new Error("DATABASE_URL is required.");
const client=new Client(verifiedDatabaseConnectionConfig(process.env.DATABASE_URL,"contracttwin-db-control-test"));
await client.connect();

const MODEL="gpt-5.6";
const CLAUSE_PROMPT="ems-legal-triage-2026-08-07.v4";
const CLAUSE_SCHEMA="clause-risk.v2";
const TERM_PROMPT="contract-term-extraction-2026-08-07.v1";
const TERM_SCHEMA="contract-term.v1";
const DEPENDENCY_PROMPT="term-dependency-2026-08-07.v1";
const DEPENDENCY_SCHEMA="term-dependency.v1";
const PRECEDENCE_PROMPT="document-precedence-2026-08-07.v1";
const PRECEDENCE_SCHEMA="document-precedence.v1";
const GRAPH_VERSION="agreement-graph-2026-08-08.v2";
const ECONOMICS_VERSION="ems-contract-economics-2026-08-07.v1";

function canonicalize(value){
  if(value instanceof Date)return value.toISOString();
  if(Array.isArray(value))return value.map(canonicalize);
  if(value&&typeof value==="object")return Object.fromEntries(Object.entries(value).sort(([a],[b])=>a<b?-1:a>b?1:0).map(([key,item])=>[key,canonicalize(item)]));
  return value;
}
function canonicalJson(value){return JSON.stringify(canonicalize(value));}
function stateHash(value){return createHash("sha256").update(canonicalJson(value),"utf8").digest("hex");}
async function expectFailure(name,fn,predicate){
  await client.query(`SAVEPOINT ${name}`);let matched=false;let observed="";
  try{await fn();}catch(error){observed=String(error?.message||error);matched=predicate(error);}
  finally{await client.query(`ROLLBACK TO SAVEPOINT ${name}`);await client.query(`RELEASE SAVEPOINT ${name}`);}
  if(!matched)throw new Error(`Expected database control failure did not occur: ${name}; observed=${observed||"no error"}`);
}
function dispositionCounts(objects){
  return {validated:objects.filter(row=>row.review_status==="VALIDATED").length,rejected:objects.filter(row=>row.review_status==="REJECTED").length,unreviewed:objects.filter(row=>row.review_status==="UNREVIEWED").length,other:objects.filter(row=>!["VALIDATED","REJECTED","UNREVIEWED"].includes(row.review_status)).length};
}
async function attest({matterId,scopeType,scopeId,attestedBy="ci-lawyer",mutateManifest}){
  let scope;let objects;let inputSha;let outputCount;
  if(scopeType==="CLAUSE_RISK"||scopeType==="TERM_EXTRACTION"){
    scope=(await client.query("select * from analysis_runs where id=$1",[scopeId])).rows[0];
    const table=scopeType==="CLAUSE_RISK"?"findings":"contract_terms";
    objects=(await client.query(`select id,review_status,reviewed_by,reviewed_at::text reviewed_at,review_note from ${table} where analysis_run_id=$1 order by id`,[scopeId])).rows;
    inputSha=scope.input_sha256;outputCount=Number(scope.output_count);
  }else{
    scope=(await client.query("select * from processing_jobs where id=$1",[scopeId])).rows[0];
    const table=scopeType==="DEPENDENCY"?"term_dependencies":"document_relations";
    objects=(await client.query(`select id,review_status,reviewed_by,reviewed_at::text reviewed_at,review_note from ${table} where processing_job_id=$1 order by id`,[scopeId])).rows;
    inputSha=scope.output.inputHash;outputCount=Number(scopeType==="DEPENDENCY"?scope.output.dependencyCount:scope.output.relationCount);
  }
  const counts=dispositionCounts(objects);
  let manifest={scope,dispositionCounts:counts,objects,authority:{capability:"LEGAL_COUNSEL_ATTEST",attestedBy,confirmComplete:true}};
  if(mutateManifest)manifest=mutateManifest(manifest);
  const manifestCanonical=canonicalJson(manifest);const manifestHash=createHash("sha256").update(manifestCanonical,"utf8").digest("hex");
  return (await client.query(`insert into analysis_review_attestations(matter_id,scope_type,analysis_run_id,processing_job_id,input_sha256,output_count,disposition_counts,manifest,manifest_canonical,manifest_hash,attestation_note,authority_capability,attested_by) values($1,$2,$3,$4,$5,$6,$7::jsonb,$8::jsonb,$9,$10,'Counsel reviewed every exact output object and confirms completion.','LEGAL_COUNSEL_ATTEST',$11) returning id`,[matterId,scopeType,scopeType==="CLAUSE_RISK"||scopeType==="TERM_EXTRACTION"?scopeId:null,scopeType==="DEPENDENCY"||scopeType==="PRECEDENCE"?scopeId:null,inputSha,outputCount,JSON.stringify(counts),manifestCanonical,manifestCanonical,manifestHash,attestedBy])).rows[0];
}
async function dependencyState(matterId,documentIds,runIds){
  const terms=(await client.query(`select t.id,t.analysis_run_id,t.clause_family,t.term_type,t.normalized_statement,t.trigger_event from contract_terms t where t.matter_id=$1 and t.document_id=any($2::uuid[]) and t.analysis_run_id=any($3::uuid[]) and t.review_status<>'SUPERSEDED' order by t.created_at,t.id`,[matterId,documentIds,runIds])).rows;
  return {sourceDocumentIds:[...documentIds].sort(),sourceRunIds:[...runIds].sort(),terms};
}
async function precedenceState(documentIds){
  const docs=(await client.query("select id,filename,document_type,sha256 from documents where id=any($1::uuid[]) order by uploaded_at,id",[documentIds])).rows;
  const result=[];
  for(const doc of docs){
    const sourceChunks=(await client.query(`select id,content_sha256 from document_chunks where document_id=$1 order by case when content ~* '(preced|conflict|amend|supersed|control|incorporat|govern|order of precedence)' then 0 else 1 end,coalesce(page_number,0),chunk_index,id limit 12`,[doc.id])).rows;
    result.push({id:doc.id,filename:doc.filename,documentType:doc.document_type,sourceChunks,sha256:doc.sha256.toLowerCase()});
  }
  return result;
}
async function createGraphJob({matterId,agreementVersionId,scopeType,documentIds,runIds,inputHash,objectIds,rawCount,rejectedCount}){
  const jobType=scopeType;const countField=scopeType==="DEPENDENCY"?"dependencyCount":"relationCount";
  const input={agreementVersionId,sourceDocumentIds:[...documentIds].sort(),sourceTermAnalysisRunIds:[...runIds].sort(),graphVersion:GRAPH_VERSION,termAnalysisRunId:runIds[0]};
  const job=(await client.query(`insert into processing_jobs(matter_id,job_type,status,idempotency_key,input,created_by,started_at,locked_by,locked_at,lease_generation,last_heartbeat_at,lease_expires_at) values($1,$2,'RUNNING',$3,$4::jsonb,'ci-worker',now(),'ci-worker',now(),1,now(),now()+interval '15 minutes') returning id`,[matterId,jobType,`ci-${scopeType.toLowerCase()}-${randomUUID()}`,JSON.stringify(input)])).rows[0];
  const output={[countField]:objectIds.length,objectIds:[...objectIds].sort(),rawCandidateCount:rawCount,rejectedCandidateCount:rejectedCount,modelName:MODEL,promptVersion:scopeType==="DEPENDENCY"?DEPENDENCY_PROMPT:PRECEDENCE_PROMPT,schemaVersion:scopeType==="DEPENDENCY"?DEPENDENCY_SCHEMA:PRECEDENCE_SCHEMA,sourceDocumentIds:[...documentIds].sort(),inputHash};
  if(scopeType==="DEPENDENCY"){output.sourceRunIds=[...runIds].sort();output.termAnalysisRunId=runIds[0];}
  await client.query("update processing_jobs set status='SUCCEEDED',output=$2::jsonb,finished_at=now(),locked_by=null,locked_at=null,last_heartbeat_at=null,lease_expires_at=null where id=$1",[job.id,JSON.stringify(output)]);
  return job;
}

async function raceSafeCounselRelationUniqueness(){
  const suffix=randomUUID();
  const customer=(await client.query("insert into customers(name) values($1) returning id",[`CI Race ${suffix}`])).rows[0];
  const matter=(await client.query(`insert into matters(matter_number,customer_id,agreement_title,region,owner_user_id) values($1,$2,'Race uniqueness','Americas','ci-user') returning id`,[`CI-RACE-${suffix}`,customer.id])).rows[0];
  const source=(await client.query(`insert into documents(matter_id,filename,document_type,mime_type,size_bytes,blob_url,blob_pathname,uploaded_by) values($1,'a.txt','OTHER','text/plain',1,'https://example.invalid/a',$2,'ci-user') returning id`,[matter.id,`ci/race/${suffix}/a`])).rows[0];
  const target=(await client.query(`insert into documents(matter_id,filename,document_type,mime_type,size_bytes,blob_url,blob_pathname,uploaded_by) values($1,'b.txt','OTHER','text/plain',1,'https://example.invalid/b',$2,'ci-user') returning id`,[matter.id,`ci/race/${suffix}/b`])).rows[0];
  const first=new Client(verifiedDatabaseConnectionConfig(process.env.DATABASE_URL,"contracttwin-race-first"));
  const second=new Client(verifiedDatabaseConnectionConfig(process.env.DATABASE_URL,"contracttwin-race-second"));
  await first.connect();await second.connect();
  try{
    await first.query("begin");await second.query("begin");
    await first.query(`insert into document_relations(matter_id,origin,source_document_id,target_document_id,relation_type,created_by) values($1,'COUNSEL',$2,$3,'REFERENCES','ci-lawyer')`,[matter.id,source.id,target.id]);
    const competing=second.query(`insert into document_relations(matter_id,origin,source_document_id,target_document_id,relation_type,created_by) values($1,'COUNSEL',$2,$3,'REFERENCES','ci-lawyer')`,[matter.id,source.id,target.id]).then(result=>({result}),error=>({error}));
    await new Promise(resolve=>setTimeout(resolve,25));
    await first.query("commit");
    const outcome=await competing;
    if(outcome.error?.code!=="23505")throw new Error(`Race-safe counsel relation uniqueness did not reject the competing insert: ${outcome.error?.message||"no unique violation"}`);
    await second.query("rollback");
  }finally{
    await first.end();await second.end();
    await client.query("delete from matters where id=$1",[matter.id]);
    await client.query("delete from customers where id=$1",[customer.id]);
  }
}

try{
  for(const table of ["user","session","account","verification","matters","documents","audit_events","negotiation_standards","contract_terms","processing_jobs","api_rate_events","decision_conditions","app_user_capabilities","analysis_review_attestations","analysis_engine_policies"]){
    const result=await client.query("select to_regclass($1) name",[table]);
    if(!result.rows[0].name)throw new Error(`Required migrated table missing: ${table}`);
  }
  await client.query("BEGIN");
  try{
    const releaseIdentityRows=(await client.query("select singleton,database_id from public.release_database_identity order by singleton")).rows;
    if(releaseIdentityRows.length!==1||releaseIdentityRows[0].singleton!==true)throw new Error("Release database identity must contain exactly one singleton row.");
    const releaseDatabaseId=releaseIdentityRows[0].database_id;
    await expectFailure("sp_release_identity_insert",()=>client.query("insert into public.release_database_identity(singleton,database_id) values(true,$1)",[randomUUID()]),error=>String(error.message).toLowerCase().includes("identity is immutable"));
    await expectFailure("sp_release_identity_update",()=>client.query("update public.release_database_identity set database_id=$1 where singleton=true",[randomUUID()]),error=>String(error.message).toLowerCase().includes("identity is immutable"));
    await expectFailure("sp_release_identity_delete",()=>client.query("delete from public.release_database_identity where singleton=true"),error=>String(error.message).toLowerCase().includes("identity is immutable"));
    await expectFailure("sp_release_identity_truncate",()=>client.query("truncate table public.release_database_identity cascade"),error=>String(error.message).toLowerCase().includes("identity is immutable"));
    const testReleaseNonceSha=createHash("sha256").update(randomUUID(),"utf8").digest("hex");
    await client.query("insert into public.release_target_receipts(nonce_sha256,database_id,source_sha) values($1,$2,$3)",[testReleaseNonceSha,releaseDatabaseId,"a".repeat(40)]);
    await expectFailure("sp_release_receipt_update",()=>client.query("update public.release_target_receipts set source_sha=$2 where nonce_sha256=$1",[testReleaseNonceSha,"b".repeat(40)]),error=>String(error.message).toLowerCase().includes("append-only"));
    await expectFailure("sp_release_receipt_delete",()=>client.query("delete from public.release_target_receipts where nonce_sha256=$1",[testReleaseNonceSha]),error=>String(error.message).toLowerCase().includes("append-only"));
    await expectFailure("sp_release_receipt_truncate",()=>client.query("truncate table public.release_target_receipts"),error=>String(error.message).toLowerCase().includes("append-only"));
    await client.query(`insert into app_user_roles(user_id,role,active,granted_by) values('ci-lawyer','LAWYER',true,'ci-admin'),('ci-approver','APPROVER',true,'ci-admin'),('ci-admin','ADMIN',true,'ci-admin')`);
    await client.query(`insert into app_user_capabilities(user_id,capability,active,granted_by) values('ci-lawyer','LEGAL_COUNSEL_ATTEST',true,'ci-admin')`);
    const customer=(await client.query("insert into customers(name) values('CI Control Customer') returning id")).rows[0];
    const matter=(await client.query(`insert into matters(matter_number,customer_id,agreement_title,region,annual_revenue,owner_user_id,legal_hold,legal_hold_reason,updated_at) values('CI-CONTROL-1',$1,'Synthetic Control Agreement','Americas',1.20,'ci-user',true,'CI hold test','2026-08-08 12:00:00.123456+00') returning id`,[customer.id])).rows[0];
    const sourceHash="b".repeat(64);
    const doc=(await client.query(`insert into documents(matter_id,filename,document_type,mime_type,size_bytes,blob_url,blob_pathname,sha256,uploaded_by,legal_hold) values($1,'test.txt','OTHER','text/plain',4,'https://example.invalid/test','ci/test',$2,'ci-user',false) returning id`,[matter.id,sourceHash])).rows[0];
    const authorityDoc=(await client.query(`insert into documents(matter_id,filename,document_type,mime_type,size_bytes,blob_url,blob_pathname,uploaded_by) values($1,'authority.txt','OTHER','text/plain',1,'https://example.invalid/authority','ci/authority','ci-user') returning id`,[matter.id])).rows[0];
    await expectFailure("sp_relation_review_authority",async()=>{
      const relation=(await client.query(`insert into document_relations(matter_id,origin,source_document_id,target_document_id,relation_type,rationale,created_by) values($1,'COUNSEL',$2,$3,'REFERENCES','Unappointed reviewer authority fixture.','ci-worker') returning id`,[matter.id,doc.id,authorityDoc.id])).rows[0];
      await client.query("update document_relations set review_status='VALIDATED',reviewed_by='ci-unappointed-lawyer',reviewed_at=now(),review_note='This reviewer lacks appointed counsel authority.' where id=$1",[relation.id]);
    },error=>String(error.message).includes("LEGAL_COUNSEL_ATTEST"));
    const counselRelation=(await client.query(`insert into document_relations(matter_id,origin,source_document_id,target_document_id,relation_type,rationale,review_status,created_by,reviewed_by,reviewed_at,review_note) values($1,'COUNSEL',$2,$3,'REFERENCES','Counsel confirmed the recorded document relationship.','VALIDATED','ci-lawyer','ci-lawyer','2026-08-08 12:00:00.111111+00','Counsel confirmed the recorded document relationship.') returning id`,[matter.id,doc.id,authorityDoc.id])).rows[0];
    await expectFailure("sp_reviewed_relation",()=>client.query("update document_relations set rationale='Tampered after review.' where id=$1",[counselRelation.id]),error=>String(error.message).toLowerCase().includes("immutable"));
    await expectFailure("sp_hold",()=>client.query("update documents set deletion_status='PURGED' where id=$1",[doc.id]),error=>String(error.message).toLowerCase().includes("legal hold"));
    await expectFailure("sp_unscanned",()=>client.query("update documents set extraction_status='EXTRACTED' where id=$1",[doc.id]),error=>String(error.message).toLowerCase().includes("malware"));
    await expectFailure("sp_purge_request",()=>client.query("insert into purge_requests(matter_id,document_id,requested_by,reason) values($1,$2,'ci-user','test')",[matter.id,doc.id]),error=>String(error.message).toLowerCase().includes("legal hold"));
    await client.query("update documents set security_scan_status='CLEAN',server_sha256=$2,integrity_status='SERVER_VERIFIED' where id=$1",[doc.id,sourceHash]);

    const extractJob=(await client.query(`insert into processing_jobs(matter_id,document_id,job_type,status,idempotency_key,created_by) values($1,$2,'EXTRACT','QUEUED','ci-extract-generation','ci-worker') returning id`,[matter.id,doc.id])).rows[0];
    await expectFailure("sp_nonrunning_extraction_generation",()=>client.query("update documents set extraction_job_id=$2 where id=$1",[doc.id,extractJob.id]),error=>String(error.message).includes("RUNNING EXTRACT"));
    await client.query("update processing_jobs set status='RUNNING',started_at=now(),locked_by='ci-worker',locked_at=now(),lease_generation=lease_generation+1,last_heartbeat_at=now(),lease_expires_at=now()+interval '15 minutes' where id=$1",[extractJob.id]);
    await client.query("update documents set extraction_job_id=$2,extraction_status='EXTRACTED' where id=$1",[doc.id,extractJob.id]);
    await expectFailure("sp_retarget_extraction_generation",()=>client.query("update processing_jobs set document_id=null where id=$1",[extractJob.id]),error=>String(error.message).toLowerCase().includes("retargeted"));
    await client.query(`update processing_jobs set status='SUCCEEDED',output='{"chunkCount":1}'::jsonb,finished_at=now(),locked_by=null,locked_at=null,last_heartbeat_at=null,lease_expires_at=null where id=$1`,[extractJob.id]);

    const quoteA="Customer shall pay Supplier within forty-five days.";
    const quoteB="Supplier may suspend delivery after a material payment default.";
    const chunkText=`Current extracted source. Customer shall pay. ${quoteA} ${quoteB}`;
    const chunkHash=createHash("sha256").update(chunkText,"utf8").digest("hex");
    await expectFailure("sp_chunk_digest",()=>client.query(`insert into document_chunks(document_id,matter_id,page_number,chunk_index,content,content_sha256) values($1,$2,1,0,$3,$4)`,[doc.id,matter.id,chunkText,"c".repeat(64)]),error=>String(error.message).toLowerCase().includes("sha-256"));
    const chunk=(await client.query(`insert into document_chunks(document_id,matter_id,page_number,chunk_index,content,content_sha256) values($1,$2,1,0,$3,$4) returning id`,[doc.id,matter.id,chunkText,chunkHash])).rows[0];
    const sourceInputHash=createHash("sha256").update(chunkHash,"utf8").digest("hex");
    const version=(await client.query(`insert into agreement_versions(matter_id,version_number,label,created_by,created_at) values($1,1,'CI v1','ci-user','2026-08-08 12:10:00.234567+00') returning id`,[matter.id])).rows[0];
    await client.query(`insert into agreement_version_documents(agreement_version_id,document_id,included_by) values($1,$2,'ci-user')`,[version.id,doc.id]);
    await expectFailure("sp_direct_working_execution",()=>client.query("update agreement_versions set status='EXECUTED' where id=$1",[version.id]),error=>String(error.message).toLowerCase().includes("transition"));

    const audit=(await client.query(`insert into audit_events(actor_user_id,actor_name,action,matter_id,entity_type,entity_id,metadata) values('ci-user','CI User','CI_TEST',$1,'matter',$2,'{}'::jsonb) returning id`,[matter.id,String(matter.id)])).rows[0];
    await expectFailure("sp_audit",()=>client.query("update audit_events set actor_name='tampered' where id=$1",[audit.id]),error=>String(error.message).toLowerCase().includes("append-only"));
    await expectFailure("sp_incomplete_standard",()=>client.query(`insert into negotiation_standards(clause_family,title,standard_position,active,version,effective_date,created_by) values('payment_terms','Bad','Position',true,'1','2026-01-01','ci-user')`),error=>String(error.message).toLowerCase().includes("governed"));
    await client.query(`insert into negotiation_standards(clause_family,title,standard_position,fallback_position,no_go_position,approval_authority,business_rationale,provenance_source,approval_role,active,version,effective_date,created_by) values('payment_terms','CI Standard 1','Position 1','Fallback 1','No-go 1','Finance','Rationale','CI-POLICY','APPROVER',true,'1','2026-01-01','ci-user')`);
    await expectFailure("sp_standard",()=>client.query(`insert into negotiation_standards(clause_family,title,standard_position,fallback_position,no_go_position,approval_authority,business_rationale,provenance_source,approval_role,active,version,effective_date,created_by) values('payment_terms','CI Standard 2','Position 2','Fallback 2','No-go 2','Finance','Rationale','CI-POLICY','APPROVER',true,'2','2026-02-01','ci-user')`),error=>String(error.code)==="23505");

    await expectFailure("sp_unbound_finding",()=>client.query(`insert into findings(matter_id,document_id,clause_family,issue,risk_level,rationale,source_excerpt,created_by) values($1,$2,'payment_terms','Unbound','High','No run.','Customer shall pay.','ci-worker')`,[matter.id,doc.id]),error=>String(error.message).includes("RUNNING clause-risk"));
    const riskRun=(await client.query(`insert into analysis_runs(matter_id,document_id,run_type,status,model_name,prompt_version,schema_version,input_sha256,source_chunk_count,created_by) values($1,$2,'CLAUSE_RISK','RUNNING',$3,$4,$5,$6,1,'ci-worker') returning id`,[matter.id,doc.id,MODEL,CLAUSE_PROMPT,CLAUSE_SCHEMA,sourceInputHash])).rows[0];
    const finding=(await client.query(`insert into findings(matter_id,document_id,analysis_run_id,clause_family,issue,risk_level,rationale,source_excerpt,created_by) values($1,$2,$3,'payment_terms','CI finding','High','CI rationale','Customer shall pay.','ci-worker') returning id`,[matter.id,doc.id,riskRun.id])).rows[0];
    await expectFailure("sp_review_authority",()=>client.query("update findings set review_status='VALIDATED',reviewed_by='ci-unappointed-lawyer',reviewed_at=now(),review_note='This reviewer lacks appointed counsel authority.' where id=$1",[finding.id]),error=>String(error.message).includes("LEGAL_COUNSEL_ATTEST"));
    await expectFailure("sp_review_note",()=>client.query("update findings set review_status='VALIDATED',reviewed_by='ci-lawyer',reviewed_at=now() where id=$1",[finding.id]),error=>String(error.message).toLowerCase().includes("substantive note"));
    await client.query("update findings set review_status='VALIDATED',reviewed_by='ci-lawyer',reviewed_at='2026-08-08 12:34:56.123456+00',review_note='Validated against the recorded source excerpt.' where id=$1",[finding.id]);
    const approvalFinding=(await client.query(`insert into findings(matter_id,document_id,analysis_run_id,clause_family,issue,risk_level,rationale,source_excerpt,approval_required,review_status,created_by,reviewed_by,reviewed_at,review_note) values($1,$2,$3,'payment_terms','CI approval finding','High','Validated approval issue.',$4,'CFO approval','VALIDATED','ci-worker','ci-lawyer','2026-08-08 12:34:56.654321+00','Validated against the current clause-risk run.') returning id`,[matter.id,doc.id,riskRun.id,quoteA])).rows[0];
    await client.query("update analysis_runs set status='SUCCEEDED',output_count=2,finished_at=now() where id=$1",[riskRun.id]);
    await expectFailure("sp_terminal_run_finding",()=>client.query(`insert into findings(matter_id,document_id,analysis_run_id,clause_family,issue,risk_level,rationale,source_excerpt,created_by) values($1,$2,$3,'payment_terms','Late output','High','Late.','Customer shall pay.','ci-worker')`,[matter.id,doc.id,riskRun.id]),error=>String(error.message).includes("RUNNING clause-risk"));
    await expectFailure("sp_reviewed_finding",()=>client.query("update findings set rationale='Tampered after review' where id=$1",[finding.id]),error=>String(error.message).toLowerCase().includes("immutable"));
    await attest({matterId:matter.id,scopeType:"CLAUSE_RISK",scopeId:riskRun.id});
    const rejectedGroundingRun=(await client.query(`insert into analysis_runs(matter_id,document_id,run_type,status,model_name,prompt_version,schema_version,input_sha256,source_chunk_count,output_count,rejected_ungrounded_count,created_by,started_at,finished_at) values($1,$2,'CLAUSE_RISK','SUCCEEDED',$3,$4,$5,$6,1,0,1,'ci-worker','2025-01-01 00:00:00+00','2025-01-01 00:00:01+00') returning id`,[matter.id,doc.id,MODEL,CLAUSE_PROMPT,CLAUSE_SCHEMA,sourceInputHash])).rows[0];
    await expectFailure("sp_attest_rejected_grounding",()=>attest({matterId:matter.id,scopeType:"CLAUSE_RISK",scopeId:rejectedGroundingRun.id}),error=>String(error.message).toLowerCase().includes("rejection-free grounded"));

    await expectFailure("sp_unbound_economics",()=>client.query(`insert into economics_runs(matter_id,inputs,outputs,formula_version,created_by) values($1,'{}','{}',$2,'ci-user')`,[matter.id,ECONOMICS_VERSION]),error=>String(error.message).toLowerCase().includes("agreement version"));
    const economics=(await client.query(`insert into economics_runs(matter_id,agreement_version_id,inputs,outputs,formula_version,created_by,created_at) values($1,$2,'{}','{}',$3,'ci-user','2026-08-08 12:20:00.345678+00') returning id`,[matter.id,version.id,ECONOMICS_VERSION])).rows[0];
    await expectFailure("sp_economics_immutable",()=>client.query("update economics_runs set formula_version='tampered' where id=$1",[economics.id]),error=>String(error.message).toLowerCase().includes("immutable"));
    await expectFailure("sp_economics_note",()=>client.query("update economics_runs set review_status='VALIDATED',reviewed_by='ci-approver',reviewed_at=now() where id=$1",[economics.id]),error=>String(error.message).toLowerCase().includes("substantive note"));
    await client.query("update economics_runs set review_status='VALIDATED',reviewed_by='ci-approver',reviewed_at='2026-08-08 12:21:00.456789+00',review_note='Validated inputs and formula outputs against the approved business case.' where id=$1",[economics.id]);
    await expectFailure("sp_economics_terminal",()=>client.query("update economics_runs set review_note='Changed after validation.' where id=$1",[economics.id]),error=>String(error.message).toLowerCase().includes("immutable"));
    const sensitivityEconomics=(await client.query(`insert into economics_runs(matter_id,agreement_version_id,inputs,outputs,formula_version,created_by,created_at) values($1,$2,'{"scenario":"sensitivity"}','{}',$3,'ci-user','2200-01-01 00:00:00+00') returning id`,[matter.id,version.id,ECONOMICS_VERSION])).rows[0];
    await client.query("update economics_runs set review_status='VALIDATED',reviewed_by='ci-approver',reviewed_at='2200-01-01 00:01:00+00',review_note='Validated as a sensitivity case, not as the authoritative agreement economics.' where id=$1",[sensitivityEconomics.id]);

    await expectFailure("sp_unbound_decision",()=>client.query(`insert into decisions(matter_id,decision_type,rationale,requested_by,required_approver_role) values($1,'ESCALATE','Unbound decision must fail','ci-requester','APPROVER')`,[matter.id]),error=>String(error.message).toLowerCase().includes("agreement version"));
    const moveTarget=(await client.query(`insert into agreement_versions(matter_id,version_number,label,created_by) values($1,98,'CI move target','ci-user') returning id`,[matter.id])).rows[0];
    await client.query(`insert into agreement_version_documents(agreement_version_id,document_id,included_by) values($1,$2,'ci-user')`,[moveTarget.id,doc.id]);

    const hashA=createHash("sha256").update(quoteA,"utf8").digest("hex");const hashB=createHash("sha256").update(quoteB,"utf8").digest("hex");
    const firstTermRun=(await client.query(`insert into analysis_runs(matter_id,document_id,run_type,status,model_name,prompt_version,schema_version,input_sha256,source_chunk_count,created_by,started_at) values($1,$2,'TERM_EXTRACTION','RUNNING',$3,$4,$5,$6,1,'ci-worker','2026-08-08 13:00:00+00') returning id`,[matter.id,doc.id,MODEL,TERM_PROMPT,TERM_SCHEMA,sourceInputHash])).rows[0];
    await expectFailure("sp_term_digest",()=>client.query(`insert into contract_terms(matter_id,document_id,analysis_run_id,chunk_id,clause_family,term_type,exact_text,exact_text_sha256,normalized_statement,confidence,created_by) values($1,$2,$3,$4,'payment_terms','OBLIGATION',$5,$6,'Bad digest.',1,'ci-user')`,[matter.id,doc.id,firstTermRun.id,chunk.id,quoteA,"a".repeat(64)]),error=>String(error.message).toLowerCase().includes("sha-256"));
    await expectFailure("sp_term_review_authority",async()=>{
      const term=(await client.query(`insert into contract_terms(matter_id,document_id,analysis_run_id,chunk_id,clause_family,term_type,exact_text,exact_text_sha256,normalized_statement,confidence,created_by) values($1,$2,$3,$4,'payment_terms','OBLIGATION',$5,$6,'Unauthorized review fixture.',1,'ci-worker') returning id`,[matter.id,doc.id,firstTermRun.id,chunk.id,quoteA,hashA])).rows[0];
      await client.query("update contract_terms set review_status='REJECTED',reviewed_by='ci-unappointed-lawyer',reviewed_at=now(),review_note='This reviewer lacks appointed counsel authority.' where id=$1",[term.id]);
    },error=>String(error.message).includes("LEGAL_COUNSEL_ATTEST"));
    await client.query(`insert into contract_terms(matter_id,document_id,analysis_run_id,chunk_id,clause_family,term_type,exact_text,exact_text_sha256,normalized_statement,confidence,review_status,created_by,reviewed_by,reviewed_at,review_note) values($1,$2,$3,$4,'payment_terms','OBLIGATION',$5,$6,'Customer must pay within 45 days.',1,'VALIDATED','ci-worker','ci-lawyer','2026-08-08 13:00:00.111111+00','Validated payment term source text.')`,[matter.id,doc.id,firstTermRun.id,chunk.id,quoteA,hashA]);
    await client.query(`insert into contract_terms(matter_id,document_id,analysis_run_id,chunk_id,clause_family,term_type,exact_text,exact_text_sha256,normalized_statement,confidence,review_status,created_by,reviewed_by,reviewed_at,review_note) values($1,$2,$3,$4,'payment_terms','REMEDY',$5,$6,'Supplier may suspend after payment default.',1,'VALIDATED','ci-worker','ci-lawyer','2026-08-08 13:00:00.222222+00','Validated suspension remedy source text.')`,[matter.id,doc.id,firstTermRun.id,chunk.id,quoteB,hashB]);
    await client.query("update analysis_runs set status='SUCCEEDED',output_count=2,finished_at=now() where id=$1",[firstTermRun.id]);

    const termRun=(await client.query(`insert into analysis_runs(matter_id,document_id,run_type,status,model_name,prompt_version,schema_version,input_sha256,source_chunk_count,created_by,started_at) values($1,$2,'TERM_EXTRACTION','RUNNING',$3,$4,$5,$6,1,'ci-worker','2026-08-08 13:01:00+00') returning id`,[matter.id,doc.id,MODEL,TERM_PROMPT,TERM_SCHEMA,sourceInputHash])).rows[0];
    await client.query(`insert into contract_terms(matter_id,document_id,analysis_run_id,chunk_id,clause_family,term_type,exact_text,exact_text_sha256,normalized_statement,confidence,review_status,created_by,reviewed_by,reviewed_at,review_note) values($1,$2,$3,$4,'payment_terms','OBLIGATION',$5,$6,'Rejected first interpretation.',1,'REJECTED','ci-worker','ci-lawyer','2026-08-08 13:01:00.111111+00','Rejected interpretation after source review.')`,[matter.id,doc.id,termRun.id,chunk.id,quoteA,hashA]);
    const correctedTerm=(await client.query(`insert into contract_terms(matter_id,document_id,analysis_run_id,chunk_id,clause_family,term_type,exact_text,exact_text_sha256,normalized_statement,confidence,review_status,created_by,reviewed_by,reviewed_at,review_note) values($1,$2,$3,$4,'payment_terms','OBLIGATION',$5,$6,'Customer must pay within 45 days.',1,'VALIDATED','ci-worker','ci-lawyer','2026-08-08 13:01:00.222222+00','Validated corrected payment interpretation.') returning id`,[matter.id,doc.id,termRun.id,chunk.id,quoteA,hashA])).rows[0];
    const remedyTerm=(await client.query(`insert into contract_terms(matter_id,document_id,analysis_run_id,chunk_id,clause_family,term_type,exact_text,exact_text_sha256,normalized_statement,confidence,review_status,created_by,reviewed_by,reviewed_at,review_note) values($1,$2,$3,$4,'payment_terms','REMEDY',$5,$6,'Supplier may suspend after payment default.',1,'VALIDATED','ci-worker','ci-lawyer','2026-08-08 13:01:00.333333+00','Validated current suspension remedy.') returning id`,[matter.id,doc.id,termRun.id,chunk.id,quoteB,hashB])).rows[0];
    const sameRunDuplicate=await client.query(`insert into contract_terms(matter_id,document_id,analysis_run_id,chunk_id,clause_family,term_type,exact_text,exact_text_sha256,normalized_statement,confidence,created_by) values($1,$2,$3,$4,'payment_terms','OBLIGATION',$5,$6,'Duplicate AI restatement.',1,'ci-worker')`,[matter.id,doc.id,termRun.id,chunk.id,quoteA,hashA]);
    if(sameRunDuplicate.rowCount!==0)throw new Error("Same-run active term deduplication failed.");
    await client.query("update analysis_runs set status='SUCCEEDED',output_count=3,finished_at=now() where id=$1",[termRun.id]);
    const lateExactText="Current extracted source.";const lateExactHash=createHash("sha256").update(lateExactText,"utf8").digest("hex");
    await expectFailure("sp_terminal_run_term",()=>client.query(`insert into contract_terms(matter_id,document_id,analysis_run_id,chunk_id,clause_family,term_type,exact_text,exact_text_sha256,normalized_statement,created_by) values($1,$2,$3,$4,'payment_terms','DEFINITION',$5,$6,'Late term.','ci-worker')`,[matter.id,doc.id,termRun.id,chunk.id,lateExactText,lateExactHash]),error=>String(error.message).includes("RUNNING term-extraction"));
    await attest({matterId:matter.id,scopeType:"TERM_EXTRACTION",scopeId:termRun.id});

    const depState=await dependencyState(matter.id,[doc.id],[termRun.id]);const depHash=stateHash(depState);
    const precState=await precedenceState([doc.id]);const precHash=stateHash(precState);
    const wrongDependency=await createGraphJob({matterId:matter.id,agreementVersionId:moveTarget.id,scopeType:"DEPENDENCY",documentIds:[doc.id],runIds:[termRun.id],inputHash:depHash,objectIds:[],rawCount:0,rejectedCount:0});
    const wrongPrecedence=await createGraphJob({matterId:matter.id,agreementVersionId:moveTarget.id,scopeType:"PRECEDENCE",documentIds:[doc.id],runIds:[termRun.id],inputHash:precHash,objectIds:[],rawCount:0,rejectedCount:0});
    await attest({matterId:matter.id,scopeType:"DEPENDENCY",scopeId:wrongDependency.id});
    await attest({matterId:matter.id,scopeType:"PRECEDENCE",scopeId:wrongPrecedence.id});

    const badCandidateJob=(await client.query(`insert into processing_jobs(matter_id,job_type,status,idempotency_key,input,created_by,started_at,locked_by,locked_at,lease_generation,last_heartbeat_at,lease_expires_at) values($1,'DEPENDENCY','RUNNING',$2,$3::jsonb,'ci-worker',now(),'ci-worker',now(),1,now(),now()+interval '15 minutes') returning id`,[matter.id,`ci-bad-candidates-${randomUUID()}`,JSON.stringify({agreementVersionId:version.id,sourceDocumentIds:[doc.id],sourceTermAnalysisRunIds:[termRun.id],graphVersion:GRAPH_VERSION})])).rows[0];
    await client.query("update processing_jobs set status='SUCCEEDED',output=$2::jsonb,finished_at=now(),locked_by=null,locked_at=null,last_heartbeat_at=null,lease_expires_at=null where id=$1",[badCandidateJob.id,JSON.stringify({dependencyCount:0,objectIds:[],rawCandidateCount:1,rejectedCandidateCount:1,modelName:MODEL,promptVersion:DEPENDENCY_PROMPT,schemaVersion:DEPENDENCY_SCHEMA,sourceDocumentIds:[doc.id],sourceRunIds:[termRun.id],inputHash:depHash})]);
    await expectFailure("sp_rejected_graph_candidates",()=>attest({matterId:matter.id,scopeType:"DEPENDENCY",scopeId:badCandidateJob.id}),error=>String(error.message).toLowerCase().includes("rejection-free"));

    const canonical='{"matter":"ci"}';const snapshotHash=createHash("sha256").update(canonical,"utf8").digest("hex");
    await expectFailure("sp_direct_succeeded_snapshot_job",()=>client.query(`insert into processing_jobs(matter_id,job_type,status,idempotency_key,input,output,created_by,finished_at) values($1,'EXECUTIVE_SUMMARY','SUCCEEDED',$2,'{}'::jsonb,'{}'::jsonb,'ci-admin',now())`,[matter.id,`ci-forged-snapshot-${randomUUID()}`]),error=>String(error.message).includes("exact bound executive snapshot"));
    await expectFailure("sp_snapshot_hash",()=>client.query(`insert into executive_snapshots(matter_id,agreement_version_id,snapshot_version,matter_context,source_manifest,source_manifest_canonical,source_state_hash,generated_by) values($1,$2,1,'{}'::jsonb,$3::jsonb,$4,$5,'ci-user')`,[matter.id,version.id,canonical,canonical,"d".repeat(64)]),error=>String(error.message).toLowerCase().includes("hash"));
    await expectFailure("sp_snapshot_without_receipt",()=>client.query(`insert into executive_snapshots(matter_id,agreement_version_id,snapshot_version,matter_context,source_manifest,source_manifest_canonical,source_state_hash,generated_by) values($1,$2,1,'{}'::jsonb,$3::jsonb,$4,$5,'ci-user')`,[matter.id,version.id,canonical,canonical,snapshotHash]),error=>String(error.message).includes("EXECUTIVE_SUMMARY processing-job receipt"));
    const missingSnapshotReceipt=(await client.query("select executive_snapshot_receipt_verified($1::uuid) verified",[randomUUID()])).rows[0];
    if(missingSnapshotReceipt.verified!==false)throw new Error("A receipt-less snapshot read did not fail closed.");
    await expectFailure("sp_active_standard_mutation",()=>client.query("update negotiation_standards set business_rationale='Mutated in place' where clause_family='payment_terms' and active=true"),error=>String(error.message).toLowerCase().includes("immutable"));
    await expectFailure("sp_synthetic_standard",()=>client.query(`insert into negotiation_standards(clause_family,title,standard_position,fallback_position,no_go_position,approval_authority,business_rationale,provenance_source,approval_role,active,version,effective_date,created_by) values('warranty','Bad','P','F','N','Legal','R','synthetic-policy','APPROVER',true,'1','2026-01-01','ci-user')`),error=>String(error.message).toLowerCase().includes("governed"));

    const matter2=(await client.query(`insert into matters(matter_number,customer_id,agreement_title,region,annual_revenue,owner_user_id) values('CI-CONTROL-2',$1,'Second Agreement','Americas',1,'ci-user') returning id`,[customer.id])).rows[0];
    const doc2Hash="e".repeat(64);const doc2=(await client.query(`insert into documents(matter_id,filename,document_type,mime_type,size_bytes,blob_url,blob_pathname,sha256,server_sha256,integrity_status,security_scan_status,extraction_status,uploaded_by) values($1,'second.txt','OTHER','text/plain',4,'https://example.invalid/second','ci/second',$2,$2,'SERVER_VERIFIED','CLEAN','EXTRACTED','ci-user') returning id`,[matter2.id,doc2Hash])).rows[0];
    const foreignText="Foreign matter excerpt is recorded here.";const foreignChunkHash=createHash("sha256").update(foreignText,"utf8").digest("hex");
    await client.query(`insert into document_chunks(document_id,matter_id,page_number,chunk_index,content,content_sha256) values($1,$2,1,0,$3,$4)`,[doc2.id,matter2.id,foreignText,foreignChunkHash]);
    const foreignRun=(await client.query(`insert into analysis_runs(matter_id,document_id,run_type,status,model_name,prompt_version,schema_version,input_sha256,source_chunk_count,created_by) values($1,$2,'CLAUSE_RISK','RUNNING',$3,$4,$5,$6,1,'ci-worker') returning id`,[matter2.id,doc2.id,MODEL,CLAUSE_PROMPT,CLAUSE_SCHEMA,createHash("sha256").update(foreignChunkHash).digest("hex")])).rows[0];
    const foreignFinding=(await client.query(`insert into findings(matter_id,document_id,analysis_run_id,clause_family,issue,risk_level,rationale,source_excerpt,created_by) values($1,$2,$3,'payment_terms','Foreign finding','High','Foreign matter rationale.',$4,'ci-worker') returning id`,[matter2.id,doc2.id,foreignRun.id,foreignText])).rows[0];
    await client.query("update analysis_runs set status='SUCCEEDED',output_count=1,finished_at=now() where id=$1",[foreignRun.id]);
    await expectFailure("sp_cross_matter_version",()=>client.query(`insert into agreement_version_documents(agreement_version_id,document_id,included_by) values($1,$2,'ci-user')`,[version.id,doc2.id]),error=>String(error.message).toLowerCase().includes("matter"));
    await expectFailure("sp_cross_matter_decision_version",()=>client.query(`insert into decisions(matter_id,agreement_version_id,decision_type,rationale,requested_by,required_approver_role) values($1,$2,'ESCALATE','Cross-matter binding must fail','ci-requester','APPROVER')`,[matter2.id,version.id]),error=>String(error.message).toLowerCase().includes("same matter"));
    await expectFailure("sp_cross_matter_decision_finding",()=>client.query(`insert into decisions(matter_id,agreement_version_id,finding_id,decision_type,rationale,requested_by,required_approver_role) values($1,$2,$3,'ESCALATE','Cross-matter finding must fail','ci-requester','APPROVER')`,[matter.id,version.id,foreignFinding.id]),error=>String(error.message).toLowerCase().includes("finding must belong to the same matter"));
    await expectFailure("sp_cross_matter_relation",()=>client.query(`insert into document_relations(matter_id,origin,source_document_id,target_document_id,relation_type,created_by) values($1,'COUNSEL',$2,$3,'REFERENCES','ci-user')`,[matter.id,doc.id,doc2.id]),error=>String(error.message).toLowerCase().includes("matter"));
    await expectFailure("sp_cross_matter_term",()=>client.query(`insert into contract_terms(matter_id,document_id,analysis_run_id,chunk_id,clause_family,term_type,exact_text,exact_text_sha256,normalized_statement,created_by) values($1,$2,$3,$4,'payment_terms','DEFINITION',$5,$6,'Cross matter.','ci-worker')`,[matter2.id,doc.id,termRun.id,chunk.id,lateExactText,lateExactHash]),error=>String(error.message).toLowerCase().includes("document must belong"));
    await expectFailure("sp_new_legacy_origin",()=>client.query(`insert into document_relations(matter_id,origin,source_document_id,target_document_id,relation_type,created_by) values($1,'LEGACY_UNATTESTED',$2,$3,'REFERENCES','ci-user')`,[matter.id,doc.id,doc2.id]),error=>String(error.message).includes("migration-only"));

    await client.query("update documents set source_status='EXECUTED' where id=$1",[doc.id]);
    const noEconomicsVersion=(await client.query(`insert into agreement_versions(matter_id,version_number,label,created_by) values($1,99,'CI no economics','ci-user') returning id`,[matter.id])).rows[0];
    await client.query(`insert into agreement_version_documents(agreement_version_id,document_id,included_by) values($1,$2,'ci-user')`,[noEconomicsVersion.id,doc.id]);
    await client.query("update agreement_versions set status='APPROVED' where id=$1",[noEconomicsVersion.id]);
    await expectFailure("sp_execution_without_validated_economics",()=>client.query("update agreement_versions set status='EXECUTED' where id=$1",[noEconomicsVersion.id]),error=>String(error.message).toLowerCase().includes("validated economics"));
    await client.query("update agreement_versions set status='SUPERSEDED' where id=$1",[noEconomicsVersion.id]);
    await client.query("update documents set extraction_status='FAILED' where id=$1",[doc.id]);
    await expectFailure("sp_execution_dirty_source",async()=>{
      await client.query("update agreement_versions set status='APPROVED' where id=$1",[version.id]);
      await client.query("update agreement_versions set status='EXECUTED' where id=$1",[version.id]);
    },error=>String(error.message).toLowerCase().includes("clean, extracted, hash-verified, and active"));
    await client.query("update documents set extraction_status='EXTRACTED' where id=$1",[doc.id]);

    const currentRejectedRun=(await client.query(`insert into analysis_runs(matter_id,document_id,run_type,status,model_name,prompt_version,schema_version,input_sha256,source_chunk_count,output_count,rejected_ungrounded_count,created_by,started_at,finished_at) values($1,$2,'CLAUSE_RISK','SUCCEEDED',$3,$4,$5,$6,1,0,1,'ci-worker','2098-01-01 00:00:00+00','2098-01-01 00:00:01+00') returning id`,[matter.id,doc.id,MODEL,CLAUSE_PROMPT,CLAUSE_SCHEMA,sourceInputHash])).rows[0];
    await expectFailure("sp_rejected_grounding_execution",async()=>{
      await client.query("update agreement_versions set status='APPROVED' where id=$1",[version.id]);
      await client.query("update agreement_versions set status='EXECUTED' where id=$1",[version.id]);
    },error=>String(error.message).includes("current clause-risk and term-extraction"));
    if(!currentRejectedRun)throw new Error("Rejected-grounding execution fixture creation failed.");
    const fallbackRun=(await client.query(`insert into analysis_runs(matter_id,document_id,run_type,status,model_name,prompt_version,schema_version,input_sha256,source_chunk_count,output_count,rejected_ungrounded_count,created_by,started_at,finished_at) values($1,$2,'CLAUSE_RISK','SUCCEEDED','deterministic-rules-fallback',$3,$4,$5,1,0,0,'ci-worker','2099-01-01 00:00:00+00','2099-01-01 00:00:01+00') returning id`,[matter.id,doc.id,CLAUSE_PROMPT,CLAUSE_SCHEMA,sourceInputHash])).rows[0];
    await attest({matterId:matter.id,scopeType:"CLAUSE_RISK",scopeId:fallbackRun.id});
    await expectFailure("sp_fallback_model_execution",async()=>{
      await client.query("update agreement_versions set status='APPROVED' where id=$1",[version.id]);
      await client.query("update agreement_versions set status='EXECUTED' where id=$1",[version.id]);
    },error=>String(error.message).includes("current clause-risk and term-extraction"));
    const currentRiskRun=(await client.query(`insert into analysis_runs(matter_id,document_id,run_type,status,model_name,prompt_version,schema_version,input_sha256,source_chunk_count,rejected_ungrounded_count,created_by,started_at) values($1,$2,'CLAUSE_RISK','RUNNING',$3,$4,$5,$6,1,0,'ci-worker','2100-01-01 00:00:00+00') returning id`,[matter.id,doc.id,MODEL,CLAUSE_PROMPT,CLAUSE_SCHEMA,sourceInputHash])).rows[0];
    const currentApprovalFinding=(await client.query(`insert into findings(matter_id,document_id,analysis_run_id,clause_family,issue,risk_level,rationale,source_excerpt,approval_required,review_status,created_by,reviewed_by,reviewed_at,review_note) values($1,$2,$3,'payment_terms','Current CI approval finding','High','Current validated approval issue.',$4,'CFO approval','VALIDATED','ci-worker','ci-lawyer','2100-01-01 00:00:00.500000+00','Validated against the current clause-risk run for authority testing.') returning id`,[matter.id,doc.id,currentRiskRun.id,quoteA])).rows[0];
    await client.query("update analysis_runs set status='SUCCEEDED',output_count=1,finished_at='2100-01-01 00:00:01+00' where id=$1",[currentRiskRun.id]);
    await attest({matterId:matter.id,scopeType:"CLAUSE_RISK",scopeId:currentRiskRun.id});
    await expectFailure("sp_wrong_version_graph_receipts",async()=>{
      await client.query("update agreement_versions set status='APPROVED' where id=$1",[version.id]);
      const temporaryAuthority=(await client.query(`insert into decisions(matter_id,agreement_version_id,finding_id,decision_type,rationale,requested_by,required_approver_role) values($1,$2,$3,'ACCEPT','Temporary legacy authority for graph-gate isolation.','ci-temporary-requester','APPROVER') returning id`,[matter.id,version.id,currentApprovalFinding.id])).rows[0];
      await client.query("update decisions set decision_status=$2,decided_by=$3,decided_at=now() where id=$1",[temporaryAuthority.id,"APPROVED","ci-approver"]);
      await client.query("update agreement_versions set status='EXECUTED' where id=$1",[version.id]);
    },error=>String(error.message).includes("exact current version term runs"));

    const dependencyJob1=(await client.query(`insert into processing_jobs(matter_id,job_type,status,idempotency_key,input,created_by,started_at,locked_by,locked_at,lease_generation,last_heartbeat_at,lease_expires_at) values($1,'DEPENDENCY','RUNNING',$2,$3::jsonb,'ci-worker',now(),'ci-worker',now(),1,now(),now()+interval '15 minutes') returning id`,[matter.id,`ci-dependency-reviewed-reject-${randomUUID()}`,JSON.stringify({agreementVersionId:version.id,sourceDocumentIds:[doc.id],sourceTermAnalysisRunIds:[termRun.id],graphVersion:GRAPH_VERSION,termAnalysisRunId:termRun.id})])).rows[0];
    await expectFailure("sp_dependency_review_authority",async()=>{
      const dependency=(await client.query(`insert into term_dependencies(matter_id,processing_job_id,origin,source_term_id,target_term_id,dependency_type,rationale,confidence,created_by) values($1,$2,'MODEL',$3,$4,'TRIGGERS','Unauthorized dependency review fixture.',1,'ci-worker') returning id`,[matter.id,dependencyJob1.id,correctedTerm.id,remedyTerm.id])).rows[0];
      await client.query("update term_dependencies set review_status='VALIDATED',reviewed_by='ci-unappointed-lawyer',reviewed_at=now(),review_note='This reviewer lacks appointed counsel authority.' where id=$1",[dependency.id]);
    },error=>String(error.message).includes("LEGAL_COUNSEL_ATTEST"));
    const rejectedDependency=(await client.query(`insert into term_dependencies(matter_id,processing_job_id,origin,source_term_id,target_term_id,dependency_type,rationale,confidence,review_status,created_by,reviewed_by,reviewed_at,review_note) values($1,$2,'MODEL',$3,$4,'TRIGGERS','Payment default may trigger suspension.',1,'REJECTED','ci-worker','ci-lawyer','2026-08-08 14:00:00.123456+00','Counsel rejected this proposed dependency.') returning id`,[matter.id,dependencyJob1.id,correctedTerm.id,remedyTerm.id])).rows[0];
    await client.query("update processing_jobs set status='SUCCEEDED',output=$2::jsonb,finished_at=now(),locked_by=null,locked_at=null,last_heartbeat_at=null,lease_expires_at=null where id=$1",[dependencyJob1.id,JSON.stringify({dependencyCount:1,objectIds:[rejectedDependency.id],rawCandidateCount:1,rejectedCandidateCount:0,modelName:MODEL,promptVersion:DEPENDENCY_PROMPT,schemaVersion:DEPENDENCY_SCHEMA,termAnalysisRunId:termRun.id,sourceDocumentIds:[doc.id],sourceRunIds:[termRun.id],inputHash:depHash})]);
    await attest({matterId:matter.id,scopeType:"DEPENDENCY",scopeId:dependencyJob1.id});

    const dependencyJob2=(await client.query(`insert into processing_jobs(matter_id,job_type,status,idempotency_key,input,created_by,started_at,locked_by,locked_at,lease_generation,last_heartbeat_at,lease_expires_at) values($1,'DEPENDENCY','RUNNING',$2,$3::jsonb,'ci-worker',now(),'ci-worker',now(),1,now(),now()+interval '15 minutes') returning id`,[matter.id,`ci-dependency-corrected-${randomUUID()}`,JSON.stringify({agreementVersionId:version.id,sourceDocumentIds:[doc.id],sourceTermAnalysisRunIds:[termRun.id],graphVersion:GRAPH_VERSION,termAnalysisRunId:termRun.id})])).rows[0];
    const correctedDependency=(await client.query(`insert into term_dependencies(matter_id,processing_job_id,origin,source_term_id,target_term_id,dependency_type,rationale,confidence,review_status,created_by,reviewed_by,reviewed_at,review_note) values($1,$2,'MODEL',$3,$4,'TRIGGERS','Payment default may trigger suspension.',1,'VALIDATED','ci-worker','ci-lawyer','2026-08-08 14:01:00.654321+00','Counsel validated the corrected dependency.') returning id`,[matter.id,dependencyJob2.id,correctedTerm.id,remedyTerm.id])).rows[0];
    if(!correctedDependency)throw new Error("A REJECTED prior graph row suppressed corrected new-job output.");
    const sameJobDuplicate=await client.query(`insert into term_dependencies(matter_id,processing_job_id,origin,source_term_id,target_term_id,dependency_type,rationale,confidence,created_by) values($1,$2,'MODEL',$3,$4,'TRIGGERS','Duplicate edge.',1,'ci-worker')`,[matter.id,dependencyJob2.id,correctedTerm.id,remedyTerm.id]);
    if(sameJobDuplicate.rowCount!==0)throw new Error("Same-job dependency deduplication failed.");
    await client.query("update processing_jobs set status='SUCCEEDED',output=$2::jsonb,finished_at=now(),locked_by=null,locked_at=null,last_heartbeat_at=null,lease_expires_at=null where id=$1",[dependencyJob2.id,JSON.stringify({dependencyCount:1,objectIds:[correctedDependency.id],rawCandidateCount:1,rejectedCandidateCount:0,modelName:MODEL,promptVersion:DEPENDENCY_PROMPT,schemaVersion:DEPENDENCY_SCHEMA,termAnalysisRunId:termRun.id,sourceDocumentIds:[doc.id],sourceRunIds:[termRun.id],inputHash:depHash})]);
    await attest({matterId:matter.id,scopeType:"DEPENDENCY",scopeId:dependencyJob2.id});

    const maskedJob=(await client.query(`insert into processing_jobs(matter_id,job_type,status,idempotency_key,input,created_by,started_at,locked_by,locked_at,lease_generation,last_heartbeat_at,lease_expires_at) values($1,'DEPENDENCY','RUNNING',$2,$3::jsonb,'ci-worker',now(),'ci-worker',now(),1,now(),now()+interval '15 minutes') returning id`,[matter.id,`ci-dependency-masked-${randomUUID()}`,JSON.stringify({agreementVersionId:version.id,sourceDocumentIds:[doc.id],sourceTermAnalysisRunIds:[termRun.id],graphVersion:GRAPH_VERSION,termAnalysisRunId:termRun.id})])).rows[0];
    const maskedDependency=(await client.query(`insert into term_dependencies(matter_id,processing_job_id,origin,source_term_id,target_term_id,dependency_type,rationale,confidence,review_status,created_by,reviewed_by,reviewed_at,review_note) values($1,$2,'MODEL',$3,$4,'REQUIRES','Masked output row.',1,'VALIDATED','ci-worker','ci-lawyer','2026-08-08 14:02:00.111111+00','Validated row must appear in receipt object IDs.') returning id`,[matter.id,maskedJob.id,correctedTerm.id,remedyTerm.id])).rows[0];
    await client.query("update processing_jobs set status='SUCCEEDED',output=$2::jsonb,finished_at=now(),locked_by=null,locked_at=null,last_heartbeat_at=null,lease_expires_at=null where id=$1",[maskedJob.id,JSON.stringify({dependencyCount:0,objectIds:[],rawCandidateCount:0,rejectedCandidateCount:0,modelName:MODEL,promptVersion:DEPENDENCY_PROMPT,schemaVersion:DEPENDENCY_SCHEMA,termAnalysisRunId:termRun.id,sourceDocumentIds:[doc.id],sourceRunIds:[termRun.id],inputHash:depHash})]);
    await expectFailure("sp_zero_masks_job_rows",()=>attest({matterId:matter.id,scopeType:"DEPENDENCY",scopeId:maskedJob.id}),error=>String(error.message).toLowerCase().includes("identities/count"));
    if(!maskedDependency)throw new Error("Masked-row fixture creation failed.");

    const precedenceJob=await createGraphJob({matterId:matter.id,agreementVersionId:version.id,scopeType:"PRECEDENCE",documentIds:[doc.id],runIds:[termRun.id],inputHash:precHash,objectIds:[],rawCount:0,rejectedCount:0});
    await attest({matterId:matter.id,scopeType:"PRECEDENCE",scopeId:precedenceJob.id});

    const matterEvidence=(await client.query("select m.matter_number,c.name customer,m.agreement_title,m.region,m.annual_revenue,m.stage,m.risk_level,m.status,m.updated_at::text updated_at from matters m join customers c on c.id=m.customer_id where m.id=$1",[matter.id])).rows[0];
    const sourceAuditId=(await client.query("select coalesce(max(id)::text,'0') id from audit_events where matter_id=$1",[matter.id])).rows[0].id;
    const baseRelianceEvidence={legalRelianceEnabled:true,legalRelianceReady:true,enginePoliciesReady:true,validation:{id:randomUUID()}};
    const matterContext={matterId:matter.id,matterNumber:matterEvidence.matter_number,customer:matterEvidence.customer,agreementTitle:matterEvidence.agreement_title,region:matterEvidence.region,annualRevenue:String(matterEvidence.annual_revenue),stage:matterEvidence.stage,riskLevel:matterEvidence.risk_level,status:matterEvidence.status,updatedAt:String(matterEvidence.updated_at)};
    const nextSteps=["Complete authorized execution and freeze the executed agreement version."];
    const createSnapshotReceipt=async(snapshotVersion,{economicsRunId=economics.id,decisions=[],executiveDecisions=[],badTerminal=false,badMatter=false,badProjection=false,agreementProtocolOverride,legacyNonReliance=false}={})=>{
      const agreementEvidence=(await client.query("select id,matter_id,version_number,label,status,effective_date::text effective_date,created_by,created_at::text created_at,authoritative_economics_run_id,authoritative_economics_selected_by,authoritative_economics_selected_at::text authoritative_economics_selected_at,evidence_protocol_version from agreement_versions where id=$1",[version.id])).rows[0];
      if(agreementProtocolOverride!==undefined)agreementEvidence.evidence_protocol_version=agreementProtocolOverride;
      const economicsEvidence=(await client.query("select id,matter_id,agreement_version_id,inputs,outputs,formula_version,review_status,reviewed_by,reviewed_at::text reviewed_at,review_note,created_by,created_at::text created_at from economics_runs where id=$1",[economicsRunId])).rows[0];
      const relianceEvidence=legacyNonReliance?{...baseRelianceEvidence,evidenceProtocolReliance:"LEGACY_NON_RELIANCE"}:baseRelianceEvidence;
      const relianceEvidenceHash=stateHash(relianceEvidence);
      const snapshotJob=(await client.query(`insert into processing_jobs(matter_id,job_type,status,idempotency_key,input,created_by,started_at,locked_by,locked_at,lease_generation,last_heartbeat_at,lease_expires_at) values($1,'EXECUTIVE_SUMMARY','RUNNING',$2,$3::jsonb,'ci-admin',now(),'ci-admin',now(),1,now(),now()+interval '15 minutes') returning id`,[matter.id,`ci-snapshot-${randomUUID()}`,JSON.stringify({requestedBy:"ci-admin",requestedAgreementVersionId:version.id,requestedEconomicsRunId:economicsRunId,requestedAuditId:sourceAuditId,requestedRelianceEvidence:relianceEvidence,requestedRelianceHash:relianceEvidenceHash})])).rows[0];
      const publicationReceipt={jobId:snapshotJob.id,requesterId:"ci-admin",agreementVersionId:version.id,economicsRunId:economicsRunId,sourceAuditId,relianceEvidenceHash};
      const snapshotPresentation={topRisks:[],quantifiedExposure:economicsEvidence,dependencies:[],negotiationActions:[],executiveDecisions,nextSteps};
      const frozenMatterContext=badMatter?{...matterContext,customer:"Forged customer context"}:matterContext;
      const manifest={matterContext:frozenMatterContext,agreement:agreementEvidence,documents:[{id:doc.id}],sourceChunks:[{id:chunk.id}],analysisRuns:[],analysisReviewAttestations:[],dependencyReceipt:{},precedenceReceipt:{},findings:[],governedStandards:[],terms:[],dependencies:[],relations:[],economics:economicsEvidence,decisions,relianceEvidence,publicationReceipt,snapshotPresentation};
      const manifestCanonical=canonicalJson(manifest);const sourceStateHash=createHash("sha256").update(manifestCanonical,"utf8").digest("hex");
      const storedExecutiveDecisions=badProjection?[]:executiveDecisions;
      const snapshot=(await client.query(`insert into executive_snapshots(matter_id,agreement_version_id,processing_job_id,snapshot_version,matter_context,source_manifest,source_manifest_canonical,top_risks,quantified_exposure,dependencies,negotiation_actions,executive_decisions,next_steps,source_state_hash,generated_by) values($1,$2,$3,$4,$5::jsonb,$6::jsonb,$7,($6::jsonb)#>'{snapshotPresentation,topRisks}',($6::jsonb)#>'{snapshotPresentation,quantifiedExposure}',($6::jsonb)#>'{snapshotPresentation,dependencies}',($6::jsonb)#>'{snapshotPresentation,negotiationActions}',$9::jsonb,($6::jsonb)#>'{snapshotPresentation,nextSteps}',$8,'ci-admin') returning id`,[matter.id,version.id,snapshotJob.id,snapshotVersion,JSON.stringify(frozenMatterContext),manifestCanonical,manifestCanonical,sourceStateHash,JSON.stringify(storedExecutiveDecisions)])).rows[0];
      const terminalOutput={snapshotId:snapshot.id,snapshotVersion,agreementVersionId:version.id,economicsRunId,requesterId:"ci-admin",sourceAuditId,sourceStateHash,relianceEvidenceHash};
      if(badTerminal)delete terminalOutput.sourceAuditId;
      return {snapshot,snapshotJob,terminalOutput};
    };

    await client.query("savepoint sp_protocol0_expand_compatibility");
    try{
      await client.query("update agreement_versions set status='APPROVED' where id=$1",[version.id]);
      const legacyDecision=(await client.query(`insert into decisions(matter_id,agreement_version_id,finding_id,decision_type,rationale,requested_by,required_approver_role) values($1,$2,$3,'ACCEPT','Legacy writer expand-phase compatibility evidence.','ci-legacy-requester','APPROVER') returning id`,[matter.id,version.id,currentApprovalFinding.id])).rows[0];
      await client.query("update decisions set decision_status=$2,decided_by=$3,decided_at=now() where id=$1",[legacyDecision.id,"APPROVED","ci-approver"]);
      const recordedLegacyDecision=(await client.query("select decision_status,evidence_protocol_version,economics_run_id,disposition_note from decisions where id=$1",[legacyDecision.id])).rows[0];
      if(recordedLegacyDecision?.decision_status!=="APPROVED"||recordedLegacyDecision?.evidence_protocol_version!==0||recordedLegacyDecision?.economics_run_id!==null||recordedLegacyDecision?.disposition_note!==null)throw new Error("The exact legacy writer did not remain an explicit protocol-0 non-reliance record.");
      const legacyDecisionEvidence=(await client.query("select id,matter_id,agreement_version_id,finding_id,decision_type,decision_status,rationale,requested_by,required_approver_role,decided_by,decided_at::text decided_at,disposition_note,economics_run_id,evidence_protocol_version from decisions where id=$1",[legacyDecision.id])).rows;
      const legacySnapshotReceipt=await createSnapshotReceipt(90,{decisions:legacyDecisionEvidence,executiveDecisions:[],legacyNonReliance:true});
      await client.query("update processing_jobs set status='SUCCEEDED',output=$2::jsonb,error_message=null,finished_at=now(),locked_by=null,locked_at=null,last_heartbeat_at=null,lease_expires_at=null where id=$1",[legacySnapshotReceipt.snapshotJob.id,JSON.stringify(legacySnapshotReceipt.terminalOutput)]);
      const legacySnapshotVerified=(await client.query("select executive_snapshot_receipt_verified($1) verified",[legacySnapshotReceipt.snapshot.id])).rows[0];
      if(legacySnapshotVerified.verified!==true)throw new Error("Protocol-0 rolling-upgrade snapshot compatibility did not verify.");
      await client.query("update agreement_versions set status='EXECUTED' where id=$1",[version.id]);
      const legacyExecution=(await client.query("select status,evidence_protocol_version,authoritative_economics_run_id from agreement_versions where id=$1",[version.id])).rows[0];
      if(legacyExecution?.status!=="EXECUTED"||legacyExecution?.evidence_protocol_version!==0||legacyExecution?.authoritative_economics_run_id!==null)throw new Error("Protocol-0 execution compatibility was not preserved as an explicit non-reliance state.");
    }finally{
      await client.query("rollback to savepoint sp_protocol0_expand_compatibility");
      await client.query("release savepoint sp_protocol0_expand_compatibility");
    }

    await expectFailure("sp_preselect_working_economics",()=>client.query("update agreement_versions set authoritative_economics_run_id=$2,authoritative_economics_selected_by='ci-approver',authoritative_economics_selected_at=now(),evidence_protocol_version=1 where id=$1",[version.id,economics.id]),error=>String(error.message).toLowerCase().includes("only while locking"));
    await expectFailure("sp_incomplete_authoritative_selection",()=>client.query("update agreement_versions set status='APPROVED',authoritative_economics_run_id=$2,evidence_protocol_version=1 where id=$1",[version.id,economics.id]),error=>String(error.message).toLowerCase().includes("requires explicitly selected authoritative economics"));
    await client.query("update agreement_versions set status='APPROVED',authoritative_economics_run_id=$2,authoritative_economics_selected_by='ci-approver',authoritative_economics_selected_at='2026-08-08 15:00:00.123456+00',evidence_protocol_version=1 where id=$1",[version.id,economics.id]);
    const authoritativeSelection=(await client.query("select status,authoritative_economics_run_id,authoritative_economics_selected_by,authoritative_economics_selected_at,evidence_protocol_version from agreement_versions where id=$1",[version.id])).rows[0];
    if(authoritativeSelection?.status!=="APPROVED"||authoritativeSelection?.authoritative_economics_run_id!==economics.id||authoritativeSelection?.authoritative_economics_selected_by!=="ci-approver"||!authoritativeSelection?.authoritative_economics_selected_at||authoritativeSelection?.evidence_protocol_version!==1)throw new Error("Atomic protocol-1 agreement lock did not persist the exact authoritative economics selection evidence.");
    await expectFailure("sp_authoritative_economics_immutable",()=>client.query("update agreement_versions set authoritative_economics_run_id=$2 where id=$1",[version.id,sensitivityEconomics.id]),error=>String(error.message).toLowerCase().includes("immutable"));
    await expectFailure("sp_authoritative_selector_immutable",()=>client.query("update agreement_versions set authoritative_economics_selected_by='ci-admin' where id=$1",[version.id]),error=>String(error.message).toLowerCase().includes("immutable"));
    await expectFailure("sp_authoritative_selection_time_immutable",()=>client.query("update agreement_versions set authoritative_economics_selected_at=now() where id=$1",[version.id]),error=>String(error.message).toLowerCase().includes("immutable"));
    await expectFailure("sp_agreement_protocol_downgrade",()=>client.query("update agreement_versions set evidence_protocol_version=0 where id=$1",[version.id]),error=>String(error.message).toLowerCase().includes("cannot be downgraded"));
    await expectFailure("sp_frozen_membership",()=>client.query("delete from agreement_version_documents where agreement_version_id=$1 and document_id=$2",[version.id,doc.id]),error=>String(error.message).toLowerCase().includes("immutable"));

    const decision=(await client.query(`insert into decisions(matter_id,agreement_version_id,decision_type,rationale,requested_by,required_approver_role) values($1,$2,'ACCEPT','Synthetic affirmative version decision.','ci-requester','APPROVER') returning id`,[matter.id,version.id])).rows[0];
    const condition=(await client.query(`insert into decision_conditions(matter_id,agreement_version_id,decision_id,sequence_number,condition_text,created_by) values($1,$2,$3,1,'Obtain documented customer confirmation.','ci-requester') returning id`,[matter.id,version.id,decision.id])).rows[0];
    await expectFailure("sp_condition_before_approval",()=>client.query("update decision_conditions set condition_status='SATISFIED',evidence='Premature customer confirmation evidence.',resolved_by='ci-approver',resolved_at=now() where id=$1",[condition.id]),error=>String(error.message).includes("only after"));
    await expectFailure("sp_decision_economics_required",()=>client.query("update decisions set decision_status='APPROVED',decided_by='ci-approver',decided_at=now(),disposition_note='Economics evidence is deliberately omitted.',evidence_protocol_version=1 where id=$1",[decision.id]),error=>String(error.message).toLowerCase().includes("exact validated economics evidence"));
    await expectFailure("sp_self_decision",()=>client.query("update decisions set decision_status='APPROVED',decided_by='ci-requester',decided_at=now(),disposition_note='Requester cannot self approve this packet.',economics_run_id=$2,evidence_protocol_version=1 where id=$1",[decision.id,economics.id]),error=>String(error.message).toLowerCase().includes("independent"));
    await expectFailure("sp_decision_disposition_note",()=>client.query("update decisions set decision_status='APPROVED',decided_by='ci-approver',decided_at=now(),economics_run_id=$2,evidence_protocol_version=1 where id=$1",[decision.id,economics.id]),error=>String(error.message).toLowerCase().includes("substantive note"));
    const decisionDispositionNote="Approved after independent review of the exact authoritative economics packet.";
    await client.query("update decisions set decision_status='APPROVED',decided_by='ci-approver',decided_at=now(),disposition_note=$2,economics_run_id=$3,evidence_protocol_version=1 where id=$1",[decision.id,decisionDispositionNote,economics.id]);
    const recordedDecision=(await client.query("select disposition_note,economics_run_id,evidence_protocol_version from decisions where id=$1",[decision.id])).rows[0];
    if(recordedDecision?.disposition_note!==decisionDispositionNote||recordedDecision?.economics_run_id!==economics.id||recordedDecision?.evidence_protocol_version!==1)throw new Error("Protocol-1 decision evidence was not persisted exactly.");
    await expectFailure("sp_duplicate_null_scope_authority",async()=>{
      const duplicate=(await client.query(`insert into decisions(matter_id,agreement_version_id,decision_type,rationale,requested_by,required_approver_role) values($1,$2,'APPROVE_EXCEPTION','Competing null-scope authority.','ci-requester-duplicate','APPROVER') returning id`,[matter.id,version.id])).rows[0];
      await client.query("update decisions set decision_status='APPROVED',decided_by='ci-approver',decided_at=now(),disposition_note='This competing effective authority must be rejected.',economics_run_id=$2,evidence_protocol_version=1 where id=$1",[duplicate.id,economics.id]);
    },error=>String(error.message).toLowerCase().includes("only one effective approved disposition"));
    await expectFailure("sp_condition_after_approval",()=>client.query(`insert into decision_conditions(matter_id,agreement_version_id,decision_id,sequence_number,condition_text,created_by) values($1,$2,$3,2,'Late approval condition.','ci-requester')`,[matter.id,version.id,decision.id]),error=>String(error.message).includes("only while the decision is PENDING"));
    await expectFailure("sp_condition_evidence",()=>client.query("update decision_conditions set condition_status='SATISFIED',resolved_by='ci-approver',resolved_at=now() where id=$1",[condition.id]),error=>String(error.message).toLowerCase().includes("substantive evidence"));
    await client.query("update decision_conditions set condition_status='SATISFIED',evidence='Customer confirmation is recorded in the matter file.',resolved_by='ci-approver',resolved_at=now() where id=$1",[condition.id]);
    await expectFailure("sp_condition_terminal",()=>client.query("update decision_conditions set evidence='Changed after resolution.' where id=$1",[condition.id]),error=>String(error.message).toLowerCase().includes("immutable"));
    await expectFailure("sp_terminal_decision",()=>client.query("update decisions set rationale='Tampered after approval' where id=$1",[decision.id]),error=>String(error.message).toLowerCase().includes("immutable"));
    await expectFailure("sp_terminal_decision_note",()=>client.query("update decisions set disposition_note='Changed after approval.' where id=$1",[decision.id]),error=>String(error.message).toLowerCase().includes("immutable"));

    const waiverDecision=(await client.query(`insert into decisions(matter_id,agreement_version_id,finding_id,decision_type,rationale,requested_by,required_approver_role) values($1,$2,$3,'ACCEPT','Waiver authority test','ci-requester-4','ADMIN') returning id`,[matter.id,version.id,finding.id])).rows[0];
    const waiverCondition=(await client.query(`insert into decision_conditions(matter_id,agreement_version_id,decision_id,sequence_number,condition_text,created_by) values($1,$2,$3,1,'Admin must document any waiver.','ci-requester-4') returning id`,[matter.id,version.id,waiverDecision.id])).rows[0];
    await client.query("update decisions set decision_status='APPROVED',decided_by='ci-admin',decided_at=now(),disposition_note='Admin approved the documented waiver authority packet.',economics_run_id=$2,evidence_protocol_version=1 where id=$1",[waiverDecision.id,economics.id]);
    await expectFailure("sp_nonadmin_waiver",()=>client.query("update decision_conditions set condition_status='WAIVED',evidence='Approver attempted an unauthorized waiver.',resolved_by='ci-approver',resolved_at=now() where id=$1",[waiverCondition.id]),error=>String(error.message).includes("active Admin"));
    await client.query("update decision_conditions set condition_status='WAIVED',evidence='Admin waiver is documented with approved authority.',resolved_by='ci-admin',resolved_at=now() where id=$1",[waiverCondition.id]);

    const wrongEconomicsDecision=(await client.query(`insert into decisions(matter_id,agreement_version_id,decision_type,rationale,requested_by,required_approver_role) values($1,$2,'ESCALATE','Exact economics scope regression','ci-requester-5','APPROVER') returning id`,[matter.id,moveTarget.id])).rows[0];
    await expectFailure("sp_wrong_version_decision_economics",()=>client.query("update decisions set decision_status='APPROVED',decided_by='ci-approver',decided_at=now(),disposition_note='Wrong-version economics must not authorize this decision.',economics_run_id=$2,evidence_protocol_version=1 where id=$1",[wrongEconomicsDecision.id,economics.id]),error=>String(error.message).toLowerCase().includes("exact same matter and agreement version"));
    await client.query("update decisions set decision_status='WITHDRAWN' where id=$1",[wrongEconomicsDecision.id]);
    const scopedDecision=(await client.query(`insert into decisions(matter_id,agreement_version_id,decision_type,rationale,requested_by,required_approver_role) values($1,$2,'ESCALATE','Immutable scope regression','ci-requester-3','APPROVER') returning id`,[matter.id,version.id])).rows[0];
    await client.query(`insert into decision_conditions(matter_id,agreement_version_id,decision_id,sequence_number,condition_text,created_by) values($1,$2,$3,1,'Preserve the originally authorized agreement scope.','ci-requester-3')`,[matter.id,version.id,scopedDecision.id]);
    await expectFailure("sp_move_decision_version",()=>client.query("update decisions set agreement_version_id=$2 where id=$1",[scopedDecision.id,moveTarget.id]),error=>String(error.message).toLowerCase().includes("scope are immutable"));
    await client.query("update decisions set decision_status='WITHDRAWN' where id=$1",[scopedDecision.id]);

    const rejectedAcceptance=(await client.query(`insert into decisions(matter_id,agreement_version_id,finding_id,decision_type,rationale,requested_by,required_approver_role) values($1,$2,$3,'ACCEPT','Test rejected acceptance authority','ci-requester-rejected','APPROVER') returning id`,[matter.id,version.id,currentApprovalFinding.id])).rows[0];
    await expectFailure("sp_execution_pending_decision",()=>client.query("update agreement_versions set status='EXECUTED' where id=$1",[version.id]),error=>String(error.message).toLowerCase().includes("pending version-scoped decisions"));
    await client.query("update decisions set decision_status='REJECTED',decided_by='ci-approver',decided_at=now(),disposition_note='Rejected because the requested risk acceptance is unsupported.',economics_run_id=$2,evidence_protocol_version=1 where id=$1",[rejectedAcceptance.id,economics.id]);
    await expectFailure("sp_execution_rejected_acceptance",()=>client.query("update agreement_versions set status='EXECUTED' where id=$1",[version.id]),error=>String(error.message).toLowerCase().includes("affirmative authority"));
    const approvedAcceptance=(await client.query(`insert into decisions(matter_id,agreement_version_id,finding_id,decision_type,rationale,requested_by,required_approver_role) values($1,$2,$3,'ACCEPT','Test affirmative version authority','ci-requester-2','APPROVER') returning id`,[matter.id,version.id,currentApprovalFinding.id])).rows[0];
    const executionCondition=(await client.query(`insert into decision_conditions(matter_id,agreement_version_id,decision_id,sequence_number,condition_text,created_by) values($1,$2,$3,1,'Obtain the documented executive risk acknowledgment.','ci-requester-2') returning id`,[matter.id,version.id,approvedAcceptance.id])).rows[0];
    await client.query("update decisions set decision_status='APPROVED',decided_by='ci-approver',decided_at=now(),disposition_note='Approved with the recorded executive acknowledgment condition.',economics_run_id=$2,evidence_protocol_version=1 where id=$1",[approvedAcceptance.id,economics.id]);
    await expectFailure("sp_duplicate_finding_scope_authority",async()=>{
      const duplicate=(await client.query(`insert into decisions(matter_id,agreement_version_id,finding_id,decision_type,rationale,requested_by,required_approver_role) values($1,$2,$3,'APPROVE_EXCEPTION','Competing finding authority.','ci-requester-finding-duplicate','APPROVER') returning id`,[matter.id,version.id,currentApprovalFinding.id])).rows[0];
      await client.query("update decisions set decision_status='APPROVED',decided_by='ci-approver',decided_at=now(),disposition_note='This competing finding disposition must be rejected.',economics_run_id=$2,evidence_protocol_version=1 where id=$1",[duplicate.id,economics.id]);
    },error=>String(error.message).toLowerCase().includes("only one effective approved disposition"));
    await expectFailure("sp_execution_pending_condition",()=>client.query("update agreement_versions set status='EXECUTED' where id=$1",[version.id]),error=>String(error.message).toLowerCase().includes("pending effective approved-decision conditions"));
    await client.query("update decision_conditions set condition_status='SATISFIED',evidence='Executive risk acknowledgment is attached to the approved matter record.',resolved_by='ci-approver',resolved_at=now() where id=$1",[executionCondition.id]);

    const allDecisionEvidence=(await client.query("select id,matter_id,agreement_version_id,finding_id,decision_type,decision_status,rationale,requested_by,requested_at::text requested_at,required_approver_role,decided_by,decided_at::text decided_at,disposition_note,economics_run_id,evidence_protocol_version from decisions where agreement_version_id=$1 order by requested_at,id",[version.id])).rows;
    const effectiveAuthorityProjection=allDecisionEvidence.filter(row=>row.decision_status==="APPROVED"&&row.evidence_protocol_version>=1&&row.economics_run_id===economics.id&&["ACCEPT","APPROVE_EXCEPTION"].includes(row.decision_type)).map(row=>({...row,projection_status:"EFFECTIVE_AUTHORITY"}));
    if(effectiveAuthorityProjection.length<3)throw new Error("The protocol-1 snapshot fixture did not construct the expected effective-authority projection.");
    await expectFailure("sp_snapshot_forged_matter_context",()=>createSnapshotReceipt(1,{decisions:allDecisionEvidence,executiveDecisions:effectiveAuthorityProjection,badMatter:true}),error=>String(error.message).includes("exact locked matter and customer state"));
    await expectFailure("sp_snapshot_protocol_downgrade",()=>createSnapshotReceipt(1,{decisions:allDecisionEvidence,executiveDecisions:effectiveAuthorityProjection,agreementProtocolOverride:0}),error=>String(error.message).includes("Protocol-1 executive snapshots"));
    await expectFailure("sp_snapshot_non_authoritative_economics",()=>createSnapshotReceipt(1,{economicsRunId:sensitivityEconomics.id,decisions:allDecisionEvidence,executiveDecisions:effectiveAuthorityProjection}),error=>String(error.message).includes("Protocol-1 executive snapshots"));
    await expectFailure("sp_snapshot_projection_mismatch",()=>createSnapshotReceipt(1,{decisions:allDecisionEvidence,executiveDecisions:effectiveAuthorityProjection,badProjection:true}),error=>String(error.message).toLowerCase().includes("presentation"));
    const validSnapshotReceipt=await createSnapshotReceipt(1,{decisions:allDecisionEvidence,executiveDecisions:effectiveAuthorityProjection});
    await client.query("update processing_jobs set status='SUCCEEDED',output=$2::jsonb,error_message=null,finished_at=now(),locked_by=null,locked_at=null,last_heartbeat_at=null,lease_expires_at=null where id=$1",[validSnapshotReceipt.snapshotJob.id,JSON.stringify(validSnapshotReceipt.terminalOutput)]);
    const verifiedSnapshotReceipt=(await client.query("select executive_snapshot_receipt_verified($1) verified",[validSnapshotReceipt.snapshot.id])).rows[0];
    if(verifiedSnapshotReceipt.verified!==true)throw new Error("A complete protocol-1 authoritative executive-snapshot receipt did not verify on read.");
    await expectFailure("sp_snapshot_immutable",()=>client.query("update executive_snapshots set generated_by='tampered' where id=$1",[validSnapshotReceipt.snapshot.id]),error=>String(error.message).toLowerCase().includes("append-only"));
    const badTerminalReceipt=await createSnapshotReceipt(2,{decisions:allDecisionEvidence,executiveDecisions:effectiveAuthorityProjection,badTerminal:true});
    await expectFailure("sp_snapshot_terminal_receipt",()=>client.query("update processing_jobs set status='SUCCEEDED',output=$2::jsonb,error_message=null,finished_at=now(),locked_by=null,locked_at=null,last_heartbeat_at=null,lease_expires_at=null where id=$1",[badTerminalReceipt.snapshotJob.id,JSON.stringify(badTerminalReceipt.terminalOutput)]),error=>String(error.message).includes("terminal output does not bind"));
    const unverifiedRunningReceipt=(await client.query("select executive_snapshot_receipt_verified($1) verified",[badTerminalReceipt.snapshot.id])).rows[0];
    if(unverifiedRunningReceipt.verified!==false)throw new Error("A non-terminal snapshot receipt was treated as verified.");

    await expectFailure("sp_execution_negative_effective_disposition",async()=>{
      const negativeDecision=(await client.query(`insert into decisions(matter_id,agreement_version_id,finding_id,decision_type,rationale,requested_by,required_approver_role) values($1,$2,$3,'NEGOTIATE','Negative execution disposition regression.','ci-requester-negative','APPROVER') returning id`,[matter.id,version.id,approvalFinding.id])).rows[0];
      await client.query("update decisions set decision_status='APPROVED',decided_by='ci-approver',decided_at=now(),disposition_note='Negotiation remains required before execution may proceed.',economics_run_id=$2,evidence_protocol_version=1 where id=$1",[negativeDecision.id,economics.id]);
      await client.query("update agreement_versions set status='EXECUTED' where id=$1",[version.id]);
    },error=>String(error.message).toLowerCase().includes("effective negotiate"));
    const stillAuthoritative=(await client.query("select authoritative_economics_run_id from agreement_versions where id=$1",[version.id])).rows[0];
    if(stillAuthoritative?.authoritative_economics_run_id!==economics.id)throw new Error("A later validated sensitivity run silently replaced the explicit authoritative economics selection.");
    await client.query("update agreement_versions set status='EXECUTED' where id=$1",[version.id]);

    const lateRiskRun=(await client.query(`insert into analysis_runs(matter_id,document_id,run_type,status,model_name,prompt_version,schema_version,input_sha256,source_chunk_count,created_by) values($1,$2,'CLAUSE_RISK','RUNNING',$3,$4,$5,$6,1,'ci-worker') returning id`,[matter.id,doc.id,MODEL,CLAUSE_PROMPT,CLAUSE_SCHEMA,sourceInputHash])).rows[0];
    await expectFailure("sp_post_execution_finding",()=>client.query(`insert into findings(matter_id,document_id,analysis_run_id,clause_family,issue,risk_level,rationale,source_excerpt,created_by) values($1,$2,$3,'payment_terms','Late output','High','Late.','Customer shall pay.','ci-worker')`,[matter.id,doc.id,lateRiskRun.id]),error=>String(error.message).includes("EXECUTED agreement version is frozen"));
    await expectFailure("sp_post_execution_chunk",()=>client.query("update document_chunks set content=$2,content_sha256=$3 where id=$1",[chunk.id,`${chunkText} tampered`,createHash("sha256").update(`${chunkText} tampered`).digest("hex")]),error=>String(error.message).includes("EXECUTED agreement version is frozen"));
    await expectFailure("sp_condition_after_execution",()=>client.query(`insert into decision_conditions(matter_id,agreement_version_id,decision_id,sequence_number,condition_text,created_by) values($1,$2,$3,2,'Late condition must not alter executed authority.','ci-user')`,[matter.id,version.id,approvedAcceptance.id]),error=>String(error.message).toLowerCase().includes("working or approved"));

    const successor=(await client.query(`insert into agreement_versions(matter_id,version_number,label,created_by) values($1,2,'CI successor','ci-user') returning id`,[matter.id])).rows[0];
    await client.query(`insert into agreement_version_documents(agreement_version_id,document_id,included_by) values($1,$2,'ci-user')`,[successor.id,doc.id]);
    await client.query("update agreement_versions set status='APPROVED' where id=$1",[successor.id]);
    const competingSuccessor=(await client.query(`insert into agreement_versions(matter_id,version_number,label,created_by) values($1,3,'CI competing successor','ci-user') returning id`,[matter.id])).rows[0];
    await client.query(`insert into agreement_version_documents(agreement_version_id,document_id,included_by) values($1,$2,'ci-user')`,[competingSuccessor.id,doc.id]);
    await expectFailure("sp_multiple_approved_successors",()=>client.query("update agreement_versions set status='APPROVED' where id=$1",[competingSuccessor.id]),error=>String(error.code)==="23505");

    await client.query(`insert into validation_cases(id,category,title,source_text,expected_families) values('ci-case','CI','CI validation','Synthetic source','[]'::jsonb)`);
    await expectFailure("sp_validation_terminal_insert_without_manifest",()=>client.query(`insert into validation_runs(run_label,model_name,prompt_version,corpus_version,status,total_cases,started_by,summary) values('Forged terminal',$1,$2,'ci-corpus','PASSED',1,'ci-admin',$3::jsonb)`,[MODEL,CLAUSE_PROMPT,JSON.stringify({resultCount:1,resultManifestHash:"0".repeat(64)})]),error=>String(error.message).toLowerCase().includes("canonical validation-result manifest"));
    const validationRun=(await client.query(`insert into validation_runs(run_label,model_name,prompt_version,corpus_version,status,total_cases,started_by,summary) values('CI manifest',$1,$2,'ci-corpus','RUNNING',1,'ci-admin','{}'::jsonb) returning id`,[MODEL,CLAUSE_PROMPT])).rows[0];
    const validationResult=(await client.query(`insert into validation_results(validation_run_id,validation_case_id,passed,detected_families,missing_families,prohibited_detected,grounded,notes,raw_result) values($1,'ci-case',true,'[]','[]','[]',true,'CI result','{}') returning id`,[validationRun.id])).rows[0];
    await expectFailure("sp_validation_bad_manifest",()=>client.query(`update validation_runs set status='PASSED',passed_cases=1,finished_at=now(),summary=$2::jsonb where id=$1`,[validationRun.id,JSON.stringify({resultCount:1,resultManifestHash:"0".repeat(64)})]),error=>String(error.message).toLowerCase().includes("canonical validation-result manifest"));
    const validationRows=(await client.query(`select validation_case_id,passed,detected_families,missing_families,prohibited_detected,grounded,notes,raw_result from validation_results where validation_run_id=$1 order by validation_case_id`,[validationRun.id])).rows;
    await client.query(`update validation_runs set status='PASSED',passed_cases=1,finished_at=now(),summary=$2::jsonb where id=$1`,[validationRun.id,JSON.stringify({resultCount:validationRows.length,resultManifestHash:stateHash(validationRows)})]);
    await expectFailure("sp_validation_child_insert_terminal",()=>client.query(`insert into validation_results(validation_run_id,validation_case_id,passed) values($1,'ci-case',true)`,[validationRun.id]),error=>String(error.message).toLowerCase().includes("immutable"));
    await expectFailure("sp_validation_child_update_terminal",()=>client.query("update validation_results set notes='tampered' where id=$1",[validationResult.id]),error=>String(error.message).toLowerCase().includes("immutable"));
    await expectFailure("sp_validation_child_delete_terminal",()=>client.query("delete from validation_results where id=$1",[validationResult.id]),error=>String(error.message).toLowerCase().includes("immutable"));

    await client.query("update matters set legal_hold=false where id=$1",[matter.id]);
    const purge=(await client.query(`insert into purge_requests(matter_id,document_id,requested_by,reason,status,approved_by,approved_at) values($1,$2,'ci-requester','Expired retention','APPROVED','ci-admin',now()) returning id`,[matter.id,doc.id])).rows[0];
    await client.query("update documents set deletion_status='PENDING_PURGE' where id=$1",[doc.id]);
    await expectFailure("sp_purge_cancel_uncertain",()=>client.query("update purge_requests set status='CANCELLED' where id=$1",[purge.id]),error=>String(error.message).toLowerCase().includes("external deletion"));

  }finally{await client.query("ROLLBACK");}
  await raceSafeCounselRelationUniqueness();
  console.log("Database integration controls passed: source/extraction lineage, run-only publication, microsecond review attestations, version-bound current-engine graph receipts, rejection-free zero-output handling, protocol-0 expand compatibility, protocol-1 authoritative economics and decision evidence, exact executive-snapshot projections, execution freeze/serialization, null/finding-scope authority uniqueness, terminal validation manifests, approved-successor uniqueness, legal holds, immutable evidence, and race-safe run-scoped graph idempotency.");
}finally{await client.end();}
