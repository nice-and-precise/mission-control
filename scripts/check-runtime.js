#!/usr/bin/env node
'use strict';

const EXPECTED_NODE_MAJOR = 20;
const EXPECTED_NODE_RANGE = '20.x';
const SQLITE_PACKAGE_NAME = 'better-sqlite3';

function getNodeMajor(version) {
  const normalized = String(version || '').replace(/^v/, '');
  const [major] = normalized.split('.');
  return Number.parseInt(major, 10);
}

function checkNodeVersion(version = process.versions.node) {
  const major = getNodeMajor(version);
  if (major === EXPECTED_NODE_MAJOR) {
    return { ok: true, actual: version };
  }

  return { ok: false, actual: version };
}

function getErrorText(error) {
  return [error?.code, error?.message, error?.stack].filter(Boolean).join('\n');
}

function isNativeAddonMismatchError(error) {
  return /ERR_DLOPEN_FAILED|NODE_MODULE_VERSION|compiled against a different Node\.js version|was compiled against a different Node\.js version/i.test(
    getErrorText(error),
  );
}

function formatNodeVersionError(actualVersion) {
  return [
    `Mission Control requires Node ${EXPECTED_NODE_RANGE} for local development.`,
    `Current runtime: Node ${actualVersion}`,
    '',
    'Fix:',
    '  1. nvm use',
    '  2. npm ci',
    '',
    'This repo uses a native SQLite addon, so switching Node majors without reinstalling dependencies can leave stale binaries behind.',
  ].join('\n');
}

function formatMissingDependencyError(packageName) {
  return [
    `Mission Control could not load ${packageName}.`,
    '',
    'Fix:',
    '  1. nvm use',
    '  2. npm ci',
  ].join('\n');
}

function formatNativeAddonError(error) {
  const detail = error?.message?.replace(/\s+/g, ' ').trim() || 'Native addon failed to load.';

  return [
    `Mission Control could not load ${SQLITE_PACKAGE_NAME} with the active Node runtime.`,
    detail,
    '',
    'Fix:',
    '  1. nvm use',
    '  2. npm ci',
    '  3. If the addon is still stale, run npm rebuild better-sqlite3',
  ].join('\n');
}

function loadBetterSqlite3(requireFn = require) {
  let database;

  try {
    const Database = requireFn(SQLITE_PACKAGE_NAME);
    database = new Database(':memory:');
    if (typeof database.close === 'function') {
      database.close();
      database = null;
    }
    return { ok: true };
  } catch (error) {
    if (error?.code === 'MODULE_NOT_FOUND' || error?.code === 'ERR_MODULE_NOT_FOUND') {
      throw new Error(formatMissingDependencyError(SQLITE_PACKAGE_NAME));
    }

    if (isNativeAddonMismatchError(error)) {
      throw new Error(formatNativeAddonError(error));
    }

    throw error;
  } finally {
    if (database && typeof database.close === 'function') {
      try {
        database.close();
      } catch {
        // Ignore cleanup failures in the preflight path.
      }
    }
  }
}

function run(options = {}) {
  const {
    argv = process.argv.slice(2),
    version = process.versions.node,
    requireFn = require,
  } = options;
  const installOnly = argv.includes('--install');
  const versionCheck = checkNodeVersion(version);

  if (!versionCheck.ok) {
    throw new Error(formatNodeVersionError(versionCheck.actual));
  }

  if (!installOnly) {
    loadBetterSqlite3(requireFn);
  }

  return { ok: true };
}

if (require.main === module) {
  try {
    run();
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.error(message);
    process.exit(1);
  }
}

module.exports = {
  EXPECTED_NODE_MAJOR,
  EXPECTED_NODE_RANGE,
  checkNodeVersion,
  formatMissingDependencyError,
  formatNativeAddonError,
  formatNodeVersionError,
  getNodeMajor,
  isNativeAddonMismatchError,
  loadBetterSqlite3,
  run,
};
