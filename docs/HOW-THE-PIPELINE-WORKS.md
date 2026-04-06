# How the Pipeline Works

Plain-language walkthrough of the current Mission Control repo-backed workflow.

For the machine-local truth on Jordan's current checkout, use [CURRENT_LOCAL_STATUS.md](CURRENT_LOCAL_STATUS.md). For the shareable verification gate, use [../VERIFICATION_CHECKLIST.md](../VERIFICATION_CHECKLIST.md).

## The Owners

- `Avery` routes and packages work
- `Builder` implements and repairs
- `Tester` validates runtime behavior and evidence
- `Reviewer` owns code review and the final strict verification stage
- `Learner` captures reusable lessons after successful completion

## The Stage Flow

1. A task is approved with a clear scope and product target.
2. `Builder` receives the implementation task in the assigned workspace.
3. `Tester` validates the built result with reproducible evidence.
4. `Reviewer` performs the final code-quality and spec-fit review.
5. `Learner` captures durable lessons only after the task has really cleared the build pod.

Failures route back to `Builder` unless `Avery` explicitly changes the path.

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
