#!/usr/bin/env bash
set -euo pipefail

cd "$(dirname "$0")/.."

required_files=(
  "README.md"
  "VERIFICATION_CHECKLIST.md"
  "docs/CURRENT_LOCAL_STATUS.md"
  "docs/LOCAL_OPERATIONS_RUNBOOK.md"
  "docs/REPOSITORY_POLICY.md"
  "docs/OPENCLAW_RELEASE_IMPACT_AUDIT_2026-04-08.md"
)

for file in "${required_files[@]}"; do
  if [[ ! -f "$file" ]]; then
    echo "missing required doc: $file" >&2
    exit 1
  fi
done

assert_contains() {
  local needle="$1"
  shift

  if ! grep -Fq "$needle" "$@"; then
    echo "expected to find '$needle' in: $*" >&2
    exit 1
  fi
}

assert_contains 'GET /api/health' README.md VERIFICATION_CHECKLIST.md docs/LOCAL_OPERATIONS_RUNBOOK.md
assert_contains 'Authorization: Bearer' README.md VERIFICATION_CHECKLIST.md docs/LOCAL_OPERATIONS_RUNBOOK.md
assert_contains '`origin/main`' docs/REPOSITORY_POLICY.md docs/LOCAL_OPERATIONS_RUNBOOK.md docs/CURRENT_LOCAL_STATUS.md
assert_contains '`source/main`' docs/REPOSITORY_POLICY.md docs/LOCAL_OPERATIONS_RUNBOOK.md docs/CURRENT_LOCAL_STATUS.md
assert_contains 'sourceChannel' docs/OPENCLAW_RELEASE_IMPACT_AUDIT_2026-04-08.md
assert_contains 'warning' docs/OPENCLAW_RELEASE_IMPACT_AUDIT_2026-04-08.md
assert_contains 'OpenClaw Release Impact Audit 2026-04-08' docs/README.md

python3 scripts/docs_policy.py

echo "docs sanity check passed"
