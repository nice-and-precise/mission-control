import test from 'node:test';
import assert from 'node:assert/strict';

import runtimeGuard from './check-runtime.js';

test('checkNodeVersion accepts the pinned Node version', () => {
  const result = runtimeGuard.checkNodeVersion('24.13.0');

  assert.equal(result.ok, true);
});

test('checkNodeVersion rejects unsupported runtimes with actionable guidance', () => {
  const result = runtimeGuard.checkNodeVersion('24.12.0');

  assert.equal(result.ok, false);
  assert.match(runtimeGuard.formatNodeVersionError(result.actual), /nvm use/);
  assert.match(runtimeGuard.formatNodeVersionError(result.actual), /npm ci/);
  assert.match(runtimeGuard.formatNodeVersionError(result.actual), /24\.13\.0/);
});

test('isNativeAddonMismatchError detects stale native addon failures', () => {
  const error = new Error(
    "The module '/tmp/better_sqlite3.node' was compiled against a different Node.js version using NODE_MODULE_VERSION 137. This version of Node.js requires NODE_MODULE_VERSION 141.",
  ) as Error & { code?: string };
  error.code = 'ERR_DLOPEN_FAILED';

  assert.equal(runtimeGuard.isNativeAddonMismatchError(error), true);
  assert.match(runtimeGuard.formatNativeAddonError(error), /npm ci/);
  assert.match(runtimeGuard.formatNativeAddonError(error), /npm rebuild better-sqlite3/);
});

test('run skips native addon loading during install guard', () => {
  let requireCalls = 0;

  runtimeGuard.run({
    argv: ['--install'],
    version: '24.13.0',
    requireFn: () => {
      requireCalls += 1;
      throw new Error('install guard should not load native modules');
    },
  });

  assert.equal(requireCalls, 0);
});

test('loadBetterSqlite3 forces the native binding to open and close once', () => {
  let closeCalls = 0;

  function FakeDatabase(filename: string) {
    assert.equal(filename, ':memory:');

    return {
      close() {
        closeCalls += 1;
      },
    };
  }

  runtimeGuard.loadBetterSqlite3(() => FakeDatabase);

  assert.equal(closeCalls, 1);
});

test('run rewrites native addon mismatch into a clear remediation message', () => {
  const error = new Error(
    "The module '/tmp/better_sqlite3.node' was compiled against a different Node.js version using NODE_MODULE_VERSION 137. This version of Node.js requires NODE_MODULE_VERSION 141.",
  ) as Error & { code?: string };
  error.code = 'ERR_DLOPEN_FAILED';

  assert.throws(
    () =>
      runtimeGuard.run({
        version: '24.13.0',
        requireFn: () => {
          throw error;
        },
      }),
    /npm ci/,
  );
});
