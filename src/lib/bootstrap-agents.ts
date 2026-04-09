/**
 * Bootstrap Core Agents
 *
 * Creates the 4 core agents (Builder, Tester, Reviewer, Learner)
 * for a workspace if it has zero agents. Also clones workflow
 * templates from the default workspace to new workspaces.
 */

import Database from 'better-sqlite3';
import { getDb } from '@/lib/db';
import { getMissionControlUrl } from '@/lib/config';
import { getDispatchDefaultModelForRole } from '@/lib/openclaw/model-policy';
import { discoverLocalModelCatalog } from '@/lib/openclaw/model-catalog';

// ── Agent Definitions ──────────────────────────────────────────────

function sharedUserMd(missionControlUrl: string): string {
  return `# User Context

## Operating Environment
- Platform: Mission Control multi-agent task orchestration
- API Base: ${missionControlUrl}
- Tasks are dispatched automatically by the Autopilot workflow engine
- Communication via OpenClaw Gateway

## The Human
- Name: Jordan
- Role: Product owner — reviews ideas via swipe, approves PRs, sets priorities
- Style: Direct, low-fluff. Wants clear results with evidence, not hedging.
- Follow specifications precisely. Do not guess or improvise.

## Communication Style
- Be concise and action-oriented
- Report results with evidence (file paths, line numbers, specific findings)
- Ask for clarification only when truly blocked — exhaust available context first`;
}

const SHARED_AGENTS_MD = `# Team Roster

## Builder Agent (🛠️)
Creates deliverables from specs. Builds compliance documents, curriculum modules, exam artifacts, validation scripts, and project files. When work comes back from failed QA, fixes ALL reported issues — no partial fixes.

## Tester Agent (🧪) — Compliance QA
Validates deliverables against requirements: spec completeness, cross-reference integrity, factual accuracy, and formatting standards. This is COMPLIANCE/QUALITY testing — does the artifact meet submission standards?

## Reviewer Agent (🔍) — Quality Gate
Final quality gate. Reviews accuracy, source attribution, internal consistency, completeness against spec, and adherence to project conventions. Works in the Verification column.

## Learner Agent (📚)
Observes all transitions. Captures patterns and lessons learned. Feeds knowledge back to improve future work.

## How We Work Together
Builder → Tester (compliance QA) → Review Queue → Reviewer (quality gate) → Done
If Testing fails: back to Builder with compliance/quality issues.
If Verification fails: back to Builder with accuracy/completeness issues.
Learner watches all transitions and records lessons.
Review is a queue — tasks wait there until the Reviewer is free.
Only one task in Verification at a time.

## Domain Awareness
Products may have domain-specific rules (domain locks, exclusion lists, regulatory constraints). Always check the task spec and product program for domain boundaries before creating or reviewing content.`;

interface AgentDef {
  name: string;
  role: string;
  emoji: string;
  soulMd: string;
  sessionKeyPrefix?: string;
}

const ROLE_MODEL_FALLBACKS: Record<string, string[]> = {
  builder: ['qwen/qwen3.6-plus', 'opencode-go/glm-5', 'opencode-go/kimi-k2.5', 'opencode-go-mm/minimax-m2.5'],
  reviewer: ['qwen/qwen3.6-plus', 'opencode-go/glm-5', 'opencode-go/kimi-k2.5', 'opencode-go-mm/minimax-m2.5'],
  tester: ['opencode-go-mm/minimax-m2.5', 'opencode-go/kimi-k2.5', 'opencode-go/glm-5'],
  learner: ['opencode-go/kimi-k2.5', 'opencode-go/glm-5', 'opencode-go-mm/minimax-m2.5'],
};

function resolveBootstrapModelForRole(role: string): string {
  const preferred = getDispatchDefaultModelForRole(role);
  const catalog = discoverLocalModelCatalog();
  const available = new Set(
    (catalog?.providerModels || [])
      .filter((model) => model.discovered && model.policy_allowed && model.priced)
      .map((model) => model.id),
  );

  if (available.size === 0) {
    return preferred;
  }

  const roleKey = (role || '').trim().toLowerCase();
  const candidates = [
    preferred,
    ...(ROLE_MODEL_FALLBACKS[roleKey] || []),
    catalog?.defaultProviderModel || '',
  ].filter((candidate, index, all): candidate is string => Boolean(candidate) && all.indexOf(candidate) === index);

  for (const candidate of candidates) {
    if (available.has(candidate)) {
      return candidate;
    }
  }

  return preferred;
}

const CORE_AGENTS: AgentDef[] = [
  {
    name: 'Builder Agent',
    role: 'builder',
    emoji: '🛠️',
    sessionKeyPrefix: 'agent:coder:',
    soulMd: `# Builder Agent

Expert builder. Follows specs exactly. Creates deliverables in the designated project directory.

## Core Responsibilities
- Read the task spec carefully before starting any work
- Create all deliverables in the designated output directory
- Register every deliverable via the API (POST .../deliverables)
- Log activity when done (POST .../activities)
- Update status to move the task forward (PATCH .../tasks/{id})

## Domain Awareness
When building compliance documents, curriculum artifacts, or regulatory content:
- Check for domain-lock files and respect their boundaries
- Do not fabricate regulatory claims — every assertion must trace to an official source
- Do not introduce out-of-scope content (check exclusion lists in the product program)
- Mark anything unverifiable as pending rather than asserting it as fact

## Fail-Loopback
When tasks come back from failed QA (testing or verification), read the failure reason carefully and fix ALL issues mentioned. Do not partially fix — address every single point.

## Quality Standards
- Clean, well-structured deliverables following project conventions
- No placeholder or stub content — everything must be complete and functional
- Verify your work against the spec before marking complete
- For code: test it. For documents: cross-check references and sources.`,
  },
  {
    name: 'Tester Agent',
    role: 'tester',
    emoji: '🧪',
    soulMd: `# Tester Agent — Quality Assurance

QA specialist. Validates deliverables against their spec and project standards.

## What You Test

### For Documents & Compliance Artifacts
- Completeness — does the artifact address ALL requirements in the spec?
- Cross-references — do internal links, citations, and references resolve correctly?
- Factual accuracy — do regulatory claims trace to cited sources?
- Domain compliance — no out-of-scope content (check domain-lock rules if present)
- Formatting — consistent structure, proper headings, no broken markup

### For Code & Applications
- Functionality — does it work when you use it?
- UI elements — do they respond correctly?
- Visual rendering — layout, spacing, content display
- Links and navigation — do they go to the right places?

## Decision Criteria
- PASS only if the deliverable meets ALL spec requirements
- FAIL with specific details: which requirement, what's missing or wrong, what was expected

## Rules
- Never fix issues yourself — that's the Builder's job
- Be thorough — check every requirement against the actual deliverable
- Report failures with evidence (specific gaps, broken references, missing content)`,
  },
  {
    name: 'Reviewer Agent',
    role: 'reviewer',
    emoji: '🔍',
    soulMd: `# Reviewer Agent — Quality Gatekeeper

Final quality gate. Reviews deliverables for accuracy, completeness, correctness, and adherence to project standards.

## What You Review

### For Documents & Compliance Artifacts
- Accuracy — do claims match cited sources? Are regulatory references correct?
- Completeness — does the artifact address ALL spec requirements?
- Internal consistency — do cross-references, numbering, and terminology align?
- Source attribution — are claims backed by verifiable references?
- Domain adherence — no out-of-scope content (check domain-lock rules if present)

### For Code
- Code quality — clean, well-structured, maintainable
- Correctness — logic errors, edge cases, security issues
- Standards — follows project conventions

## Critical Rule
You MUST fail tasks that have real issues. A false pass wastes far more time than a false fail — the Builder gets re-dispatched with your notes, which is fast. But if bad work ships to Done, the whole pipeline failed.

Never rubber-stamp. If the deliverable is genuinely good, pass it. If there are real issues, fail it.

## Failure Reports
Explain every issue with:
- File path and specific location (line number, section heading, or artifact reference)
- What's wrong
- What the fix should be

Be specific. "Quality could be better" is useless. "docs/MODULE_03.md §2.1 — claims 48-hour incident reporting window but statute specifies no timeline" is actionable.`,
  },
  {
    name: 'Learner Agent',
    role: 'learner',
    emoji: '📚',
    soulMd: `# Learner Agent

Observes all task transitions — both passes and failures. Captures lessons learned and writes them to the knowledge base.

## What You Capture
- Failure patterns — what went wrong and why (domain violations, missing references, incomplete specs)
- Fix patterns — what the Builder did to fix failures
- Checklists — recurring items that should be checked every time
- Best practices — patterns that consistently lead to passes
- Domain lessons — which requirements cause confusion, which spec areas are underspecified

## How to Record
POST /api/workspaces/{workspace_id}/knowledge
Body: {
  "task_id": "the task id",
  "category": "failure" | "fix" | "pattern" | "checklist",
  "title": "Brief, searchable title",
  "content": "Detailed description",
  "tags": ["relevant", "tags"],
  "confidence": 0.0-1.0
}

## Guidelines
- Focus on actionable insights that help the team avoid repeating mistakes
- Higher confidence for patterns seen multiple times
- Lower confidence for first-time observations
- Tag entries so they can be found and injected into future dispatches
- For compliance/regulatory products: track which source documents are most often missing or misinterpreted`,
  },
];

// ── Public API ──────────────────────────────────────────────────────

/**
 * Bootstrap core agents for a workspace using the normal getDb() accessor.
 * Safe to call from API routes (NOT from migrations — use bootstrapCoreAgentsRaw).
 */
export function bootstrapCoreAgents(workspaceId: string): void {
  const db = getDb();
  const missionControlUrl = getMissionControlUrl();
  bootstrapCoreAgentsRaw(db, workspaceId, missionControlUrl);
}

/**
 * Bootstrap core agents using a raw db handle.
 * Use this inside migrations to avoid getDb() recursion.
 */
export function bootstrapCoreAgentsRaw(
  db: Database.Database,
  workspaceId: string,
  missionControlUrl: string,
): void {
  // Only bootstrap if workspace has zero agents
  const count = db.prepare(
    'SELECT COUNT(*) as cnt FROM agents WHERE workspace_id = ?'
  ).get(workspaceId) as { cnt: number };

  if (count.cnt > 0) {
    console.log(`[Bootstrap] Workspace ${workspaceId} already has ${count.cnt} agent(s) — skipping`);
    return;
  }

  const userMd = sharedUserMd(missionControlUrl);
  const now = new Date().toISOString();

  const insert = db.prepare(`
    INSERT INTO agents (id, name, role, description, avatar_emoji, status, is_master, workspace_id, soul_md, user_md, agents_md, model, source, session_key_prefix, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, 'standby', 0, ?, ?, ?, ?, ?, 'local', ?, ?, ?)
  `);

  for (const agent of CORE_AGENTS) {
    const id = crypto.randomUUID();
    insert.run(
      id,
      agent.name,
      agent.role,
      `${agent.name} — core team member`,
      agent.emoji,
      workspaceId,
      agent.soulMd,
      userMd,
      SHARED_AGENTS_MD,
      resolveBootstrapModelForRole(agent.role),
      agent.sessionKeyPrefix || null,
      now,
      now,
    );
    console.log(`[Bootstrap] Created ${agent.name} (${agent.role}) for workspace ${workspaceId}`);
  }
}

/**
 * Clone workflow templates from the default workspace into a new workspace.
 */
export function cloneWorkflowTemplates(db: Database.Database, targetWorkspaceId: string): void {
  const templates = db.prepare(
    "SELECT * FROM workflow_templates WHERE workspace_id = 'default'"
  ).all() as { id: string; name: string; description: string; stages: string; fail_targets: string; is_default: number }[];

  if (templates.length === 0) return;

  const now = new Date().toISOString();
  const insert = db.prepare(`
    INSERT INTO workflow_templates (id, workspace_id, name, description, stages, fail_targets, is_default, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);

  for (const tpl of templates) {
    const newId = `${tpl.id}-${targetWorkspaceId}`;
    insert.run(newId, targetWorkspaceId, tpl.name, tpl.description, tpl.stages, tpl.fail_targets, tpl.is_default, now, now);
  }

  console.log(`[Bootstrap] Cloned ${templates.length} workflow template(s) to workspace ${targetWorkspaceId}`);
}
