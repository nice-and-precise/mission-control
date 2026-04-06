import test from 'node:test';
import assert from 'node:assert/strict';
import { resolvePolicyAccountingModelFromCatalog } from './model-catalog';

test('resolvePolicyAccountingModelFromCatalog keeps provider overrides unchanged', () => {
  const resolved = resolvePolicyAccountingModelFromCatalog('opencode-go/kimi-k2.5', {
    defaultProviderModel: 'opencode-go/glm-5',
    providerModels: [],
  });

  assert.equal(resolved, 'opencode-go/kimi-k2.5');
});

test('resolvePolicyAccountingModelFromCatalog maps openclaw to the default priced provider model', () => {
  const resolved = resolvePolicyAccountingModelFromCatalog('openclaw', {
    defaultProviderModel: 'opencode-go/kimi-k2.5',
    providerModels: [],
  });

  assert.equal(resolved, 'opencode-go/kimi-k2.5');
});

test('resolvePolicyAccountingModelFromCatalog falls back to another priced allowed provider model', () => {
  const resolved = resolvePolicyAccountingModelFromCatalog('openclaw/default', {
    defaultProviderModel: 'google/gemini-2.5-flash',
    providerModels: [
      {
        id: 'google/gemini-2.5-flash',
        label: 'google/gemini-2.5-flash',
        policy_allowed: false,
        priced: false,
        provider_family: 'google',
        discovery_source: 'local',
        discovered: true,
      },
      {
        id: 'opencode-go/glm-5',
        label: 'opencode-go/glm-5',
        policy_allowed: true,
        priced: true,
        provider_family: 'opencode-go',
        discovery_source: 'local',
        discovered: true,
      },
    ],
  });

  assert.equal(resolved, 'opencode-go/glm-5');
});

test('resolvePolicyAccountingModelFromCatalog throws when no priced allowed provider model exists', () => {
  assert.throws(
    () => resolvePolicyAccountingModelFromCatalog('openclaw', {
      defaultProviderModel: 'google/gemini-2.5-flash',
      providerModels: [
        {
          id: 'google/gemini-2.5-flash',
          label: 'google/gemini-2.5-flash',
          policy_allowed: false,
          priced: false,
          provider_family: 'google',
          discovery_source: 'local',
          discovered: true,
        },
      ],
    }),
    /could not resolve a priced provider model/i,
  );
});
