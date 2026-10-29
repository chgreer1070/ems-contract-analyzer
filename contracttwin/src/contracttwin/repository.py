"""Save readings so they are still there after a restart.

The service talks to this interface, not to SQLite directly. A different
store can implement the same three operations later.
"""

from __future__ import annotations

import hashlib
import sqlite3
from datetime import datetime, timezone
from pathlib import Path
from typing import Protocol

from contracttwin.models import AgreementAnalysis, ReadingVersion


class ReadingRepository(Protocol):
    def save(self, analysis: AgreementAnalysis, agreement_key: str) -> AgreementAnalysis:
        """Store a reading. The same agreement and the same text return the earlier version."""

    def get(self, analysis_id: str) -> AgreementAnalysis | None:
        """Return one stored reading, or nothing if that id is unknown."""

    def versions(self, agreement_key: str) -> list[ReadingVersion]:
        """List readings for one agreement, oldest first."""


class SqliteReadingRepository:
    def __init__(self, path: str) -> None:
        self.path = path
        Path(path).parent.mkdir(parents=True, exist_ok=True)
        with self._connect() as connection:
            connection.execute(
                """
                CREATE TABLE IF NOT EXISTS readings (
                    analysis_id TEXT PRIMARY KEY,
                    agreement_key TEXT NOT NULL,
                    version INTEGER NOT NULL,
                    content_id TEXT NOT NULL,
                    created_at TEXT NOT NULL,
                    engine_version TEXT NOT NULL,
                    payload_json TEXT NOT NULL,
                    UNIQUE (agreement_key, version)
                )
                """
            )
            connection.execute(
                "CREATE INDEX IF NOT EXISTS readings_by_agreement ON readings (agreement_key, version)"
            )

    def save(self, analysis: AgreementAnalysis, agreement_key: str) -> AgreementAnalysis:
        content_id = analysis.analysis_id
        analysis_id = _stored_id(agreement_key, content_id)
        with self._connect() as connection:
            existing = connection.execute(
                "SELECT payload_json FROM readings WHERE analysis_id = ?",
                (analysis_id,),
            ).fetchone()
            if existing is not None:
                return AgreementAnalysis.model_validate_json(existing["payload_json"])
            row = connection.execute(
                "SELECT COALESCE(MAX(version), 0) AS version FROM readings WHERE agreement_key = ?",
                (agreement_key,),
            ).fetchone()
            version = int(row["version"]) + 1
            created_at = datetime.now(timezone.utc).replace(microsecond=0).isoformat()
            stored = analysis.model_copy(
                update={
                    "analysis_id": analysis_id,
                    "agreement_key": agreement_key,
                    "version": version,
                }
            )
            connection.execute(
                """
                INSERT INTO readings (
                    analysis_id, agreement_key, version, content_id, created_at, engine_version, payload_json
                ) VALUES (?, ?, ?, ?, ?, ?, ?)
                """,
                (
                    analysis_id,
                    agreement_key,
                    version,
                    content_id,
                    created_at,
                    stored.engine_version,
                    stored.model_dump_json(),
                ),
            )
        return stored

    def get(self, analysis_id: str) -> AgreementAnalysis | None:
        with self._connect() as connection:
            row = connection.execute(
                "SELECT payload_json FROM readings WHERE analysis_id = ?",
                (analysis_id,),
            ).fetchone()
        if row is None:
            return None
        return AgreementAnalysis.model_validate_json(row["payload_json"])

    def versions(self, agreement_key: str) -> list[ReadingVersion]:
        with self._connect() as connection:
            rows = connection.execute(
                """
                SELECT analysis_id, agreement_key, version, created_at, engine_version
                FROM readings
                WHERE agreement_key = ?
                ORDER BY version
                """,
                (agreement_key,),
            ).fetchall()
        return [ReadingVersion.model_validate(dict(row)) for row in rows]

    def _connect(self) -> sqlite3.Connection:
        connection = sqlite3.connect(self.path, timeout=5)
        connection.row_factory = sqlite3.Row
        return connection


def _stored_id(agreement_key: str, content_id: str) -> str:
    digest = hashlib.sha256(f"{agreement_key}\n{content_id}".encode("utf-8")).hexdigest()
    return digest[:16]
