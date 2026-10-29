"""HTTP service for one agreement reading.

Readings are stored in SQLite so they survive a restart. Each agreement can
have more than one version. The service does not write the cockpit database,
and it does not decide that a reading is approved.
"""

from __future__ import annotations

import hashlib
import hmac
import json
import os

from fastapi import APIRouter, Depends, FastAPI, File, Form, Header, HTTPException, UploadFile
from pydantic import ValidationError

from contracttwin.ingest import MAX_DOCUMENTS, MAX_UPLOAD_BYTES, Extraction, IngestError, extract_upload
from contracttwin.llm import OptionalLlmExtractor
from contracttwin.models import AgreementAnalysis, AgreementInput, AuditEvent, ReadingVersion
from contracttwin.pipeline import AnalysisRequest, analyze
from contracttwin.repository import ReadingRepository, SqliteReadingRepository
from contracttwin.textutil import sha256_text

_repository: ReadingRepository | None = None
_repository_path: str | None = None


def create_app() -> FastAPI:
    app = FastAPI(
        title="ContractTwin Core",
        version="0.2.0",
        summary="Source-grounded reading of an EMS customer agreement and its amendments.",
    )
    protected = APIRouter(dependencies=[Depends(require_api_key)])

    @app.get("/health")
    def health() -> dict[str, str]:
        return {"status": "ok", "service": "contracttwin-core", "version": "0.2.0"}

    @protected.post("/v1/agreements", response_model=AgreementAnalysis)
    def create_agreement(body: AgreementInput, actor: str = Depends(require_api_key)) -> AgreementAnalysis:
        if body.base.role != "base":
            raise HTTPException(status_code=400, detail="The first document must be the base agreement.")
        if body.base.text is None:
            raise HTTPException(status_code=400, detail="The base agreement needs text. Use the file endpoint for PDF or Word.")
        if 1 + len(body.amendments) > MAX_DOCUMENTS:
            raise HTTPException(status_code=400, detail=f"Send at most {MAX_DOCUMENTS} documents.")
        for amendment in body.amendments:
            if amendment.role != "amendment":
                raise HTTPException(status_code=400, detail="Later documents must be amendments.")
            if amendment.text is None:
                raise HTTPException(status_code=400, detail=f"{amendment.name} needs text.")
        base = Extraction(text=body.base.text)
        amendments = [Extraction(text=item.text or "") for item in body.amendments]
        return _read(body, base, amendments, actor)

    @protected.post("/v1/agreements/files", response_model=AgreementAnalysis)
    async def create_agreement_from_files(
        manifest: str = Form(...),
        files: list[UploadFile] = File(...),
        actor: str = Depends(require_api_key),
    ) -> AgreementAnalysis:
        try:
            payload = json.loads(manifest)
            body = AgreementInput.model_validate(payload)
        except (json.JSONDecodeError, ValidationError) as exc:
            raise HTTPException(status_code=400, detail="The manifest is not a valid agreement description.") from exc
        if 1 + len(body.amendments) > MAX_DOCUMENTS:
            raise HTTPException(status_code=400, detail=f"Send at most {MAX_DOCUMENTS} documents.")
        uploaded: dict[str, tuple[str, bytes]] = {}
        try:
            if len(files) > MAX_DOCUMENTS:
                raise ValueError(f"Send at most {MAX_DOCUMENTS} files.")
            for upload in files:
                name = upload.filename or ""
                if not name or "/" in name or "\\" in name or name in uploaded:
                    raise ValueError("Each uploaded file needs its own plain file name.")
                uploaded[name] = (name, await _read_capped(upload))
            base = _extraction_for(body.base, uploaded)
            amendments = [_extraction_for(item, uploaded) for item in body.amendments]
        except (IngestError, ValueError) as exc:
            raise HTTPException(status_code=400, detail=str(exc)) from exc
        return _read(body, base, amendments, actor)

    @protected.get("/v1/agreements/{analysis_id}", response_model=AgreementAnalysis)
    def get_agreement(analysis_id: str, actor: str = Depends(require_api_key)) -> AgreementAnalysis:
        found = get_repository().get(analysis_id)
        if found is None:
            raise HTTPException(status_code=404, detail="No reading with that id is stored.")
        get_repository().append_audit(actor, "reading.read", found.agreement_key, found.analysis_id, "Read a stored reading.")
        return found

    @protected.get("/v1/agreement-versions", response_model=list[ReadingVersion])
    def list_versions(agreement_key: str, actor: str = Depends(require_api_key)) -> list[ReadingVersion]:
        if not agreement_key.strip():
            raise HTTPException(status_code=400, detail="Provide an agreement_key.")
        versions = get_repository().versions(agreement_key)
        get_repository().append_audit(actor, "versions.listed", agreement_key, None, f"Listed {len(versions)} versions.")
        return versions

    @protected.get("/v1/audit", response_model=list[AuditEvent])
    def list_audit() -> list[AuditEvent]:
        return get_repository().list_audit()

    app.include_router(protected)
    return app


def require_api_key(
    x_api_key: str | None = Header(default=None),
    authorization: str | None = Header(default=None),
) -> str:
    expected = os.environ.get("CONTRACTTWIN_API_KEY", "")
    if not expected:
        raise HTTPException(status_code=503, detail="The service has no API key configured.")
    presented = ""
    if authorization and authorization.lower().startswith("bearer "):
        presented = authorization[7:].strip()
    elif x_api_key:
        presented = x_api_key.strip()
    if not presented or not _keys_match(presented, expected):
        raise HTTPException(status_code=401, detail="The API key was missing or wrong.")
    return _key_fingerprint(presented)


def get_repository() -> ReadingRepository:
    global _repository, _repository_path
    path = os.environ.get("CONTRACTTWIN_DB_PATH", "data/contracttwin.sqlite")
    if _repository is None or _repository_path != path:
        _repository = SqliteReadingRepository(path)
        _repository_path = path
    return _repository


def clear_store() -> None:
    """Point the service at the current database path, dropping a test file if asked."""

    global _repository, _repository_path
    path = os.environ.get("CONTRACTTWIN_DB_PATH", "data/contracttwin.sqlite")
    if os.environ.get("CONTRACTTWIN_DB_RESET") == "1" and os.path.exists(path):
        os.remove(path)
    _repository = None
    _repository_path = None


def _read(body: AgreementInput, base: Extraction, amendments: list[Extraction], actor: str) -> AgreementAnalysis:
    request = AnalysisRequest(
        base_name=body.base.name,
        base_text=base.text,
        base_manifest_effective_date=body.base.effective_date,
        base_filename=body.base.filename,
        amendments=[(item.name, extraction.text, item.effective_date) for item, extraction in zip(body.amendments, amendments, strict=True)],
        amendment_filenames=[item.filename for item in body.amendments],
        extractor=_selected_extractor(),
    )
    try:
        analysis = analyze(request)
    except ValueError as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc
    _attach(analysis, [base, *amendments])
    agreement_key = (body.agreement_key or "").strip() or f"base-{sha256_text(base.text)[:16]}"
    repository = get_repository()
    prior = {item.analysis_id for item in repository.versions(agreement_key)}
    stored = repository.save(analysis, agreement_key)
    action = "reading.reused" if stored.analysis_id in prior else "reading.created"
    repository.append_audit(
        actor,
        action,
        stored.agreement_key,
        stored.analysis_id,
        f"Version {stored.version} of the agreement reading.",
    )
    return stored


def _attach(analysis: AgreementAnalysis, extractions: list[Extraction]) -> None:
    for document, extraction in zip(analysis.documents, extractions, strict=False):
        document.revisions = list(extraction.revisions)
        document.annotations = list(extraction.annotations)
        document.extraction_warnings = list(extraction.warnings)
        analysis.warnings.extend(extraction.warnings)


def _extraction_for(document, uploaded: dict[str, tuple[str, bytes]]) -> Extraction:
    if document.filename:
        if document.filename not in uploaded:
            raise ValueError(f"The upload is missing {document.filename}.")
        filename, data = uploaded[document.filename]
        return extract_upload(filename, data)
    if document.text:
        return Extraction(text=document.text)
    raise ValueError(f"{document.name} needs a file or text.")


async def _read_capped(upload: UploadFile) -> bytes:
    chunks: list[bytes] = []
    total = 0
    while True:
        block = await upload.read(65536)
        if not block:
            break
        total += len(block)
        if total > MAX_UPLOAD_BYTES:
            raise ValueError(f"A file is larger than {MAX_UPLOAD_BYTES} bytes.")
        chunks.append(block)
    if not chunks:
        raise ValueError("An uploaded file is empty.")
    return b"".join(chunks)


def _selected_extractor() -> OptionalLlmExtractor | None:
    if os.environ.get("CONTRACTTWIN_EXTRACTOR") != "llm":
        return None
    return OptionalLlmExtractor()


def _key_fingerprint(secret: str) -> str:
    return "key:" + hashlib.sha256(secret.encode("utf-8")).hexdigest()[:12]


def _keys_match(presented: str, expected: str) -> bool:
    return hmac.compare_digest(
        hashlib.sha256(presented.encode("utf-8")).digest(),
        hashlib.sha256(expected.encode("utf-8")).digest(),
    )


app = create_app()
