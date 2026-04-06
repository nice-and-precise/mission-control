import { NextRequest, NextResponse } from 'next/server';
import { v4 as uuidv4 } from 'uuid';
import { queryAll, queryOne, run } from '@/lib/db';
import { canonicalMissionControlModelId } from '@/lib/openclaw/model-policy';
import { isOpenClawAgentTarget, validateProviderModelOverride } from '@/lib/openclaw/model-catalog';
import type { Agent, CreateAgentRequest } from '@/lib/types';

async function validateAgentModelOverride(value: unknown): Promise<string | null> {
  if (value === null || value === undefined) {
    return null;
  }

  if (typeof value !== 'string') {
    throw new Error('Agent model must be a string or null.');
  }

  const trimmed = value.trim();
  if (!trimmed) {
    return null;
  }

  await validateProviderModelOverride(trimmed);
  return isOpenClawAgentTarget(trimmed) ? trimmed : canonicalMissionControlModelId(trimmed);
}

// GET /api/agents - List all agents
export async function GET(request: NextRequest) {
  try {
    const workspaceId = request.nextUrl.searchParams.get('workspace_id');
    const includeTaskAgents = request.nextUrl.searchParams.get('include_task_agents') === 'true';
    const taskId = request.nextUrl.searchParams.get('task_id');
    
    let agents: Agent[];
    if (workspaceId) {
      if (includeTaskAgents && taskId) {
        agents = queryAll<Agent>(`
          SELECT *
          FROM agents
          WHERE workspace_id = ?
            AND (COALESCE(scope, 'workspace') = 'workspace' OR (COALESCE(scope, 'workspace') = 'task' AND task_id = ?))
          ORDER BY COALESCE(scope, 'workspace') ASC, is_master DESC, name ASC
        `, [workspaceId, taskId]);
      } else {
        agents = queryAll<Agent>(`
          SELECT *
          FROM agents
          WHERE workspace_id = ?
            AND COALESCE(scope, 'workspace') = 'workspace'
          ORDER BY is_master DESC, name ASC
        `, [workspaceId]);
      }
    } else {
      agents = queryAll<Agent>(`
        SELECT *
        FROM agents
        WHERE COALESCE(scope, 'workspace') = 'workspace'
        ORDER BY is_master DESC, name ASC
      `);
    }
    return NextResponse.json(agents);
  } catch (error) {
    console.error('Failed to fetch agents:', error);
    return NextResponse.json({ error: 'Failed to fetch agents' }, { status: 500 });
  }
}

// POST /api/agents - Create a new agent
export async function POST(request: NextRequest) {
  try {
    const body: CreateAgentRequest = await request.json();

    if (!body.name || !body.role) {
      return NextResponse.json({ error: 'Name and role are required' }, { status: 400 });
    }

    let validatedModel: string | null;
    try {
      validatedModel = await validateAgentModelOverride(body.model);
    } catch (validationError) {
      const message = validationError instanceof Error
        ? validationError.message
        : 'Invalid agent model override value';
      return NextResponse.json({ error: message }, { status: 400 });
    }

    const id = uuidv4();
    const now = new Date().toISOString();

    run(
      `INSERT INTO agents (id, name, role, description, avatar_emoji, is_master, workspace_id, soul_md, user_md, agents_md, model, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        id,
        body.name,
        body.role,
        body.description || null,
        body.avatar_emoji || '🤖',
        body.is_master ? 1 : 0,
        (body as { workspace_id?: string }).workspace_id || 'default',
        body.soul_md || null,
        body.user_md || null,
        body.agents_md || null,
        validatedModel,
        now,
        now,
      ]
    );

    // Log event
    run(
      `INSERT INTO events (id, type, agent_id, message, created_at)
       VALUES (?, ?, ?, ?, ?)`,
      [uuidv4(), 'agent_joined', id, `${body.name} joined the team`, now]
    );

    const agent = queryOne<Agent>('SELECT * FROM agents WHERE id = ?', [id]);
    return NextResponse.json(agent, { status: 201 });
  } catch (error) {
    console.error('Failed to create agent:', error);
    return NextResponse.json({ error: 'Failed to create agent' }, { status: 500 });
  }
}
