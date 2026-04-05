import { NextRequest, NextResponse } from 'next/server';
import { getDb } from '@/lib/db';

// GET /api/workspaces/[id]/workflows - List workflow templates for a workspace
export async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id } = await params;

  try {
    const db = getDb();

    // Resolve workspace by id or slug
    const workspace = db.prepare(
      'SELECT id FROM workspaces WHERE id = ? OR slug = ?'
    ).get(id, id) as { id: string } | undefined;

    if (!workspace) {
      return NextResponse.json({ error: 'Workspace not found' }, { status: 404 });
    }

    const rows = db.prepare(
      'SELECT * FROM workflow_templates WHERE workspace_id = ? ORDER BY is_default DESC, created_at ASC'
    ).all(workspace.id) as Record<string, unknown>[];

    const templates = rows.map((row) => ({
      ...row,
      stages: typeof row.stages === 'string' ? JSON.parse(row.stages) : row.stages,
      fail_targets: typeof row.fail_targets === 'string' ? JSON.parse(row.fail_targets) : row.fail_targets,
    }));

    return NextResponse.json(templates);
  } catch (error) {
    console.error('Failed to fetch workflow templates:', error);
    return NextResponse.json({ error: 'Failed to fetch workflow templates' }, { status: 500 });
  }
}
