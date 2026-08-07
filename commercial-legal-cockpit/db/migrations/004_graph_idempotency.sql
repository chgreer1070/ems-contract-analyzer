-- Prevent repeated analysis from duplicating graph objects that counsel has already reviewed.

create or replace function suppress_duplicate_contract_term() returns trigger as $$
begin
  if exists (
    select 1 from contract_terms t
     where t.document_id = new.document_id
       and t.clause_family = new.clause_family
       and t.term_type = new.term_type
       and t.exact_text_sha256 = new.exact_text_sha256
       and t.review_status <> 'SUPERSEDED'
  ) then
    return null;
  end if;
  return new;
end;
$$ language plpgsql;

drop trigger if exists trg_suppress_duplicate_contract_term on contract_terms;
create trigger trg_suppress_duplicate_contract_term
before insert on contract_terms
for each row execute function suppress_duplicate_contract_term();

create or replace function suppress_duplicate_term_dependency() returns trigger as $$
begin
  if exists (
    select 1 from term_dependencies d
     where d.matter_id = new.matter_id
       and d.source_term_id = new.source_term_id
       and d.target_term_id = new.target_term_id
       and d.dependency_type = new.dependency_type
  ) then
    return null;
  end if;
  return new;
end;
$$ language plpgsql;

drop trigger if exists trg_suppress_duplicate_term_dependency on term_dependencies;
create trigger trg_suppress_duplicate_term_dependency
before insert on term_dependencies
for each row execute function suppress_duplicate_term_dependency();

create or replace function suppress_duplicate_document_relation() returns trigger as $$
begin
  if exists (
    select 1 from document_relations r
     where r.matter_id = new.matter_id
       and r.source_document_id = new.source_document_id
       and r.target_document_id = new.target_document_id
       and r.relation_type = new.relation_type
  ) then
    return null;
  end if;
  return new;
end;
$$ language plpgsql;

drop trigger if exists trg_suppress_duplicate_document_relation on document_relations;
create trigger trg_suppress_duplicate_document_relation
before insert on document_relations
for each row execute function suppress_duplicate_document_relation();
