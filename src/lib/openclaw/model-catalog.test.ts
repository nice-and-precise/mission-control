import test, { afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { loadOpenClawModelCatalog } from './model-catalog';

const originalHome = process.env.HOME;
let tempHome: string | null = null;

afterEach(() => {
  if (originalHome === undefined) {
    delete process.env.HOME;
  } else {
    process.env.HOME = originalHome;
  }
  if (tempHome) {
    rmSync(tempHome, { recursive: true, force: true });
    tempHome = null;
  }
});

test('local model catalog keeps runtime discovery separate from Mission Control policy', async () => {
  tempHome = mkdtempSync(join(tmpdir(), 'mc-model-catalog-'));
  process.env.HOME = tempHome;

  const configDir = join(tempHome, '.openclaw');
  mkdirSync(configDir, { recursive: true });
  writeFileSync(join(configDir, 'openclaw.json'), JSON.stringify({
    agents: {
      defaults: {
        model: {
          primary: 'deepinfra/meta-llama',
        },
      },
    },
    models: {
      providers: {
        'openai-codex': {
          models: [{ id: 'gpt-5.4' }],
        },
        deepinfra: {
          models: [{ id: 'meta-llama' }],
        },
      },
    },
  }));

  const catalog = await loadOpenClawModelCatalog('local');
  const modelsById = new Map(catalog.providerModels.map((model) => [model.id, model]));

  assert.equal(catalog.source, 'local');
  assert.equal(catalog.defaultProviderModel, 'deepinfra/meta-llama');

  assert.equal(modelsById.get('openai-codex/gpt-5.4')?.policy_allowed, true);
  assert.equal(modelsById.get('openai-codex/gpt-5.4')?.priced, true);
  assert.equal(modelsById.get('openai-codex/gpt-5.4')?.discovered, true);

  assert.equal(modelsById.get('deepinfra/meta-llama')?.policy_allowed, false);
  assert.equal(modelsById.get('deepinfra/meta-llama')?.discovered, true);
  assert.equal(modelsById.get('deepinfra/meta-llama')?.discovery_source, 'local');

  assert.equal(modelsById.get('opencode-go/glm-5')?.policy_allowed, true);
  assert.equal(modelsById.get('opencode-go/glm-5')?.discovered, false);
  assert.equal(modelsById.get('opencode-go/glm-5')?.discovery_source, 'policy');
});
