"""Optional model extractor.

The default reading does not call a model. A caller can pass an extractor.
Any quote the model returns still has to appear verbatim in the named document.
If the model is not configured, or its output is unusable, the deterministic
rules remain the reading.
"""

from __future__ import annotations

import json
import os
import urllib.request
from typing import Callable, Protocol

from contracttwin.precedence import PreparedDocument
from contracttwin.quote_check import Candidate

Complete = Callable[[str], str]


class ExtractorUnavailable(RuntimeError):
    """The model extractor cannot be used. The rule reading should continue."""


class Extractor(Protocol):
    name: str

    def extract(self, documents: list[PreparedDocument]) -> list[Candidate]:
        """Return candidate statements. The quote checker accepts or rejects them."""


class OptionalLlmExtractor:
    name = "llm"

    def __init__(self, complete: Complete | None = None) -> None:
        self._complete = complete

    def extract(self, documents: list[PreparedDocument]) -> list[Candidate]:
        complete = self._complete or _configured_complete()
        raw = complete(_prompt(documents))
        return _candidates_from_model(raw, documents)


def _configured_complete() -> Complete:
    if not os.environ.get("CONTRACTTWIN_LLM_API_KEY"):
        raise ExtractorUnavailable("No model key is configured. The rule reading was used.")
    return _openai_complete


def _prompt(documents: list[PreparedDocument]) -> str:
    blocks = []
    for document in documents:
        blocks.append(
            f"DOCUMENT {document.document_id} ({document.name})\n{document.text}"
        )
    joined = "\n\n".join(blocks)
    return (
        "Extract pricing, NCNR, excess-and-obsolete, and notice facts from the documents. "
        "Return JSON only, with a statements array. Each item needs statement, quote, document_id, "
        "section, and domain. The quote must be copied exactly from that document. "
        "Do not invent amounts.\n\n"
        f"{joined}"
    )


def _candidates_from_model(raw: str, documents: list[PreparedDocument]) -> list[Candidate]:
    try:
        payload = json.loads(raw)
    except json.JSONDecodeError as exc:
        raise ExtractorUnavailable("The model output was not JSON.") from exc
    rows = payload.get("statements") if isinstance(payload, dict) else None
    if not isinstance(rows, list):
        raise ExtractorUnavailable("The model output did not contain a statements array.")
    known = {document.document_id: document for document in documents}
    candidates: list[Candidate] = []
    for row in rows:
        if not isinstance(row, dict):
            continue
        document_id = str(row.get("document_id") or "")
        document = known.get(document_id)
        domain = str(row.get("domain") or "general")
        if domain not in {
            "pricing",
            "ncnr",
            "excess_and_obsolete",
            "notice",
            "definition",
            "survival",
            "precedence",
            "general",
        }:
            domain = "general"
        candidates.append(
            Candidate(
                kind="fact",
                domain=domain,
                statement=str(row.get("statement") or ""),
                operative=True,
                section=row.get("section") if isinstance(row.get("section"), str) else None,
                document_id=document_id or None,
                document_name=document.name if document else None,
                quote=row.get("quote") if isinstance(row.get("quote"), str) else None,
                attributes={"source": "llm"},
            )
        )
    return candidates


def _openai_complete(prompt: str) -> str:
    key = os.environ.get("CONTRACTTWIN_LLM_API_KEY", "")
    base = os.environ.get("CONTRACTTWIN_LLM_BASE_URL", "https://api.openai.com/v1/chat/completions")
    model = os.environ.get("CONTRACTTWIN_LLM_MODEL", "gpt-4.1-mini")
    body = json.dumps(
        {
            "model": model,
            "temperature": 0,
            "messages": [
                {"role": "system", "content": "You extract contract facts and answer with JSON only."},
                {"role": "user", "content": prompt},
            ],
        }
    ).encode("utf-8")
    request = urllib.request.Request(
        base,
        data=body,
        headers={"Authorization": f"Bearer {key}", "Content-Type": "application/json"},
        method="POST",
    )
    try:
        with urllib.request.urlopen(request, timeout=30) as response:
            payload = json.loads(response.read().decode("utf-8"))
    except Exception as exc:
        raise ExtractorUnavailable("The model request failed.") from exc
    try:
        return str(payload["choices"][0]["message"]["content"])
    except (KeyError, IndexError, TypeError) as exc:
        raise ExtractorUnavailable("The model response had no message text.") from exc
