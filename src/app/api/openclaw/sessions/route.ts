import { NextRequest, NextResponse } from 'next/server';
import { getOpenClawClient } from '@/lib/openclaw/client';
import { queryAll } from '@/lib/db';
import type { OpenClawSession } from '@/lib/types';

// GET /api/openclaw/sessions - List OpenClaw sessions
export async function GET(request: NextRequest) {
  try {
    const { searchParams } = new URL(request.url);
    const sessionType = searchParams.get('session_type');
    const status = searchParams.get('status');
    const taskId = searchParams.get('task_id');

    // If filtering by database fields, query the database
    if (sessionType || status || taskId) {
      let sql = `SELECT
        s.*, 
        a.name as agent_name,
        a.avatar_emoji as agent_avatar_emoji
      FROM openclaw_sessions s
      LEFT JOIN agents a ON a.id = s.agent_id
      WHERE 1=1`;
      const params: unknown[] = [];

      if (sessionType) {
        sql += ' AND s.session_type = ?';
        params.push(sessionType);
      }

      if (status) {
        sql += ' AND s.status = ?';
        params.push(status);
      }

      if (taskId) {
        sql += ' AND s.task_id = ?';
        params.push(taskId);
      }

      sql += ` ORDER BY
        CASE WHEN s.status = 'active' THEN 0 ELSE 1 END,
        COALESCE(s.updated_at, s.created_at) DESC,
        s.created_at DESC`;

      const sessions = queryAll<OpenClawSession & { agent_name?: string; agent_avatar_emoji?: string }>(sql, params);
      return NextResponse.json(sessions);
    }

    // Otherwise, query OpenClaw Gateway for live sessions
    const client = getOpenClawClient();

    if (!client.isConnected()) {
      try {
        await client.connect();
      } catch {
        return NextResponse.json(
          { error: 'Failed to connect to OpenClaw Gateway' },
          { status: 503 }
        );
      }
    }

    const sessions = await client.listSessions();
    return NextResponse.json({ sessions });
  } catch (error) {
    console.error('Failed to list OpenClaw sessions:', error);
    return NextResponse.json(
      { error: 'Internal server error' },
      { status: 500 }
    );
  }
}

// POST /api/openclaw/sessions - Create a new OpenClaw session
export async function POST(request: Request) {
  try {
    const body = await request.json();
    const { channel, peer } = body;

    if (!channel) {
      return NextResponse.json(
        { error: 'channel is required' },
        { status: 400 }
      );
    }

    const client = getOpenClawClient();

    if (!client.isConnected()) {
      try {
        await client.connect();
      } catch {
        return NextResponse.json(
          { error: 'Failed to connect to OpenClaw Gateway' },
          { status: 503 }
        );
      }
    }

    const session = await client.createSession(channel, peer);
    return NextResponse.json({ session }, { status: 201 });
  } catch (error) {
    console.error('Failed to create OpenClaw session:', error);
    return NextResponse.json(
      { error: 'Internal server error' },
      { status: 500 }
    );
  }
}
