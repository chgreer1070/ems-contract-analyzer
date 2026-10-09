"""Recheck cross-agent raw artifact and source bindings without live connections."""
from pathlib import Path
import datetime
import hashlib
import json
import subprocess

evidence = Path(__file__).resolve().parent
app = evidence.parents[2]
root = app.parent
base = "0d446203d670e086aa50ef8d65755cbc653ae6be"


def sha(data):
    return hashlib.sha256(data).hexdigest()


def git_bytes(revision, relative):
    return subprocess.run(
        ["git", "show", revision + ":commercial-legal-cockpit/" + relative],
        cwd=root, capture_output=True, check=True,
    ).stdout


checks = []
for name in [
    "legal-document-evidence-final-check-output.json",
    "legal-model-controls-pack.json",
    "parser-security-load-results.json",
    "database-integrity-command-record.json",
]:
    data = json.loads((evidence / name).read_text())
    records = [data] if "sourceHashes" in data else list(data.get("results", []))
    if name.startswith("parser"):
        records += [item for batch in data.get("batches", []) for item in batch["items"]]
    current, baseline, mismatches = 0, 0, []
    for record in records:
        for relative, digest in record.get("sourceHashes", {}).items():
            if sha((app / relative).read_bytes()) == digest:
                current += 1
            else:
                mismatches.append(relative)
            if name.startswith("database"):
                assert sha(git_bytes(base, relative)) == digest
                baseline += 1
    result = {
        "report": name,
        "verifiedCurrentSourceHashReferences": current,
        "mismatchedCurrentSourceHashReferences": sorted(set(mismatches)),
    }
    if baseline:
        result["verifiedExactBaselineSourceHashReferences"] = baseline
    if name.startswith("legal-document"):
        for record in data["results"]:
            fixture = evidence / ("legal-document-evidence-" + record["name"] + ".docx")
            assert sha(fixture.read_bytes()) == record["sourceSha256"]
        result["verifiedPreservedFixtureHashes"] = len(data["results"])
    if name.startswith("parser"):
        assert len(data["results"]) == 14
        assert sum(len(batch["items"]) for batch in data["batches"]) == 7
        assert all(record["expectationMet"] for record in records)
        result["profileSamples"] = 14
        result["burstWorkerSamples"] = 7
        installed = app / "node_modules/@xmldom/xmldom/package.json"
        assert json.loads(installed.read_text())["version"] == "0.8.15"
        assert sha(installed.read_bytes()) == data["metadata"]["installedXmlParser"]["packageJsonSha256"]
        result["installedXmlParserVersionVerified"] = "0.8.15"
    checks.append(result)

manifest = json.loads((evidence / "database-integrity-evidence-manifest.json").read_text())
for reference in manifest["files"]:
    path = app / reference["path"]
    assert path.stat().st_size == reference["bytes"]
    assert sha(path.read_bytes()) == reference["sha256"]
checks.append({
    "report": "database-integrity-evidence-manifest.json",
    "verifiedArtifactHashes": len(manifest["files"]),
    "diagnosticExitCode": manifest["embeddedExecution"]["exitCode"],
    "defects": manifest["embeddedExecution"]["releaseDefectsReproduced"],
    "acceptedServerConcurrency": False,
    "acceptedLiveTarget": False,
})

dependency = json.loads((evidence / "dependency-ci-local-validation.json").read_text())
commit = subprocess.run(
    ["git", "rev-parse", "--verify", dependency["proposedSha"] + "^{commit}"],
    cwd=root, capture_output=True, text=True, check=True,
).stdout.strip()
for relative in ["package.json", "package-lock.json"]:
    assert sha(git_bytes(commit, relative)) == dependency["artifactHashes"][relative]
assert sha((app / "package-lock.json").read_bytes()) == dependency["artifactHashes"]["package-lock.json"]
checks.append({
    "report": "dependency-ci-local-validation.json",
    "verifiedIsolatedGitCommit": commit,
    "verifiedIsolatedPackageHashes": 2,
    "integratedLockHashMatches": True,
    "integratedPackageWiringDiffers": sha((app / "package.json").read_bytes()) != dependency["artifactHashes"]["package.json"],
    "liveOrHostedAcceptance": False,
})

coordinator = json.loads((evidence / "coordinator-source-inventory.json").read_text())
assert sha(json.dumps(coordinator["files"], separators=(",", ":")).encode()) == coordinator["sourceSnapshotSha256"]
for reference in coordinator["files"]:
    assert sha((app / reference["path"]).read_bytes()) == reference["sha256"]
parser = json.loads((evidence / "parser-security-load-results.json").read_text())
assert parser["metadata"]["sourceSnapshotSha256"] == coordinator["sourceSnapshotSha256"]
assert parser["metadata"]["sourceSnapshotFiles"] == coordinator["files"]
assert parser["metadata"]["snapshotUnchangedBeforeAndAfter"] is True
checks.append({
    "report": "coordinator-source-inventory.json",
    "verifiedCoordinatorScopeSnapshotSha256": coordinator["sourceSnapshotSha256"],
    "verifiedCurrentScopeFiles": len(coordinator["files"]),
    "definition": "Compact UTF-8 JSON of the listed ten selected source/package files; distinct from full tracked-source snapshot",
})

reviewed = [item["report"] for item in checks] + [
    "dependency-ci-checks.json", "coordinator-audit.json", "coordinator-audit-command.json",
    "coordinator-controls.json", "coordinator-typecheck.json", "coordinator-build.json",
    "coordinator-controls.log", "coordinator-typecheck.log", "coordinator-build.log",
    "parser-security-load-run.log", "parser-security-load-integrity-check.log",
]
record = {
    "observedAtUtc": datetime.datetime.now(datetime.timezone.utc).isoformat(),
    "command": "python3 acceptance/docx/evidence/release-authority-cross-review.py",
    "runnerSha256": sha(Path(__file__).read_bytes()),
    "reviewedSourceSnapshotSha256": json.loads((evidence / "release-authority-check.json").read_text())["revision"],
    "reviewScope": "Source/artifact hashes and raw diagnostics; not hosted re-fetch, authenticated producer, server concurrency or live acceptance",
    "results": checks,
    "reviewedEvidence": [
        {"path": str((evidence / name).relative_to(root)), "sha256": sha((evidence / name).read_bytes())}
        for name in reviewed
    ],
}
(evidence / "release-authority-cross-review.json").write_text(json.dumps(record, indent=2) + "\n")
print(json.dumps(record, indent=2))
