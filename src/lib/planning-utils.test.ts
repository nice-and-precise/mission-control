import test, { afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { NextRequest } from 'next/server';
import { closeDb, queryOne, run } from './db';
import {
  extractJSON,
  finalizePlanningCompletion,
  resolvePlanningTranscript,
  setOpenClawMessagesResolverForTests,
  type PlanningMessage,
} from './planning-utils';
import { GET as getPlanningRoute } from '../app/api/tasks/[id]/planning/route';
import { GET as getPlanningPollRoute } from '../app/api/tasks/[id]/planning/poll/route';
import { POST as postPlanningForceCompleteRoute } from '../app/api/tasks/[id]/planning/force-complete/route';

afterEach(() => {
  setOpenClawMessagesResolverForTests(null);
  closeDb();
});

function ensureWorkspace(id: string) {
  run(
    `INSERT OR IGNORE INTO workspaces (id, name, slug, created_at, updated_at)
     VALUES (?, ?, ?, datetime('now'), datetime('now'))`,
    [id, `Workspace ${id}`, id],
  );
}

function seedTask(args: {
  id: string;
  workspaceId: string;
  messages: PlanningMessage[];
  planningComplete?: number;
  sessionKey?: string;
}) {
  ensureWorkspace(args.workspaceId);
  run(
    `INSERT INTO tasks
      (id, title, status, priority, workspace_id, business_id, planning_session_key, planning_messages, planning_complete, created_at, updated_at)
     VALUES (?, 'Planning Task', 'planning', 'normal', ?, 'default', ?, ?, ?, datetime('now'), datetime('now'))`,
    [
      args.id,
      args.workspaceId,
      args.sessionKey || `agent:main:planning:${args.id}`,
      JSON.stringify(args.messages),
      args.planningComplete || 0,
    ],
  );
}

function planningQuestion(question: string): PlanningMessage {
  return {
    role: 'assistant',
    content: `\`\`\`json
{
  "question": "${question}",
  "options": [
    { "id": "A", "label": "Alpha" },
    { "id": "other", "label": "Other" }
  ]
}
\`\`\``,
    timestamp: Date.now(),
  };
}

function planningCompletion(title: string): PlanningMessage {
  return {
    role: 'assistant',
    content: `\`\`\`json
{
  "status": "complete",
  "spec": {
    "title": "${title}",
    "summary": "Recovered summary",
    "deliverables": ["Spec"],
    "success_criteria": ["Works"],
    "constraints": {}
  },
  "agents": [
    {
      "name": "Planner Agent",
      "role": "builder",
      "avatar_emoji": "🛠️",
      "instructions": "Implement the plan"
    }
  ],
  "execution_plan": {
    "approach": "Recover",
    "steps": ["Finalize planning"]
  }
}
\`\`\``,
    timestamp: Date.now(),
  };
}

test('resolvePlanningTranscript returns the latest question when planning is incomplete', () => {
  const messages: PlanningMessage[] = [
    { role: 'user', content: 'Start', timestamp: 1 },
    planningQuestion('First question?'),
    { role: 'user', content: 'Answer', timestamp: 2 },
    planningQuestion('Latest question?'),
  ];

  const resolution = resolvePlanningTranscript(messages);

  assert.equal(resolution.completion, null);
  assert.equal(resolution.currentQuestion?.question, 'Latest question?');
  assert.deepEqual(
    resolution.currentQuestion?.options.map((option) => option.label),
    ['Alpha', 'Other'],
  );
});

test('resolvePlanningTranscript gives completion precedence over earlier questions', () => {
  const messages: PlanningMessage[] = [
    { role: 'user', content: 'Start', timestamp: 1 },
    planningQuestion('Earlier question?'),
    { role: 'user', content: 'Answer', timestamp: 2 },
    planningCompletion('Completed Plan'),
  ];

  const resolution = resolvePlanningTranscript(messages);

  assert.equal(resolution.currentQuestion, null);
  assert.equal(resolution.completion?.status, 'complete');
  assert.equal((resolution.completion?.spec as { title?: string })?.title, 'Completed Plan');
});

test('extractJSON repairs malformed planner constraints objects well enough to recover completion', () => {
  const malformed = `\`\`\`json
{
  "status": "complete",
  "spec": {
    "title": "Malformed Constraints Plan",
    "summary": "Recovered",
    "deliverables": ["Spec"],
    "success_criteria": ["Works"],
    "constraints": {
      "First constraint string.",
      "Second constraint string."
    }
  },
  "agents": []
}
\`\`\``;

  const parsed = extractJSON(malformed) as { spec?: { constraints?: Record<string, string> }; status?: string } | null;

  assert.equal(parsed?.status, 'complete');
  assert.deepEqual(parsed?.spec?.constraints, {
    constraint_1: 'First constraint string.',
    constraint_2: 'Second constraint string.',
  });
});

test('planning GET recovers a stored completion payload and persists final state', async () => {
  const workspaceId = `ws-${crypto.randomUUID()}`;
  const taskId = crypto.randomUUID();
  const messages: PlanningMessage[] = [
    { role: 'user', content: 'Start', timestamp: 1 },
    planningQuestion('What should we build?'),
    { role: 'user', content: 'A validator', timestamp: 2 },
    planningCompletion('Recovered GET Plan'),
  ];

  seedTask({ id: taskId, workspaceId, messages });

  const response = await getPlanningRoute(
    new NextRequest(`http://localhost/api/tasks/${taskId}/planning`),
    { params: Promise.resolve({ id: taskId }) },
  );
  const payload = await response.json() as {
    isComplete: boolean;
    spec: { title: string } | null;
    agents: Array<{ name: string }> | null;
    currentQuestion: unknown;
  };

  assert.equal(response.status, 200);
  assert.equal(payload.isComplete, true);
  assert.equal(payload.currentQuestion, null);
  assert.equal(payload.spec?.title, 'Recovered GET Plan');
  assert.equal(payload.agents?.[0]?.name, 'Planner Agent');

  const stored = queryOne<{ planning_complete: number; planning_spec: string | null }>(
    'SELECT planning_complete, planning_spec FROM tasks WHERE id = ?',
    [taskId],
  );
  assert.equal(stored?.planning_complete, 1);
  assert.match(stored?.planning_spec || '', /Recovered GET Plan/);
});

test('finalizePlanningCompletion keeps planner suggestions in task metadata and cleans up old task-scoped agents', async () => {
  const workspaceId = `ws-${crypto.randomUUID()}`;
  const taskId = crypto.randomUUID();
  const staleAgentId = crypto.randomUUID();

  seedTask({
    id: taskId,
    workspaceId,
    messages: [{ role: 'user', content: 'Start', timestamp: 1 }],
  });

  run(
    `INSERT INTO agents (id, workspace_id, name, role, status, source, scope, task_id, created_at, updated_at)
     VALUES (?, ?, 'Old Planner Agent', 'builder', 'standby', 'local', 'task', ?, datetime('now'), datetime('now'))`,
    [staleAgentId, workspaceId, taskId],
  );

  const completion = {
    status: 'complete' as const,
    spec: {
      title: 'No Agent Rows',
      summary: 'Suggestions only',
      deliverables: ['spec'],
      success_criteria: ['no implicit agents'],
      constraints: {},
    },
    agents: [
      {
        name: 'Data Modeler & Validator',
        role: 'validator',
        avatar_emoji: '🧪',
        instructions: 'Define shared schemas',
      },
    ],
  };

  const result = await finalizePlanningCompletion(taskId, [{ role: 'assistant', content: 'done', timestamp: 2 }], completion);

  assert.equal(result.agents.length, 1);
  assert.equal(result.agents[0]?.name, 'Data Modeler & Validator');
  assert.equal(result.agents[0]?.agent_id, undefined);
  assert.equal(result.agents[0]?.scope, undefined);

  const remainingTaskScopedAgents = queryOne<{ count: number }>(
    `SELECT COUNT(*) as count FROM agents WHERE task_id = ? AND COALESCE(scope, 'workspace') = 'task'`,
    [taskId],
  );
  assert.equal(remainingTaskScopedAgents?.count, 0);

  const stored = queryOne<{ planning_agents: string | null }>(
    'SELECT planning_agents FROM tasks WHERE id = ?',
    [taskId],
  );
  assert.match(stored?.planning_agents || '', /Data Modeler & Validator/);
  assert.doesNotMatch(stored?.planning_agents || '', /agent_id/);
 });

test('planning poll recovers completion even when no new assistant messages arrive', async () => {
  const workspaceId = `ws-${crypto.randomUUID()}`;
  const taskId = crypto.randomUUID();
  const messages: PlanningMessage[] = [
    { role: 'user', content: 'Start', timestamp: 1 },
    planningQuestion('Which field matters most?'),
    { role: 'user', content: 'Email', timestamp: 2 },
    planningCompletion('Recovered Poll Plan'),
  ];

  seedTask({ id: taskId, workspaceId, messages });
  setOpenClawMessagesResolverForTests(async () => ({
    messages: [
      { role: 'assistant', content: messages[1].content },
      { role: 'assistant', content: messages[3].content },
    ],
  }));

  const response = await getPlanningPollRoute(
    new NextRequest(`http://localhost/api/tasks/${taskId}/planning/poll`),
    { params: Promise.resolve({ id: taskId }) },
  );
  const payload = await response.json() as {
    hasUpdates: boolean;
    complete: boolean;
    spec: { title: string };
  };

  assert.equal(response.status, 200);
  assert.equal(payload.hasUpdates, true);
  assert.equal(payload.complete, true);
  assert.equal(payload.spec.title, 'Recovered Poll Plan');
});

test('planning poll merges a completion from OpenClaw transcript and persists it', async () => {
  const workspaceId = `ws-${crypto.randomUUID()}`;
  const taskId = crypto.randomUUID();
  const storedMessages: PlanningMessage[] = [
    { role: 'user', content: 'Start', timestamp: 1 },
    planningQuestion('First question?'),
    { role: 'user', content: 'Go ahead', timestamp: 2 },
  ];
  const completionMessage = planningCompletion('Merged Transcript Plan');

  seedTask({ id: taskId, workspaceId, messages: storedMessages });
  setOpenClawMessagesResolverForTests(async () => ({
    messages: [
      { role: 'assistant', content: storedMessages[1].content },
      { role: 'assistant', content: completionMessage.content },
    ],
  }));

  const response = await getPlanningPollRoute(
    new NextRequest(`http://localhost/api/tasks/${taskId}/planning/poll`),
    { params: Promise.resolve({ id: taskId }) },
  );
  const payload = await response.json() as {
    hasUpdates: boolean;
    complete: boolean;
    spec: { title: string };
    messages: PlanningMessage[];
  };

  assert.equal(response.status, 200);
  assert.equal(payload.hasUpdates, true);
  assert.equal(payload.complete, true);
  assert.equal(payload.spec.title, 'Merged Transcript Plan');
  assert.equal(payload.messages.length, 4);

  const stored = queryOne<{ planning_complete: number; planning_spec: string | null; planning_messages: string }>(
    'SELECT planning_complete, planning_spec, planning_messages FROM tasks WHERE id = ?',
    [taskId],
  );
  assert.equal(stored?.planning_complete, 1);
  assert.match(stored?.planning_spec || '', /Merged Transcript Plan/);
  assert.equal(JSON.parse(stored?.planning_messages || '[]').length, 4);
});

test('force-complete route reuses transcript reconciliation before finalizing', async () => {
  const workspaceId = `ws-${crypto.randomUUID()}`;
  const taskId = crypto.randomUUID();
  const storedMessages: PlanningMessage[] = [
    { role: 'user', content: 'Start', timestamp: 1 },
    planningQuestion('Any constraints?'),
    { role: 'user', content: 'None', timestamp: 2 },
  ];
  const completionMessage = planningCompletion('Recovered Force Complete Plan');

  seedTask({ id: taskId, workspaceId, messages: storedMessages });
  setOpenClawMessagesResolverForTests(async () => ({
    messages: [
      { role: 'assistant', content: storedMessages[1].content },
      { role: 'assistant', content: completionMessage.content },
    ],
  }));

  const response = await postPlanningForceCompleteRoute(
    new NextRequest(`http://localhost/api/tasks/${taskId}/planning/force-complete`, { method: 'POST' }),
    { params: Promise.resolve({ id: taskId }) },
  );
  const payload = await response.json() as { success: boolean; spec?: { title: string } };

  assert.equal(response.status, 200);
  assert.equal(payload.success, true);
  assert.equal(payload.spec?.title, 'Recovered Force Complete Plan');

  const stored = queryOne<{ planning_complete: number; status_reason: string | null }>(
    'SELECT planning_complete, status_reason FROM tasks WHERE id = ?',
    [taskId],
  );
  assert.equal(stored?.planning_complete, 1);
  assert.equal(stored?.status_reason, 'Planning force-completed by user — awaiting approval');
});

test('planning poll surfaces transcript issues instead of silently idling', async () => {
  const workspaceId = `ws-${crypto.randomUUID()}`;
  const taskId = crypto.randomUUID();
  const messages: PlanningMessage[] = [
    { role: 'user', content: 'Start', timestamp: 1 },
    planningQuestion('What should this do?'),
  ];

  seedTask({ id: taskId, workspaceId, messages });
  setOpenClawMessagesResolverForTests(async () => ({
    messages: [{ role: 'assistant', content: messages[1].content }],
    transcriptIssue: {
      code: 'history_omitted',
      message: 'OpenClaw omitted one or more oversized transcript entries.',
    },
  }));

  const response = await getPlanningPollRoute(
    new NextRequest(`http://localhost/api/tasks/${taskId}/planning/poll`),
    { params: Promise.resolve({ id: taskId }) },
  );
  const payload = await response.json() as {
    hasUpdates: boolean;
    complete: boolean;
    transcriptIssue: { code: string; message: string } | null;
  };

  assert.equal(response.status, 200);
  assert.equal(payload.hasUpdates, true);
  assert.equal(payload.complete, false);
  assert.deepEqual(payload.transcriptIssue, {
    code: 'history_omitted',
    message: 'OpenClaw omitted one or more oversized transcript entries.',
  });
});
