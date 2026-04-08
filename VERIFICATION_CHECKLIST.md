# Mission Control Verification Checklist

Use this as the shareable verification contract for a fresh clone, handoff, or local baseline refresh.

For Jordan's current machine-specific deviations, use [docs/CURRENT_LOCAL_STATUS.md](docs/CURRENT_LOCAL_STATUS.md).
For the canonical docs map, use [docs/README.md](docs/README.md).

## OpenClaw Gate

Run from the workspace root unless noted otherwise.

```bash
./scripts/update_openclaw_local_runtime.sh
python3 scripts/sync_openclaw_model_lanes.py
openclaw update status --json
openclaw config validate --json
openclaw doctor --fix --yes --non-interactive
openclaw gateway restart
sleep 8
openclaw gateway status --require-rpc --deep
openclaw status --json
openclaw secrets audit --json
openclaw logs --plain --limit 200
openclaw health
```

Pass criteria:

- OpenClaw reports `2026.4.8` or newer
- config validation returns `valid: true`
- `doctor` does not report stale entrypoint mismatches after the restart/install step settles
- `gateway status --require-rpc` and `openclaw health` both succeed
- `openclaw status --json` reports a healthy gateway with `authWarning = null`
- `openclaw secrets audit --json` keeps `unresolvedRefCount = 0`
- `openclaw update status --json` keeps `root` under `~/.openclaw/lib/node_modules/openclaw`
- `gateway status --deep` shows the service command under `~/.openclaw`; the managed gateway may legitimately use `~/.openclaw/tools/node-v22.22.0/bin/node` even while Mission Control uses Node `24.13.0`
- a short post-restart warm-up gap is acceptable if a retry after a brief wait succeeds and the auth-surface log marker stays present
- if `doctor` only shows a SecretRef read-only warning while the deeper checks above stay green, treat that as a command-path diagnostic instead of rewriting auth to plaintext

## Mission Control Gate

Run from `mission-control/`.

```bash
nvm use
npm ci
npm run test:runtime-targeted
npm test
npm run build
```

Pass criteria:

- the runtime preflight succeeds
- the targeted callback/runtime suite passes
- the test suite passes
- the production build completes successfully

## Runtime Sanity Check

Run from `mission-control/` after `.env.local` is configured.

```bash
npm run dev
```

In a second terminal:

```bash
TOKEN="$(python3 - <<'PY'
from dotenv import dotenv_values
vals = dotenv_values('.env.local')
print(vals.get('MC_API_TOKEN', ''))
PY
)"
curl -i -H "Authorization: Bearer $TOKEN" http://localhost:4000/api/health
curl -s -H "Authorization: Bearer $TOKEN" http://localhost:4000/api/openclaw/status | jq
curl -s -H "Authorization: Bearer $TOKEN" http://localhost:4000/api/openclaw/models | jq
curl -s -H "Authorization: Bearer $TOKEN" "http://localhost:4000/api/openclaw/background-tasks" | jq
curl -I http://localhost:4000/autopilot
curl -I http://localhost:4000/activity

PRODUCT_ID="$(curl -s -H "Authorization: Bearer $TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"name":"Verification Smoke Product","description":"temporary verification product","icon":"🧪"}' \
  http://localhost:4000/api/products | jq -r '.id')"

curl -s -H "Authorization: Bearer $TOKEN" http://localhost:4000/api/products | jq 'length'
curl -s -H "Authorization: Bearer $TOKEN" http://localhost:4000/api/products/"$PRODUCT_ID" | jq
curl -s -H "Authorization: Bearer $TOKEN" http://localhost:4000/api/products/"$PRODUCT_ID"/swipe/deck | jq
curl -s -H "Authorization: Bearer $TOKEN" http://localhost:4000/api/products/"$PRODUCT_ID"/health | jq
curl -s -H "Authorization: Bearer $TOKEN" http://localhost:4000/api/products/"$PRODUCT_ID"/costs | jq
curl -s -X DELETE -H "Authorization: Bearer $TOKEN" http://localhost:4000/api/products/"$PRODUCT_ID" | jq
```

Pass criteria:

- `GET /api/health` returns HTTP `200`
- when `MC_API_TOKEN` is set, direct `curl` checks include `Authorization: Bearer <token>`
- the UI loads on `http://localhost:4000`
- `/autopilot` and `/activity` both return HTTP `200`
- Mission Control can reach the configured OpenClaw gateway
- `/api/openclaw/models` returns separate `agentTargets` and `providerModels`
- `/api/openclaw/background-tasks` returns `tasks`, `status`, `sourceChannel`, and `warning`
- `/api/openclaw/background-tasks` uses `status: "ok"` for true empty-success responses and for successful parsed ledger payloads recovered from `stderr`
- `/api/openclaw/background-tasks` only uses `status: "degraded"` when the OpenClaw CLI timed out or returned no JSON payload at all
- if you have a known session key or session ID, `/api/openclaw/sessions/{id}/history` returns a normalized transcript payload instead of `501`
- the product smoke flow can create a temporary product, fetch its detail/deck/health/cost routes, and archive it again without `404`
- after the delete call, the temporary product no longer appears in `GET /api/products`
- if new `src/app/**` routes were added during an already-running `next dev` session, restart `npm run dev` before treating route-level `404`s as code regressions

## Documentation Gate

Run from `mission-control/`.

```bash
npm run docs:check
```

Pass criteria:

- the active portable docs do not hardcode Jordan-specific absolute machine paths
- local markdown links in the active portable docs resolve
- the docs sanity gate exits `0`
- the governed docs metadata and canonical-doc registration checks both pass

## Final Result

The baseline is considered good when:

- OpenClaw is healthy and free of the stale `qwen-portal-auth` warnings
- Mission Control passes test and build
- the portable docs and local docs agree on the current setup
- a collaborator can follow the portable setup docs without relying on hidden machine-local knowledge
