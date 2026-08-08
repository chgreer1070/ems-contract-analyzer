-- Bind every newly generated executive snapshot to the exact authorized
-- EXECUTIVE_SUMMARY job that produced it. Existing rows remain readable as
-- explicit legacy evidence, but cannot satisfy the reliance receipt check.

alter table executive_snapshots
  add column if not exists processing_job_id uuid references processing_jobs(id) on delete restrict;

create unique index if not exists uq_executive_snapshot_processing_job
  on executive_snapshots(processing_job_id) where processing_job_id is not null;

create or replace function enforce_executive_snapshot_job_lineage() returns trigger as $$
declare
  source_job processing_jobs%rowtype;
  source_version agreement_versions%rowtype;
  source_economics economics_runs%rowtype;
  expected_reliance_hash text;
  requested_economics_id uuid;
  requester_role text;
  matter_owner text;
  matter_number text;
  customer_name text;
  matter_agreement_title text;
  matter_region text;
  matter_annual_revenue numeric(18,2);
  matter_stage text;
  matter_risk_level text;
  matter_status text;
  matter_updated_at timestamptz;
  requester_matter_access text;
  current_audit_id text;
begin
  if new.processing_job_id is null then
    raise exception 'New executive snapshots require an exact EXECUTIVE_SUMMARY processing-job receipt';
  end if;
  if new.agreement_version_id is null then
    raise exception 'New executive snapshots require an exact agreement-version binding';
  end if;
  if jsonb_typeof(new.source_manifest) is distinct from 'object' or
     jsonb_typeof(new.source_manifest->'matterContext') is distinct from 'object' or
     jsonb_typeof(new.source_manifest->'agreement') is distinct from 'object' or
     jsonb_typeof(new.source_manifest->'documents') is distinct from 'array' or
     jsonb_array_length(new.source_manifest->'documents')=0 or
     jsonb_typeof(new.source_manifest->'sourceChunks') is distinct from 'array' or
     jsonb_array_length(new.source_manifest->'sourceChunks')=0 or
     jsonb_typeof(new.source_manifest->'analysisRuns') is distinct from 'array' or
     jsonb_typeof(new.source_manifest->'analysisReviewAttestations') is distinct from 'array' or
     jsonb_typeof(new.source_manifest->'dependencyReceipt') is distinct from 'object' or
     jsonb_typeof(new.source_manifest->'precedenceReceipt') is distinct from 'object' or
     jsonb_typeof(new.source_manifest->'findings') is distinct from 'array' or
     jsonb_typeof(new.source_manifest->'governedStandards') is distinct from 'array' or
     jsonb_typeof(new.source_manifest->'terms') is distinct from 'array' or
     jsonb_typeof(new.source_manifest->'dependencies') is distinct from 'array' or
     jsonb_typeof(new.source_manifest->'relations') is distinct from 'array' or
     jsonb_typeof(new.source_manifest->'decisions') is distinct from 'array' or
     jsonb_typeof(new.source_manifest->'relianceEvidence') is distinct from 'object' or
     jsonb_typeof(new.source_manifest->'economics') is distinct from 'object' or
     jsonb_typeof(new.source_manifest->'publicationReceipt') is distinct from 'object' or
     jsonb_typeof(new.source_manifest->'snapshotPresentation') is distinct from 'object' then
    raise exception 'Executive snapshot receipt requires complete frozen source, reliance, economics, and presentation evidence';
  end if;
  if new.matter_context is distinct from new.source_manifest->'matterContext' or
     new.top_risks is distinct from new.source_manifest#>'{snapshotPresentation,topRisks}' or
     new.quantified_exposure is distinct from new.source_manifest#>'{snapshotPresentation,quantifiedExposure}' or
     new.dependencies is distinct from new.source_manifest#>'{snapshotPresentation,dependencies}' or
     new.negotiation_actions is distinct from new.source_manifest#>'{snapshotPresentation,negotiationActions}' or
     new.executive_decisions is distinct from new.source_manifest#>'{snapshotPresentation,executiveDecisions}' or
     new.next_steps is distinct from new.source_manifest#>'{snapshotPresentation,nextSteps}' then
    raise exception 'Executive snapshot presentation must be an exact projection of its frozen source manifest';
  end if;

  select * into source_job from processing_jobs where id=new.processing_job_id for update;
  if source_job.id is null or source_job.job_type<>'EXECUTIVE_SUMMARY' or source_job.status<>'RUNNING' or
     source_job.matter_id is distinct from new.matter_id or source_job.document_id is not null then
    raise exception 'Executive snapshot must be published by its same-matter RUNNING EXECUTIVE_SUMMARY job';
  end if;
  if source_job.input->>'requestedBy' is distinct from new.generated_by or
     source_job.created_by is distinct from new.generated_by or
     source_job.input->>'requestedAgreementVersionId' is distinct from new.agreement_version_id::text or
     coalesce(source_job.input->>'requestedAuditId','') !~ '^\d+$' then
    raise exception 'Executive snapshot requester or agreement-version lineage is invalid';
  end if;
  select coalesce(max(id)::text,'0') into current_audit_id from audit_events where matter_id=new.matter_id;
  if source_job.input->>'requestedAuditId' is distinct from current_audit_id or
     new.source_manifest#>>'{publicationReceipt,jobId}' is distinct from source_job.id::text or
     new.source_manifest#>>'{publicationReceipt,requesterId}' is distinct from new.generated_by or
     new.source_manifest#>>'{publicationReceipt,agreementVersionId}' is distinct from new.agreement_version_id::text or
     new.source_manifest#>>'{publicationReceipt,economicsRunId}' is distinct from source_job.input->>'requestedEconomicsRunId' or
     new.source_manifest#>>'{publicationReceipt,sourceAuditId}' is distinct from current_audit_id or
     new.source_manifest#>>'{publicationReceipt,relianceEvidenceHash}' is distinct from lower(source_job.input->>'requestedRelianceHash') then
    raise exception 'Executive snapshot publication receipt does not match its exact authorized source state';
  end if;
  select role into requester_role from app_user_roles
   where user_id=new.generated_by and active=true limit 1 for share;
  select m.owner_user_id,m.matter_number,c.name,m.agreement_title,m.region,m.annual_revenue,
         m.stage,m.risk_level,m.status,m.updated_at
    into matter_owner,matter_number,customer_name,matter_agreement_title,matter_region,matter_annual_revenue,
         matter_stage,matter_risk_level,matter_status,matter_updated_at
    from matters m join customers c on c.id=m.customer_id where m.id=new.matter_id for share of m,c;
  select mm.access_level into requester_matter_access from matter_members mm
   where mm.matter_id=new.matter_id and mm.user_id=new.generated_by for share;
  if requester_role is null or requester_role not in ('APPROVER','ADMIN') or
     (requester_role<>'ADMIN' and matter_owner is distinct from new.generated_by and requester_matter_access is distinct from 'APPROVE') then
    raise exception 'Executive snapshot requester lacks active matter approval authority';
  end if;
  if new.source_manifest#>>'{matterContext,matterId}' is distinct from new.matter_id::text or
     new.source_manifest#>>'{matterContext,matterNumber}' is distinct from matter_number or
     new.source_manifest#>>'{matterContext,customer}' is distinct from customer_name or
     new.source_manifest#>>'{matterContext,agreementTitle}' is distinct from matter_agreement_title or
     new.source_manifest#>>'{matterContext,region}' is distinct from matter_region or
     new.source_manifest#>>'{matterContext,annualRevenue}' is distinct from matter_annual_revenue::text or
     new.source_manifest#>>'{matterContext,stage}' is distinct from matter_stage or
     new.source_manifest#>>'{matterContext,riskLevel}' is distinct from matter_risk_level or
     new.source_manifest#>>'{matterContext,status}' is distinct from matter_status or
     (new.source_manifest#>>'{matterContext,updatedAt}')::timestamptz is distinct from matter_updated_at then
    raise exception 'Executive snapshot matter context does not match the exact locked matter and customer state';
  end if;

  expected_reliance_hash:=encode(digest(convert_to(canonical_jsonb_text(new.source_manifest->'relianceEvidence'),'UTF8'),'sha256'),'hex');
  if source_job.input->'requestedRelianceEvidence' is distinct from new.source_manifest->'relianceEvidence' or
     lower(coalesce(source_job.input->>'requestedRelianceHash',''))<>expected_reliance_hash or
     new.source_manifest#>>'{relianceEvidence,legalRelianceEnabled}' is distinct from 'true' or
     new.source_manifest#>>'{relianceEvidence,legalRelianceReady}' is distinct from 'true' or
     new.source_manifest#>>'{relianceEvidence,enginePoliciesReady}' is distinct from 'true' or
     nullif(btrim(new.source_manifest#>>'{relianceEvidence,validation,id}'),'') is null then
    raise exception 'Executive snapshot reliance evidence does not match its authorized job preimage';
  end if;

  select * into source_version from agreement_versions where id=new.agreement_version_id and matter_id=new.matter_id for share;
  if source_version.id is null or source_version.status not in ('APPROVED','EXECUTED') or
     new.source_manifest#>>'{agreement,id}' is distinct from source_version.id::text or
     new.source_manifest#>>'{agreement,matter_id}' is distinct from source_version.matter_id::text or
     (new.source_manifest#>>'{agreement,version_number}')::integer is distinct from source_version.version_number or
     new.source_manifest#>>'{agreement,label}' is distinct from source_version.label or
     new.source_manifest#>>'{agreement,status}' is distinct from source_version.status or
     (new.source_manifest#>>'{agreement,effective_date}')::date is distinct from source_version.effective_date or
     new.source_manifest#>>'{agreement,created_by}' is distinct from source_version.created_by or
     (new.source_manifest#>>'{agreement,created_at}')::timestamptz is distinct from source_version.created_at then
    raise exception 'Executive snapshot agreement or matter state does not match its exact source version';
  end if;

  begin
    requested_economics_id:=(source_job.input->>'requestedEconomicsRunId')::uuid;
  exception when others then
    raise exception 'Executive snapshot job has an invalid economics-run binding';
  end;
  select * into source_economics from economics_runs where id=requested_economics_id for share;
  if source_economics.id is null or source_economics.matter_id is distinct from new.matter_id or
     source_economics.agreement_version_id is distinct from new.agreement_version_id or
     source_economics.review_status<>'VALIDATED' or
     new.source_manifest#>>'{economics,id}' is distinct from source_economics.id::text or
     new.source_manifest#>>'{economics,matter_id}' is distinct from source_economics.matter_id::text or
     new.source_manifest#>>'{economics,agreement_version_id}' is distinct from source_economics.agreement_version_id::text or
     new.source_manifest#>>'{economics,formula_version}' is distinct from source_economics.formula_version or
     new.source_manifest#>>'{economics,review_status}' is distinct from source_economics.review_status or
     new.source_manifest->'economics'->'inputs' is distinct from source_economics.inputs or
     new.source_manifest->'economics'->'outputs' is distinct from source_economics.outputs or
     new.source_manifest#>>'{economics,reviewed_by}' is distinct from source_economics.reviewed_by or
     (new.source_manifest#>>'{economics,reviewed_at}')::timestamptz is distinct from source_economics.reviewed_at or
     new.source_manifest#>>'{economics,review_note}' is distinct from source_economics.review_note or
     new.source_manifest#>>'{economics,created_by}' is distinct from source_economics.created_by or
     (new.source_manifest#>>'{economics,created_at}')::timestamptz is distinct from source_economics.created_at then
    raise exception 'Executive snapshot economics evidence does not match its exact validated run';
  end if;
  return new;
end;
$$ language plpgsql;

drop trigger if exists trg_snapshot_receipt_lineage on executive_snapshots;
create trigger trg_snapshot_receipt_lineage
before insert on executive_snapshots
for each row execute function enforce_executive_snapshot_job_lineage();

create or replace function enforce_executive_summary_terminal_receipt() returns trigger as $$
declare
  bound_snapshot executive_snapshots%rowtype;
  expected_reliance_hash text;
begin
  if tg_op='INSERT' then
    if new.job_type='EXECUTIVE_SUMMARY' and new.status='SUCCEEDED' then
      raise exception 'Successful EXECUTIVE_SUMMARY jobs require an exact bound executive snapshot';
    end if;
    return new;
  end if;
  select * into bound_snapshot from executive_snapshots where processing_job_id=old.id;
  if bound_snapshot.id is null then
    if new.job_type='EXECUTIVE_SUMMARY' and new.status='SUCCEEDED' then
      raise exception 'Successful EXECUTIVE_SUMMARY jobs require an exact bound executive snapshot';
    end if;
    return new;
  end if;
  if old.job_type<>'EXECUTIVE_SUMMARY' or new.job_type<>'EXECUTIVE_SUMMARY' or
     new.matter_id is distinct from old.matter_id or new.matter_id is distinct from bound_snapshot.matter_id or
     new.document_id is not null or new.input is distinct from old.input or
     new.created_by is distinct from old.created_by then
    raise exception 'A snapshot-bound EXECUTIVE_SUMMARY job cannot be retargeted';
  end if;
  if new.status<>'SUCCEEDED' then
    raise exception 'A snapshot-bound EXECUTIVE_SUMMARY job may terminate only with its exact successful receipt';
  end if;

  expected_reliance_hash:=encode(digest(convert_to(canonical_jsonb_text(bound_snapshot.source_manifest->'relianceEvidence'),'UTF8'),'sha256'),'hex');
  if jsonb_typeof(new.output) is distinct from 'object' or
     new.output->>'snapshotId' is distinct from bound_snapshot.id::text or
     (new.output->>'snapshotVersion')::integer is distinct from bound_snapshot.snapshot_version or
     new.output->>'agreementVersionId' is distinct from bound_snapshot.agreement_version_id::text or
     new.output->>'economicsRunId' is distinct from old.input->>'requestedEconomicsRunId' or
     new.output->>'requesterId' is distinct from bound_snapshot.generated_by or
     new.output->>'sourceAuditId' is distinct from old.input->>'requestedAuditId' or
     lower(coalesce(new.output->>'sourceStateHash',''))<>lower(bound_snapshot.source_state_hash) or
     lower(coalesce(new.output->>'relianceEvidenceHash',''))<>expected_reliance_hash or
     lower(coalesce(old.input->>'requestedRelianceHash',''))<>expected_reliance_hash or
     new.finished_at is null or new.error_message is not null then
    raise exception 'EXECUTIVE_SUMMARY terminal output does not bind the exact snapshot receipt';
  end if;
  return new;
end;
$$ language plpgsql;

drop trigger if exists trg_executive_summary_terminal_receipt on processing_jobs;
create trigger trg_executive_summary_terminal_receipt
before insert or update on processing_jobs
for each row
execute function enforce_executive_summary_terminal_receipt();

create or replace function executive_snapshot_receipt_verified(snapshot_id uuid) returns boolean as $$
  select coalesce((
    select pj.job_type='EXECUTIVE_SUMMARY' and pj.status='SUCCEEDED' and
           pj.matter_id is not distinct from es.matter_id and pj.document_id is null and
           pj.created_by=es.generated_by and pj.input->>'requestedBy'=es.generated_by and
           pj.input->>'requestedAgreementVersionId'=es.agreement_version_id::text and
           pj.input->>'requestedEconomicsRunId'=es.source_manifest#>>'{economics,id}' and
           pj.input->>'requestedAuditId'=es.source_manifest#>>'{publicationReceipt,sourceAuditId}' and
           pj.input->'requestedRelianceEvidence'=es.source_manifest->'relianceEvidence' and
           lower(pj.input->>'requestedRelianceHash')=encode(digest(convert_to(canonical_jsonb_text(es.source_manifest->'relianceEvidence'),'UTF8'),'sha256'),'hex') and
           pj.output->>'snapshotId'=es.id::text and
           (pj.output->>'snapshotVersion')::integer=es.snapshot_version and
           pj.output->>'agreementVersionId'=es.agreement_version_id::text and
           pj.output->>'economicsRunId'=es.source_manifest#>>'{economics,id}' and
           pj.output->>'requesterId'=es.generated_by and
           pj.output->>'sourceAuditId'=pj.input->>'requestedAuditId' and
           lower(pj.output->>'sourceStateHash')=lower(es.source_state_hash) and
           lower(pj.output->>'relianceEvidenceHash')=lower(pj.input->>'requestedRelianceHash') and
           es.source_manifest=es.source_manifest_canonical::jsonb and
           lower(es.source_state_hash)=encode(digest(convert_to(es.source_manifest_canonical,'UTF8'),'sha256'),'hex') and
           es.matter_context=es.source_manifest->'matterContext' and
           es.top_risks=es.source_manifest#>'{snapshotPresentation,topRisks}' and
           es.quantified_exposure=es.source_manifest#>'{snapshotPresentation,quantifiedExposure}' and
           es.dependencies=es.source_manifest#>'{snapshotPresentation,dependencies}' and
           es.negotiation_actions=es.source_manifest#>'{snapshotPresentation,negotiationActions}' and
           es.executive_decisions=es.source_manifest#>'{snapshotPresentation,executiveDecisions}' and
           es.next_steps=es.source_manifest#>'{snapshotPresentation,nextSteps}' and
           es.source_manifest#>>'{publicationReceipt,jobId}'=pj.id::text and
           es.source_manifest#>>'{publicationReceipt,requesterId}'=es.generated_by and
           es.source_manifest#>>'{publicationReceipt,agreementVersionId}'=es.agreement_version_id::text and
           es.source_manifest#>>'{publicationReceipt,economicsRunId}'=pj.input->>'requestedEconomicsRunId' and
           lower(es.source_manifest#>>'{publicationReceipt,relianceEvidenceHash}')=lower(pj.input->>'requestedRelianceHash') and
           pj.finished_at is not null and pj.error_message is null
      from executive_snapshots es
      join processing_jobs pj on pj.id=es.processing_job_id
     where es.id=snapshot_id and es.processing_job_id is not null
  ),false);
$$ language sql stable;
