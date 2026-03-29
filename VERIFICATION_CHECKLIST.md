# Mission Control Verification Checklist

Use this as the shareable verification contract for a fresh clone, handoff, or local baseline refresh.

For Jordan's current machine-specific deviations, use [docs/CURRENT_LOCAL_STATUS.md](docs/CURRENT_LOCAL_STATUS.md).

## OpenClaw Gate

Run from the workspace root unless noted otherwise.

```bash
openclaw --version
openclaw update status
python3 scripts/cleanup_openclaw_2026_3_28.py
python3 scripts/sync_openclaw_model_lanes.py
openclaw config validate --json
openclaw doctor
openclaw gateway restart
openclaw gateway status --deep
openclaw health
```

Pass criteria:

- OpenClaw reports `2026.3.28`
- config validation returns `valid: true`
- `doctor` does not report stale `qwen-portal-auth` plugin warnings
- gateway status and health both succeed

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
```

Pass criteria:

- `GET /api/health` returns HTTP `200`
- the UI loads on `http://localhost:4000`
- Mission Control can reach the configured OpenClaw gateway

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
