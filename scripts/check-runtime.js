#!/usr/bin/env node
'use strict';

const LOCAL_DEFAULT_NODE_MAJOR = 24;
const LOCAL_DEFAULT_NODE_VERSION = '24.13.0';
const SUPPORTED_NODE_RANGE = LOCAL_DEFAULT_NODE_VERSION;
const SQLITE_PACKAGE_NAME = 'better-sqlite3';

function getNodeMajor(version) {
  const normalized = String(version || '').replace(/^v/, '');
  const [major] = normalized.split('.');
  return Number.parseInt(major, 10);
}

function checkNodeVersion(version = process.versions.node) {
  const normalized = String(version || '').replace(/^v/, '');
  const major = getNodeMajor(normalized);
  if (normalized === LOCAL_DEFAULT_NODE_VERSION) {
    return { ok: true, actual: normalized, major };
  }

  return { ok: false, actual: normalized, major };
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
    `Mission Control supports Node ${SUPPORTED_NODE_RANGE}.`,
    `Current runtime: Node ${String(actualVersion || '').replace(/^v/, '')}`,
    '',
    'Fix:',
    `  1. Use Node ${LOCAL_DEFAULT_NODE_VERSION}: nvm use`,
    '  2. Reinstall dependencies after switching runtimes: npm ci',
    '',
    'This repo uses a native SQLite addon, so switching Node versions without reinstalling dependencies can leave stale binaries behind.',
  ].join('\n');
}

function formatMissingDependencyError(packageName) {
  return [
    `Mission Control could not load ${packageName}.`,
    '',
    'Fix:',
    `  1. Use the pinned runtime (Node ${LOCAL_DEFAULT_NODE_VERSION})`,
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
    `  1. Stay on the pinned runtime (Node ${LOCAL_DEFAULT_NODE_VERSION})`,
    '  2. Reinstall dependencies for that runtime: npm ci',
    `  3. If the addon is still stale after a clean install, run npm rebuild ${SQLITE_PACKAGE_NAME}`,
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
  LOCAL_DEFAULT_NODE_MAJOR,
  LOCAL_DEFAULT_NODE_VERSION,
  SUPPORTED_NODE_RANGE,
  checkNodeVersion,
  formatMissingDependencyError,
  formatNativeAddonError,
  formatNodeVersionError,
  getNodeMajor,
  isNativeAddonMismatchError,
  loadBetterSqlite3,
  run,
};
