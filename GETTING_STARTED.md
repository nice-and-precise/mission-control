# Getting Started with Mission Control

A step-by-step guide for new collaborators. Takes about 15 minutes to go from clone to running.

---

## Prerequisites

You need three things installed before Mission Control will work:

### 1. Node.js (pinned version)

This repo pins its Node.js version in `.nvmrc`. Install nvm, then let it read the pin:

```bash
curl -o- https://raw.githubusercontent.com/nvm-sh/nvm/v0.39.7/install.sh | bash
# Restart your shell, then:
nvm install   # installs the exact version from .nvmrc
nvm use
```

Or download the matching version from [nodejs.org](https://nodejs.org/).

### 2. OpenClaw Gateway

Mission Control orchestrates AI agents through OpenClaw. Install it:

```bash
# macOS
brew install openclaw/tap/openclaw

# Or follow: https://docs.openclaw.ai/getting-started/installation
```

After install, configure your AI provider API key:

```bash
openclaw init
# Follow prompts — you'll need an API key from your AI provider
# Supported: Anthropic, OpenAI, Google, Qwen (Alibaba), OpenRouter, and others
```

Start the gateway:

```bash
openclaw start
# Gateway runs on ws://127.0.0.1:18789 by default
```

### 3. Git access

You need access to the `nice-and-precise/mission-control` repo. If you can read this, you have it.

---

## Setup (5 minutes)

```bash
# Clone the repo
git clone https://github.com/nice-and-precise/mission-control.git
cd mission-control

# Use the pinned Node version
nvm use

# Install dependencies
npm ci

# Create your local config
cp .env.example .env.local
```

Edit `.env.local` with your values:

```bash
# Required — path to your database (auto-created on first run)
DATABASE_PATH=./mission-control.db

# Required — your OpenClaw gateway connection
OPENCLAW_GATEWAY_URL=ws://127.0.0.1:18789

# Required if your gateway has auth enabled
# Get this from: openclaw config get gateway.token
OPENCLAW_GATEWAY_TOKEN=your-gateway-token-here

# Recommended for security — if not set, authentication is DISABLED (local dev mode only)
# Generate with: openssl rand -hex 32
MC_API_TOKEN=your-api-token-here

# Base directory for all Mission Control files
WORKSPACE_BASE_PATH=~/Documents/Shared

# Projects sub-directory (each project gets a folder here)
PROJECTS_PATH=~/Documents/Shared/projects
```

Initialize the database and start:

```bash
npm run db:seed   # Seeds agents, a default workspace, and sample tasks (run once on first setup)
npm run dev       # Starts on http://localhost:4000 (also auto-applies DB migrations on boot)
```

> **Note:** `db:seed` only needs to run once on a fresh database. If you skip it, `npm run dev` will still boot and apply all schema migrations — you just won't have the sample data.

Open **http://localhost:4000** — you should see the Mission Control dashboard.

---

## First Steps in the UI

### Create a Product

1. Go to the **Products** page
2. Click **New Product**
3. Give it a name and description (e.g., "My Project — autonomous improvement pipeline")
4. Optionally paste your product program (a markdown doc that guides all AI decisions)

### Create a Workspace

1. Each product needs a **workspace** — this is where agents do their work
2. A workspace points to a git repo on your machine
3. Create one from the product's settings or the workspace management page

### Create Agents

Agents are the AI workers. You need at least one to start:

1. Go to **Agents** and create one (or use the auto-created Orchestrator)
2. Set the agent's **model** (the gateway will show available models)
3. Give it a **soul** — markdown instructions that define its personality and skills
4. Assign it to your workspace

### Create a Task

1. Click **New Task** on the Kanban board
2. Write a description of what you want built
3. The agent enters a **planning phase** — it may ask clarifying questions
4. Once planning is complete, the agent starts building

### Try Autopilot

The real power is the autopilot pipeline:

1. Go to the **Autopilot** page for your product and open the **Program** tab — write a product program (what you're building, what's done, what's needed next)
2. If you have a canonical `PRODUCT_PROGRAM.md` in your repo, configure `canonical_program_path` in the product settings so Mission Control can detect drift and block stale research runs. Then click **Audit & Sync Program** to verify the DB copy is current.
3. Open the **Research** tab and run a research cycle — this audits your product against the program checklist
4. Review generated **Ideas** with the swipe interface (Approve / Reject / Maybe)
5. Approved ideas get planned and dispatched to agents automatically

---

## Key Concepts

| Concept | What it is |
|---------|-----------|
| **Product** | The thing you're building. Has a program, research, ideas, and tasks. |
| **Product Program** | A markdown doc the AI reads before every decision. Your north star. |
| **Workspace** | A git repo where agents write code. Isolated per product. |
| **Agent** | An AI worker with a model, soul (instructions), and assigned workspace. |
| **Autopilot** | The full pipeline: Research → Ideas → Swipe → Plan → Build → Test → Review → Done |
| **Convoy Mode** | Parallel multi-agent execution with dependency ordering. |
| **Planning Phase** | Q&A between you and the agent before any code is written. |

---

## Useful Commands

```bash
npm run dev          # Start development server (http://localhost:4000)
npm run build        # Production build
npm run db:seed      # Seed agents, workspace, and sample tasks (first setup only)
npm run db:backup    # Snapshot database to mission-control.db.backup
npm run db:restore   # Restore from mission-control.db.backup
npm run db:reset     # Wipe database and re-seed (DESTRUCTIVE — all data lost)
npm test             # Run the full test suite
```

---

## Troubleshooting

**"Cannot connect to OpenClaw Gateway"**
- Make sure `openclaw start` is running
- Check that `OPENCLAW_GATEWAY_URL` in `.env.local` matches your gateway address
- If gateway has auth, ensure `OPENCLAW_GATEWAY_TOKEN` is set

**"No models available"**
- The gateway discovers models from your AI provider config
- Run `openclaw models` to see what's available
- Check your API key is set: `openclaw config get providers`

**Dashboard shows "OFFLINE"**
- This means the WebSocket to the gateway dropped
- Restart the gateway: `openclaw restart`
- Refresh the browser

**Database errors**
- Run `npm run db:reset` for a fresh start (this deletes all data)
- Check `DATABASE_PATH` in `.env.local` points to a writable location

---

## Architecture Overview

```
┌──────────────┐  HTTP + SSE events  ┌──────────────────┐
│   Browser     │◄──────────────────►│  Mission Control  │
│  (Next.js UI) │                    │  (Next.js API)    │
└──────────────┘                     └────────┬─────────┘
                                              │
                                     SQLite   │  WebSocket
                                       DB     │
                                              ▼
                                     ┌──────────────────┐
                                     │  OpenClaw Gateway  │
                                     │  (AI orchestrator) │
                                     └────────┬─────────┘
                                              │
                                              ▼
                                     ┌──────────────────┐
                                     │  AI Providers     │
                                     │  (Anthropic, etc) │
                                     └──────────────────┘
```

Mission Control is the dashboard and task manager. The browser communicates with it over HTTP with Server-Sent Events (SSE) for real-time updates. Mission Control talks to the OpenClaw Gateway over WebSocket — that is where agents actually run and call AI models.

---

## Next Steps

- Read [docs/HOW-THE-PIPELINE-WORKS.md](docs/HOW-THE-PIPELINE-WORKS.md) for the full autopilot deep-dive
- Read [docs/NEXT-CYCLE-PLAYBOOK.md](docs/NEXT-CYCLE-PLAYBOOK.md) for the repeatable research → dispatch cycle
- Read [docs/AGENT_PROTOCOL.md](docs/AGENT_PROTOCOL.md) for how agents communicate
- Check [CONTRIBUTING.md](CONTRIBUTING.md) for development conventions
- See [PRODUCTION_SETUP.md](PRODUCTION_SETUP.md) for deployment options
