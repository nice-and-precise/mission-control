import { NextRequest, NextResponse } from 'next/server';
import { queryAll, queryOne } from '@/lib/db';
import type { WorkflowTemplate, WorkflowStage } from '@/lib/types';

export const dynamic = 'force-dynamic';

interface WorkflowTemplateRow {
  id: string;
  workspace_id: string;
  name: string;
  description: string | null;
  stages: string;
  fail_targets: string;
  is_default: number;
  created_at: string;
  updated_at: string;
}

function parseTemplate(row: WorkflowTemplateRow): WorkflowTemplate {
  return {
    id: row.id,
    workspace_id: row.workspace_id,
    name: row.name,
    description: row.description || undefined,
    stages: JSON.parse(row.stages || '[]') as WorkflowStage[],
    fail_targets: JSON.parse(row.fail_targets || '{}') as Record<string, string>,
    is_default: Boolean(row.is_default),
    created_at: row.created_at,
    updated_at: row.updated_at,
  };
}

// GET /api/workspaces/[id]/workflows - List workflow templates for a workspace
export async function GET(
  _request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  try {
    const { id } = await params;
    const workspace = queryOne<{ id: string }>(
      'SELECT id FROM workspaces WHERE id = ? OR slug = ?',
      [id, id]
    );

    if (!workspace) {
      return NextResponse.json({ error: 'Workspace not found' }, { status: 404 });
    }

    let rows = queryAll<WorkflowTemplateRow>(
      `SELECT *
       FROM workflow_templates
       WHERE workspace_id = ?
       ORDER BY is_default DESC, name ASC`,
      [workspace.id]
    );

    if (rows.length === 0) {
      rows = queryAll<WorkflowTemplateRow>(
        `SELECT *
         FROM workflow_templates
         WHERE workspace_id = 'default'
         ORDER BY is_default DESC, name ASC`
      );
    }

    return NextResponse.json(rows.map(parseTemplate));
  } catch (error) {
    console.error('Failed to fetch workflows:', error);
    return NextResponse.json({ error: 'Failed to fetch workflows' }, { status: 500 });
  }
}
