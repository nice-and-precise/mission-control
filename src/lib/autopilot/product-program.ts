import { createHash } from 'crypto';
import fs from 'fs/promises';
import path from 'path';
import type { Product } from '@/lib/types';

type ProductSettingsRecord = Record<string, unknown>;

export function hashProductProgram(text: string): string {
  return createHash('sha256').update(text).digest('hex');
}

export function parseProductSettings(settings?: string | null): ProductSettingsRecord {
  if (!settings) return {};
  try {
    const parsed = JSON.parse(settings) as ProductSettingsRecord;
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : {};
  } catch {
    return {};
  }
}

function readString(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() ? value.trim() : undefined;
}

export function stringifyProductSettings(settings: ProductSettingsRecord): string | null {
  const entries = Object.entries(settings).filter(([, value]) => value != null && value !== '');
  return entries.length > 0 ? JSON.stringify(Object.fromEntries(entries)) : null;
}

export function resolveCanonicalProgramPath(product: Pick<Product, 'canonical_program_path' | 'settings'>): string | undefined {
  return readString(product.canonical_program_path)
    || readString(parseProductSettings(product.settings).canonical_program_path);
}

export function resolveRepoCheckoutPath(product: Pick<Product, 'settings'>): string | undefined {
  return readString(parseProductSettings(product.settings).repo_checkout_path);
}

export function mergeCanonicalProgramPathIntoSettings(
  existingSettings: string | null | undefined,
  canonicalProgramPath: string | null | undefined,
): string | null {
  const settings = parseProductSettings(existingSettings);
  const normalizedPath = readString(canonicalProgramPath);
  if (normalizedPath) {
    settings.canonical_program_path = normalizedPath;
  } else {
    delete settings.canonical_program_path;
  }
  return stringifyProductSettings(settings);
}

export function normalizeProduct<T extends Product | undefined>(product: T): T {
  if (!product) return product;

  const canonicalProgramPath = resolveCanonicalProgramPath(product);
  const normalized = {
    ...product,
    canonical_program_path: canonicalProgramPath,
    current_product_program_sha: hashProductProgram(product.product_program || ''),
  };

  return normalized as T;
}

export async function readCanonicalProductProgram(product: Pick<Product, 'canonical_program_path' | 'settings' | 'repo_url' | 'default_branch'>): Promise<{
  content: string;
  source: 'filesystem' | 'github';
  resolvedPath: string;
}> {
  const canonicalPath = resolveCanonicalProgramPath(product);
  if (!canonicalPath) {
    throw new Error('Canonical program path is not set for this product.');
  }

  const repoCheckoutPath = resolveRepoCheckoutPath(product);

  const candidatePaths: string[] = [];
  if (path.isAbsolute(canonicalPath)) {
    candidatePaths.push(canonicalPath);
  }
  if (repoCheckoutPath) {
    candidatePaths.push(path.join(repoCheckoutPath, canonicalPath));
  }

  for (const candidate of candidatePaths) {
    try {
      const content = await fs.readFile(candidate, 'utf8');
      return { content, source: 'filesystem', resolvedPath: candidate };
    } catch {
      // Try the next candidate before falling back to GitHub.
    }
  }

  if (!product.repo_url) {
    throw new Error('Repository URL is not set for this product.');
  }

  let rawBase = product.repo_url.replace(/\/+$/, '').replace(/\.git$/, '');
  if (!rawBase.includes('github.com')) {
    throw new Error('Only GitHub URLs are currently supported for sync when no local checkout path is available.');
  }
  rawBase = rawBase.replace('github.com', 'raw.githubusercontent.com');
  const branch = product.default_branch || 'main';
  const filePath = canonicalPath.startsWith('/') ? canonicalPath.slice(1) : canonicalPath;
  const fetchUrl = `${rawBase}/${branch}/${filePath}`;

  const response = await fetch(fetchUrl);
  if (!response.ok) {
    if (response.status === 404) {
      throw new Error(`File not found at ${fetchUrl}. Check path and branch.`);
    }
    throw new Error(`Failed to fetch from GitHub: ${response.status} ${response.statusText}`);
  }

  return {
    content: await response.text(),
    source: 'github',
    resolvedPath: fetchUrl,
  };
}
