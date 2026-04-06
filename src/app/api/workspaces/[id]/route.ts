import { NextRequest, NextResponse } from 'next/server';
import { getDb } from '@/lib/db';
import { reconcileBudgetStateForScope } from '@/lib/costs/budget-policy';
import { validateWorkspaceOverrideModel } from '@/lib/openclaw/workspace-model-overrides';

// GET /api/workspaces/[id] - Get a single workspace
export async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id } = await params;
  
  try {
    const db = getDb();
    
    // Try to find by ID or slug
    const workspace = db.prepare(
      'SELECT * FROM workspaces WHERE id = ? OR slug = ?'
    ).get(id, id);
    
    if (!workspace) {
      return NextResponse.json({ error: 'Workspace not found' }, { status: 404 });
    }
    
    return NextResponse.json(workspace);
  } catch (error) {
    console.error('Failed to fetch workspace:', error);
    return NextResponse.json({ error: 'Failed to fetch workspace' }, { status: 500 });
  }
}

// PATCH /api/workspaces/[id] - Update a workspace
export async function PATCH(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id } = await params;
  
  try {
    const body = await request.json();
    const { name, description, icon } = body;
    const dailyCap = body.cost_cap_daily;
    const monthlyCap = body.cost_cap_monthly;
    const autopilotModelOverride = body.autopilot_model_override;
    const planningModelOverride = body.planning_model_override;
    
    const db = getDb();
    
    // Check workspace exists
    const existing = db.prepare('SELECT * FROM workspaces WHERE id = ?').get(id);
    if (!existing) {
      return NextResponse.json({ error: 'Workspace not found' }, { status: 404 });
    }
    if (dailyCap !== undefined && dailyCap !== null && (typeof dailyCap !== 'number' || Number.isNaN(dailyCap) || dailyCap < 0)) {
      return NextResponse.json({ error: 'cost_cap_daily must be a non-negative number' }, { status: 400 });
    }
    if (monthlyCap !== undefined && monthlyCap !== null && (typeof monthlyCap !== 'number' || Number.isNaN(monthlyCap) || monthlyCap < 0)) {
      return NextResponse.json({ error: 'cost_cap_monthly must be a non-negative number' }, { status: 400 });
    }

    let validatedAutopilotModelOverride: string | null | undefined;
    let validatedPlanningModelOverride: string | null | undefined;
    try {
      if (autopilotModelOverride !== undefined) {
        validatedAutopilotModelOverride = await validateWorkspaceOverrideModel(autopilotModelOverride);
      }
      if (planningModelOverride !== undefined) {
        validatedPlanningModelOverride = await validateWorkspaceOverrideModel(planningModelOverride);
      }
    } catch (validationError) {
      const message = validationError instanceof Error
        ? validationError.message
        : 'Invalid workspace model override value';
      return NextResponse.json({ error: message }, { status: 400 });
    }
    
    // Build update query dynamically
    const updates: string[] = [];
    const values: unknown[] = [];
    
    if (name !== undefined) {
      updates.push('name = ?');
      values.push(name);
    }
    if (description !== undefined) {
      updates.push('description = ?');
      values.push(description);
    }
    if (icon !== undefined) {
      updates.push('icon = ?');
      values.push(icon);
    }
    if (dailyCap !== undefined) {
      updates.push('cost_cap_daily = ?');
      values.push(dailyCap);
    }
    if (monthlyCap !== undefined) {
      updates.push('cost_cap_monthly = ?');
      values.push(monthlyCap);
    }
    if (validatedAutopilotModelOverride !== undefined) {
      updates.push('autopilot_model_override = ?');
      values.push(validatedAutopilotModelOverride);
    }
    if (validatedPlanningModelOverride !== undefined) {
      updates.push('planning_model_override = ?');
      values.push(validatedPlanningModelOverride);
    }
    
    if (updates.length === 0) {
      return NextResponse.json({ error: 'No fields to update' }, { status: 400 });
    }
    
    updates.push("updated_at = datetime('now')");
    values.push(id);
    
    db.prepare(`
      UPDATE workspaces SET ${updates.join(', ')} WHERE id = ?
    `).run(...values);

    reconcileBudgetStateForScope(id);
    
    const workspace = db.prepare('SELECT * FROM workspaces WHERE id = ?').get(id);
    return NextResponse.json(workspace);
  } catch (error) {
    console.error('Failed to update workspace:', error);
    return NextResponse.json({ error: 'Failed to update workspace' }, { status: 500 });
  }
}

// DELETE /api/workspaces/[id] - Delete a workspace
export async function DELETE(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id } = await params;
  
  try {
    const db = getDb();
    
    // Don't allow deleting the default workspace
    if (id === 'default') {
      return NextResponse.json({ error: 'Cannot delete the default workspace' }, { status: 400 });
    }
    
    // Check workspace exists
    const existing = db.prepare('SELECT * FROM workspaces WHERE id = ?').get(id);
    if (!existing) {
      return NextResponse.json({ error: 'Workspace not found' }, { status: 404 });
    }
    
    // Check if workspace has tasks or agents
    const taskCount = db.prepare(
      'SELECT COUNT(*) as count FROM tasks WHERE workspace_id = ?'
    ).get(id) as { count: number };
    
    const agentCount = db.prepare(
      `SELECT COUNT(*) as count
       FROM agents
       WHERE workspace_id = ?
         AND COALESCE(scope, 'workspace') = 'workspace'`
    ).get(id) as { count: number };
    
    if (taskCount.count > 0 || agentCount.count > 0) {
      return NextResponse.json({ 
        error: 'Cannot delete workspace with existing tasks or agents',
        taskCount: taskCount.count,
        agentCount: agentCount.count
      }, { status: 400 });
    }
    
    db.prepare('DELETE FROM workspaces WHERE id = ?').run(id);
    
    return NextResponse.json({ success: true });
  } catch (error) {
    console.error('Failed to delete workspace:', error);
    return NextResponse.json({ error: 'Failed to delete workspace' }, { status: 500 });
  }
}
