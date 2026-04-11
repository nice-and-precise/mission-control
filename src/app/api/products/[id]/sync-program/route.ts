import { NextRequest, NextResponse } from 'next/server';
import { queryOne, run } from '@/lib/db';
import type { Product } from '@/lib/types';

export async function POST(
  req: NextRequest,
  { params }: { params: { id: string } }
) {
  try {
    const product = queryOne<Product>('SELECT * FROM products WHERE id = ?', [params.id]);
    if (!product) {
      return NextResponse.json({ error: 'Product not found' }, { status: 404 });
    }

    if (!product.canonical_program_path) {
      return NextResponse.json({ error: 'Canonical program path is not set for this product.' }, { status: 400 });
    }

    if (!product.repo_url) {
      return NextResponse.json({ error: 'Repository URL is not set for this product.' }, { status: 400 });
    }

    // Convert github.com URL to raw.githubusercontent.com
    // e.g. https://github.com/owner/repo.git -> https://raw.githubusercontent.com/owner/repo
    let rawBase = product.repo_url.replace(/\/+$/, '').replace(/\.git$/, '');
    
    if (rawBase.includes('github.com')) {
      rawBase = rawBase.replace('github.com', 'raw.githubusercontent.com');
    } else {
      return NextResponse.json({ error: 'Only GitHub URLs are currently supported for sync.' }, { status: 400 });
    }

    const branch = product.default_branch || 'main';
    const filePath = product.canonical_program_path.startsWith('/') 
      ? product.canonical_program_path.slice(1) 
      : product.canonical_program_path;

    const fetchUrl = `${rawBase}/${branch}/${filePath}`;

    const res = await fetch(fetchUrl);
    if (!res.ok) {
      if (res.status === 404) {
        return NextResponse.json({ error: `File not found at ${fetchUrl}. Check path and branch.` }, { status: 404 });
      }
      return NextResponse.json({ error: `Failed to fetch from GitHub: ${res.statusText}` }, { status: res.status });
    }

    const content = await res.text();

    run(
      `UPDATE products SET product_program = ?, updated_at = datetime('now') WHERE id = ?`,
      [content, product.id]
    );

    const updated = queryOne<Product>('SELECT * FROM products WHERE id = ?', [product.id]);
    return NextResponse.json(updated);
    
  } catch (err) {
    console.error('[SyncProgram]', err);
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 });
  }
}
