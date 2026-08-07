import pg from "pg";
const {Client}=pg;if(!process.env.DATABASE_URL)throw new Error("DATABASE_URL is required.");
const client=new Client({connectionString:process.env.DATABASE_URL,application_name:"contracttwin-db-control-test"});
await client.connect();
async function expectFailure(name,fn,predicate){await client.query(`SAVEPOINT ${name}`);let matched=false;try{await fn();}catch(error){matched=predicate(error);}finally{await client.query(`ROLLBACK TO SAVEPOINT ${name}`);await client.query(`RELEASE SAVEPOINT ${name}`);}if(!matched)throw new Error(`Expected database control failure did not occur: ${name}`);}
try{
  for(const table of ["user","session","account","verification","matters","documents","audit_events","negotiation_standards","contract_terms","processing_jobs"]){
    const r=await client.query("select to_regclass($1) name",[table]);
    if(!r.rows[0].name)throw new Error(`Required migrated table missing: ${table}`);
  }
  await client.query("BEGIN");
  try{
    const customer=(await client.query("insert into customers(name) values('CI Control Customer') returning id")).rows[0];
    const matter=(await client.query(`insert into matters(matter_number,customer_id,agreement_title,region,annual_revenue,owner_user_id,legal_hold,legal_hold_reason) values('CI-CONTROL-1',$1,'Synthetic Control Agreement','Americas',1,'ci-user',true,'CI hold test') returning id`,[customer.id])).rows[0];
    const doc=(await client.query(`insert into documents(matter_id,filename,document_type,mime_type,size_bytes,blob_url,blob_pathname,uploaded_by,legal_hold) values($1,'test.txt','OTHER','text/plain',4,'https://example.invalid/test','ci/test','ci-user',false) returning id`,[matter.id])).rows[0];
    await expectFailure("sp_hold",()=>client.query("update documents set deletion_status='PURGED' where id=$1",[doc.id]),error=>String(error.message).toLowerCase().includes("legal hold"));

    const audit=(await client.query(`insert into audit_events(actor_user_id,actor_name,action,matter_id,entity_type,entity_id,metadata) values('ci-user','CI User','CI_TEST',$1,'matter',$1,'{}'::jsonb) returning id`,[matter.id])).rows[0];
    await expectFailure("sp_audit",()=>client.query("update audit_events set actor_name='tampered' where id=$1",[audit.id]),error=>String(error.message).toLowerCase().includes("append-only"));

    await client.query(`insert into negotiation_standards(clause_family,title,standard_position,active,version,effective_date,created_by) values('ci_test_family','CI Standard 1','Position 1',true,'1','2026-01-01','ci-user')`);
    await expectFailure("sp_standard",()=>client.query(`insert into negotiation_standards(clause_family,title,standard_position,active,version,effective_date,created_by) values('ci_test_family','CI Standard 2','Position 2',true,'2','2026-02-01','ci-user')`),error=>String(error.code)==="23505");
    console.log("Database integration controls passed: auth schema, legal hold, append-only audit, active-standard uniqueness.");
  }finally{await client.query("ROLLBACK");}
}finally{await client.end();}
