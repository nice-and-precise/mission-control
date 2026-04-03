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

## Local OpenClaw Preflight

For local Autopilot on this baseline:

- keep `AUTOPILOT_MODEL=openclaw`
- treat `openclaw` as the execution target, not a provider override
- verify `GET /api/openclaw/models` reports both `defaultAgentTarget` and `defaultProviderModel`
- ensure the reported `defaultProviderModel` is in Mission Control's docs-backed allowlist and has pricing metadata
- for first-time machine setup, use [FIRST_TIME_SETUP.md](FIRST_TIME_SETUP.md) before editing Mission Control env vars by hand

Why this matters:

- research and ideation execute through the `openclaw` agent target
- Mission Control still needs a priced, policy-allowed provider model for budget and cost accounting
- if the OpenClaw default provider model is not allowed or unpriced, Autopilot can fail before research or ideation completes

Current Autopilot-compatible default provider models on this branch:

- `openai-codex/gpt-5.4`
- `opencode-go/kimi-k2.5`
- `opencode-go/glm-5`
- `opencode-go/minimax-m2.5`

After deleting a mistaken product:

- the product should disappear from `/autopilot`
- `GET /api/products/{id}` should return `404`
- if the product had a dedicated workspace, that workspace should also be gone
- if the product used `default` or another shared workspace, that workspace should remain
