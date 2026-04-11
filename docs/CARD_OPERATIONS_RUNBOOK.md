# Mission Control Card Operations Runbook

This document records the failure patterns seen during the BoreReady curriculum card rollout on 2026-04-05 and defines the correct operating method for creating, dispatching, and recovering cards.

Use this when:

- creating new execution or review cards
- moving cards between builder, tester, and reviewer lanes
- deciding whether a task is truly stalled or only queued
- debugging ended-session and wrong-lane problems

## What Went Wrong

The failures were not one bug. They were a chain:

1. Cards were created directly into active stages without all stage metadata being initialized.
2. Some tasks launched without hydrated repo context, which allowed invalid repo and PR artifacts.
3. Runtime inspection initially leaned too hard on UI state and subagent-only views instead of authoritative task session state.
4. A dispatch can return HTTP 200 while still meaning queued, not started.
5. Queue stages such as review were manually redispatched instead of being advanced through workflow rules.
6. The automated test route changed task status directly without routing the change through the workflow engine.
7. That direct status mutation left `assigned_agent_id` and session ownership on the wrong lane after testing.
8. Reused persistent sessions plus stale task pointers made some cards look active when the wrong agent lane actually owned the runtime.
9. Several review outputs contained fabricated or cross-project claims, which triggered fail-loopbacks and made the queue look more broken than it was.

## Root Causes

### Card creation mistakes

- Direct-to-execution tasks need `planning_complete = 1`.
- Repo-backed tasks need `product_id`, `repo_url`, and `repo_branch` at creation time.
- Review/verification cards need evidence attached before quality-stage advancement.

### Monitoring mistakes

- `/api/tasks/[id]/subagent` is not the full runtime picture.
- Agent rows can be stale.
- The board can show a card in a lane even when there is no active root session.

### Workflow mistakes

- Queue stages are not executable stages.
- Test pass/fail must go through `handleStageTransition(...)`, not direct status updates.
- A queued dispatch result must not be treated as started work.

### Content-quality mistakes

- Review cards must validate only against the actual source packet in the repo.
- Any claim not anchored to the real workspace files must be treated as failure.
- Do not accept deliverables that describe a different module, different statute set, or different project state.

## Correct Way To Create Cards

### 1. Create cards with the right initial state

For execution-stage cards:

- use the intended active stage only when the card is truly ready to run
- ensure planning is already complete
- ensure repo-backed metadata is present

Required invariants:

- execution-stage task does not reopen planning UI
- repo-backed task has workspace product context
- workflow template is attached

### 2. Register exact deliverables up front

Before entering testing, review, or verification:

- attach the file deliverables that actually exist
- attach the PR URL only if it is real
- add at least one activity note describing what the card is meant to validate

Do not let cards carry placeholder PR URLs, off-repo paths, or artifact lists that were never produced.

### 3. Respect strict stage ownership

On this workflow:

- `assigned` and `in_progress` are builder-owned
- `testing` is tester-owned
- `review` is queue-only
- `verification` is reviewer-owned

Implication:

- do not dispatch queue stages directly unless the dispatch route explicitly auto-promotes them to the next actionable stage
- do not hand-force a tester or reviewer onto the wrong stage just to make the board move

## Correct Way To Monitor Cards

### Use task sessions, not subagent-only views

Authoritative runtime check:

```bash
curl -s -H "Authorization: Bearer $MC_API_TOKEN" \
  "http://localhost:4000/api/openclaw/sessions?task_id=<task-id>"
```

Use this to answer:

- is there an active root session
- which model is actually bound
- which task the active lane is actually attached to

Do not infer runtime ownership from:

- board column alone
- agent sidebar alone
- `/api/tasks/[id]/subagent` alone

### Distinguish queued from broken

Queued is healthy when:

- task status is `assigned`
- `planning_dispatch_error` is `NULL`
- `status_reason` says it is waiting for another task
- no active session exists for the queued task
- the blocking task does have the active session

Broken is real when:

- task is in an executing stage and has no active session
- task shows `Run ended without completion callback or workflow handoff ...`
- task has a session attached to the wrong lane or wrong task

### Queue and session invariant

For builder-owned work, the dispatch route must decide whether the builder is busy before it touches root-session ownership.

Required invariant:

- queued builder work remains `assigned`
- queued builder work gets a waiting `status_reason`
- queued builder work does not create or rebind an active root `openclaw_sessions` row
- the generic unreconciled-run banner belongs only to work that actually started and then lost its completion signal

If any queued builder card violates that invariant, treat it as a control-plane bug or stale pre-fix state, not as a normal operator condition.

### Treat HTTP 200 carefully

Dispatch success is only a true start if the payload is not queued.

Healthy queued response:

- `success: true`
- `queued: true`
- a `waiting_for_task_id`

That means wait, not run.

## Correct Way To Recover Cards

### If an executing card has no active session

1. Check `/api/openclaw/sessions?task_id=<task-id>`.
2. If there is no active root session, redispatch the specific card.
3. Re-read the task and sessions immediately.

### If a queued card still shows an ended-session error

Re-dispatch it so the queue logic can rewrite the waiting state cleanly.

Expected good result:

- `success: true`
- `queued: true`
- waiting message names the actually active blocking task
- the queued task still has no active root session after the redispatch

Post-fix note:

- `POST /api/tasks/{id}/dispatch` now performs the builder-busy check before any root-session create-or-rebind work
- `agent-health` now preserves or restores the waiting state for legitimately queued builder cards instead of overwriting them with the generic ended-session banner

### If a tester pass moves a task to review with the tester still attached

That is a workflow bug, not an operator-only problem.

Correct fix:

- patch the route that changed status directly
- make it call `handleStageTransition(...)`
- only then normalize the live cards that were damaged by the old behavior

## Session Lessons From This Incident

### Session truth beats UI truth

The board can lag or show stale lane placement. Root sessions are the real ownership signal.

### False unreconciled-run errors exist

Some generic ended-session errors can be stale while a streaming root session still exists, or while the card is only queued behind another builder task. Health reconciliation must clear or restore those states instead of preserving them forever.

### Persistent session reuse needs authoritative selection

When multiple stored sessions exist for one task, use the authoritative root session, not just the newest row.

## Content Validation Lessons

The review cards failed repeatedly because some agent outputs were validating against invented or wrong-source content.

Required review standard:

- validate only against real files present in the checked-out workspace
- prefer absolute task workspace paths for repo-backed work
- reject any report that references files, statutes, or module content absent from the workspace
- treat cross-project bleed as a hard fail, not a warning

## Operator Checklist

Before creating cards:

- confirm workspace product is active and repo-backed metadata is present
- confirm the workflow template is attached
- define exact deliverables
- define the intended first actionable stage

After creating cards:

- verify execution-stage cards have `planning_complete = 1`
- verify repo-backed cards have `repo_url` and `repo_branch`
- verify quality-stage cards have evidence attached

While monitoring cards:

- check `/api/health`
- inspect `/api/openclaw/sessions?task_id=...`
- treat queued 200 responses as waiting, not started
- do not rely on stale agent `task_id` pointers

When something looks wrong:

- recover the specific card first
- do not restart the full gateway unless the gateway itself is unhealthy or multiple unrelated dispatches fail

## Product Program Guardrails

- Research and ideation do not run from a stale Product Program anymore when canonical repo truth is configured.
- Use the Program tab's `Audit & Sync Program` action after repo-side Product Program merges and before kicking off the next cycle.
- Completed research and ideation cycles now retain `product_program_sha` and `product_program_snapshot` so you can audit which revision drove the run.
- if lane ownership is wrong after a stage transition, audit the route for direct status mutation bypassing workflow handoff

## Planning Approval and Recovery

### Normal approval flow

1. A Planning Agent writes a planning spec (`planning_spec` JSON with objectives, deliverables, validation).
2. Once planning is complete (`planning_complete = 1`), call `POST /api/tasks/{id}/planning/approve`.
3. The approve route locks the spec in `planning_specs`, assigns a builder, and dispatches.

### "Spec already locked" error

If you get HTTP 400 `Spec already locked`, it means a record already exists in `planning_specs` for this task. This happens when:

- A prior planning round produced a spec lock, but the task was never dispatched (e.g., session ended, or task was manually reset).
- A card was manually moved back to planning after a failed round.

**Code fix (2026-04-11):** The approve route now auto-clears stale specs when the task is still in `planning` or `inbox` status, so this error should only appear for tasks that have already progressed past planning.

**Manual recovery (if needed):**

```bash
# Delete the stale planning_specs record
sqlite3 mission-control.db "DELETE FROM planning_specs WHERE task_id = '<task-id>';"

# Then re-approve
curl -X POST -H "Authorization: Bearer $MC_API_TOKEN" \
  "http://localhost:4000/api/tasks/<task-id>/planning/approve"
```

### Stuck planning cards ("Planning already started")

If `POST /api/tasks/{id}/planning` returns `Planning already started`, a `planning_session_key` exists from a prior session. The planning LLM session may have ended or become stale.

**Recovery:** Use the DELETE handler to reset planning entirely:

```bash
# Reset task to inbox — clears session_key, messages, spec, agents, planning_specs
curl -X DELETE -H "Authorization: Bearer $MC_API_TOKEN" \
  "http://localhost:4000/api/tasks/<task-id>/planning"

# Then restart planning
curl -X POST -H "Authorization: Bearer $MC_API_TOKEN" \
  "http://localhost:4000/api/tasks/<task-id>/planning"
```

The DELETE handler resets the task to `inbox` status with all planning fields cleared.

### Inbox card promotion

Inbox cards have no planning spec. To approve them directly (skipping the planning LLM):

1. Write the spec and set `planning_complete` via SQL or PATCH:

```bash
sqlite3 mission-control.db "
  UPDATE tasks
  SET planning_spec = '{\"objectives\":[\"...\"],\"deliverables\":[\"...\"],\"validation_criteria\":[\"...\"]}',
      planning_complete = 1,
      status = 'planning'
  WHERE id = '<task-id>';
"
```

2. Then approve as normal: `POST /api/tasks/{id}/planning/approve`

### PR merge does not always close cards automatically

The GitHub PR-merge webhook (`src/app/api/webhooks/github-pr-merged/route.ts`) is now implemented. When configured on GitHub, it automatically marks tasks `done` and updates `merge_status` to `merged` when a PR is merged.

**If the webhook is not yet configured on GitHub** (requires one-time setup in repo Settings → Webhooks), merging a PR still requires a manual status update:

```bash
sqlite3 mission-control.db "UPDATE tasks SET status = 'done' WHERE id = '<task-id>';"
```

**Webhook setup (one-time):** GitHub repo Settings → Webhooks → Add webhook
- URL: `https://<MC-domain>/api/webhooks/github-pr-merged`
- Content type: `application/json`
- Event: `pull_request`
- Secret: value of `GITHUB_WEBHOOK_SECRET` in your MC `.env`

### Preventing duplicate dispatches

Before approving a card, verify it doesn't already have a merged PR or active work:

```bash
# Check for existing PRs or completed work
sqlite3 mission-control.db "
  SELECT td.deliverable_type, td.deliverable_url, td.status
  FROM task_deliverables td WHERE td.task_id = '<task-id>';
"
```

If the card already has merged deliverables, mark it `done` instead of re-approving — otherwise the builder will create a duplicate PR.

## Code Paths That Matter

- [src/app/api/tasks/route.ts](../src/app/api/tasks/route.ts): task creation invariants
- [src/app/api/tasks/[id]/dispatch/route.ts](../src/app/api/tasks/%5Bid%5D/dispatch/route.ts): dispatch, queue handling, model binding
- [src/app/api/tasks/[id]/test/route.ts](../src/app/api/tasks/%5Bid%5D/test/route.ts): automated test pass/fail stage transitions
- [src/app/api/tasks/[id]/planning/approve/route.ts](../src/app/api/tasks/%5Bid%5D/planning/approve/route.ts): spec lock, builder assignment, dispatch
- [src/app/api/tasks/[id]/planning/route.ts](../src/app/api/tasks/%5Bid%5D/planning/route.ts): POST starts planning, DELETE resets to inbox
- [src/lib/autopilot/research.ts](../src/lib/autopilot/research.ts): research cycle, compliance gap audit
- [src/lib/autopilot/ideation.ts](../src/lib/autopilot/ideation.ts): idea generation, tier filter, similarity dedup
- [src/lib/autopilot/swipe.ts](../src/lib/autopilot/swipe.ts): swipe deck, createTaskFromIdea, build_mode routing
- [src/lib/autopilot/scheduling.ts](../src/lib/autopilot/scheduling.ts): cron-driven research/ideation/maybe-pool cycles
- [src/lib/agent-signals.ts](../src/lib/agent-signals.ts): TASK_COMPLETE/TEST_PASS/VERIFY_PASS signal handling
- [src/lib/workspace-isolation.ts](../src/lib/workspace-isolation.ts): triggerWorkspaceMerge, PR creation, branch management
- [src/lib/workflow-engine.ts](../src/lib/workflow-engine.ts): authoritative stage ownership and queue draining
- [src/app/api/openclaw/sessions/route.ts](../src/app/api/openclaw/sessions/route.ts): full task session inspection

## Upstream Influences on Card Quality

Cards inherit quality from the upstream research → ideation pipeline. Problems at each stage cascade:

### Research quality

- If the product program is stale or incomplete, research will miss gaps or report false positives.
- Research drives ideation directly — a weak report produces weak ideas.
- Always run `POST /api/products/{id}/research/run` before ideation if the product program has changed.

### Ideation quality

- Ideation is bounded by the research report. Ideas without a backing finding are lower quality.
- The tier filter (only tier-2 and tier-3) and similarity dedup (>90% match to rejected ideas) are automatic post-LLM guards. If ideas slip through with wrong tiers, check the LLM output in `ideation_cycles.phase_data`.
- If ideation produces fewer ideas than expected (1 instead of 5-15), see the "Ideation-Level Failure Diagnosis" section below.

### Swipe decisions

- Rejected ideas train the preference model and the similarity dedup. Bad rejects can suppress future good ideas.
- "Maybe" ideas resurface in 7 days via `maybe_reevaluation` schedule.
- "Fire" (urgent) ideas bypass planning and enter `inbox` directly — they skip the planning spec step. Use fire sparingly.

### build_mode impact

- `plan_first` (default): Approved ideas → `planning` status → requires planning spec → requires approval → dispatches to builder. Most controlled path.
- `auto_build`: Approved ideas → `assigned` status → immediately queued for dispatch. Skips planning entirely. Use only for well-scoped S/M tasks with clear specs in the idea itself.

### Preventing upstream waste

Before running a research+ideation cycle, verify:
- Product program is current (`product.product_program` matches reality)
- Research report is fresh (check `research_cycles` for recent completed cycle)
- Swipe history reflects actual preferences (100 most recent swipes are used)
- No duplicate pending ideas in the swipe deck from a prior cycle

## Bottom Line

The correct pattern is:

1. Keep the product program current — it drives research and ideation.
2. Run research before ideation. Ideation without fresh research produces low-quality ideas.
3. Create cards with complete metadata (via swipe deck, not manual SQL when possible).
4. Attach evidence before quality gates.
5. Use task-scoped root sessions as the runtime source of truth.
6. Treat queued cards as waiting, not stalled.
7. Route every stage change through the workflow engine.
8. After merging a PR, the GitHub PR-merge webhook auto-closes the task if configured; otherwise mark `done` manually.
9. Recover individual broken cards before considering full control-plane restarts.

## Ideation-Level Failure Diagnosis

When ideation cycles produce fewer ideas than expected (typically 1 instead of 8-12), the problem is upstream of card creation.

### Diagnosis steps

```bash
# 1. Check recent ideation cycles
sqlite3 mission-control.db \
  "SELECT id, product_id, ideas_generated, status, current_phase FROM ideation_cycles ORDER BY created_at DESC LIMIT 5;"

# 2. For a suspect cycle, check the raw LLM response length
sqlite3 mission-control.db \
  "SELECT length(json_extract(phase_data, '$.raw_content')) as raw_len, ideas_generated FROM ideation_cycles WHERE id = '<cycle-id>';"

# 3. Check server logs for truncated array recovery
grep "Recovered.*truncated JSON array" <server-log-file>
```

### Interpretation

| raw_len | ideas_generated | Meaning |
|---------|----------------|---------|
| >5000   | 1              | Parser collapsed multi-idea response → check if truncated recovery fired |
| >5000   | 5-12           | Normal — recovery worked, or response was clean JSON |
| <2000   | 1              | Model genuinely produced 1 idea — may need prompt tuning |
| null    | 0              | LLM call failed entirely — check `phase_data` for error |

### Common causes

- **Code-fence wrapping + truncated array**: Reasoning models (Qwen, DeepSeek) wrap JSON in markdown fences and may truncate long arrays. Fixed in `extractStructuredJSON()` with `stripCodeFences()` and `recoverTruncatedArray()`.
- **Prompt too large**: If the product program + research report + swipe history exceeds the model's effective context, the response may be short. Check `usage.promptTokens` in the cycle's activity log.
- **Model misconfiguration**: Verify the model target in `GET /api/openclaw/models`. See [TROUBLESHOOTING.md](TROUBLESHOOTING.md) section 8 and 13.
