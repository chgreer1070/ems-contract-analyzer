#!/usr/bin/env python3
"""Decide whether the CI gate can pass.

The gate passes only when the latest run of each required validation check
succeeded. A failed Vercel preview and any npm audit check are ignored.
Synthetic fixtures in --self-test cover that rule. No live data is used there.
"""

from __future__ import annotations

import json
import os
import re
import subprocess
import sys
import time
from typing import Mapping, Sequence

REQUIRED_CHECKS: tuple[str, ...] = (
    "Cockpit validation",
    "Reading service tests",
    "Dockerfile builds",
    "Sample agreement page",
    "CodeQL JavaScript / TypeScript",
    "Release preflight",
)

PENDING = "pending"
PASS = "pass"
FAIL = "fail"

_PENDING_STATUSES = {"queued", "in_progress", "waiting", "pending", "requested"}
_TOKEN_RE = re.compile(r"gh[pousr]_[A-Za-z0-9_]+")
_POLL_SECONDS = 30
_DEADLINE_SECONDS = 75 * 60


def sanitize(text: str) -> str:
    return _TOKEN_RE.sub("[redacted]", text)


def latest_required(runs: Sequence[Mapping[str, object]]) -> dict[str, Mapping[str, object]]:
    """Keep the newest GitHub Actions run for each required check name."""
    chosen: dict[str, Mapping[str, object]] = {}
    required = set(REQUIRED_CHECKS)
    for run in runs:
        name = run.get("name")
        if name not in required:
            continue
        current = chosen.get(str(name))
        if current is None or _prefer(run, current):
            chosen[str(name)] = run
    return chosen


def _app_slug(run: Mapping[str, object]) -> str:
    app = run.get("app")
    if isinstance(app, Mapping):
        slug = app.get("slug")
        if isinstance(slug, str):
            return slug
    return ""


def _prefer(candidate: Mapping[str, object], current: Mapping[str, object]) -> bool:
    candidate_actions = _app_slug(candidate) == "github-actions"
    current_actions = _app_slug(current) == "github-actions"
    if candidate_actions != current_actions:
        return candidate_actions
    return int(str(candidate.get("id", 0))) > int(str(current.get("id", 0)))


def decide(runs: Sequence[Mapping[str, object]]) -> tuple[str, list[str]]:
    latest = latest_required(runs)
    lines: list[str] = []
    pending: list[str] = []
    failed: list[str] = []
    for name in REQUIRED_CHECKS:
        run = latest.get(name)
        if run is None:
            pending.append(f"{name}: not started")
            continue
        status = str(run.get("status") or "")
        conclusion = str(run.get("conclusion") or "")
        if status in _PENDING_STATUSES or status != "completed":
            pending.append(f"{name}: {status or 'unknown'}")
            continue
        if conclusion != "success":
            failed.append(f"{name}: {conclusion or 'no result'}")
            continue
        lines.append(f"{name}: success")
    ignored = _ignored_failures(runs)
    if failed:
        return FAIL, ["Required validation did not pass:", *failed, *lines, *ignored]
    if pending:
        return PENDING, ["Waiting for required validation:", *pending, *lines]
    return PASS, ["Required validation passed:", *lines, *ignored]


def _ignored_failures(runs: Sequence[Mapping[str, object]]) -> list[str]:
    required = set(REQUIRED_CHECKS)
    ignored: list[str] = []
    seen: set[str] = set()
    for run in runs:
        name = str(run.get("name") or "")
        if name in required or name in seen:
            continue
        if str(run.get("status") or "") == "completed" and str(run.get("conclusion") or "") not in {"", "success", "skipped", "neutral"}:
            seen.add(name)
            ignored.append(f"Ignored (not part of the gate): {name}: {run.get('conclusion')}")
    return ignored


def fetch_check_runs(repository: str, sha: str) -> list[dict[str, object]]:
    result = subprocess.run(
        [
            "gh",
            "api",
            "--paginate",
            f"repos/{repository}/commits/{sha}/check-runs?per_page=100",
        ],
        check=False,
        capture_output=True,
        text=True,
        timeout=60,
    )
    if result.returncode != 0:
        detail = sanitize(result.stderr.strip() or result.stdout.strip() or "gh api failed")
        raise RuntimeError(detail)
    runs: list[dict[str, object]] = []
    decoder = json.JSONDecoder()
    text = result.stdout
    index = 0
    while index < len(text):
        while index < len(text) and text[index].isspace():
            index += 1
        if index >= len(text):
            break
        page, index = decoder.raw_decode(text, index)
        if isinstance(page, dict):
            page_runs = page.get("check_runs", [])
            if isinstance(page_runs, list):
                runs.extend(item for item in page_runs if isinstance(item, dict))
    return runs


def poll_until_decided() -> int:
    cockpit = os.environ.get("LOCAL_COCKPIT_RESULT", "")
    if cockpit != "success":
        print(f"Cockpit validation did not succeed: {cockpit or 'missing'}")
        return 1
    repository = os.environ.get("GITHUB_REPOSITORY", "")
    sha = os.environ.get("CHECK_SHA") or os.environ.get("GITHUB_SHA", "")
    if re.fullmatch(r"[A-Za-z0-9_.-]+/[A-Za-z0-9_.-]+", repository) is None:
        print("GITHUB_REPOSITORY is not an owner/name.")
        return 1
    if re.fullmatch(r"[0-9a-fA-F]{40}", sha) is None:
        print("CHECK_SHA is not a commit id.")
        return 1
    print(f"Judging validation checks on {sha}.")
    deadline = time.monotonic() + _DEADLINE_SECONDS
    while True:
        try:
            runs = fetch_check_runs(repository, sha)
        except (RuntimeError, json.JSONDecodeError, subprocess.TimeoutExpired) as error:
            print(sanitize(str(error)))
            return 1
        decision, lines = decide(runs)
        print("\n".join(lines))
        if decision == PASS:
            return 0
        if decision == FAIL:
            return 1
        if time.monotonic() >= deadline:
            print("Timed out waiting for the required validation checks.")
            return 1
        time.sleep(_POLL_SECONDS)


def _run(
    name: str,
    status: str,
    conclusion: str | None,
    run_id: int,
    app: str | None = "github-actions",
) -> dict[str, object]:
    payload: dict[str, object] = {
        "id": run_id,
        "name": name,
        "status": status,
        "conclusion": conclusion,
    }
    if app is not None:
        payload["app"] = {"slug": app}
    return payload


def _success_runs(start_id: int = 10) -> list[dict[str, object]]:
    return [
        _run(name, "completed", "success", start_id + index)
        for index, name in enumerate(REQUIRED_CHECKS)
    ]


def run_self_test() -> int:
    for name in REQUIRED_CHECKS:
        lowered = name.casefold()
        if "audit" in lowered or lowered == "vercel preview":
            print(f"Required list includes a check that must stay out of the gate: {name}")
            return 1
    cases: list[tuple[str, list[dict[str, object]], str]] = []
    passing = _success_runs()
    passing.extend(
        [
            _run("Vercel preview", "completed", "failure", 1),
            _run("npm audit", "completed", "failure", 2),
            _run("Production dependency audit", "completed", "failure", 3),
            _run("Approval-gated Vercel production", "completed", "skipped", 4),
        ]
    )
    cases.append(("preview and audit failures stay outside the gate", passing, PASS))

    failed = _success_runs()
    failed[0] = _run(REQUIRED_CHECKS[0], "completed", "failure", 100)
    cases.append(("a required failure fails the gate", failed, FAIL))

    skipped = _success_runs()
    skipped[3] = _run(REQUIRED_CHECKS[3], "completed", "skipped", 80)
    cases.append(("a skipped required check is not a pass", skipped, FAIL))

    waiting = _success_runs()
    waiting[4] = _run(REQUIRED_CHECKS[4], "in_progress", None, 90)
    cases.append(("an unfinished required check keeps waiting", waiting, PENDING))

    missing = _success_runs()[:-1]
    cases.append(("a missing required check keeps waiting", missing, PENDING))

    replaced = _success_runs(start_id=1)
    replaced.append(_run(REQUIRED_CHECKS[1], "completed", "success", 50))
    replaced.append(_run(REQUIRED_CHECKS[1], "completed", "failure", 20))
    cases.append(("a newer success replaces an older failure", replaced, PASS))

    regressed = _success_runs(start_id=1)
    regressed.append(_run(REQUIRED_CHECKS[2], "completed", "failure", 70))
    cases.append(("a newer failure replaces an older success", regressed, FAIL))

    foreign = _success_runs()
    foreign.append(_run(REQUIRED_CHECKS[0], "completed", "failure", 500, app="other-app"))
    cases.append(("a non-Actions check does not override the Actions job", foreign, PASS))

    problems = 0
    for label, runs, expected in cases:
        decision, _lines = decide(runs)
        if decision != expected:
            problems += 1
            print(f"FAIL {label}: expected {expected}, got {decision}")
        else:
            print(f"ok {label}")
    if problems:
        return 1
    print("self-test passed")
    print("required checks:")
    for name in REQUIRED_CHECKS:
        print(f"- {name}")
    return 0


def main() -> int:
    if "--self-test" in sys.argv:
        return run_self_test()
    return poll_until_decided()


if __name__ == "__main__":
    sys.exit(main())
