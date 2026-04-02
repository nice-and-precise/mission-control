# Mission Control Verification Checklist

Use this as the shareable verification contract for a fresh clone, handoff, or local baseline refresh.

For Jordan's current machine-specific deviations, use [docs/CURRENT_LOCAL_STATUS.md](docs/CURRENT_LOCAL_STATUS.md).

## OpenClaw Gate

Run from the workspace root unless noted otherwise.

```bash
./scripts/update_openclaw_local_runtime.sh
python3 scripts/cleanup_openclaw_2026_3_28.py
python3 scripts/sync_openclaw_model_lanes.py
openclaw config validate --json
openclaw doctor
openclaw gateway restart
sleep 8
openclaw gateway status --require-rpc --deep
openclaw status --json
openclaw secrets audit --json
openclaw logs --plain --limit 200
openclaw health
```

Pass criteria:

- OpenClaw reports `2026.4.1` or newer
- config validation returns `valid: true`
- `doctor` does not report stale `qwen-portal-auth` plugin warnings
- `gateway status --require-rpc` and `openclaw health` both succeed
- `openclaw status --json` reports a healthy gateway with `authWarning = null`
- `openclaw secrets audit --json` keeps `unresolvedRefCount = 0`
- `openclaw update status --json` keeps `root` under `~/.openclaw/lib/node_modules/openclaw`
- a short post-restart warm-up gap is acceptable if a retry after a brief wait succeeds and the auth-surface log marker stays present
- if `doctor` only shows a SecretRef read-only warning while the deeper checks above stay green, treat that as a command-path diagnostic instead of rewriting auth to plaintext

## Mission Control Gate

Run from `mission-control/`.

```bash
nvm use
npm ci
npm test
npm run build
```

Pass criteria:

- the runtime preflight succeeds
- the test suite passes
- the production build completes successfully

## Runtime Sanity Check

Run from `mission-control/` after `.env.local` is configured.

```bash
npm run dev
```

In a second terminal:

```bash
curl -i http://localhost:4000/api/health
TOKEN="$(python3 - <<'PY'
from dotenv import dotenv_values
vals = dotenv_values('.env.local')
print(vals.get('MC_API_TOKEN', ''))
PY
)"
curl -s -H "Authorization: Bearer $TOKEN" http://localhost:4000/api/openclaw/status | jq
curl -s -H "Authorization: Bearer $TOKEN" http://localhost:4000/api/openclaw/models | jq
curl -s -H "Authorization: Bearer $TOKEN" "http://localhost:4000/api/openclaw/background-tasks" | jq
```

Pass criteria:

- `GET /api/health` returns HTTP `200`
- the UI loads on `http://localhost:4000`
- Mission Control can reach the configured OpenClaw gateway
- `/api/openclaw/models` returns separate `agentTargets` and `providerModels`
- `/api/openclaw/background-tasks` returns `tasks`, `status`, `sourceChannel`, and `warning`
- `/api/openclaw/background-tasks` uses `status: "ok"` for true empty-success responses and `status: "degraded"` when the CLI timed out or only returned JSON on `stderr`
- if you have a known session key or session ID, `/api/openclaw/sessions/{id}/history` returns a normalized transcript payload instead of `501`

## Documentation Gate

Run from the workspace root.

```bash
pytest tests/test_model_lanes_policy.py tests/test_docs_integrity.py
```

Pass criteria:

- the active portable docs do not hardcode Jordan-specific absolute machine paths
- local markdown links in the active portable docs resolve
- the current model-lane policy does not reintroduce `qwen-portal`

## Final Result

The baseline is considered good when:

- OpenClaw is healthy and free of the stale `qwen-portal-auth` warnings
- Mission Control passes test and build
- the portable docs and local docs agree on the current setup
- a collaborator can follow the portable setup docs without relying on hidden machine-local knowledge
