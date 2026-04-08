#!/usr/bin/env python3
"""Mission Control docs contract checks."""

from __future__ import annotations

import re
import sys
from pathlib import Path

REQUIRED_FIELDS = (
    "doc_id",
    "title",
    "doc_type",
    "status",
    "owner",
    "last-reviewed",
    "canonical",
    "applies-to",
)

ALLOWED_STATUS = {"draft", "active", "deprecated"}
ALLOWED_DOC_TYPES = {"index", "how-to", "reference", "explanation", "runbook", "standard"}
ALLOWED_APPLIES_TO = {"mission-control", "machine-local", "shared"}
DOCS_INDEX = "docs/README.md"
INDEX_LINK_RE = re.compile(r"\[[^\]]+]\(([^)]+)\)")
BODY_HISTORICAL_RE = re.compile(r"historical", re.IGNORECASE)


def parse_frontmatter(path: Path) -> tuple[dict[str, str], list[str], str]:
    text = path.read_text(encoding="utf-8")
    lines = text.splitlines()
    if not lines or lines[0].strip() != "---":
        raise ValueError("missing frontmatter")

    end = None
    for idx, line in enumerate(lines[1:], start=1):
        if line.strip() == "---":
            end = idx
            break
    if end is None:
        raise ValueError("unclosed frontmatter")

    metadata: dict[str, str] = {}
    for line in lines[1:end]:
        if not line.strip():
            continue
        if ":" not in line:
            raise ValueError(f"invalid frontmatter line: {line}")
        key, value = line.split(":", 1)
        metadata[key.strip()] = value.strip().strip("\"'")
    return metadata, lines[end + 1 :], text


def normalize_index_target(raw: str, current_doc: str) -> str | None:
    target = raw.split("#", 1)[0].split("?", 1)[0].strip()
    if not target or target.startswith(("http://", "https://", "mailto:")):
        return None
    if target.startswith("../"):
        return (Path(current_doc).parent / target).as_posix()
    if target.startswith("./"):
        return (Path(current_doc).parent / target).as_posix()
    if target.startswith("docs/"):
        return target
    return (Path(current_doc).parent / target).as_posix()


def load_index_targets(repo_root: Path) -> set[str]:
    index_path = repo_root / DOCS_INDEX
    text = index_path.read_text(encoding="utf-8")
    targets: set[str] = set()
    for raw in INDEX_LINK_RE.findall(text):
        normalized = normalize_index_target(raw, DOCS_INDEX)
        if normalized:
            targets.add(str(Path(normalized).as_posix()))
    return targets


def collect_duplicate_doc_id_errors(doc_metadata: dict[str, dict[str, str]]) -> list[str]:
    doc_id_to_paths: dict[str, list[str]] = {}
    errors: list[str] = []

    for rel, metadata in doc_metadata.items():
        doc_id = metadata.get("doc_id", "").strip()
        if not doc_id:
            continue
        doc_id_to_paths.setdefault(doc_id, []).append(rel)

    for doc_id, paths in sorted(doc_id_to_paths.items()):
        if len(paths) < 2:
            continue
        joined = ", ".join(sorted(paths))
        for rel in sorted(paths):
            errors.append(f"{rel}: duplicate doc_id '{doc_id}' also used by {joined}")

    return errors


def main() -> int:
    repo_root = Path.cwd()
    docs = sorted(
        path for path in (repo_root / "docs").rglob("*.md")
        if "docs/archive/" not in path.as_posix()
    )
    indexed_targets = load_index_targets(repo_root)
    errors: list[str] = []
    doc_metadata: dict[str, dict[str, str]] = {}

    for path in docs:
        rel = path.relative_to(repo_root).as_posix()
        try:
            metadata, body_lines, _ = parse_frontmatter(path)
        except ValueError as exc:
            errors.append(f"{rel}: {exc}")
            continue

        doc_metadata[rel] = metadata

        for field in REQUIRED_FIELDS:
            if not metadata.get(field):
                errors.append(f"{rel}: missing required field '{field}'")

        if metadata.get("status") and metadata["status"] not in ALLOWED_STATUS:
            errors.append(f"{rel}: invalid status '{metadata['status']}'")
        if metadata.get("doc_type") and metadata["doc_type"] not in ALLOWED_DOC_TYPES:
            errors.append(f"{rel}: invalid doc_type '{metadata['doc_type']}'")
        if metadata.get("canonical") and metadata["canonical"] not in {"true", "false"}:
            errors.append(f"{rel}: canonical must be true or false")
        if metadata.get("applies-to") and metadata["applies-to"] not in ALLOWED_APPLIES_TO:
            errors.append(f"{rel}: invalid applies-to '{metadata['applies-to']}'")

        if metadata.get("canonical") == "true" and rel != DOCS_INDEX and rel not in indexed_targets:
            errors.append(f"{rel}: canonical doc is not registered in {DOCS_INDEX}")

        if metadata.get("status") == "deprecated":
            if not (metadata.get("replaced-by") or metadata.get("supersedes")):
                errors.append(f"{rel}: deprecated doc needs replaced-by or supersedes")
            head = "\n".join(body_lines[:20])
            if not BODY_HISTORICAL_RE.search(head):
                errors.append(f"{rel}: deprecated doc must identify itself as historical near the top")

    errors.extend(collect_duplicate_doc_id_errors(doc_metadata))

    if errors:
        for error in errors:
            print(error, file=sys.stderr)
        return 1

    print("docs policy check passed")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
