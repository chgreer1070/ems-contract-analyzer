"""Shared fixture loader for the synthetic Harborline agreement."""

from __future__ import annotations

import warnings
from pathlib import Path

warnings.filterwarnings("ignore", category=UserWarning, module=r"fastapi\.testclient")

import pytest

from contracttwin.api import clear_store
from contracttwin.models import AgreementAnalysis
from contracttwin.pipeline import AnalysisRequest, analyze

FIXTURES = Path(__file__).parent / "fixtures"
API_KEY = "test-key"
API_HEADERS = {"X-API-Key": API_KEY}


@pytest.fixture(autouse=True)
def _reset_store(tmp_path, monkeypatch) -> None:
    monkeypatch.setenv("CONTRACTTWIN_API_KEY", API_KEY)
    monkeypatch.setenv("CONTRACTTWIN_DB_PATH", str(tmp_path / "readings.sqlite"))
    clear_store()


def read_fixture(name: str) -> str:
    return (FIXTURES / name).read_text(encoding="utf-8")


def harborline_request() -> AnalysisRequest:
    return AnalysisRequest(
        base_name="Harborline MSA",
        base_text=read_fixture("harborline_msa.txt"),
        base_manifest_effective_date="2024-01-15",
        base_filename="harborline_msa.txt",
        amendments=[
            ("Amendment No. 1", read_fixture("harborline_amendment_1.txt"), "2025-03-01"),
        ],
        amendment_filenames=["harborline_amendment_1.txt"],
    )


def harborline_analysis() -> AgreementAnalysis:
    return analyze(harborline_request())
