# Troubleshooting Quick Reference

Ten common local problems and their fixes. For deeper runtime evidence and verified claim history, see [CURRENT_LOCAL_STATUS.md](CURRENT_LOCAL_STATUS.md).

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
