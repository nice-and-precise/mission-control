# Local Operations Runbook

Short local commands for this checkout.

## Start / Restart

```bash
cd /Users/jordan/.openclaw/workspace/mission-control
npm run dev
```

If `localhost:4000` is already occupied, identify the listener first:

```bash
lsof -nP -iTCP:4000 -sTCP:LISTEN
```

## Health Check

```bash
curl -i http://localhost:4000/api/health
```

Expected result: HTTP `200` with JSON like `{"status":"ok",...}`.

## Database Backup

```bash
cd /Users/jordan/.openclaw/workspace/mission-control
npm run db:backup
```

## Checkpoint Convention

- Branch: `chore/pre-real-work-baseline-YYYYMMDD`
- Commit: `chore: checkpoint <what changed>`

Current example:

- Branch: `chore/pre-real-work-baseline-20260327`
- Commit: `chore: checkpoint mission control runtime stabilization baseline`

## Disposable Fixture Data

Treat these rows as disposable only when they are clearly synthetic:

- `tasks.product_id IS NULL`
- `tasks.title` in:
  - `Runtime evidence task`
  - `Queue task`
  - `Build task`
  - `Review task`
  - `Verification task`
  - `Repo task`
- orphan learner-session rows where:
  - `openclaw_sessions.status = 'active'`
  - `openclaw_sessions.openclaw_session_id = 'mission-control-learner-agent'`
  - `openclaw_sessions.task_id IS NULL`

Do not purge real product rows, planning tasks, or the reusable smoke product.
