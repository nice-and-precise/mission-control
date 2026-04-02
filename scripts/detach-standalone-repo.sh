#!/usr/bin/env bash

set -euo pipefail

BACKUP_ROOT="${1:-/Users/jordan/.openclaw/workspace/backups/mission-control-detach-prep-20260402-095401}"
REPO="${MISSION_CONTROL_REPO:-nice-and-precise/mission-control}"
DESCRIPTION="${MISSION_CONTROL_DESCRIPTION:-AI Agent Orchestration Dashboard - Manage AI agents, assign tasks, and coordinate multi-agent collaboration via OpenClaw Gateway.}"
RETARGET_REF="refs/heads/retarget/work-from-pre-real-work-baseline-20260327-origin-main"

require_file() {
  local path="$1"
  if [ ! -e "$path" ]; then
    echo "Missing required path: $path" >&2
    exit 1
  fi
}

wait_for_repo_state() {
  local desired="$1"
  local tries="$2"

  for _ in $(seq 1 "$tries"); do
    if gh api "repos/$REPO" >/dev/null 2>&1; then
      if [ "$desired" = "present" ]; then
        return 0
      fi
    else
      if [ "$desired" = "absent" ]; then
        return 0
      fi
    fi
    sleep 2
  done

  echo "Timed out waiting for repo state '$desired' on $REPO" >&2
  exit 1
}

main() {
  require_file "$BACKUP_ROOT/mission-control-fork-remote-backup.git"
  require_file "$BACKUP_ROOT/mission-control-local-mirror.git"

  gh api "repos/$REPO" > "$BACKUP_ROOT/repo-before-detach.json"

  gh api -X DELETE "repos/$REPO"
  wait_for_repo_state absent 30

  gh api user/repos \
    -f name="${REPO##*/}" \
    -f description="$DESCRIPTION" \
    -F private=false \
    -F has_issues=false \
    > "$BACKUP_ROOT/repo-after-create.json"
  wait_for_repo_state present 30

  git --git-dir "$BACKUP_ROOT/mission-control-fork-remote-backup.git" push --mirror "https://github.com/$REPO.git"
  git --git-dir "$BACKUP_ROOT/mission-control-local-mirror.git" push "https://github.com/$REPO.git" \
    "$RETARGET_REF:$RETARGET_REF"

  gh repo view "$REPO" --json nameWithOwner,isFork,parent,defaultBranchRef,visibility,url
}

main "$@"
