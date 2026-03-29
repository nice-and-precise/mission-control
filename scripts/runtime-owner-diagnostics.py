#!/usr/bin/env python3
"""
Show which local process currently owns Mission Control runtime leases.
"""

from __future__ import annotations

import os
import sqlite3
import subprocess
from pathlib import Path


DB_PATH = Path(os.environ.get("DATABASE_PATH", Path.cwd() / "mission-control.db"))


def classify_owner(command: str) -> str:
    normalized = command.lower()
    if "next dev" in normalized or "next start" in normalized or "next-server" in normalized:
        return "app-runtime"
    if "tsx --test" in normalized or " --test " in normalized:
        return "test-runtime"
    if "tsx" in normalized or "node" in normalized:
        return "script-runtime"
    return "unknown"


def describe_process(pid: str) -> tuple[str, str]:
    proc = subprocess.run(
        ["ps", "-p", pid, "-o", "pid=,ppid=,etime=,command="],
        capture_output=True,
        text=True,
        check=False,
    )
    if proc.returncode != 0 or not proc.stdout.strip():
        return "missing", ""

    command = proc.stdout.strip()
    return classify_owner(command), command


def main() -> int:
    print(f"database: {DB_PATH}")
    print(f"runtime boot flag: {os.environ.get('MISSION_CONTROL_RUNTIME_BOOT', '<unset>')}")

    if not DB_PATH.exists():
        print("runtime leases: database not found")
        return 1

    with sqlite3.connect(DB_PATH) as conn:
        rows = conn.execute(
            """
            SELECT name, owner_id, expires_at, updated_at
            FROM runtime_leases
            ORDER BY name
            """
        ).fetchall()

    if not rows:
        print("runtime leases: none")
        return 0

    print("runtime leases:")
    for name, owner_id, expires_at, updated_at in rows:
        pid = str(owner_id).split(":", 1)[0]
        owner_type, command = describe_process(pid)
        print(f"- {name}")
        print(f"  owner_id: {owner_id}")
        print(f"  owner_type: {owner_type}")
        print(f"  expires_at: {expires_at}")
        print(f"  updated_at: {updated_at}")
        if command:
            print(f"  process: {command}")

    return 0


if __name__ == "__main__":
    raise SystemExit(main())
