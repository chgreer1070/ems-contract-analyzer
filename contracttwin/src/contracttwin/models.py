"""Public shapes for an agreement reading.

`kind` separates three things that must not be mixed:

- fact: stated in the cited contract text
- inference: computed from cited text (for example a notice date)
- assumption: a convention the contract does not state
"""

from __future__ import annotations

from typing import Literal

from pydantic import BaseModel, ConfigDict, Field

ENGINE_VERSION = "contracttwin-core-0.2.0"

DISCLAIMER = (
    "This is a source-grounded reading aid, not a legal conclusion, not a financial "
    "determination, and not an authorized decision. Every fact cites contract text. "
    "Margin, cash, working-capital, and inventory amounts say 'cannot be determined' "
    "unless that amount is stated in the cited text. A person still has to review the result."
)

StatementKind = Literal["fact", "inference", "assumption"]
DomainName = Literal[
    "pricing",
    "ncnr",
    "excess_and_obsolete",
    "notice",
    "definition",
    "survival",
    "precedence",
    "liability",
    "indemnity",
    "warranty",
    "termination",
    "forecast",
    "consignment",
    "general",
]
ImpactArea = Literal["margin", "cash", "working_capital", "inventory"]
Determination = Literal["supported", "cannot_be_determined"]
DocumentRole = Literal["base", "amendment"]


class Citation(BaseModel):
    model_config = ConfigDict(extra="forbid")

    document_id: str
    document_name: str
    section: str | None = None
    quote: str


class InputDocument(BaseModel):
    model_config = ConfigDict(extra="forbid")

    name: str = Field(min_length=1, max_length=200)
    role: DocumentRole
    text: str | None = None
    filename: str | None = None
    effective_date: str | None = None


class Revision(BaseModel):
    model_config = ConfigDict(extra="forbid")

    kind: Literal["insertion", "deletion"]
    text: str
    location: str


class AgreementInput(BaseModel):
    """JSON body for a reading. File bytes are handled by the upload endpoint."""

    model_config = ConfigDict(extra="forbid")

    base: InputDocument
    amendments: list[InputDocument] = Field(default_factory=list)
    agreement_key: str | None = Field(default=None, max_length=200)


class DocumentRecord(BaseModel):
    document_id: str
    name: str
    role: DocumentRole
    filename: str | None = None
    manifest_effective_date: str | None = None
    sha256: str
    character_count: int
    order: int
    revisions: list[Revision] = Field(default_factory=list)
    extraction_warnings: list[str] = Field(default_factory=list)


class SectionSource(BaseModel):
    section: str
    title: str
    document_id: str
    document_name: str
    operative: bool


class ClauseRecord(BaseModel):
    id: str
    section: str
    title: str
    operative: bool
    survives_termination: bool
    document_id: str
    superseded_by_document_id: str | None = None
    citation: Citation


class Obligation(BaseModel):
    id: str
    kind: Literal["fact"]
    domain: DomainName
    statement: str
    operative: bool
    section: str | None
    citation: Citation


class Fact(BaseModel):
    id: str
    kind: StatementKind
    domain: DomainName
    statement: str
    operative: bool
    section: str | None
    citations: list[Citation]
    attributes: dict[str, str | int | float | bool | None] = Field(default_factory=dict)
    depends_on: list[str] = Field(default_factory=list)


class CrossReference(BaseModel):
    id: str
    from_section: str
    to_section: str
    resolved: bool
    operative: bool
    document_id: str
    citation: Citation


class CalendarEntry(BaseModel):
    id: str
    kind: StatementKind
    domain: DomainName
    description: str
    date: str | None
    operative: bool
    citations: list[Citation]
    basis: str
    depends_on: list[str] = Field(default_factory=list)


class Impact(BaseModel):
    area: ImpactArea
    determination: Determination
    kind: StatementKind | None = None
    summary: str
    amount: str | None = None
    currency: str | None = None
    source_fact_ids: list[str] = Field(default_factory=list)
    citations: list[Citation] = Field(default_factory=list)


class DomainExposure(BaseModel):
    domain: Literal["pricing", "ncnr", "excess_and_obsolete"]
    impacts: list[Impact]


class ExposureSummary(BaseModel):
    domains: list[DomainExposure]


class RejectedCandidate(BaseModel):
    statement: str
    reason: str
    document_id: str | None = None
    quote: str | None = None


class ReadingVersion(BaseModel):
    analysis_id: str
    agreement_key: str
    version: int
    created_at: str
    engine_version: str


class AgreementAnalysis(BaseModel):
    analysis_id: str
    agreement_key: str = ""
    version: int = 0
    engine_version: str
    extractor: str
    fallback_used: bool
    review_required: bool
    disclaimer: str
    documents: list[DocumentRecord]
    operative_sections: list[SectionSource]
    clause_register: list[ClauseRecord]
    obligation_register: list[Obligation]
    facts: list[Fact]
    cross_references: list[CrossReference]
    calendar: list[CalendarEntry]
    exposure: ExposureSummary
    rejected: list[RejectedCandidate]
    warnings: list[str]
