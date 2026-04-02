export const dynamic = 'force-dynamic';

import { NextResponse } from 'next/server';
import { loadOpenClawModelCatalog, toOpenClawModelsResponse } from '@/lib/openclaw/model-catalog';
import type { OpenClawModelsResponse } from '@/lib/types';

// Model discovery mode: 'remote' | 'local' | 'auto' (default)
// - remote: Query the connected OpenClaw Gateway via RPC (models.list)
// - local:  Read ~/.openclaw/openclaw.json from the local filesystem
// - auto:   Try remote first, fall back to local, then common defaults
const MODEL_DISCOVERY = (process.env.MODEL_DISCOVERY || 'auto').toLowerCase();

/**
 * GET /api/openclaw/models
 *
 * Returns available AI models for agent configuration.
 *
 * Discovery strategy controlled by MODEL_DISCOVERY env var:
 *   - "remote": Query the connected OpenClaw Gateway via models.list RPC
 *   - "local":  Read ~/.openclaw/openclaw.json from the local filesystem
 *   - "auto":   Try remote first, fall back to local, then common defaults
 */
export async function GET() {
  try {
    const catalog = await loadOpenClawModelCatalog(MODEL_DISCOVERY);
    return NextResponse.json<OpenClawModelsResponse>(toOpenClawModelsResponse(catalog));
  } catch (error) {
    console.error('[models] Failed to discover models:', error);
    return NextResponse.json<OpenClawModelsResponse>({
      defaultAgentTarget: 'openclaw',
      defaultProviderModel: undefined,
      agentTargets: [
        { id: 'openclaw', label: 'openclaw' },
        { id: 'openclaw/default', label: 'openclaw/default' },
      ],
      providerModels: [],
      source: 'fallback',
      error: error instanceof Error ? error.message : 'Unknown error',
    }, { status: 500 });
  }
}
