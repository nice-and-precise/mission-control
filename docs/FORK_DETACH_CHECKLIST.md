---
doc_id: MC-FORK-DETACH-001
title: Fork Detach Checklist
doc_type: how-to
status: active
owner: nice-and-precise
last-reviewed: 2026-04-08
canonical: true
applies-to: mission-control
---

# Fork Detach Checklist

This checklist records the admin sequence that turned `nice-and-precise/mission-control` from a GitHub fork into a standalone product repository.

Use this only when you are ready to stop GitHub fork semantics entirely.

## Current State

Verified on `2026-04-02` after the detach:

- Repository: `https://github.com/nice-and-precise/mission-control`
- GitHub fork status: `isFork = false`
- Parent repo: none
- Default branch: `main`
- Branch protection on `main`: treat current GitHub repo settings as canonical; the detach baseline no longer assumes an unprotected branch
- Pull requests in `nice-and-precise/mission-control`: PR `#1` was the reconciliation PR and was merged into `main`
- Issues: disabled

Local checkout facts that matter after detaching:

- Current branch: `main`
- Local `HEAD` matches `origin/main`
- The temporary reconciliation branch has been merged and can be deleted locally and on `origin`
- `origin/main` is now the canonical product trunk
- `source/main` is kept only as read-only comparison input, and the local `source` push URL should be disabled
- The destructive pre-detach safety steps below are historical reference now that the standalone repository state is already live

## Official GitHub Process

GitHub documents fork detachment here:

- <https://docs.github.com/en/pull-requests/collaborating-with-pull-requests/working-with-forks/detaching-a-fork>

Their documented sequence is:

1. Create a bare clone of the fork.
2. Delete the forked repository.
3. Create a new repository with the same name in the same location.
4. Mirror-push the repository back to the same remote URL.

GitHub warns that deleting the fork permanently deletes associated pull requests and configurations.

## Repo-Specific Safe Order

Follow this order for `nice-and-precise/mission-control`.

### 1. Freeze branch churn

- Do not create new work branches until detachment is complete.
- Do not rebase normal work onto `source/main`.

### 2. Preserve local-only work

Before touching GitHub, decide whether you want to keep the local-only retarget branch:

- `retarget/work-from-pre-real-work-baseline-20260327-origin-main`

If yes, either push it to GitHub first:

```bash
cd /Users/jordan/.openclaw/workspace/mission-control
git push origin retarget/work-from-pre-real-work-baseline-20260327-origin-main
```

Or archive it locally in a bundle:

```bash
cd /Users/jordan/.openclaw/workspace/mission-control
git bundle create /Users/jordan/.openclaw/workspace/mission-control-retarget.bundle retarget/work-from-pre-real-work-baseline-20260327-origin-main
```

### 3. Preserve uncommitted work

The current worktree is dirty. Mirror pushes only preserve committed refs.

Before detaching, do one of:

- commit the edits you want to preserve
- stash them
- export a patch

Example patch backup:

```bash
cd /Users/jordan/.openclaw/workspace/mission-control
git diff > /Users/jordan/.openclaw/workspace/mission-control-uncommitted-$(date +%Y%m%d-%H%M%S).patch
```

### 4. Create two backups

Create one backup that follows GitHub's documented approach and one backup from the local repo so you keep local refs too.

GitHub-style bare clone of the current remote:

```bash
cd /Users/jordan/.openclaw/workspace
git clone --bare https://github.com/nice-and-precise/mission-control.git mission-control-fork-remote-backup.git
```

Local mirror clone that preserves local refs:

```bash
cd /Users/jordan/.openclaw/workspace
git clone --mirror /Users/jordan/.openclaw/workspace/mission-control mission-control-local-mirror.git
```

### 5. Record the current repo settings

Capture the settings that will be lost on delete/recreate:

```bash
gh repo view nice-and-precise/mission-control --json nameWithOwner,description,homepageUrl,visibility,defaultBranchRef,isFork,parent
```

Right now:

- default branch is already `main`
- branch protection is not configured
- issues are disabled
- no PRs were found

### 6. Delete the fork on GitHub

This is the destructive step and must be done intentionally in GitHub with admin access.

### 7. Recreate the repository with the same owner/name

Create:

- owner: `nice-and-precise`
- repo: `mission-control`
- visibility: `public`

Do not fork it. Create it as a standalone repository.

### 8. Mirror-push the backup into the new standalone repo

If you only want the remote refs that existed on GitHub before deletion:

```bash
git --git-dir /Users/jordan/.openclaw/workspace/mission-control-fork-remote-backup.git push --mirror https://github.com/nice-and-precise/mission-control.git
```

If you also want local refs restored, use the local mirror instead:

```bash
git --git-dir /Users/jordan/.openclaw/workspace/mission-control-local-mirror.git push --mirror https://github.com/nice-and-precise/mission-control.git
```

Use the local mirror only if you intentionally want every local branch ref restored.

### 9. Reapply repo settings

After the new standalone repo is live:

1. Set default branch to `main` if needed.
2. Recreate branch protection for `main`.
3. Recheck that issues remain disabled if that is still desired.
4. Re-add any repository secrets, variables, webhooks, or rulesets that were attached to the old fork.

### 10. Repoint local clones

After recreation, verify the local checkout still points at the correct URL:

```bash
cd /Users/jordan/.openclaw/workspace/mission-control
git remote -v
git fetch origin --prune
gh repo view nice-and-precise/mission-control --json isFork,parent,defaultBranchRef
```

Expected result after detachment:

- `isFork = false`
- `parent = null`
- default branch = `main`

## Immediate Follow-Up After Detach

Once the repo is standalone:

1. Protect `main`.
2. Decide whether to keep a read-only `source` remote for `crshdn/mission-control` or remove the comparison remote entirely.
3. Reconcile the current source-based work branch onto the canonical product trunk.
4. Keep using the tracked branch-policy hooks in this repo.

## Recommended Default Policy After Detach

- `origin/main` is the canonical product trunk.
- `source` is optional and read-only.
- Normal feature branches start from `origin/main`.
- Normal PRs target `nice-and-precise/main`.
