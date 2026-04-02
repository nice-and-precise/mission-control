# Repository Policy

This checkout is a product repo, not an upstream-contribution fork workflow.

## Canonical Rules

- `nice-and-precise/mission-control` is the canonical repository for ongoing work.
- `origin/main` is the canonical product trunk unless it is explicitly replaced by another default branch in `nice-and-precise/mission-control`.
- `source/main` is the read-only comparison/import line when this clone has a `source` remote configured for `crshdn/mission-control`.
- Day-to-day feature branches must start from `origin/main`.
- Day-to-day pull requests from this checkout must target `nice-and-precise/main`.

## Disallowed By Default

- Rebasing a normal work branch onto `source/main`
- Treating `source/main` as the default branch base for new work
- Using GitHub's fork contribution flow as the implied operating model for this checkout

## Allowed With Deliberate Intent

- Fetching `source` to compare behavior or inspect changes
- Cherry-picking or manually porting selected source commits into `origin/main`
- Running one-off source-import operations with an explicit local override

## Local Guardrails

This repo ships a branch-policy check plus tracked Git hooks:

- `scripts/git-branch-policy.sh check`
- `.githooks/pre-push`
- `.githooks/pre-rebase`

The hooks block:

- pushes to non-`origin` remotes from this checkout
- pushes of branches that are not based on `origin/main`
- rebases directly onto `source/main`

If you intentionally need a one-off source import, run the command with:

```bash
MISSION_CONTROL_ALLOW_SOURCE_BASE=1 <command>
```

Use that override only for deliberate reconciliation work, not normal feature development.
