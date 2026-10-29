"""HTTP service for one agreement reading.

The service keeps results in memory for this process only. It does not write
the cockpit database, and it does not decide that a reading is approved.
"""

from __future__ import annotations

import json
import os
import threading
from collections import OrderedDict

from fastapi import FastAPI, File, Form, HTTPException, UploadFile
from pydantic import ValidationError

from contracttwin.ingest import MAX_UPLOAD_BYTES, IngestError, extract_upload
from contracttwin.llm import OptionalLlmExtractor
from contracttwin.models import AgreementAnalysis, AgreementInput
from contracttwin.pipeline import AnalysisRequest, analyze

app = FastAPI(
    title="ContractTwin Core",
    version="0.1.0",
    summary="Source-grounded reading of an EMS customer agreement and its amendments.",
)

_STORE: OrderedDict[str, AgreementAnalysis] = OrderedDict()
_LOCK = threading.Lock()
_MAX_STORED = 100


@app.get("/health")
def health() -> dict[str, str]:
    return {"status": "ok", "service": "contracttwin-core", "version": "0.1.0"}


@app.post("/v1/agreements", response_model=AgreementAnalysis)
def create_agreement(body: AgreementInput) -> AgreementAnalysis:
    if body.base.role != "base":
        raise HTTPException(status_code=400, detail="The first document must be the base agreement.")
    if body.base.text is None:
        raise HTTPException(status_code=400, detail="The base agreement needs text. Use the file endpoint for PDF or Word.")
    for amendment in body.amendments:
        if amendment.role != "amendment":
            raise HTTPException(status_code=400, detail="Later documents must be amendments.")
        if amendment.text is None:
            raise HTTPException(status_code=400, detail=f"{amendment.name} needs text.")
    request = AnalysisRequest(
        base_name=body.base.name,
        base_text=body.base.text,
        base_manifest_effective_date=body.base.effective_date,
        base_filename=body.base.filename,
        amendments=[(item.name, item.text or "", item.effective_date) for item in body.amendments],
        amendment_filenames=[item.filename for item in body.amendments],
        extractor=_selected_extractor(),
    )
    return _run(request)


@app.post("/v1/agreements/files", response_model=AgreementAnalysis)
async def create_agreement_from_files(
    manifest: str = Form(...),
    files: list[UploadFile] = File(...),
) -> AgreementAnalysis:
    try:
        payload = json.loads(manifest)
        body = AgreementInput.model_validate(payload)
    except (json.JSONDecodeError, ValidationError) as exc:
        raise HTTPException(status_code=400, detail="The manifest is not a valid agreement description.") from exc
    uploaded: dict[str, tuple[str, bytes]] = {}
    try:
        for upload in files:
            name = upload.filename or ""
            if not name or "/" in name or "\\" in name or name in uploaded:
                raise ValueError("Each uploaded file needs its own plain file name.")
            uploaded[name] = (name, await _read_capped(upload))
        base_text = _text_for(body.base, uploaded)
        amendments = [(_text_for(item, uploaded), item) for item in body.amendments]
    except (IngestError, ValueError) as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc
    request = AnalysisRequest(
        base_name=body.base.name,
        base_text=base_text,
        base_manifest_effective_date=body.base.effective_date,
        base_filename=body.base.filename,
        amendments=[(item.name, text, item.effective_date) for text, item in amendments],
        amendment_filenames=[item.filename for item in body.amendments],
        extractor=_selected_extractor(),
    )
    return _run(request)


@app.get("/v1/agreements/{analysis_id}", response_model=AgreementAnalysis)
def get_agreement(analysis_id: str) -> AgreementAnalysis:
    with _LOCK:
        found = _STORE.get(analysis_id)
    if found is None:
        raise HTTPException(status_code=404, detail="No reading with that id is stored in this process.")
    return found


def clear_store() -> None:
    with _LOCK:
        _STORE.clear()


def _run(request: AnalysisRequest) -> AgreementAnalysis:
    try:
        analysis = analyze(request)
    except ValueError as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc
    with _LOCK:
        _STORE[analysis.analysis_id] = analysis
        _STORE.move_to_end(analysis.analysis_id)
        while len(_STORE) > _MAX_STORED:
            _STORE.popitem(last=False)
    return analysis


def _text_for(document, uploaded: dict[str, tuple[str, bytes]]) -> str:
    if document.filename:
        if document.filename not in uploaded:
            raise ValueError(f"The upload is missing {document.filename}.")
        filename, data = uploaded[document.filename]
        return extract_upload(filename, data)
    if document.text:
        return document.text
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
