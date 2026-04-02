import test, { afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { closeDb, queryOne } from './db';
import { syncGatewayAgentsToCatalog } from './agent-catalog-sync';
import { getOpenClawClient } from './openclaw/client';

afterEach(() => {
  const client = getOpenClawClient() as unknown as {
    isConnected?: () => boolean;
    connect?: () => Promise<void>;
    listAgents?: () => Promise<unknown[]>;
  };
  delete client.isConnected;
  delete client.connect;
  delete client.listAgents;
  getOpenClawClient().disconnect();

  const cleanupTimer = (globalThis as Record<string, unknown>).__openclaw_cache_cleanup_timer__;
  if (cleanupTimer) {
    clearInterval(cleanupTimer as NodeJS.Timeout);
    delete (globalThis as Record<string, unknown>).__openclaw_cache_cleanup_timer__;
  }

  closeDb();
});

function stubGatewayAgents(agents: unknown[]): void {
  const client = getOpenClawClient() as unknown as {
    isConnected: () => boolean;
    connect: () => Promise<void>;
    listAgents: () => Promise<unknown[]>;
  };

  client.isConnected = () => true;
  client.connect = async () => undefined;
  client.listAgents = async () => agents;
}

test('syncGatewayAgentsToCatalog stores scalar gateway models unchanged', async () => {
  const gatewayId = `gateway-${crypto.randomUUID()}`;
  stubGatewayAgents([
    { id: gatewayId, name: 'Reviewer Agent', model: 'openclaw/default' },
  ]);

  const changed = await syncGatewayAgentsToCatalog({ force: true, reason: 'test_scalar_model' });
  assert.equal(changed, 1);

  const row = queryOne<{ model: string | null }>(
    'SELECT model FROM agents WHERE gateway_agent_id = ?',
    [gatewayId],
  );

  assert.equal(row?.model, 'openclaw/default');
});

test('syncGatewayAgentsToCatalog stores only the primary model from routing objects', async () => {
  const gatewayId = `gateway-${crypto.randomUUID()}`;
  stubGatewayAgents([
    {
      id: gatewayId,
      name: 'Builder Agent',
      model: {
        primary: 'openai/gpt-5.4',
        fallbacks: ['openai/gpt-5.4-mini'],
      },
    },
  ]);

  const changed = await syncGatewayAgentsToCatalog({ force: true, reason: 'test_object_model' });
  assert.equal(changed, 1);

  const row = queryOne<{ model: string | null }>(
    'SELECT model FROM agents WHERE gateway_agent_id = ?',
    [gatewayId],
  );

  assert.equal(row?.model, 'openai/gpt-5.4');
});

test('syncGatewayAgentsToCatalog ignores malformed model objects without throwing', async () => {
  const gatewayId = `gateway-${crypto.randomUUID()}`;
  stubGatewayAgents([
    {
      id: gatewayId,
      name: 'Tester Agent',
      model: {
        primary: 42,
        fallbacks: [123, 'openai/gpt-5.4-mini'],
      },
    },
  ]);

  const changed = await syncGatewayAgentsToCatalog({ force: true, reason: 'test_malformed_model' });
  assert.equal(changed, 1);

  const row = queryOne<{ model: string | null }>(
    'SELECT model FROM agents WHERE gateway_agent_id = ?',
    [gatewayId],
  );

  assert.equal(row?.model, null);
});
