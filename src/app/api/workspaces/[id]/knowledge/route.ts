import { NextRequest, NextResponse } from 'next/server';
import { getDb } from '@/lib/db';
import { queryAll } from '@/lib/db';
import type { KnowledgeEntry } from '@/lib/types';

// POST /api/workspaces/[id]/knowledge - Create a knowledge entry
export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id } = await params;
  
  try {
    const body = await request.json();
    const { task_id, category, title, content, tags, confidence } = body;
    
    // Validate required fields
    if (!category || !title || !content) {
      return NextResponse.json(
        { error: 'Missing required fields: category, title, content' },
        { status: 400 }
      );
    }
    
    // Validate category
    const validCategories = ['failure', 'fix', 'pattern', 'checklist'];
    if (!validCategories.includes(category)) {
      return NextResponse.json(
        { error: `Invalid category. Must be one of: ${validCategories.join(', ')}` },
        { status: 400 }
      );
    }
    
    // Validate confidence if provided
    if (confidence !== undefined && (typeof confidence !== 'number' || confidence < 0 || confidence > 1)) {
      return NextResponse.json(
        { error: 'Confidence must be a number between 0 and 1' },
        { status: 400 }
      );
    }
    
    const db = getDb();
    
    // Check workspace exists
    const workspace = db.prepare('SELECT id FROM workspaces WHERE id = ?').get(id);
    if (!workspace) {
      return NextResponse.json({ error: 'Workspace not found' }, { status: 404 });
    }
    
    // Check task exists if task_id provided
    if (task_id) {
      const task = db.prepare('SELECT id FROM tasks WHERE id = ?').get(task_id);
      if (!task) {
        return NextResponse.json({ error: 'Task not found' }, { status: 404 });
      }
    }
    
    // Generate ID if not provided
    const { v4: uuidv4 } = await import('uuid');
    const entryId = uuidv4();
    
    // Insert knowledge entry
    db.prepare(`
      INSERT INTO knowledge_entries (id, workspace_id, task_id, category, title, content, tags, confidence, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, datetime('now'))
    `).run(
      entryId,
      id,
      task_id || null,
      category,
      title,
      content,
      tags ? JSON.stringify(tags) : null,
      confidence || 0.5
    );
    
    // Fetch the created entry
    const entry = db.prepare('SELECT * FROM knowledge_entries WHERE id = ?').get(entryId) as KnowledgeEntry & { tags: string };
    
    return NextResponse.json({
      ...entry,
      tags: entry.tags ? JSON.parse(entry.tags) : [],
    }, { status: 201 });
  } catch (error) {
    console.error('Failed to create knowledge entry:', error);
    return NextResponse.json({ error: 'Failed to create knowledge entry' }, { status: 500 });
  }
}

// GET /api/workspaces/[id]/knowledge - Get knowledge entries for a workspace
export async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id } = await params;
  
  try {
    const db = getDb();
    
    // Check workspace exists
    const workspace = db.prepare('SELECT id FROM workspaces WHERE id = ?').get(id);
    if (!workspace) {
      return NextResponse.json({ error: 'Workspace not found' }, { status: 404 });
    }
    
    // Parse query parameters
    const url = new URL(request.url);
    const category = url.searchParams.get('category');
    const taskId = url.searchParams.get('task_id');
    const limit = parseInt(url.searchParams.get('limit') || '50', 10);
    const minConfidence = parseFloat(url.searchParams.get('min_confidence') || '0');
    
    // Build query
    let query = `SELECT * FROM knowledge_entries WHERE workspace_id = ?`;
    const queryParams: unknown[] = [id];
    
    if (category) {
      query += ` AND category = ?`;
      queryParams.push(category);
    }
    
    if (taskId) {
      query += ` AND task_id = ?`;
      queryParams.push(taskId);
    }
    
    if (minConfidence > 0) {
      query += ` AND confidence >= ?`;
      queryParams.push(minConfidence);
    }
    
    query += ` ORDER BY confidence DESC, created_at DESC LIMIT ?`;
    queryParams.push(Math.min(limit, 100)); // Cap at 100
    
    const entries = queryAll<KnowledgeEntry & { tags: string }>(query, queryParams);
    
    return NextResponse.json(
      entries.map(e => ({
        ...e,
        tags: e.tags ? (typeof e.tags === 'string' ? JSON.parse(e.tags) : e.tags) : [],
      }))
    );
  } catch (error) {
    console.error('Failed to fetch knowledge entries:', error);
    return NextResponse.json({ error: 'Failed to fetch knowledge entries' }, { status: 500 });
  }
}
