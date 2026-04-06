'use client';

import { useState, useEffect } from 'react';
import { Plus, Rocket, ArrowRight, MoreVertical, Trash2 } from 'lucide-react';
import Link from 'next/link';
import { HealthBadge } from '@/components/autopilot/HealthBadge';
import type { Product } from '@/lib/types';

export default function AutopilotPage() {
  const [products, setProducts] = useState<Product[]>([]);
  const [loading, setLoading] = useState(true);
  const [pendingCounts, setPendingCounts] = useState<Record<string, number>>({});
  const [healthScores, setHealthScores] = useState<Record<string, number>>({});
  const [menuOpenId, setMenuOpenId] = useState<string | null>(null);
  const [deletingId, setDeletingId] = useState<string | null>(null);

  useEffect(() => {
    (async () => {
      try {
        const res = await fetch('/api/products');
        if (res.ok) {
          const prods: Product[] = await res.json();
          setProducts(prods);

          // Fetch pending idea counts in parallel
          const counts: Record<string, number> = {};
          await Promise.all(prods.map(async (p) => {
            try {
              const r = await fetch(`/api/products/${p.id}/ideas/pending`);
              if (r.ok) {
                const ideas = await r.json();
                if (Array.isArray(ideas) && ideas.length > 0) counts[p.id] = ideas.length;
              }
            } catch { /* skip */ }
          }));
          setPendingCounts(counts);

          // Fetch health scores
          try {
            const healthRes = await fetch('/api/products/health-scores');
            if (healthRes.ok) {
              const scores = await healthRes.json();
              setHealthScores(scores);
            }
          } catch { /* skip */ }
        }
      } catch (error) {
        console.error('Failed to load products:', error);
      } finally {
        setLoading(false);
      }
    })();
  }, []);

  async function handleDeleteProduct(product: Product) {
    const confirmDelete = window.confirm(
      `Delete ${product.name}? This permanently removes the product, its Autopilot data, and any product-owned build tasks.`
    );
    if (!confirmDelete) return;

    setDeletingId(product.id);
    setMenuOpenId(null);
    try {
      const res = await fetch(`/api/products/${product.id}`, { method: 'DELETE' });
      if (!res.ok) {
        const data = await res.json().catch(() => ({ error: 'Failed to delete product' }));
        throw new Error(data.error || 'Failed to delete product');
      }

      setProducts(prev => prev.filter(item => item.id !== product.id));
      setPendingCounts(prev => {
        const next = { ...prev };
        delete next[product.id];
        return next;
      });
      setHealthScores(prev => {
        const next = { ...prev };
        delete next[product.id];
        return next;
      });
    } catch (error) {
      window.alert(error instanceof Error ? error.message : 'Failed to delete product');
    } finally {
      setDeletingId(null);
    }
  }

  // Listen for SSE health score updates
  useEffect(() => {
    function handleHealthUpdate(e: Event) {
      const { productId, score } = (e as CustomEvent).detail;
      setHealthScores(prev => ({ ...prev, [productId]: score }));
    }
    window.addEventListener('health-score-updated', handleHealthUpdate);
    return () => window.removeEventListener('health-score-updated', handleHealthUpdate);
  }, []);

  if (loading) {
    return (
      <div className="min-h-screen bg-mc-bg flex items-center justify-center">
        <div className="text-center">
          <div className="text-4xl mb-4 animate-pulse">🚀</div>
          <p className="text-mc-text-secondary">Loading autopilot...</p>
        </div>
      </div>
    );
  }

  return (
    <div className="min-h-screen bg-mc-bg">
      <header className="border-b border-mc-border bg-mc-bg-secondary">
        <div className="max-w-7xl mx-auto px-4 sm:px-6 py-4">
          <div className="flex items-center justify-between">
            <div className="flex items-center gap-3">
              <Rocket className="w-6 h-6 text-mc-accent-cyan" />
              <h1 className="text-xl font-bold text-mc-text">Product Autopilot</h1>
            </div>
            <div className="flex items-center gap-2">
              <Link href="/" className="min-h-11 px-4 rounded-lg border border-mc-border bg-mc-bg text-mc-text-secondary hover:text-mc-text hover:bg-mc-bg-tertiary flex items-center gap-2 text-sm">
                Workspaces
              </Link>
              <Link
                href="/autopilot/new"
                className="min-h-11 px-4 rounded-lg bg-mc-accent text-white hover:bg-mc-accent/90 flex items-center gap-2 text-sm font-medium"
              >
                <Plus className="w-4 h-4" />
                New Product
              </Link>
            </div>
          </div>
        </div>
      </header>

      <main className="max-w-7xl mx-auto px-4 sm:px-6 py-8">
        {products.length === 0 ? (
          <div className="text-center py-20">
            <div className="text-6xl mb-6">🚀</div>
            <h2 className="text-2xl font-bold text-mc-text mb-3">No products yet</h2>
            <p className="text-mc-text-secondary mb-8 max-w-md mx-auto">
              Create your first product to start the autonomous development loop.
              Agents will research, ideate, and you swipe to decide what gets built.
            </p>
            <Link
              href="/autopilot/new"
              className="inline-flex items-center gap-2 px-6 py-3 bg-mc-accent text-white rounded-lg hover:bg-mc-accent/90 font-medium"
            >
              <Plus className="w-5 h-5" />
              Create First Product
            </Link>
          </div>
        ) : (
          <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4">
            {products.map(product => (
              <div
                key={product.id}
                className="group relative rounded-xl border border-mc-border bg-mc-bg-secondary p-5 transition-colors hover:border-mc-accent/50"
              >
                <button
                  type="button"
                  onClick={() => setMenuOpenId(current => current === product.id ? null : product.id)}
                  className="absolute right-3 top-3 rounded-md p-1.5 text-mc-text-secondary hover:bg-mc-bg-tertiary hover:text-mc-text"
                  title="Product actions"
                >
                  <MoreVertical className="h-4 w-4" />
                </button>
                {menuOpenId === product.id && (
                  <div className="absolute right-3 top-12 z-20 w-48 rounded-lg border border-mc-border bg-mc-bg shadow-lg">
                    <button
                      type="button"
                      onClick={() => handleDeleteProduct(product)}
                      disabled={deletingId === product.id}
                      className="flex w-full items-center gap-2 px-3 py-2 text-left text-sm text-red-400 hover:bg-mc-bg-tertiary disabled:opacity-50"
                    >
                      <Trash2 className="h-4 w-4" />
                      {deletingId === product.id ? 'Deleting...' : 'Delete product'}
                    </button>
                  </div>
                )}
                <div className="flex h-full flex-col">
                  <div className="mb-3 flex items-start justify-between gap-3 pr-8">
                    <div className="flex items-center gap-3">
                      <span className="relative text-2xl">
                        {product.icon}
                        {pendingCounts[product.id] > 0 && (
                          <span className="absolute -top-2 -right-2 min-w-[18px] h-[18px] flex items-center justify-center rounded-full bg-red-500 text-white text-[10px] font-bold leading-none px-1">
                            {pendingCounts[product.id] > 99 ? '99+' : pendingCounts[product.id]}
                          </span>
                        )}
                      </span>
                      <div>
                        <Link
                          href={`/autopilot/${product.id}`}
                          className="font-semibold text-mc-text transition-colors hover:text-mc-accent"
                        >
                          {product.name}
                        </Link>
                        <div className="mt-1">
                          <span className={`text-xs px-2 py-0.5 rounded ${
                            product.status === 'active' ? 'bg-green-500/20 text-green-400' :
                            product.status === 'paused' ? 'bg-amber-500/20 text-amber-400' :
                            'bg-mc-bg-tertiary text-mc-text-secondary'
                          }`}>
                            {product.status}
                          </span>
                        </div>
                      </div>
                    </div>
                    <div className="flex items-center gap-2">
                      {healthScores[product.id] !== undefined && (
                        <Link
                          href={`/autopilot/${product.id}/health`}
                          className="hover:scale-110 transition-transform"
                          aria-label={`Open ${product.name} health`}
                        >
                          <HealthBadge score={healthScores[product.id]} size={38} />
                        </Link>
                      )}
                      <Link
                        href={`/autopilot/${product.id}`}
                        className="rounded-md p-1 text-mc-text-secondary transition-colors hover:bg-mc-bg-tertiary hover:text-mc-accent"
                        aria-label={`Open ${product.name}`}
                      >
                        <ArrowRight className="w-4 h-4" />
                      </Link>
                    </div>
                  </div>
                  {product.description && (
                    <p className="line-clamp-2 text-sm text-mc-text-secondary">{product.description}</p>
                  )}
                  <div className="mt-4 flex flex-wrap gap-2 text-xs">
                    <Link
                      href={`/workspace/${product.workspace_slug || product.workspace_id}`}
                      className="rounded-full border border-mc-border bg-mc-bg px-2.5 py-1 text-mc-text-secondary transition-colors hover:border-mc-accent/50 hover:text-mc-text"
                    >
                      Workspace: {product.workspace_name || product.workspace_slug || product.workspace_id}
                    </Link>
                    <span className="rounded-full border border-mc-border bg-mc-bg px-2.5 py-1 text-mc-text-secondary">
                      {product.workspace_mode === 'dedicated' ? 'Dedicated workspace' : 'Shared workspace'}
                    </span>
                  </div>
                </div>
              </div>
            ))}
          </div>
        )}
      </main>
    </div>
  );
}
