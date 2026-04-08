# Production Setup Guide

This guide walks you through setting up Mission Control for production use with proper configuration management.

> [!NOTE]
> This guide uses generic setup examples. For the verified state of this local checkout, including the current machine-specific project-root override, see [docs/CURRENT_LOCAL_STATUS.md](docs/CURRENT_LOCAL_STATUS.md).
> Use [docs/README.md](docs/README.md) when you need the current docs authority map.

## ⚠️ Security First

**NEVER commit sensitive data to the repository!** This includes:
- IP addresses
- User paths
- Authentication tokens
- API keys
- Database credentials

All sensitive values go in `.env.local` (which is gitignored).

## 📦 Initial Setup

### 1. Clone the Repository

```bash
git clone https://github.com/yourusername/mission-control.git
cd mission-control
```

### 2. Install Dependencies

```bash
nvm use
npm ci
```

For local development, `nvm use` defaults this repo to the pinned Node `24.13.0` runtime. Treat that exact patch version as the Mission Control runtime contract for install, test, build, and local app boot.

This is intentionally separate from the OpenClaw gateway LaunchAgent, which may use the OpenClaw-managed Node `22.22.0` toolchain under `~/.openclaw/tools/` on `2026.4.8`.

### 3. Configure Environment Variables

```bash
cp .env.example .env.local
python3 ../scripts/sync_mission_control_gateway_token.py --env-file .env.local
```

Edit `.env.local` with your configuration:

```bash
# Database
DATABASE_PATH=./mission-control.db

# OpenClaw Gateway
OPENCLAW_GATEWAY_URL=ws://127.0.0.1:18789
OPENCLAW_GATEWAY_TOKEN=your-token-here

# Workspace Paths
WORKSPACE_BASE_PATH=/var/lib/mission-control/workspace
PROJECTS_PATH=/var/lib/mission-control/workspace/projects

# API URL (auto-detected if not set)
MISSION_CONTROL_URL=http://localhost:4000
```

On the local workspace baseline, treat `python3 ../scripts/sync_mission_control_gateway_token.py --env-file .env.local` as the supported way to source `OPENCLAW_GATEWAY_TOKEN` from OpenClaw's canonical SecretRef target.

### 4. Initialize Database

```bash
npm run db:seed
```

This creates the database and seeds it with:
- the master agent
- Sample tasks
- Default business

### 5. Start Development Server

```bash
npm run dev
```

Visit [http://localhost:4000](http://localhost:4000)

## ⚙️ Configuration Management

Mission Control supports configuration via **two methods**:

### Method 1: Environment Variables (.env.local)

Best for:
- Server-side configuration
- Deployment environments
- Team consistency

Variables in `.env.local`:
```bash
WORKSPACE_BASE_PATH=/var/lib/mission-control/workspace
PROJECTS_PATH=/var/lib/mission-control/workspace/projects
MISSION_CONTROL_URL=http://your-server-ip:4000
OPENCLAW_GATEWAY_URL=ws://127.0.0.1:18789
```

### Method 2: Settings UI

Best for:
- User-specific preferences
- Quick adjustments
- Per-user customization

Access via: **Settings** button (top-right) or `/settings`

Settings stored in browser localStorage:
- Workspace base path
- Projects path
- Mission Control API URL
- Default project name

**Priority:** Environment variables override UI settings for server operations.

## 📁 Workspace Structure

Mission Control organizes files in a structured workspace:

```
/var/lib/mission-control/workspace/    # Base workspace
├── projects/                    # All projects
│   ├── [PROJECT_NAME_1]/       # Individual project
│   │   ├── deliverables/       # Task deliverables
│   │   ├── docs/               # Project docs
│   │   └── README.md
│   └── [PROJECT_NAME_2]/
└── mission-control/             # Mission Control app
    └── mission-control.db       # Database
```

### Configuring Paths

**Via Environment Variables:**
```bash
WORKSPACE_BASE_PATH=/var/lib/mission-control/workspace
PROJECTS_PATH=/var/lib/mission-control/workspace/projects
```

**Via Settings UI:**
1. Click **Settings** (gear icon)
2. Update "Workspace Base Path"
3. Update "Projects Path"
4. Click **Save Changes**

### Path Variables

- `~` expands to your home directory
- Paths can be absolute: `/home/user/workspace`
- Paths can be relative: `./workspace`

## 🔌 OpenClaw Gateway Setup

### Local Connection

```bash
# .env.local
OPENCLAW_GATEWAY_URL=ws://127.0.0.1:18789
OPENCLAW_GATEWAY_TOKEN=your-local-token-if-gateway-auth-is-enabled
```

Local connections may still require a token if your gateway is running with token auth enabled.

### Remote Connection (Tailscale)

```bash
# .env.local
OPENCLAW_GATEWAY_URL=wss://your-machine.tail12345.ts.net
OPENCLAW_GATEWAY_TOKEN=$(openssl rand -hex 32)
```

**Generate a secure token when you control the gateway config directly:**
```bash
openssl rand -hex 32
```

Use the same token source on both sides:
1. Mission Control's `.env.local`
2. OpenClaw's gateway auth configuration or secret source

If your OpenClaw install uses SecretRef-backed gateway auth, resolve or rotate that external secret source instead of assuming a plaintext token lives in `~/.openclaw/openclaw.json`.

## 🚀 Production Deployment

### Build for Production

```bash
npm run build
npm run start
```

For containerized and production-like runtime parity, keep the runtime aligned with the same pinned Node `24.13.0` contract unless and until the repo explicitly ships a different deployment baseline.

### Environment Variables for Production

Create `.env.production.local`:

```bash
NODE_ENV=production
DATABASE_PATH=/var/lib/mission-control/mission-control.db
WORKSPACE_BASE_PATH=/var/lib/mission-control/workspace
PROJECTS_PATH=/var/lib/mission-control/workspace/projects
MISSION_CONTROL_URL=https://mission-control.yourdomain.com
OPENCLAW_GATEWAY_URL=wss://gateway.yourdomain.com
OPENCLAW_GATEWAY_TOKEN=your-production-token
```

### Database Backups

```bash
# Backup database
cp mission-control.db mission-control.backup.$(date +%Y%m%d).db

# Restore from backup
cp mission-control.backup.20250131.db mission-control.db
```

## 🧪 Testing Your Setup

### 1. Verify Configuration

```bash
# Check environment variables
cat .env.local

# Verify database
ls -la mission-control.db
```

### 2. Test OpenClaw Connection

1. Start or restart the OpenClaw Gateway service: `openclaw gateway start`
2. Open Mission Control: `http://localhost:4000`
3. Check status indicator (top-right): Should show **ONLINE** (green)

### 3. Test Real-Time Updates

1. Create a task
2. Assign it to an agent
3. Drag to "In Progress"
4. Watch it update in real-time (no refresh needed)

✅ **Task cards should move between columns instantly**

### 4. Test Deliverables

1. Open a task with deliverables
2. Click the arrow (→) button next to a file deliverable
3. File path should copy to clipboard

## 🔧 Troubleshooting

### Real-Time Updates Not Working

**Symptom:** Task cards don't move when status changes

**Solutions:**
1. Check browser console for SSE errors
2. Verify SSE endpoint: `/api/events/stream`
3. Clear browser cache
4. Restart dev server

### OpenClaw Not Connecting

**Symptom:** Status shows OFFLINE

**Solutions:**
1. Verify Gateway is running: `openclaw gateway status`
2. Check `OPENCLAW_GATEWAY_URL` in `.env.local`
3. For remote: Verify `OPENCLAW_GATEWAY_TOKEN` matches
4. Test WebSocket connection: `wscat -c ws://127.0.0.1:18789`

### Deliverables Button Not Working

**Symptom:** Arrow button does nothing

**Solutions:**
1. Check browser clipboard permissions
2. Look for console errors
3. Try on a task with a file deliverable (not URL)

### Hardcoded Paths in Code

**Symptom:** Paths still reference wrong user

**Solution:** All hardcoded paths have been removed! If you find any:
1. File a bug report
2. Use `getWorkspaceBasePath()` or `getProjectsPath()` from `@/lib/config`

## 📚 Configuration Reference

### Environment Variables

| Variable | Default | Description |
|----------|---------|-------------|
| `DATABASE_PATH` | `./mission-control.db` | SQLite database file path |
| `WORKSPACE_BASE_PATH` | Example: `/var/lib/mission-control/workspace` | Base directory for workspace |
| `PROJECTS_PATH` | Example: `/var/lib/mission-control/workspace/projects` | Directory for project folders |
| `MISSION_CONTROL_URL` | Auto-detected | API URL for agent orchestration |
| `OPENCLAW_GATEWAY_URL` | `ws://127.0.0.1:18789` | Gateway WebSocket URL |
| `OPENCLAW_GATEWAY_TOKEN` | (empty) | Authentication token |

### Settings UI Fields

| Setting | Description |
|---------|-------------|
| Workspace Base Path | Root directory for all Mission Control files |
| Projects Path | Where individual project folders are created |
| Default Project Name | Template name for new projects |
| Mission Control URL | API endpoint (usually auto-detected) |

## 🎯 Next Steps

1. ✅ Configure `.env.local`
2. ✅ Run database seed
3. ✅ Start dev server
4. ✅ Test real-time updates
5. ✅ Configure workspace paths
6. 🚀 Create your first agent!

## 📖 Further Reading

- [Agent Protocol Documentation](docs/AGENT_PROTOCOL.md)
- [Local Checkout Status](docs/CURRENT_LOCAL_STATUS.md)
- [Real-Time Implementation](REALTIME_IMPLEMENTATION_SUMMARY.md)
- [the orchestrator Orchestration Guide](src/lib/orchestration.ts)

---

**Questions?** File an issue or check the documentation in `/docs`.
