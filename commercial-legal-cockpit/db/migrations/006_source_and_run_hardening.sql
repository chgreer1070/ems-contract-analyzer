-- Source quarantine, analysis-run provenance, and governed-standard authority.

alter table documents
  add column if not exists security_scan_status text not null default 'PENDING'
    check (security_scan_status in ('PENDING','CLEAN','QUARANTINED','FAILED')),
  add column if not exists security_scanned_at timestamptz,
  add column if not exists security_scan_result text;

alter table findings
  add column if not exists analysis_run_id uuid references analysis_runs(id) on delete set null;

alter table contract_terms
  add column if not exists analysis_run_id uuid references analysis_runs(id) on delete set null;

alter table term_dependencies
  add column if not exists review_note text;

alter table document_relations
  add column if not exists review_note text;

alter table term_dependencies drop constraint if exists term_dependencies_review_status_check;
alter table term_dependencies add constraint term_dependencies_review_status_check check (review_status in ('UNREVIEWED','VALIDATED','REJECTED','SUPERSEDED'));
alter table document_relations drop constraint if exists document_relations_review_status_check;
alter table document_relations add constraint document_relations_review_status_check check (review_status in ('UNREVIEWED','VALIDATED','REJECTED','SUPERSEDED'));

alter table negotiation_standards
  add column if not exists approval_role text check (approval_role in ('APPROVER','ADMIN')),
  add column if not exists provenance_source text;

alter table purge_requests
  add column if not exists disposition_reason text;

alter table executive_snapshots
  add column if not exists matter_context jsonb,
  add column if not exists source_manifest jsonb,
  add column if not exists source_manifest_canonical text;

do $$
begin
  if exists(select 1 from documents group by blob_pathname having count(*)>1) then
    raise exception 'Duplicate document blob pathnames must be reconciled before source hardening can be applied';
  end if;
end;
$$;

create unique index if not exists uq_documents_blob_pathname on documents(blob_pathname);
create unique index if not exists uq_document_chunks_logical_position on document_chunks(document_id,coalesce(page_number,0),chunk_index);

update decisions set required_approver_role='APPROVER' where required_approver_role is null;
alter table decisions alter column required_approver_role set default 'APPROVER';
alter table decisions alter column required_approver_role set not null;
alter table decisions drop constraint if exists decisions_required_approver_role_check;
alter table decisions add constraint decisions_required_approver_role_check check (required_approver_role in ('APPROVER','ADMIN'));

alter table processing_jobs drop constraint if exists processing_jobs_job_type_check;
alter table processing_jobs
  add constraint processing_jobs_job_type_check
  check (job_type in ('MALWARE_SCAN','OCR','EXTRACT','ANALYZE','TERM_EXTRACT','DEPENDENCY','PRECEDENCE','EXECUTIVE_SUMMARY','VALIDATION'));

create or replace function prevent_unscanned_extraction() returns trigger as $$
begin
  if new.extraction_status in ('EXTRACTED','OCR_REQUIRED') and new.security_scan_status <> 'CLEAN' then
    raise exception 'Source document must pass malware scanning before extraction';
  end if;
  return new;
end;
$$ language plpgsql;

drop trigger if exists trg_prevent_unscanned_extraction on documents;
create trigger trg_prevent_unscanned_extraction
before insert or update of extraction_status, security_scan_status on documents
for each row execute function prevent_unscanned_extraction();

create or replace function enforce_verified_document_hash() returns trigger as $$
begin
  if new.integrity_status='SERVER_VERIFIED' and
     (new.sha256 is null or new.server_sha256 is null or lower(new.sha256)<>lower(new.server_sha256)) then
    raise exception 'SERVER_VERIFIED requires matching client and server SHA-256 values';
  end if;
  return new;
end;
$$ language plpgsql;

drop trigger if exists trg_enforce_verified_document_hash on documents;
create trigger trg_enforce_verified_document_hash
before insert or update of integrity_status, sha256, server_sha256 on documents
for each row execute function enforce_verified_document_hash();

create or replace function enforce_derived_text_hash() returns trigger as $$
declare expected_hash text;
begin
  if tg_table_name='document_chunks' then
    expected_hash:=encode(digest(convert_to(new.content,'UTF8'),'sha256'),'hex');
    if lower(new.content_sha256)<>expected_hash then
      raise exception 'Document chunk SHA-256 does not match its content';
    end if;
  elsif tg_table_name='contract_terms' then
    expected_hash:=encode(digest(convert_to(new.exact_text,'UTF8'),'sha256'),'hex');
    if lower(new.exact_text_sha256)<>expected_hash then
      raise exception 'Contract term SHA-256 does not match its exact text';
    end if;
  end if;
  return new;
end;
$$ language plpgsql;

drop trigger if exists trg_chunks_content_hash on document_chunks;
create trigger trg_chunks_content_hash before insert or update of content,content_sha256 on document_chunks for each row execute function enforce_derived_text_hash();
drop trigger if exists trg_terms_exact_text_hash on contract_terms;
create trigger trg_terms_exact_text_hash before insert or update of exact_text,exact_text_sha256 on contract_terms for each row execute function enforce_derived_text_hash();

do $$
begin
  if exists(select 1 from document_chunks where lower(content_sha256)<>encode(digest(convert_to(content,'UTF8'),'sha256'),'hex')) then
    raise exception 'Existing document chunk content hashes are inconsistent';
  end if;
  if exists(select 1 from contract_terms where lower(exact_text_sha256)<>encode(digest(convert_to(exact_text,'UTF8'),'sha256'),'hex')) then
    raise exception 'Existing contract term text hashes are inconsistent';
  end if;
end;
$$;

create or replace function prevent_source_identity_mutation() returns trigger as $$
begin
  if new.matter_id is distinct from old.matter_id or new.blob_url is distinct from old.blob_url or
     new.blob_pathname is distinct from old.blob_pathname or new.sha256 is distinct from old.sha256 or
     new.size_bytes is distinct from old.size_bytes or new.mime_type is distinct from old.mime_type or
     new.uploaded_by is distinct from old.uploaded_by or new.uploaded_at is distinct from old.uploaded_at then
    raise exception 'Registered source identity is immutable; create a new document record instead';
  end if;
  return new;
end;
$$ language plpgsql;

drop trigger if exists trg_prevent_source_identity_mutation on documents;
create trigger trg_prevent_source_identity_mutation before update on documents for each row execute function prevent_source_identity_mutation();

create or replace function enforce_human_review_record() returns trigger as $$
begin
  if new.review_status in ('VALIDATED','REJECTED') and
     (new.reviewed_by is null or new.reviewed_at is null or length(btrim(coalesce(new.review_note,'')))<12) then
    raise exception 'Human disposition requires reviewer, timestamp, and substantive note';
  end if;
  return new;
end;
$$ language plpgsql;

drop trigger if exists trg_findings_human_review on findings;
create trigger trg_findings_human_review before insert or update of review_status,reviewed_by,reviewed_at,review_note on findings for each row execute function enforce_human_review_record();
drop trigger if exists trg_terms_human_review on contract_terms;
create trigger trg_terms_human_review before insert or update of review_status,reviewed_by,reviewed_at,review_note on contract_terms for each row execute function enforce_human_review_record();
drop trigger if exists trg_dependencies_human_review on term_dependencies;
create trigger trg_dependencies_human_review before insert or update of review_status,reviewed_by,reviewed_at,review_note on term_dependencies for each row execute function enforce_human_review_record();
drop trigger if exists trg_relations_human_review on document_relations;
create trigger trg_relations_human_review before insert or update of review_status,reviewed_by,reviewed_at,review_note on document_relations for each row execute function enforce_human_review_record();

create or replace function prevent_reviewed_object_mutation() returns trigger as $$
begin
  if tg_op='DELETE' then
    if old.review_status in ('VALIDATED','REJECTED') then
      raise exception 'Human-reviewed legal objects are immutable; supersede with a new record';
    end if;
    return old;
  end if;
  if old.review_status in ('VALIDATED','REJECTED') and to_jsonb(new) is distinct from to_jsonb(old) then
    raise exception 'Human-reviewed legal objects are immutable; supersede with a new record';
  end if;
  return new;
end;
$$ language plpgsql;

drop trigger if exists trg_findings_reviewed_immutable on findings;
create trigger trg_findings_reviewed_immutable before update or delete on findings for each row execute function prevent_reviewed_object_mutation();
drop trigger if exists trg_terms_reviewed_immutable on contract_terms;
create trigger trg_terms_reviewed_immutable before update or delete on contract_terms for each row execute function prevent_reviewed_object_mutation();
drop trigger if exists trg_dependencies_reviewed_immutable on term_dependencies;
create trigger trg_dependencies_reviewed_immutable before update or delete on term_dependencies for each row execute function prevent_reviewed_object_mutation();
drop trigger if exists trg_relations_reviewed_immutable on document_relations;
create trigger trg_relations_reviewed_immutable before update or delete on document_relations for each row execute function prevent_reviewed_object_mutation();

create or replace function enforce_decision_disposition() returns trigger as $$
begin
  if new.decision_status in ('APPROVED','REJECTED') and
     (new.decided_by is null or new.decided_at is null or new.decided_by=new.requested_by) then
    raise exception 'Decision disposition requires an independent recorded approver';
  end if;
  return new;
end;
$$ language plpgsql;

drop trigger if exists trg_enforce_decision_disposition on decisions;
create trigger trg_enforce_decision_disposition before insert or update of decision_status,decided_by,decided_at on decisions for each row execute function enforce_decision_disposition();

create or replace function prevent_terminal_decision_mutation() returns trigger as $$
begin
  if tg_op='DELETE' then
    if old.decision_status in ('APPROVED','REJECTED','WITHDRAWN') then
      raise exception 'Terminal decisions are immutable';
    end if;
    return old;
  end if;
  if old.decision_status in ('APPROVED','REJECTED','WITHDRAWN') and to_jsonb(new) is distinct from to_jsonb(old) then
    raise exception 'Terminal decisions are immutable';
  end if;
  return new;
end;
$$ language plpgsql;

drop trigger if exists trg_terminal_decisions_immutable on decisions;
create trigger trg_terminal_decisions_immutable before update or delete on decisions for each row execute function prevent_terminal_decision_mutation();

create or replace function enforce_active_standard_governance() returns trigger as $$
begin
  if tg_op='UPDATE' and old.active and new.active and
     (new.clause_family,new.title,new.standard_position,new.fallback_position,new.no_go_position,new.approval_authority,new.business_rationale,new.provenance_source,new.approval_role,new.version,new.effective_date,new.created_by)
       is distinct from
     (old.clause_family,old.title,old.standard_position,old.fallback_position,old.no_go_position,old.approval_authority,old.business_rationale,old.provenance_source,old.approval_role,old.version,old.effective_date,old.created_by) then
    raise exception 'Active negotiation standards are immutable; activate a new version instead';
  end if;
  if new.active then
    if nullif(btrim(new.clause_family),'') is null or nullif(btrim(new.title),'') is null or
       nullif(btrim(new.standard_position),'') is null or nullif(btrim(new.fallback_position),'') is null or
       nullif(btrim(new.no_go_position),'') is null or nullif(btrim(new.approval_authority),'') is null or
       nullif(btrim(new.business_rationale),'') is null or nullif(btrim(new.provenance_source),'') is null or
       new.clause_family not in ('forecasting_demand','purchase_orders','pricing_repricing','raw_materials','long_lead_ncnr','consigned_inventory','title_risk_of_loss','safety_stock','excess_obsolete_inventory','engineering_changes','quality_acceptance_audits','delivery_incoterms_logistics','payment_terms','warranty','indemnity','liability_cap','termination','force_majeure','regulatory_change','sustainability') or
       new.approval_role not in ('APPROVER','ADMIN') or new.effective_date>current_date or
       lower(new.provenance_source) ~ '(^|[-_.[:space:]])(demo|illustrative|sample|synthetic|seed)([-_.[:space:]]|$)' or
       lower(new.version) ~ '(^|[-_.[:space:]])(demo|illustrative|sample|synthetic|seed)([-_.[:space:]]|$)' or
       lower(new.created_by) ~ '^(seed|demo|illustrative|sample|synthetic)([-_.[:space:]]|$)' then
      raise exception 'Active negotiation standard lacks complete governed non-illustrative provenance';
    end if;
  end if;
  return new;
end;
$$ language plpgsql;

drop trigger if exists trg_enforce_active_standard_governance on negotiation_standards;
create trigger trg_enforce_active_standard_governance before insert or update on negotiation_standards for each row execute function enforce_active_standard_governance();

create or replace function prevent_purge_request_on_hold() returns trigger as $$
declare source_matter uuid; source_hold boolean; source_state text; parent_hold boolean;
begin
  if tg_op='DELETE' then
    if old.status in ('REJECTED','EXECUTED','CANCELLED') then raise exception 'Terminal purge requests are immutable'; end if;
    return old;
  end if;
  if tg_op='UPDATE' and (new.matter_id is distinct from old.matter_id or new.document_id is distinct from old.document_id or new.requested_by is distinct from old.requested_by or new.requested_at is distinct from old.requested_at or new.reason is distinct from old.reason) then
    raise exception 'Purge request identity and rationale are immutable';
  end if;
  if tg_op='UPDATE' and old.status in ('REJECTED','EXECUTED','CANCELLED') and to_jsonb(new) is distinct from to_jsonb(old) then
    raise exception 'Terminal purge requests are immutable';
  end if;
  select d.matter_id,d.legal_hold,d.deletion_status into source_matter,source_hold,source_state from documents d where d.id=new.document_id;
  select m.legal_hold into parent_hold from matters m where m.id=new.matter_id;
  if source_matter is null or source_matter<>new.matter_id then
    raise exception 'Purge request document must belong to the recorded matter';
  end if;
  if new.status in ('PENDING','APPROVED') and (source_hold or parent_hold or source_state not in ('ACTIVE','PENDING_PURGE')) then
    raise exception 'Purge request cannot be opened while a legal hold or non-active source state exists';
  end if;
  if new.status='APPROVED' and (new.approved_by is null or new.approved_at is null or new.approved_by=new.requested_by) then
    raise exception 'Purge approval requires an independent recorded administrator';
  end if;
  if tg_op='UPDATE' and old.status='APPROVED' and source_state='PENDING_PURGE' and new.status<>'EXECUTED' then
    raise exception 'A purge request cannot leave APPROVED after external deletion may have started';
  end if;
  if new.status='EXECUTED' and (source_state<>'PURGED' or new.executed_by is null or new.executed_at is null) then
    raise exception 'Executed purge request requires a reconciled PURGED source record';
  end if;
  return new;
end;
$$ language plpgsql;

drop trigger if exists trg_prevent_purge_request_on_hold on purge_requests;
create trigger trg_prevent_purge_request_on_hold
before insert or update or delete on purge_requests
for each row execute function prevent_purge_request_on_hold();

create or replace function prevent_purge_on_hold() returns trigger as $$
begin
  if old.deletion_status='PENDING_PURGE' and new.deletion_status='ACTIVE' then
    raise exception 'PENDING_PURGE cannot be reverted because external deletion may already have succeeded';
  end if;
  if new.deletion_status in ('PENDING_PURGE','PURGED') then
    if new.legal_hold=true or exists(select 1 from matters m where m.id=new.matter_id and m.legal_hold=true) then
      raise exception 'Source document cannot be purged while a legal hold is active';
    end if;
    if not exists(select 1 from purge_requests pr where pr.document_id=new.id and pr.matter_id=new.matter_id and pr.status='APPROVED' and pr.approved_by is not null and pr.approved_by<>pr.requested_by) then
      raise exception 'Source deletion requires an independently approved purge request';
    end if;
  end if;
  return new;
end;
$$ language plpgsql;

create or replace function enforce_analysis_run_lineage() returns trigger as $$
declare source_matter uuid;
begin
  if new.run_type in ('CLAUSE_RISK','TERM_EXTRACTION') and new.document_id is null then
    raise exception 'Document analysis runs require a source document';
  end if;
  if new.document_id is not null then
    select matter_id into source_matter from documents where id=new.document_id;
    if source_matter is null or source_matter<>new.matter_id then raise exception 'Analysis run document must belong to its matter'; end if;
  end if;
  return new;
end;
$$ language plpgsql;

drop trigger if exists trg_analysis_run_lineage on analysis_runs;
create trigger trg_analysis_run_lineage before insert or update of matter_id,document_id,run_type on analysis_runs for each row execute function enforce_analysis_run_lineage();

-- Serialize derived-evidence publication against agreement execution. Locking
-- every affected version row first closes the race where an output publisher
-- and an EXECUTED transition could each validate a stale pre-transition view.
create or replace function lock_documents_for_legal_publication(source_documents uuid[]) returns void as $$
begin
  perform av.id
    from agreement_versions av
   where av.id in (
     select avd.agreement_version_id
       from agreement_version_documents avd
      where avd.document_id=any(source_documents)
   )
   order by av.id
   for update;

  if exists (
    select 1
      from agreement_versions av
      join agreement_version_documents avd on avd.agreement_version_id=av.id
     where avd.document_id=any(source_documents) and av.status='EXECUTED'
  ) then
    raise exception 'Derived legal evidence for an EXECUTED agreement version is frozen; create a successor source/version';
  end if;
end;
$$ language plpgsql;

create or replace function enforce_chunk_lineage() returns trigger as $$
declare source_matter uuid;
begin
  select matter_id into source_matter from documents where id=new.document_id;
  if source_matter is null or source_matter<>new.matter_id then raise exception 'Document chunk must belong to the document matter'; end if;
  return new;
end;
$$ language plpgsql;

drop trigger if exists trg_chunk_lineage on document_chunks;
create trigger trg_chunk_lineage before insert or update of document_id,matter_id on document_chunks for each row execute function enforce_chunk_lineage();

create or replace function enforce_chunk_execution_freeze() returns trigger as $$
declare source_document uuid;
begin
  source_document:=case when tg_op='DELETE' then old.document_id else new.document_id end;
  perform lock_documents_for_legal_publication(array[source_document]);
  if tg_op='DELETE' then return old; end if;
  return new;
end;
$$ language plpgsql;

drop trigger if exists trg_chunk_execution_freeze on document_chunks;
create trigger trg_chunk_execution_freeze
before insert or update or delete on document_chunks
for each row execute function enforce_chunk_execution_freeze();

create or replace function enforce_finding_lineage() returns trigger as $$
declare source_matter uuid; run_matter uuid; run_document uuid; run_kind text; run_status text;
begin
  if new.document_id is null then raise exception 'Published finding requires a source document'; end if;
  select matter_id into source_matter from documents where id=new.document_id;
  if source_matter is null or source_matter<>new.matter_id then raise exception 'Finding document must belong to its matter'; end if;
  if new.analysis_run_id is null then raise exception 'Published finding requires a RUNNING clause-risk analysis run'; end if;
  if length(btrim(new.source_excerpt))<12 then raise exception 'Finding source excerpt is too short for source grounding'; end if;
  select matter_id,document_id,run_type,status into run_matter,run_document,run_kind,run_status from analysis_runs where id=new.analysis_run_id;
  if run_kind is null or run_kind<>'CLAUSE_RISK' or run_status<>'RUNNING' or run_matter<>new.matter_id or run_document is distinct from new.document_id then
    raise exception 'Finding must be published by its same-source RUNNING clause-risk run';
  end if;
  if not exists(select 1 from document_chunks dc where dc.document_id=new.document_id and position(btrim(regexp_replace(lower(new.source_excerpt),'[[:space:]]+',' ','g')) in btrim(regexp_replace(lower(dc.content),'[[:space:]]+',' ','g')))>0) then raise exception 'Finding source excerpt must occur in its recorded source document'; end if;
  return new;
end;
$$ language plpgsql;

drop trigger if exists trg_finding_lineage on findings;
create trigger trg_finding_lineage before insert or update of matter_id,document_id,analysis_run_id on findings for each row execute function enforce_finding_lineage();

create or replace function enforce_term_lineage() returns trigger as $$
declare source_matter uuid; run_matter uuid; run_document uuid; run_kind text; run_status text; chunk_document uuid; chunk_content text;
begin
  select matter_id into source_matter from documents where id=new.document_id;
  if source_matter is null or source_matter<>new.matter_id then raise exception 'Contract term document must belong to its matter'; end if;
  if new.analysis_run_id is null or new.chunk_id is null then raise exception 'Published contract term requires a RUNNING term-extraction run and source chunk'; end if;
  if length(btrim(new.exact_text))<8 then raise exception 'Contract term exact text is too short for source grounding'; end if;
  select matter_id,document_id,run_type,status into run_matter,run_document,run_kind,run_status from analysis_runs where id=new.analysis_run_id;
  if run_kind is null or run_kind<>'TERM_EXTRACTION' or run_status<>'RUNNING' or run_matter<>new.matter_id or run_document<>new.document_id then
    raise exception 'Contract term must be published by its same-source RUNNING term-extraction run';
  end if;
  select document_id,content into chunk_document,chunk_content from document_chunks where id=new.chunk_id;
  if chunk_document is null or chunk_document<>new.document_id then raise exception 'Contract term chunk must belong to its source document'; end if;
  if position(btrim(regexp_replace(lower(new.exact_text),'[[:space:]]+',' ','g')) in btrim(regexp_replace(lower(chunk_content),'[[:space:]]+',' ','g')))=0 then raise exception 'Contract term exact text must occur in its recorded source chunk'; end if;
  return new;
end;
$$ language plpgsql;

drop trigger if exists trg_term_lineage on contract_terms;
create trigger trg_term_lineage before insert or update of matter_id,document_id,analysis_run_id,chunk_id on contract_terms for each row execute function enforce_term_lineage();

create or replace function enforce_dependency_lineage() returns trigger as $$
declare source_matter uuid; target_matter uuid;
begin
  select matter_id into source_matter from contract_terms where id=new.source_term_id;
  select matter_id into target_matter from contract_terms where id=new.target_term_id;
  if source_matter is null or target_matter is null or source_matter<>new.matter_id or target_matter<>new.matter_id then raise exception 'Dependency terms must belong to the dependency matter'; end if;
  return new;
end;
$$ language plpgsql;

drop trigger if exists trg_dependency_lineage on term_dependencies;
create trigger trg_dependency_lineage before insert or update of matter_id,source_term_id,target_term_id on term_dependencies for each row execute function enforce_dependency_lineage();

create or replace function enforce_relation_lineage() returns trigger as $$
declare source_matter uuid; target_matter uuid;
begin
  select matter_id into source_matter from documents where id=new.source_document_id;
  select matter_id into target_matter from documents where id=new.target_document_id;
  if source_matter is null or target_matter is null or source_matter<>new.matter_id or target_matter<>new.matter_id then raise exception 'Related documents must belong to the relation matter'; end if;
  return new;
end;
$$ language plpgsql;

drop trigger if exists trg_relation_lineage on document_relations;
create trigger trg_relation_lineage before insert or update of matter_id,source_document_id,target_document_id on document_relations for each row execute function enforce_relation_lineage();

create or replace function enforce_legal_object_execution_freeze() returns trigger as $$
declare row_value record; source_documents uuid[];
begin
  if tg_op='DELETE' then row_value:=old; else row_value:=new; end if;
  if tg_table_name='findings' or tg_table_name='contract_terms' then
    source_documents:=array[row_value.document_id];
  elsif tg_table_name='term_dependencies' then
    select array[s.document_id,t.document_id] into source_documents
      from contract_terms s,contract_terms t
     where s.id=row_value.source_term_id and t.id=row_value.target_term_id;
  elsif tg_table_name='document_relations' then
    source_documents:=array[row_value.source_document_id,row_value.target_document_id];
  end if;
  if source_documents is not null and cardinality(array_remove(source_documents,null))>0 then
    perform lock_documents_for_legal_publication(array_remove(source_documents,null));
  end if;
  if tg_op='DELETE' then return old; end if;
  return new;
end;
$$ language plpgsql;

drop trigger if exists trg_findings_execution_freeze on findings;
create trigger trg_findings_execution_freeze before insert or update or delete on findings for each row execute function enforce_legal_object_execution_freeze();
drop trigger if exists trg_terms_execution_freeze on contract_terms;
create trigger trg_terms_execution_freeze before insert or update or delete on contract_terms for each row execute function enforce_legal_object_execution_freeze();
drop trigger if exists trg_dependencies_execution_freeze on term_dependencies;
create trigger trg_dependencies_execution_freeze before insert or update or delete on term_dependencies for each row execute function enforce_legal_object_execution_freeze();
drop trigger if exists trg_relations_execution_freeze on document_relations;
create trigger trg_relations_execution_freeze before insert or update or delete on document_relations for each row execute function enforce_legal_object_execution_freeze();

create or replace function enforce_agreement_document_lineage() returns trigger as $$
declare version_matter uuid; source_matter uuid;
begin
  select matter_id into version_matter from agreement_versions where id=new.agreement_version_id;
  select matter_id into source_matter from documents where id=new.document_id;
  if version_matter is null or source_matter is null or version_matter<>source_matter then raise exception 'Agreement version document must belong to the agreement matter'; end if;
  return new;
end;
$$ language plpgsql;

drop trigger if exists trg_agreement_document_lineage on agreement_version_documents;
create trigger trg_agreement_document_lineage before insert or update of agreement_version_id,document_id on agreement_version_documents for each row execute function enforce_agreement_document_lineage();

create or replace function enforce_working_version_membership() returns trigger as $$
declare old_status text; new_status text;
begin
  if tg_op in ('UPDATE','DELETE') then
    select status into old_status from agreement_versions where id=old.agreement_version_id for update;
    if old_status is null or old_status<>'WORKING' then raise exception 'Document membership of non-WORKING agreement versions is immutable'; end if;
  end if;
  if tg_op in ('INSERT','UPDATE') then
    select status into new_status from agreement_versions where id=new.agreement_version_id for update;
    if new_status is null or new_status<>'WORKING' then raise exception 'Documents may be added only to a WORKING agreement version'; end if;
    return new;
  end if;
  return old;
end;
$$ language plpgsql;

drop trigger if exists trg_working_version_membership on agreement_version_documents;
create trigger trg_working_version_membership before insert or update or delete on agreement_version_documents for each row execute function enforce_working_version_membership();

create or replace function prevent_terminal_analysis_run_mutation() returns trigger as $$
begin
  if tg_op='DELETE' then
    if old.status in ('SUCCEEDED','FAILED','PARTIAL') then raise exception 'Terminal analysis runs are immutable'; end if;
    return old;
  end if;
  if old.status in ('SUCCEEDED','FAILED','PARTIAL') and to_jsonb(new) is distinct from to_jsonb(old) then raise exception 'Terminal analysis runs are immutable'; end if;
  return new;
end;
$$ language plpgsql;

drop trigger if exists trg_terminal_analysis_runs_immutable on analysis_runs;
create trigger trg_terminal_analysis_runs_immutable before update or delete on analysis_runs for each row execute function prevent_terminal_analysis_run_mutation();

create or replace function prevent_append_only_record_mutation() returns trigger as $$
begin
  raise exception '% is append-only',tg_table_name;
end;
$$ language plpgsql;

drop trigger if exists trg_economics_runs_append_only on economics_runs;
create trigger trg_economics_runs_append_only before update or delete on economics_runs for each row execute function prevent_append_only_record_mutation();
drop trigger if exists trg_executive_snapshots_append_only on executive_snapshots;
create trigger trg_executive_snapshots_append_only before update or delete on executive_snapshots for each row execute function prevent_append_only_record_mutation();

create or replace function enforce_snapshot_manifest() returns trigger as $$
begin
  if new.matter_context is null or new.source_manifest is null or nullif(new.source_manifest_canonical,'') is null then
    raise exception 'Frozen snapshot requires matter context and canonical source manifest';
  end if;
  if new.source_manifest is distinct from new.source_manifest_canonical::jsonb then
    raise exception 'Frozen snapshot manifest does not match its canonical preimage';
  end if;
  if lower(new.source_state_hash)<>encode(digest(convert_to(new.source_manifest_canonical,'UTF8'),'sha256'),'hex') then
    raise exception 'Frozen snapshot hash does not match its canonical source manifest';
  end if;
  return new;
end;
$$ language plpgsql;

drop trigger if exists trg_snapshot_manifest_integrity on executive_snapshots;
create trigger trg_snapshot_manifest_integrity before insert on executive_snapshots for each row execute function enforce_snapshot_manifest();

create or replace function suppress_duplicate_contract_term() returns trigger as $$
begin
  if exists (
    select 1 from contract_terms t
     where t.document_id=new.document_id
       and t.analysis_run_id is not distinct from new.analysis_run_id
       and t.clause_family=new.clause_family
       and t.term_type=new.term_type
       and t.exact_text_sha256=new.exact_text_sha256
       and t.review_status in ('UNREVIEWED','VALIDATED')
  ) then return null; end if;
  return new;
end;
$$ language plpgsql;

create or replace function suppress_duplicate_term_dependency() returns trigger as $$
begin
  if exists (
    select 1 from term_dependencies d
     where d.matter_id=new.matter_id
       and d.source_term_id=new.source_term_id
       and d.target_term_id=new.target_term_id
       and d.dependency_type=new.dependency_type
       and d.review_status in ('UNREVIEWED','VALIDATED')
  ) then return null; end if;
  return new;
end;
$$ language plpgsql;

create or replace function suppress_duplicate_document_relation() returns trigger as $$
begin
  if exists (
    select 1 from document_relations r
     where r.matter_id=new.matter_id
       and r.source_document_id=new.source_document_id
       and r.target_document_id=new.target_document_id
       and r.relation_type=new.relation_type
       and r.review_status in ('UNREVIEWED','VALIDATED')
  ) then return null; end if;
  return new;
end;
$$ language plpgsql;

do $$
begin
  if exists(select 1 from findings where review_status in ('VALIDATED','REJECTED') and (reviewed_by is null or reviewed_at is null or length(btrim(coalesce(review_note,'')))<12))
     or exists(select 1 from contract_terms where review_status in ('VALIDATED','REJECTED') and (reviewed_by is null or reviewed_at is null or length(btrim(coalesce(review_note,'')))<12))
     or exists(select 1 from term_dependencies where review_status in ('VALIDATED','REJECTED') and (reviewed_by is null or reviewed_at is null or length(btrim(coalesce(review_note,'')))<12))
     or exists(select 1 from document_relations where review_status in ('VALIDATED','REJECTED') and (reviewed_by is null or reviewed_at is null or length(btrim(coalesce(review_note,'')))<12)) then
    raise exception 'Existing human-reviewed objects lack a substantive attestation';
  end if;
  if exists(select 1 from document_chunks dc join documents d on d.id=dc.document_id where dc.matter_id<>d.matter_id)
     or exists(select 1 from analysis_runs ar join documents d on d.id=ar.document_id where ar.matter_id<>d.matter_id)
     or exists(select 1 from findings f join documents d on d.id=f.document_id where f.matter_id<>d.matter_id)
     or exists(select 1 from contract_terms t join documents d on d.id=t.document_id where t.matter_id<>d.matter_id)
     or exists(select 1 from contract_terms t join analysis_runs ar on ar.id=t.analysis_run_id where ar.run_type<>'TERM_EXTRACTION' or ar.matter_id<>t.matter_id or ar.document_id<>t.document_id)
     or exists(select 1 from findings f join analysis_runs ar on ar.id=f.analysis_run_id where ar.run_type<>'CLAUSE_RISK' or ar.matter_id<>f.matter_id or ar.document_id is distinct from f.document_id)
     or exists(select 1 from term_dependencies td join contract_terms s on s.id=td.source_term_id join contract_terms t on t.id=td.target_term_id where td.matter_id<>s.matter_id or td.matter_id<>t.matter_id)
     or exists(select 1 from document_relations r join documents s on s.id=r.source_document_id join documents t on t.id=r.target_document_id where r.matter_id<>s.matter_id or r.matter_id<>t.matter_id)
     or exists(select 1 from agreement_version_documents avd join agreement_versions av on av.id=avd.agreement_version_id join documents d on d.id=avd.document_id where av.matter_id<>d.matter_id) then
    raise exception 'Existing source or legal-object lineage is inconsistent';
  end if;
end;
$$;

do $$
begin
  if exists (
    select 1 from contract_terms
     where analysis_run_id is not null and review_status in ('UNREVIEWED','VALIDATED')
     group by document_id,analysis_run_id,clause_family,term_type,exact_text_sha256
    having count(*)>1
  ) then
    raise exception 'Duplicate active contract terms within one analysis run must be reconciled before source hardening can be applied';
  end if;
end;
$$;

create unique index if not exists uq_contract_terms_active_per_run
  on contract_terms(document_id,analysis_run_id,clause_family,term_type,exact_text_sha256)
  where analysis_run_id is not null and review_status in ('UNREVIEWED','VALIDATED');

create index if not exists idx_documents_security_scan on documents(security_scan_status, uploaded_at);
create index if not exists idx_findings_analysis_run on findings(analysis_run_id);
create index if not exists idx_contract_terms_analysis_run on contract_terms(analysis_run_id);
