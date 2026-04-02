#!/usr/bin/env bash

set -euo pipefail

CANONICAL_REMOTE="${MISSION_CONTROL_CANONICAL_REMOTE:-origin}"
CANONICAL_BRANCH="${MISSION_CONTROL_CANONICAL_BRANCH:-main}"
SOURCE_REMOTE="${MISSION_CONTROL_SOURCE_REMOTE:-source}"
ALLOW_SOURCE_BASE="${MISSION_CONTROL_ALLOW_SOURCE_BASE:-0}"

CANONICAL_REF="${CANONICAL_REMOTE}/${CANONICAL_BRANCH}"
SOURCE_REF="${SOURCE_REMOTE}/${CANONICAL_BRANCH}"

usage() {
  cat <<'EOF'
Usage:
  scripts/git-branch-policy.sh check
  scripts/git-branch-policy.sh pre-push <remote-name> <remote-url>
  scripts/git-branch-policy.sh pre-rebase [upstream] [branch]

Environment overrides:
  MISSION_CONTROL_CANONICAL_REMOTE   Default: origin
  MISSION_CONTROL_CANONICAL_BRANCH   Default: main
  MISSION_CONTROL_SOURCE_REMOTE      Default: source
  MISSION_CONTROL_ALLOW_SOURCE_BASE  Default: 0
EOF
}

print_line() {
  printf '%s\n' "$1"
}

branch_name() {
  git symbolic-ref --quiet --short HEAD 2>/dev/null || true
}

ref_exists() {
  git rev-parse --verify --quiet "$1" >/dev/null 2>&1
}

contains_ref() {
  local ancestor_ref="$1"
  local target_ref="$2"
  git merge-base --is-ancestor "$ancestor_ref" "$target_ref" >/dev/null 2>&1
}

resolve_ref() {
  git rev-parse --verify --quiet "$1" 2>/dev/null || true
}

show_status() {
  local branch canonical_sha source_sha

  branch="$(branch_name)"
  canonical_sha="$(resolve_ref "$CANONICAL_REF")"
  source_sha="$(resolve_ref "$SOURCE_REF")"

  print_line "Mission Control branch policy"
  print_line "  branch: ${branch:-DETACHED}"
  print_line "  canonical trunk: ${CANONICAL_REF}${canonical_sha:+ @ ${canonical_sha:0:12}}"

  if [ -n "$source_sha" ]; then
    print_line "  source reference: ${SOURCE_REF} @ ${source_sha:0:12}"
  else
    print_line "  source reference: ${SOURCE_REF} (not configured)"
  fi

  if ref_exists HEAD && ref_exists "$CANONICAL_REF" && contains_ref "$CANONICAL_REF" HEAD; then
    print_line "  contains canonical trunk: yes"
  else
    print_line "  contains canonical trunk: no"
  fi

  if ref_exists HEAD && ref_exists "$SOURCE_REF" && contains_ref "$SOURCE_REF" HEAD; then
    print_line "  contains source trunk: yes"
  else
    print_line "  contains source trunk: no"
  fi
}

ensure_canonical_base() {
  if ! ref_exists "$CANONICAL_REF"; then
    print_line "ERROR: canonical ref ${CANONICAL_REF} does not exist locally."
    print_line "Run: git fetch ${CANONICAL_REMOTE} ${CANONICAL_BRANCH}"
    return 1
  fi

  if ! contains_ref "$CANONICAL_REF" HEAD; then
    print_line "ERROR: current branch is not based on ${CANONICAL_REF}."
    if ref_exists "$SOURCE_REF" && contains_ref "$SOURCE_REF" HEAD; then
      print_line "This branch contains ${SOURCE_REF}, which means it is source-based rather than product-trunk-based."
    fi
    print_line "Mission Control policy for this checkout is:"
    print_line "  - ${CANONICAL_REF} is the canonical product trunk"
    print_line "  - ${SOURCE_REF} is read-only reference input, not a branch base for day-to-day work"
    print_line "Rebase or rebuild this branch on ${CANONICAL_REF} before pushing."
    return 1
  fi
}

handle_check() {
  show_status
  ensure_canonical_base
}

handle_pre_push() {
  local remote_name remote_url local_ref local_sha remote_ref remote_sha

  remote_name="${1:-}"
  remote_url="${2:-}"

  show_status

  if [ -z "$remote_name" ]; then
    print_line "ERROR: pre-push hook did not receive a remote name."
    return 1
  fi

  if [ "$remote_name" != "$CANONICAL_REMOTE" ]; then
    print_line "ERROR: refusing push to remote '${remote_name}'."
    print_line "This checkout publishes product work to '${CANONICAL_REMOTE}' only."
    print_line "Remote URL: ${remote_url:-unknown}"
    return 1
  fi

  while read -r local_ref local_sha remote_ref remote_sha; do
    if [ -z "${local_ref:-}" ]; then
      continue
    fi

    case "$local_ref" in
      refs/heads/*)
        ;;
      *)
        continue
        ;;
    esac

    ensure_canonical_base
  done
}

handle_pre_rebase() {
  local upstream_ref

  upstream_ref="${1:-}"

  show_status

  if [ "$ALLOW_SOURCE_BASE" = "1" ]; then
    print_line "Policy override active: MISSION_CONTROL_ALLOW_SOURCE_BASE=1"
    return 0
  fi

  if [ -z "$upstream_ref" ]; then
    return 0
  fi

  if ! ref_exists "$SOURCE_REF"; then
    return 0
  fi

  if [ "$upstream_ref" = "$SOURCE_REF" ] || [ "$upstream_ref" = "${SOURCE_REMOTE}" ] || [ "$upstream_ref" = "${SOURCE_REMOTE}/${CANONICAL_BRANCH}" ]; then
    print_line "ERROR: refusing to rebase onto ${upstream_ref}."
    print_line "This checkout uses ${CANONICAL_REF} as the product trunk."
    print_line "If you intentionally need a one-off source import, set MISSION_CONTROL_ALLOW_SOURCE_BASE=1 for that command."
    return 1
  fi

  if contains_ref "$SOURCE_REF" "$upstream_ref" && ! contains_ref "$CANONICAL_REF" "$upstream_ref"; then
    print_line "ERROR: ${upstream_ref} resolves on top of ${SOURCE_REF} but not on ${CANONICAL_REF}."
    print_line "Rebase onto ${CANONICAL_REF} instead."
    return 1
  fi
}

main() {
  local subcommand

  subcommand="${1:-}"
  shift || true

  case "$subcommand" in
    check)
      handle_check "$@"
      ;;
    pre-push)
      handle_pre_push "$@"
      ;;
    pre-rebase)
      handle_pre_rebase "$@"
      ;;
    *)
      usage
      exit 2
      ;;
  esac
}

main "$@"
