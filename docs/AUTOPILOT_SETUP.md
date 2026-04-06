# Autopilot Setup

Use this when creating a new Product Autopilot product or resetting one that was pointed at the wrong workspace.

## Workspace Model

Mission Control and OpenClaw both use the word "workspace", but they mean different things.

- OpenClaw `agents.defaults.workspace` is the runtime filesystem base from `~/.openclaw/openclaw.json`.
  Source: <https://docs.openclaw.ai/gateway/configuration-reference>
- Mission Control product workspaces are in-app queue and agent scopes.
- A dedicated Mission Control product workspace does not replace the OpenClaw runtime base. It gives the product its own task board, core agents, and workflow templates inside Mission Control.

## Default Product Setup

New products now default to `Dedicated workspace`.

What that does:

- creates a product-specific Mission Control workspace
- clones the default workflow templates into that workspace
- bootstraps the core workspace agents there
- points the product at that workspace so approved ideas create build tasks outside `default`

Use `Use existing workspace` only when you intentionally want the product to share an existing queue such as `default`.

## Recommended Operator Flow

1. Open `/autopilot/new`.
2. Leave `Dedicated workspace` selected unless you have a specific reason to share a workspace.
3. Confirm the workspace destination before saving the product.
4. After the product is created, verify the workspace chip on the product card or product dashboard header.
5. If the workspace destination is wrong, delete the product and recreate it. Do not repoint an existing product manually.

## Reset a Mistaken Product

Mission Control now treats product delete as a hard reset.

Delete does all of the following:

- removes the product row
- removes product-owned Autopilot history
- removes product-owned tasks linked through `tasks.product_id`
- deletes the dedicated workspace if Mission Control created it for that product
- leaves shared existing workspaces intact

Operator entry points:

- `/autopilot` product card overflow menu
- `/autopilot/[productId]` settings modal `Danger Zone`

## Validation

After creating a product:

- the product card should show the target workspace
- the product dashboard header should show the same workspace
- approving an idea should create the build task in that workspace, not in `default`

After deleting a mistaken product:

- the product should disappear from `/autopilot`
- `GET /api/products/{id}` should return `404`
- if the product had a dedicated workspace, that workspace should also be gone
- if the product used `default` or another shared workspace, that workspace should remain

## Model Compatibility

Autopilot uses `completeJSON()` for all structured LLM interactions (ideation, research, planning). The JSON parsing pipeline handles common model behaviors, but some models work better than others.

### Verified models

- **qwen/qwen3.6-plus** — reasoning model with `reasoning: true`. Works well. May wrap JSON in markdown code fences and occasionally truncate long arrays, but the parser recovers both cases automatically.
- **openclaw** — default routing target. Works when the gateway has a compatible default model configured.

### Known behaviors with reasoning models

Reasoning models (Qwen, DeepSeek) may:

1. **Wrap JSON in code fences** — ` ```json ... ``` `. Handled by `stripCodeFences()` in `extractStructuredJSON()`.
2. **Truncate long arrays** — output stops mid-element with `finishReason: "stop"`. Handled by `recoverTruncatedArray()`, which collects all balanced elements. A warning is logged when this occurs.
3. **Include thinking blocks** — the response content array contains `thinking` entries alongside `text` entries. The session history parser (`extractContentText()`) correctly extracts only the text block.

### If ideation produces too few ideas

Check the server logs for `[LLM] Recovered N element(s) from truncated JSON array`. If this warning is absent and only 1 idea was generated, the raw response may genuinely contain only 1 idea. Inspect the phase_data in the `ideation_cycles` table. See [TROUBLESHOOTING.md](TROUBLESHOOTING.md) section 13 for diagnosis steps.
