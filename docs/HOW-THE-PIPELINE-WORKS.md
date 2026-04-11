# How the Pipeline Works

Plain-language walkthrough of the current Mission Control repo-backed workflow.

For the machine-local truth on Jordan's current checkout, use [CURRENT_LOCAL_STATUS.md](CURRENT_LOCAL_STATUS.md). For the shareable verification gate, use [../VERIFICATION_CHECKLIST.md](../VERIFICATION_CHECKLIST.md).

## The Owners

- `Avery` routes and packages work
- `Builder` implements and repairs
- `Tester` validates runtime behavior and evidence
- `Reviewer` owns code review and the final strict verification stage
- `Learner` captures reusable lessons after successful completion

## How Cards Are Generated

Cards do not appear from nowhere. They are produced by the autopilot pipeline, which runs upstream of the build workflow.

### Research → Ideation → Swipe → Task

```
Product Program (finish-line checklist)
    ↓
Research Cycle — audits repo against checklist, finds gaps
    ↓
Ideation Cycle — LLM generates 5-15 task ideas from research report
    ↓
Swipe Deck — operator reviews pending ideas
    ↓
Approved ideas become tasks (cards on the board)
```

### Research cycles

A research cycle audits the product repo against its finish-line artifact checklist and produces a structured JSON report identifying missing artifacts, factual gaps, contradictions, and domain-lock violations.

- **Trigger:** Manual (`POST /api/products/{id}/research/run`), scheduled (cron via `product_schedules`), or chained from a prior ideation cycle.
- **Input:** Product program, learned preferences from swipe history.
- **Output:** `research_cycles.report` JSON with sections: `missing_artifacts`, `factual_gaps`, `contradictions`, `domain_lock_violations`.
- **Code:** [src/lib/autopilot/research.ts](../src/lib/autopilot/research.ts)

### Ideation cycles

An ideation cycle takes a research report and generates actionable task ideas.

- **Input:** Research report, last 100 swipes + learned preferences, product program.
- **Output:** 5-15 ideas stored in `ideas` table with status `pending`.
- **Post-generation filters:**
  - **Tier filter:** Only `tier-2` and `tier-3` tags allowed. Ideas with `tier-1`, `tier-4`, or `tier-5` are rejected.
  - **Similarity dedup:** Ideas >90% similar to previously rejected ideas are auto-suppressed (logged in `idea_suppressions`).
- **Required fields per idea:** title, description, category, artifact path, blocker_cleared, why_now, impact_score, feasibility_score, complexity (S/M/L/XL), technical_approach, research_backing, risks, tags.
- **Code:** [src/lib/autopilot/ideation.ts](../src/lib/autopilot/ideation.ts)

### Swipe deck

The operator reviews pending ideas sorted by impact score descending.

| Action | Idea Status | Task Created? | Task Initial Status |
|--------|------------|---------------|---------------------|
| approve | approved | Yes | `planning` (plan_first) or `assigned` (auto_build) |
| fire | approved | Yes | `inbox` (urgent bypass) |
| maybe | maybe | No | Added to maybe pool, resurfaces in 7 days |
| reject | rejected | No | Used for future similarity dedup |

- **Code:** [src/lib/autopilot/swipe.ts](../src/lib/autopilot/swipe.ts)

### Task creation from idea

When an idea is approved or fired, `createTaskFromIdea()` creates a task row:

- Populates title, description (enriched with technical_approach + research_backing), priority, estimated cost.
- Links to product via `product_id`, `repo_url`, `default_branch`.
- **`build_mode`** on the product determines initial status:
  - `plan_first` (default): status = `planning` — must complete planning before dispatch.
  - `auto_build`: status = `assigned` — immediately queues dispatch to builder.
- Urgent (fire) tasks always start as `inbox` regardless of build_mode.
- Estimated cost by complexity: S=$3, M=$10, L=$25, XL=$60.

### Scheduling

The SSE heartbeat checks `product_schedules` every 60 seconds. Supported schedule types: `research`, `ideation`, `maybe_reevaluation`. Cron expressions use standard 5-field format. Only enabled schedules for active products fire.

**Code:** [src/lib/autopilot/scheduling.ts](../src/lib/autopilot/scheduling.ts)

## The Stage Flow

1. A task enters the board in `inbox` status (from fire action) or `planning` status (from approve action with plan_first build mode).
2. A Planning Agent writes a structured spec (`planning_spec`) with objectives, deliverables, and validation criteria.
3. An operator approves the planning spec via `POST /api/tasks/{id}/planning/approve`.
4. The approve route locks the spec, assigns a `Builder`, and dispatches.
5. `Builder` implements the change (creates branch, commits, opens PR).
6. `Tester` validates the built result with reproducible evidence.
7. `Reviewer` performs the final code-quality and spec-fit review.
8. `Learner` captures durable lessons only after the task has really cleared the build pod.

Failures route back to `Builder` unless `Avery` explicitly changes the path.

### Planning lifecycle

- `POST /api/tasks/{id}/planning` — starts a planning session (creates `planning_session_key`, binds a Planning Agent)
- The Planning Agent produces a `planning_spec` JSON and sets `planning_complete = 1`
- `POST /api/tasks/{id}/planning/approve` — locks the spec and dispatches to builder
- `DELETE /api/tasks/{id}/planning` — resets the task to `inbox`, clears all planning state (session key, messages, spec, agents, planning_specs). Use this to recover stuck planning cards.

### Supervised mode limitations

In supervised mode (current default), three gaps exist:

1. **PR merge does not close cards.** There is no GitHub webhook handler in the main codebase. After merging a PR on GitHub, you must manually mark the task as `done` in the database or via API. A prototype webhook exists in `projects/` but was never integrated.
2. **Spec approval requires operator action.** Planning specs are not auto-approved. The operator must review and call the approve endpoint.
3. **`automation_tier` is stored but not enforced.** The `settings.automation_tier` field on products (`full_auto`, `semi_auto`) exists in the schema but is never checked at runtime. There is no auto-idea-approval, no auto-merge, and no CI polling based on this field.

### Workspace merge and PR creation

When a task reaches `done` status via `VERIFY_PASS` signal:

1. `agent-signals.ts` calls `triggerWorkspaceMerge(taskId)`.
2. The merge function commits workspace changes, pushes to a branch (e.g., `autopilot/<slug>-<taskId>`), and creates a GitHub PR via `gh pr create`.
3. Task `merge_status` is set to `pr_created` and `merge_pr_url` is populated.
4. **The PR is NOT auto-merged.** An operator must review and merge on GitHub.
5. After merging, the operator must manually update task status to `done` (MC has no PR-merge webhook).

When one task finishes, `dispatchNextQueuedTask()` checks for queued tasks assigned to the now-idle agent and dispatches the next one.

## OpenClaw Integration Rules

- Mission Control uses stable OpenClaw routing keys for persistent task sessions.
- Fresh reruns prepend `/new` on the existing routing key, so a healthy rerun normally keeps the same `sessionKey` and creates a fresh `sessionId`.
- Do not treat a reused `sessionKey` by itself as evidence of stale task context.
- When `MC_API_TOKEN` is configured, Mission Control includes `Authorization: Bearer <token>` in protected localhost callback requests.

## Runtime Evidence vs Transcript History

- Activities, Deliverables, Sessions, and Agent Live are the primary runtime surfaces.
- Workflow advancement still depends on explicit completion markers such as `TASK_COMPLETE`, `BLOCKED`, `TEST_PASS`, `TEST_FAIL`, `VERIFY_PASS`, and `VERIFY_FAIL`.
- If a run ends before the live listener catches the marker, Mission Control can use the official OpenClaw gateway session-history endpoint internally to recover a missed marker or synthesize an explicit runtime blocker.
- Mission Control's public `GET /api/openclaw/sessions/{id}/history` route is now available as a read-only review aid, but OpenClaw can omit oversized entries from bounded transcript history.
- Detached OpenClaw background work is visible separately through Mission Control's background-task ledger; it is an observability surface, not workflow control.

## What a Good Handoff Looks Like

Each build-pod handoff should include:

- task id or title
- current workspace path
- changed files
- checks run
- evidence artifacts
- known limitations or unverified areas
- the exact next owner

If those are missing, the next stage should stop and request a correction instead of guessing.

## LLM Completion and JSON Parsing

Mission Control's autopilot uses `completeJSON()` in `src/lib/autopilot/llm.ts` for all structured LLM responses (ideation, research, planning prompts).

### Completion Transports

- **session** (default for Qwen/reasoning models): Routes through the OpenClaw Gateway via `chat.send` RPC and polls `chat.history` for the assistant response. Does not pass `maxTokens` or `temperature` to the gateway — the gateway's model config controls those.
- **http**: Direct `/v1/chat/completions` call to the gateway's OpenAI-compatible endpoint.
- **agent-cli**: Shells out to the `openclaw` CLI binary.

### JSON Extraction Pipeline

`extractStructuredJSON()` handles the gap between what models return and what the pipeline needs:

1. **Direct parse** — works when the model returns clean JSON
2. **Code-fence stripping** — models like Qwen wrap output in ` ```json ... ``` `
3. **Truncated array recovery** — collects all balanced top-level elements from arrays where the output was cut off before the closing `]`
4. **Balanced extraction** — finds the first complete `{...}` or `[...]` in arbitrary text

If the first parse attempt fails entirely, `completeJSON()` retries once with `temperature: 0` and a strict "JSON only, no markdown" system prompt.

### Model Compatibility Notes

Reasoning models (Qwen, DeepSeek) commonly exhibit:
- Markdown code-fence wrapping around JSON output
- Truncated output at model-determined stopping points (may report `finishReason: "stop"` despite incomplete content)
- Thinking blocks interleaved with text blocks in the response content array

The parsing pipeline handles all three cases. When truncated array recovery fires, it logs: `[LLM] Recovered N element(s) from truncated JSON array`.
