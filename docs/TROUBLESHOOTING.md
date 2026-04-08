---
doc_id: MC-TROUBLESHOOTING-001
title: Troubleshooting Quick Reference
doc_type: runbook
status: active
owner: nice-and-precise
last-reviewed: 2026-04-08
canonical: true
applies-to: machine-local
version-reviewed: OpenClaw 2026.4.8; Mission Control Node 24.13.0
---

# Troubleshooting Quick Reference

Common local problems and their fixes. For deeper runtime evidence and verified claim history, see [CURRENT_LOCAL_STATUS.md](CURRENT_LOCAL_STATUS.md).

---

## 1. OFFLINE badge in the UI

**Symptom:** The badge in the top bar shows OFFLINE; the console shows a 401 on `/api/events/stream`.

**Cause:** `EventSource` in browsers never sends an `Authorization` header. If the middleware rejected same-origin SSE connections, the badge went red immediately on load.

**Fix:** The `isSameOriginEventStreamRequest()` guard in `src/middleware.ts` whitelists same-origin `Accept: text/event-stream` connections. The badge should stay ONLINE for any normal page load.

**Verify:**
```bash
curl -s -i -m 5 \
  -H 'Sec-Fetch-Site: same-origin' \
  -H 'Accept: text/event-stream' \
  http://localhost:4000/api/events/stream | head -5
# expect: HTTP/1.1 200  content-type: text/event-stream
```

---

## 2. Stale "Run ended without completion callback" on done tasks

**Symptom:** A task shows `Done` on the board but still carries a `planning_dispatch_error` or `status_reason` that begins with `Run ended without completion callback`.

**Cause:** The run completed successfully but the live listener missed the callback (restart, DB lock, etc.). The error string was written and never cleared.

**Fix:**
```bash
# Dry-run to see what would change
npm run tasks:repair-successful-run-errors

# Apply the targeted clear
npm run tasks:repair-successful-run-errors -- --apply
```

The repair script clears only the generic prefix on tasks whose `status` is `done`. Real error strings are not touched.

---

## 3. `npm test` fails with `SQLITE_ERROR` in agent-signals or similar test file

**Symptom:** A handful of tests in an isolated file fail with `{ code: 'SQLITE_ERROR' }` when run as part of the full `npm test` suite, but pass when run individually.

**Cause:** Test-DB isolation is per-run via `.tmp/mission-control-test.db`. If a prior test run left the file in a partial state (e.g. interrupted mid-migration), the next full run can pick up a corrupted fixture.

**Fix:**
```bash
rm -f .tmp/mission-control-test.db
npm test
```

Re-run the single file to confirm it passes in isolation first if you need to narrow down the failure.

---

## 4. New route returns 404 in the running dev server

**Symptom:** You added a new file under `src/app/api/` or `src/app/` but the route still returns 404.

**Cause:** `next dev` caches the route graph at startup. Adding a file on disk does not hot-reload new routes in all cases.

**Fix:** Restart the dev server:
```bash
# kill existing process (PID is in the terminal that ran npm run dev)
kill <pid>
npm run dev
```

---

## 5. Sessions tab shows nothing / "No sessions"

**Symptom:** The Sessions tab in mission control is empty even though tasks have run recently.

**Cause (most common):** The OpenClaw gateway is unreachable or the session-list RPC returned a non-array payload that the client couldn't parse.

**Fix:**
1. Confirm the gateway is up: the gateway log should show a WebSocket accept line.
2. Make an authenticated request to `GET /api/openclaw/sessions` and inspect the raw response.
3. If the gateway is healthy but the list is empty, check that `MC_OPENCLAW_API_TOKEN` or `MC_OPENCLAW_BASE_URL` in `.env.local` are correct.

---

## 6. Stuck card — assigned/in_progress but no agent activity for several minutes

**Symptom:** A task card sits in `assigned` or `in_progress` for more than ~5 minutes with no new activity rows.

**Cause:** Multiple possible — agent dispatch hit a 429/504, the session session key collision caused the run to be dropped, or the builder agent's `TASK_COMPLETE` marker was emitted but never received.

**Triage order:**
1. Check `GET /api/tasks/{id}` — look at `planning_dispatch_error` and `status_reason`.
2. Check `GET /api/openclaw/sessions` — find the session key for this task and inspect its status.
3. If the agent finished but the marker was missed, use `PATCH /api/tasks/{id}` with `{ "status": "done" }` and set `status_reason` manually.
4. For a full rerun: patch the task back to `inbox`, then `POST /api/tasks/{id}/dispatch`.

See [CARD_OPERATIONS_RUNBOOK.md](CARD_OPERATIONS_RUNBOOK.md) for the full procedure.

---

## 7. Planning stuck at "Waiting for response…"

**Symptom:** A task enters `planning` and the UI shows "Waiting for response…" indefinitely.

**Cause (most common):** The planner run already completed but the `PLANNING_COMPLETE` marker was missed due to a restart or an oversized transcript entry that OpenClaw omitted.

**Fix:**
```bash
# Check gateway history for the planning session key
curl -s -H "Authorization: Bearer $TOKEN" \
  http://localhost:4000/api/openclaw/sessions/<planning-session-key>/history
```

If the history shows a completed spec, use `POST /api/tasks/{id}/planning/retry-dispatch` to re-trigger the planning reconcile from transcript.

---

## 8. Planning/research is still hitting an old Qwen or OpenRouter model

**Symptom:** Mission Control planning, research, or ideation reports an old Qwen model id such as `openrouter/qwen/...` or `qwen3.5-plus-02-15`.

**Cause:** The host OpenClaw routing config, workspace override, or explicit agent model row was not normalized to the current local policy.

**Current expected policy:**

- local `AUTOPILOT_MODEL` stays `openclaw`
- local `OPENCLAW_AUTOPILOT_COMPLETION_MODE` stays `session`
- Codex work uses `openai-codex/*`
- planning, research, ideation, and other Qwen lanes use `qwen/qwen3.6-plus`
- non-Qwen lanes use OpenCode Go

**Fix:**

```bash
TOKEN="$(python3 -c 'from dotenv import dotenv_values; print(dotenv_values(\".env.local\").get(\"MC_API_TOKEN\",\"\"))')"

curl -s -H "Authorization: Bearer $TOKEN" \
  http://localhost:4000/api/openclaw/models | jq '{defaultProviderModel, providerModels}'

curl -s -H "Authorization: Bearer $TOKEN" \
  http://localhost:4000/api/workspaces/e37d91ec-3f15-4b54-985f-b9daadde88de | jq '{autopilot_model_override,planning_model_override}'
```

If the model catalog is stale, restart the gateway and `npm run dev`, then start a fresh `/new` conversation before retrying the workflow. If research/planning still fails on JSON parse, note that Mission Control now retries once automatically with a strict JSON-only prompt; a repeated failure after that usually means the provider reply itself was incomplete rather than lightly malformed.

---

## 8. Tester or reviewer dispatch returns 400 "Wrong stage owner"

**Symptom:** Manually triggering a test or review dispatch via the API returns `400` with a message about stage ownership.

**Cause:** Strict workflow ownership is enforced at dispatch time. Only the designated owner for the current stage is allowed to dispatch. If the task status doesn't match the caller (e.g. a `testing` task dispatched as a builder prompt), the request fails closed.

**Fix:** Confirm the task `status` first:
```bash
curl -s -H "Authorization: Bearer $TOKEN" http://localhost:4000/api/tasks/<id> | jq .status
```

Use the correct dispatch route for the current stage: `/api/tasks/{id}/test` for tester, `/api/tasks/{id}/dispatch` for builder. To advance a task to the next stage, use `PATCH /api/tasks/{id}` to update `status` before re-dispatching.

---

## 9. Ghost "Auto Fixer" agent appears in the Agents list

**Symptom:** An agent named "Auto Fixer" with no model, no soul docs, and no session key appears in the DB or the settings UI.

**Cause (historical):** Before the `2026-04-05` fix, `ensureFixerExists()` in `task-governance.ts` auto-inserted an agent row after two consecutive stage failures, even though the resulting row had no dispatch capability.

**Current behavior:** `ensureFixerExists()` is now lookup-only. No auto-creation happens. If you see a ghost fixer, it predates the fix.

**Cleanup:**
```bash
sqlite3 mission-control.db \
  "DELETE FROM agents WHERE role = 'fixer' AND description LIKE 'Auto-created%';"
```

To enable real fixer capability, manually seed a fixer-role agent with a model, soul doc, and user doc. See `src/lib/task-governance.ts` for the lookup contract.

---

## 10. Activity log shows `governance_warning` — "No fixer agent configured"

**Symptom:** You see a `governance_warning` activity row on a task after several consecutive stage failures, but no agent was reassigned.

**Cause:** `escalateFailureIfNeeded()` fires after the threshold is reached (default: 2 failures). Because no fixer-role agent is pre-seeded, it inserts a `governance_warning` activity and returns without reassigning the task.

**What to do:** This is a deliberate safe fallback — it tells you something is stuck but avoids silently creating a broken ghost agent. Review the stage activity log for the root failure, then take one of:
- Patch the task back to `inbox` and redispatch with a corrected prompt.
- Seed a real fixer agent if you want automatic escalation handling.
- Treat it as a manual escalation trigger and handle it directly.

---

## 11. Queued builder card shows `Run ended without completion callback...`

**Symptom:** A builder-owned task in `assigned` shows the generic ended-session banner instead of a waiting message, usually while another builder task is already active.

**Cause:** Before the `2026-04-05` queue/session fix, the builder root session could be rebound before the dispatch route decided to queue the task. The queued task then carried stale session history, and health recovery later misclassified it as a broken ended run.

**Correct invariant:**

- queued builder tasks stay in `assigned`
- `planning_dispatch_error` stays `NULL`
- `status_reason` says `Waiting for Builder Agent to finish "..."`
- the queued task does not own an active root session

**Fix:** Re-dispatch the queued task through the normal dispatch route so Mission Control can restore the waiting state or start it cleanly if the builder is free.

```bash
TOKEN="$(python3 -c 'from dotenv import dotenv_values; print(dotenv_values(\".env.local\").get(\"MC_API_TOKEN\",\"\"))')"

curl -s -X POST \
  -H "Authorization: Bearer $TOKEN" \
  http://localhost:4000/api/tasks/<TASK_ID>/dispatch | jq

curl -s -H "Authorization: Bearer $TOKEN" \
  http://localhost:4000/api/tasks/<TASK_ID> | jq '{status,status_reason,planning_dispatch_error}'

sqlite3 mission-control.db \
  "select task_id, active_task_id, session_key, status from openclaw_sessions where task_id = '<TASK_ID>' order by updated_at desc limit 3;"
```

Expected result:

- if the builder is busy, the response returns `queued: true` and the task gets the waiting message
- if the builder is free, the task moves to `in_progress`
- no queued card should show the generic ended-session banner

---

## 12. `npm ci` or tests fail after switching to a newer Node major

**Symptom:** Native-module tests fail after a Node upgrade, often with `better-sqlite3` ABI/build errors.

**Cause:** Native addons are compiled against a Node ABI. The repo now pins `.nvmrc` to `24.13.0`, and this checkout should be verified on that exact runtime. See the official Node ABI notes at <https://nodejs.org/en/learn/modules/abi-stability> and the current `better-sqlite3` Node 25 incompatibility report at <https://github.com/WiseLibs/better-sqlite3/issues/1411>.

**Fix:**

```bash
cd /Users/jordan/.openclaw/workspace/mission-control
source ~/.nvm/nvm.sh
nvm use 24.13.0
npm ci
npm run test:runtime-targeted
```

If `node --version` is not `v24.13.0`, treat any native-module test failure as an environment mismatch first.

---

## 13. Ideation produces only 1 idea per cycle

**Symptom:** Autopilot ideation consistently generates exactly 1 idea/card instead of the expected 8-12.

**Root cause (fixed 2026-04-xx):** Two interacting problems in the JSON parsing layer (`src/lib/autopilot/llm.ts`):

1. **Code-fence wrapping:** Reasoning models (Qwen, DeepSeek) wrap JSON output in ` ```json ... ``` ` markdown fences. The old `extractStructuredJSON` tried balanced-brace extraction *before* code-fence stripping, so it found the first balanced `{}` object inside the array and returned it as a single idea.
2. **Truncated arrays:** The model's JSON array was truncated mid-element (the closing `]` never appeared, despite `finishReason: "stop"`). The old parser had no recovery path for truncated arrays — it could only find complete balanced structures.

**Fix applied:** `extractStructuredJSON` now:
- Strips code fences before attempting balanced extraction
- Recovers truncated arrays by collecting all balanced top-level elements
- Logs a warning: `[LLM] Recovered N element(s) from truncated JSON array`

**Diagnosing if this recurs:**
```bash
# Check how many ideas a recent cycle generated
sqlite3 mission-control.db \
  "SELECT id, ideas_generated, status FROM ideation_cycles ORDER BY created_at DESC LIMIT 5;"

# If ideas_generated = 1, check the phase_data for the raw LLM content length
sqlite3 mission-control.db \
  "SELECT length(json_extract(phase_data, '$.raw_content')) as raw_len FROM ideation_cycles WHERE id = '<cycle-id>';"
```

If `raw_len` is large (>5000) but `ideas_generated` is 1, the parser is likely collapsing a multi-idea response again. Check server logs for the `[LLM] Recovered` warning — its absence means the truncated recovery path isn't firing.
