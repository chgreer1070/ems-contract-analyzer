"""Run one agreement reading from text that has already been extracted."""

from __future__ import annotations

import hashlib
import json
import re
from dataclasses import dataclass

from contracttwin.calendar_builder import build_calendar
from contracttwin.exposure import build_exposure
from contracttwin.extract_rules import cross_references, extract_rules
from contracttwin.llm import Extractor, ExtractorUnavailable
from contracttwin.models import (
    DISCLAIMER,
    ENGINE_VERSION,
    AgreementAnalysis,
    Citation,
    ClauseRecord,
    CrossReference,
    DocumentRecord,
    Fact,
    Obligation,
    SectionSource,
)
from contracttwin.precedence import Ledger, PreparedDocument, SectionVersion, build_ledger
from contracttwin.quote_check import review_candidates
from contracttwin.textutil import MAX_DOCUMENT_CHARS, normalize_newlines, parse_iso_date, sha256_text, stable_id

_SURVIVING_NUMBERS = re.compile(r"\d+")


@dataclass
class AnalysisRequest:
    base_name: str
    base_text: str
    amendments: list[tuple[str, str, str | None]]
    base_manifest_effective_date: str | None = None
    base_filename: str | None = None
    amendment_filenames: list[str | None] | None = None
    extractor: Extractor | None = None


def analyze(request: AnalysisRequest) -> AgreementAnalysis:
    base_text = _guard_text(request.base_text, request.base_name)
    _check_date(request.base_manifest_effective_date, request.base_name)
    amendment_filenames = request.amendment_filenames or [None] * len(request.amendments)
    prepared_amendments: list[PreparedDocument] = []
    for index, (name, text, effective) in enumerate(request.amendments, start=1):
        _check_date(effective, name)
        prepared_amendments.append(
            PreparedDocument(
                document_id=f"doc-amendment-{index}",
                name=name,
                role="amendment",
                text=_guard_text(text, name),
                manifest_effective_date=effective,
                filename=amendment_filenames[index - 1] if index - 1 < len(amendment_filenames) else None,
                order=index,
            )
        )
    base = PreparedDocument(
        document_id="doc-base",
        name=request.base_name,
        role="base",
        text=base_text,
        manifest_effective_date=request.base_manifest_effective_date,
        filename=request.base_filename,
        order=0,
    )
    documents = [base, *prepared_amendments]
    by_id = {document.document_id: (document.name, document.text) for document in documents}
    ledger = build_ledger(base, prepared_amendments)
    warnings = list(ledger.warnings)
    rule_candidates, rule_warnings = extract_rules(
        ledger,
        [(item.document_id, item.name, item.text) for item in prepared_amendments],
    )
    warnings.extend(rule_warnings)
    facts, rejected = review_candidates(rule_candidates, by_id)
    extractor_name = "rules"
    fallback_used = False
    if request.extractor is not None:
        extractor_name, fallback_used, extra_rejected = _merge_extractor(
            request.extractor,
            documents,
            ledger,
            by_id,
            facts,
            warnings,
        )
        rejected.extend(extra_rejected)

    _flag_conflicts(facts, warnings)
    calendar, derived, calendar_warnings = build_calendar(facts, by_id)
    warnings.extend(calendar_warnings)
    facts.extend(derived)
    _apply_survival(ledger, facts)
    clauses = _clauses(ledger, by_id)
    obligations = _obligations(facts)
    exposure = build_exposure(facts)
    labeled = [fact for fact in facts if not fact.attributes.get("obligation")]
    references = _references(ledger, by_id)
    warnings.extend(_date_warnings(base, prepared_amendments, labeled))
    if not any(fact.operative and fact.domain == "pricing" for fact in labeled):
        warnings.append("No operative pricing term was found.")
    if not any(fact.operative and fact.domain == "ncnr" for fact in labeled):
        warnings.append("No operative NCNR term was found.")
    if not any(fact.operative and fact.domain == "excess_and_obsolete" for fact in labeled):
        warnings.append("No operative excess-and-obsolete term was found.")

    return AgreementAnalysis(
        analysis_id=_analysis_id(documents, extractor_name),
        engine_version=ENGINE_VERSION,
        extractor=extractor_name,
        fallback_used=fallback_used,
        review_required=True,
        disclaimer=DISCLAIMER,
        documents=[_document_record(document) for document in documents],
        operative_sections=_operative_sections(ledger),
        clause_register=clauses,
        obligation_register=obligations,
        facts=labeled,
        cross_references=references,
        calendar=calendar,
        exposure=exposure,
        rejected=rejected,
        warnings=warnings,
    )


def _merge_extractor(
    extractor: Extractor,
    documents: list[PreparedDocument],
    ledger: Ledger,
    by_id: dict[str, tuple[str, str]],
    facts: list[Fact],
    warnings: list[str],
) -> tuple[str, bool, list]:
    try:
        candidates = extractor.extract(documents)
    except ExtractorUnavailable as exc:
        warnings.append(str(exc))
        return "rules", True, []
    accepted, rejected = review_candidates(candidates, by_id)
    existing_quotes = {(citation.document_id, citation.quote) for fact in facts for citation in fact.citations}
    for fact in accepted:
        _force_operative(fact, ledger)
        quote = fact.citations[0].quote if fact.citations else ""
        key = (fact.citations[0].document_id, quote) if fact.citations else None
        if key and key not in existing_quotes:
            facts.append(fact)
            existing_quotes.add(key)
    if rejected:
        warnings.append("Some model statements were rejected because the citation was not verbatim.")
    return "rules+llm", False, rejected


def _force_operative(fact: Fact, ledger: Ledger) -> None:
    if not fact.citations:
        return
    quote = fact.citations[0].quote
    operative_hit = False
    superseded_hit = False
    versions: list[SectionVersion] = []
    if ledger.preamble is not None:
        versions.append(ledger.preamble)
    for group in ledger.versions.values():
        versions.extend(group)
    for version in versions:
        if quote not in version.text:
            continue
        if version.operative:
            operative_hit = True
        else:
            superseded_hit = True
    if superseded_hit and not operative_hit:
        fact.operative = False


def _clauses(ledger: Ledger, by_id: dict[str, tuple[str, str]]) -> list[ClauseRecord]:
    records: list[ClauseRecord] = []
    versions: list[SectionVersion] = []
    if ledger.preamble is not None:
        versions.append(ledger.preamble)
    for number in _section_order(ledger):
        versions.extend(ledger.versions[number])
    for version in versions:
        if version.text not in by_id[version.document_id][1]:
            raise RuntimeError(f"Section {version.number} text was not a verbatim slice of its document.")
        records.append(_clause(version, survives=version.survives_termination))
    return records


def _clause(version: SectionVersion, survives: bool) -> ClauseRecord:
    return ClauseRecord(
        id=stable_id("clause", version.number, version.document_id, version.text[:80], str(version.operative)),
        section=version.number,
        title=version.title,
        operative=version.operative,
        survives_termination=survives and version.operative,
        document_id=version.document_id,
        superseded_by_document_id=version.superseded_by_document_id,
        citation=_cite(version),
    )


def _apply_survival(ledger: Ledger, facts: list[Fact]) -> None:
    numbers: set[str] = set()
    for fact in facts:
        if fact.operative and fact.domain == "survival":
            raw = str(fact.attributes.get("surviving_sections") or "")
            numbers.update(_SURVIVING_NUMBERS.findall(raw))
    for group in ledger.versions.values():
        for version in group:
            version.survives_termination = _section_survives(version.number, numbers)


def _section_survives(section: str, numbers: set[str]) -> bool:
    return any(section == number or section.startswith(f"{number}.") for number in numbers)


def _obligations(facts: list[Fact]) -> list[Obligation]:
    obligations: list[Obligation] = []
    for fact in facts:
        if not fact.attributes.get("obligation") or not fact.citations:
            continue
        obligations.append(
            Obligation(
                id=fact.id,
                kind="fact",
                domain=fact.domain,
                statement=fact.statement,
                operative=fact.operative,
                section=fact.section,
                citation=fact.citations[0],
            )
        )
    return obligations


def _references(ledger: Ledger, by_id: dict[str, tuple[str, str]]) -> list[CrossReference]:
    known = set(ledger.versions)
    references: list[CrossReference] = []
    seen: set[tuple[str, str, str]] = set()
    for group in ledger.versions.values():
        for version in group:
            if not version.operative:
                continue
            for target, line in cross_references(version):
                key = (version.number, target, line)
                if key in seen or line not in by_id[version.document_id][1]:
                    continue
                seen.add(key)
                references.append(
                    CrossReference(
                        id=stable_id("xref", version.number, target, line),
                        from_section=version.number,
                        to_section=target,
                        resolved=target in known,
                        operative=True,
                        document_id=version.document_id,
                        citation=_cite(version, quote=line),
                    )
                )
    return references


def _operative_sections(ledger: Ledger) -> list[SectionSource]:
    sources: list[SectionSource] = []
    for number in _section_order(ledger):
        for version in ledger.versions[number]:
            if version.operative:
                sources.append(
                    SectionSource(
                        section=number,
                        title=version.title,
                        document_id=version.document_id,
                        document_name=version.document_name,
                        operative=True,
                    )
                )
    return sources


def _section_order(ledger: Ledger) -> list[str]:
    def sort_key(number: str) -> tuple:
        return tuple(int(part) for part in number.split("."))

    return sorted(ledger.versions, key=sort_key)


def _cite(version: SectionVersion, quote: str | None = None) -> Citation:
    return Citation(
        document_id=version.document_id,
        document_name=version.document_name,
        section=version.number,
        quote=quote if quote is not None else version.text,
    )


def _document_record(document: PreparedDocument) -> DocumentRecord:
    return DocumentRecord(
        document_id=document.document_id,
        name=document.name,
        role="base" if document.role == "base" else "amendment",
        filename=document.filename,
        manifest_effective_date=document.manifest_effective_date,
        sha256=sha256_text(document.text),
        character_count=len(document.text),
        order=document.order,
    )


def _date_warnings(base: PreparedDocument, amendments: list[PreparedDocument], facts: list[Fact]) -> list[str]:
    warnings: list[str] = []
    if base.manifest_effective_date:
        cited = [
            str(fact.attributes.get("date"))
            for fact in facts
            if fact.attributes.get("date_role") == "agreement_effective" and fact.operative
        ]
        if cited and cited[0] != base.manifest_effective_date:
            warnings.append(
                "The effective date typed in with the file does not match the effective date written in the agreement. The written date was used."
            )
    for amendment in amendments:
        if not amendment.manifest_effective_date:
            continue
        cited = [
            str(fact.attributes.get("date"))
            for fact in facts
            if fact.attributes.get("date_role") == "amendment_effective"
            and fact.citations
            and fact.citations[0].document_id == amendment.document_id
        ]
        if cited and cited[0] != amendment.manifest_effective_date:
            warnings.append(
                f"{amendment.name}: the date typed in with the file does not match the date written in the amendment. "
                "The written date is the fact. The typed date was used only to decide which amendment is later."
            )
    return warnings


def _flag_conflicts(facts: list[Fact], warnings: list[str]) -> None:
    keys = (
        "net_days",
        "ncnr_days",
        "notice_business_days",
        "notice_days_before_anniversary",
        "adjustment_cap_percent",
    )
    for key in keys:
        groups: dict[str | None, list[Fact]] = {}
        for fact in facts:
            if fact.operative and key in fact.attributes:
                groups.setdefault(fact.section, []).append(fact)
        for section, group in groups.items():
            values = {str(fact.attributes[key]) for fact in group}
            if len(values) < 2:
                continue
            label = key.replace("_", " ")
            warnings.append(
                f"Section {section} states more than one {label} ({', '.join(sorted(values))}), so a single operative value cannot be determined."
            )
            for fact in group:
                fact.attributes["conflicting"] = True


def _analysis_id(documents: list[PreparedDocument], extractor_name: str) -> str:
    canonical = [
        {
            "id": document.document_id,
            "role": document.role,
            "name": document.name,
            "effective": document.manifest_effective_date,
            "sha256": sha256_text(document.text),
        }
        for document in documents
    ]
    raw = json.dumps({"documents": canonical, "extractor": extractor_name, "engine": ENGINE_VERSION}, sort_keys=True)
    return hashlib.sha256(raw.encode("utf-8")).hexdigest()[:16]


def _guard_text(text: str, name: str) -> str:
    normalized = normalize_newlines(text or "")
    if not normalized.strip():
        raise ValueError(f"{name} has no text.")
    if len(normalized) > MAX_DOCUMENT_CHARS:
        raise ValueError(f"{name} is too long.")
    return normalized


def _check_date(value: str | None, name: str) -> None:
    if value is None or value == "":
        return
    try:
        parse_iso_date(value)
    except ValueError as exc:
        raise ValueError(f"{name}: {exc}") from exc
