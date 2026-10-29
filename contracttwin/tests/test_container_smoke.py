"""Prove a built container can read an agreement and still find it after a restart."""

from __future__ import annotations

import json
import os
import subprocess
import time
import urllib.error
import urllib.request

import pytest

pytestmark = pytest.mark.smoke

KEY = "smoke-key"
TEXT = (
    "1. Pricing\n\n"
    "1.1 Payment. Customer shall pay each undisputed invoice within sixty (60) days after the invoice date (Net 60).\n"
)


@pytest.fixture
def container():
    image = os.environ.get("CONTRACTTWIN_IMAGE", "contracttwin-core")
    name = f"contracttwin-smoke-{os.getpid()}"
    subprocess.run(["docker", "rm", "-f", name], check=False, capture_output=True)
    started = subprocess.run(
        [
            "docker",
            "run",
            "-d",
            "--name",
            name,
            "-e",
            f"CONTRACTTWIN_API_KEY={KEY}",
            "-e",
            "CONTRACTTWIN_DB_PATH=/tmp/readings.sqlite",
            "--network",
            "host",
            image,
        ],
        check=False,
        capture_output=True,
        text=True,
    )
    if started.returncode != 0:
        pytest.fail(started.stderr or started.stdout)
    try:
        _wait(name)
        yield "8080", name
    finally:
        subprocess.run(["docker", "rm", "-f", name], check=False, capture_output=True)


def test_container_requires_a_key_and_keeps_the_reading(container) -> None:
    port, name = container
    health = urllib.request.urlopen(f"http://127.0.0.1:{port}/health", timeout=5)
    assert health.status == 200
    with pytest.raises(urllib.error.HTTPError) as denied:
        _request(port, "POST", "/v1/agreements", {"base": {"name": "Smoke", "role": "base", "text": TEXT}})
    assert denied.value.code == 401

    created = _request(
        port,
        "POST",
        "/v1/agreements",
        {"agreement_key": "smoke", "base": {"name": "Smoke", "role": "base", "text": TEXT}},
        key=KEY,
    )
    assert created["version"] == 1
    assert any(fact["attributes"].get("net_days") == 60 for fact in created["facts"] if fact["operative"])

    subprocess.run(["docker", "restart", name], check=True, capture_output=True)
    _wait(name)
    fetched = _request(port, "GET", f"/v1/agreements/{created['analysis_id']}", None, key=KEY)
    assert fetched["analysis_id"] == created["analysis_id"]
    assert fetched["version"] == 1
    assert fetched["agreement_key"] == "smoke"


def _wait(name: str) -> None:
    deadline = time.time() + 30
    last_error = "container did not answer"
    while time.time() < deadline:
        try:
            urllib.request.urlopen("http://127.0.0.1:8080/health", timeout=2)
            return
        except Exception as exc:
            last_error = str(exc)
            time.sleep(0.5)
    logs = subprocess.run(["docker", "logs", name], capture_output=True, text=True)
    state = subprocess.run(
        ["docker", "inspect", "-f", "{{.State.Status}} exit={{.State.ExitCode}} error={{.State.Error}}", name],
        capture_output=True,
        text=True,
    )
    pytest.fail(f"{last_error}\nstate: {state.stdout}\nstdout:\n{logs.stdout}\nstderr:\n{logs.stderr}")


def _request(port: str, method: str, path: str, payload: dict | None, key: str | None = None) -> dict:
    data = None if payload is None else json.dumps(payload).encode("utf-8")
    headers = {"content-type": "application/json", "accept": "application/json"}
    if key:
        headers["x-api-key"] = key
    request = urllib.request.Request(f"http://127.0.0.1:{port}{path}", data=data, headers=headers, method=method)
    with urllib.request.urlopen(request, timeout=10) as response:
        return json.loads(response.read().decode("utf-8"))
