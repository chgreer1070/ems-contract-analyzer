"""Readings stay on disk and stack up as versions of one agreement."""

from __future__ import annotations

from fastapi.testclient import TestClient

from contracttwin.api import app, clear_store
from contracttwin.repository import SqliteReadingRepository

from .conftest import API_HEADERS

client = TestClient(app, headers=API_HEADERS)

BASE = "1. Pricing\n\n1.1 Payment. Customer shall pay each undisputed invoice within ten (10) days after the invoice date (Net 10).\n"
CHANGED = "1. Pricing\n\n1.1 Payment. Customer shall pay each undisputed invoice within twenty (20) days after the invoice date (Net 20).\n"


def test_versions_survive_reopening_the_database(tmp_path, monkeypatch) -> None:
    path = tmp_path / "readings.sqlite"
    monkeypatch.setenv("CONTRACTTWIN_DB_PATH", str(path))
    clear_store()
    first = client.post("/v1/agreements", json={"agreement_key": "harborline", "base": {"name": "Base", "role": "base", "text": BASE}})
    second = client.post("/v1/agreements", json={"agreement_key": "harborline", "base": {"name": "Base", "role": "base", "text": CHANGED}})
    assert first.status_code == 200, first.text
    assert second.status_code == 200, second.text
    assert first.json()["version"] == 1
    assert second.json()["version"] == 2
    assert first.json()["analysis_id"] != second.json()["analysis_id"]
    again = client.post("/v1/agreements", json={"agreement_key": "harborline", "base": {"name": "Base", "role": "base", "text": CHANGED}})
    assert again.json()["analysis_id"] == second.json()["analysis_id"]
    assert again.json()["version"] == 2

    clear_store()
    reopened = SqliteReadingRepository(str(path))
    versions = reopened.versions("harborline")
    assert [item.version for item in versions] == [1, 2]
    listed = client.get("/v1/agreement-versions", params={"agreement_key": "harborline"})
    assert listed.status_code == 200
    assert [item["version"] for item in listed.json()] == [1, 2]
    fetched = client.get(f"/v1/agreements/{first.json()['analysis_id']}")
    assert fetched.status_code == 200
    assert fetched.json()["facts"]
    assert fetched.json()["version"] == 1
