# First-Time Setup

Use this when a new operator is setting up Mission Control on a new machine for the first time.

This path is designed to avoid hidden machine-local drift:

- do not copy another operator's `~/.openclaw/` directory
- do not copy another operator's `.env.local`
- choose your own provider auth and default models in OpenClaw
- keep Mission Control pointed at the OpenClaw agent target, not at a hardcoded provider model

## What John Should Install

1. Install Node.js `20.x` or `24.x`.
2. Install OpenClaw on the `stable` channel.
3. Clone this repo and run `npm ci`.

Mission Control's current public quick-start stays in [../README.md](../README.md). This doc adds the first-time operator decisions that should happen before running the app.

## OpenClaw First

OpenClaw's official recommendation for first setup is the onboarding wizard:

```bash
openclaw onboard
```

Official docs:

- Onboarding Wizard (CLI): <https://docs.openclaw.ai/cli/onboard>
- Onboarding Overview: <https://docs.openclaw.ai/start/onboarding-overview>

What the wizard is for:

- local or remote Gateway setup
- provider auth
- workspace defaults
- channel and skill bootstrap

Official follow-up commands after onboarding:

```bash
openclaw configure
openclaw agents add <name>
```

Use `openclaw configure` when John wants to revise an existing setup. Use `openclaw agents add <name>` if he wants additional named agent profiles instead of a single default.

## Model Choice Rules

John should choose models in OpenClaw, not in Mission Control.

The official OpenClaw model commands are:

```bash
openclaw models status
openclaw models list
openclaw models set <model-or-alias>
openclaw models scan
```

Official docs:

- Models CLI: <https://docs.openclaw.ai/cli/models>
- Models overview: <https://docs.openclaw.ai/models>
- Configuration: <https://docs.openclaw.ai/gateway/configuration>

Important OpenClaw behavior from the official docs:

- `agents.defaults.model.primary` and `agents.defaults.model.fallbacks` control the active defaults
- `agents.defaults.models` defines the model catalog and acts as the allowlist for `/model`
- `openclaw models set <model-or-alias>` changes the default model to a `provider/model` ref or alias

That means John can use whichever providers and models he wants in OpenClaw, as long as he authenticates them and includes them in his OpenClaw model catalog.

For Mission Control specifically, that catalog is not abstract. Bootstrapped workspace agents need a provider model that is actually present in `openclaw models list`, not just theoretically allowed by Mission Control policy.

## Provider Auth Best Practice

For a long-lived local Gateway, OpenClaw's official auth docs recommend API keys as the predictable default:

- Authentication: <https://docs.openclaw.ai/gateway/authentication>

Official guidance to keep in mind:

- API keys are usually the most predictable option for always-on gateway hosts
- if the Gateway runs under launchd/systemd, prefer `~/.openclaw/.env` so the daemon can read the credentials
- `openclaw models status --check` is the portable health check for credential validity

Recommended verification:

```bash
openclaw models status --check
openclaw doctor
openclaw gateway status --require-rpc --deep
```

If John wants GitHub Copilot specifically, OpenClaw's official provider docs support it directly:

```bash
openclaw models auth login-github-copilot
openclaw models set github-copilot/gpt-4o
```

Official docs:

- GitHub Copilot provider: <https://docs.openclaw.ai/providers/github-copilot>

## Mission Control Settings

After OpenClaw is healthy, set up Mission Control:

```bash
git clone https://github.com/nice-and-precise/mission-control.git
cd mission-control
nvm use
npm ci
cp .env.example .env.local
python3 ../scripts/sync_mission_control_gateway_token.py --env-file .env.local
```

Keep this contract in `.env.local`:

```env
AUTOPILOT_MODEL=openclaw
OPENCLAW_GATEWAY_URL=ws://127.0.0.1:18789
OPENCLAW_GATEWAY_TOKEN=...
```

Why:

- Mission Control should call the OpenClaw agent target, not a provider model directly
- John should change provider/model defaults in OpenClaw with `openclaw models set ...`, not by editing Mission Control to point at `openai/...`, `anthropic/...`, or similar refs

## Bootstrapped Agent Models

Mission Control now seeds workspace agents from the local OpenClaw catalog instead of assuming one fixed builder model on every machine.

What that means:

- a bootstrapped Builder or Reviewer can prefer `openai-codex/gpt-5.4`, but only if that model is actually present in `openclaw models list`
- if a preferred model is not discovered locally, Mission Control falls back to another policy-allowed, priced model from the local catalog
- John should verify his intended working models are both:
  - present in `openclaw models list`
  - allowed and priced in `GET /api/openclaw/models`

Recommended check:

```bash
openclaw models status
openclaw models list
TOKEN="${MC_API_TOKEN:-your-token}"
curl -s -H "Authorization: Bearer $TOKEN" http://localhost:4000/api/openclaw/models | jq
```

## Important Autopilot Limitation Right Now

Mission Control Product Autopilot currently separates:

- execution target: `openclaw`
- accounting model: the `defaultProviderModel` reported by `GET /api/openclaw/models`

John can still use other models for normal OpenClaw chat or agent work, but Autopilot research and ideation on this branch currently expect the default provider model to be one of Mission Control's accounted models:

- `openai-codex/gpt-5.4`
- `opencode-go/kimi-k2.5`
- `opencode-go/glm-5`
- `opencode-go/minimax-m2.5`

If John picks another OpenClaw default provider model, normal OpenClaw usage may still work, but Mission Control Autopilot research and ideation can fail policy or accounting checks until Mission Control's model policy is extended.

Check the live contract here:

```bash
TOKEN="${MC_API_TOKEN:-your-token}"
curl -s -H "Authorization: Bearer $TOKEN" http://localhost:4000/api/openclaw/models | jq
```

What to verify:

- `defaultAgentTarget` is `openclaw`
- `defaultProviderModel` is present
- the chosen `defaultProviderModel` is one of the current Autopilot-compatible models above
- if John expects a specific builder model, that same model also appears as a discovered entry in `openclaw models list`

## Recommended First-Time Verification

Run this after OpenClaw and Mission Control are both configured:

```bash
openclaw models status --check
openclaw doctor
openclaw gateway status --require-rpc --deep

npm run docs:check
npm test
npm run build
```

Then check the Mission Control/OpenClaw contract:

```bash
TOKEN="${MC_API_TOKEN:-your-token}"
curl -s -H "Authorization: Bearer $TOKEN" http://localhost:4000/api/health | jq
curl -s -H "Authorization: Bearer $TOKEN" http://localhost:4000/api/openclaw/models | jq
```

## If VS Code Opens Blank

If VS Code reopens to a blank or half-loaded window while Mission Control is running:

- restart the VS Code window first
- verify Mission Control separately in a normal browser tab before assuming the dev server failed
- check VS Code logs for an extension-host crash before blaming the app
- if the logs mention missing MCP `manifest.json` files, clear stale user-level MCP cache or sync state and reopen VS Code
- if chat extensions keep crashing the extension host, disable or update them before continuing

## If a Task Shows "Assigned, But Blocked"

If a Mission Control task is assigned but blocked with an OpenClaw model-binding error:

- check the task's assigned workspace agent model in Mission Control
- check `openclaw models list` on that machine
- if the agent model is not present in the local OpenClaw catalog, update the agent to a locally discovered, policy-allowed model and retry dispatch

This is a machine-local model/catalog mismatch, not usually a product-data problem.

## If a Task Blocks on Budget Caps

If Mission Control shows a task as blocked by a cost cap even though recorded spend is still `$0`:

- remember that Mission Control blocks on estimated dispatch reserve before execution starts
- dedicated workspaces default to `$20` daily and `$100` monthly local caps on this baseline
- large or XL tasks can exceed the workspace daily cap immediately
- check the product Cost tab and confirm whether the blocker is the workspace cap or the product cap
- use the Cost tab to raise the correct cap layer if John intentionally wants to allow the task

When John needs provider/runtime context outside Mission Control's local accounting model, use these read-only diagnostics:

```bash
openclaw status --usage
/usage cost
/usage full
```

Those diagnostics are for provider/runtime context only. They do not replace Mission Control's own budget/accounting rules.

## Sharing Checklist Before John Starts

- John has his own OpenClaw install and credentials
- John chose his own default model in OpenClaw
- John's intended builder/reviewer model is present in `openclaw models list`
- Mission Control still uses `AUTOPILOT_MODEL=openclaw`
- `GET /api/openclaw/models` returns a compatible `defaultProviderModel`
- John can pass the verification gate in [../VERIFICATION_CHECKLIST.md](../VERIFICATION_CHECKLIST.md)
