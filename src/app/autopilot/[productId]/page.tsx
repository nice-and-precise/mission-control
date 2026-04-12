'use client';

import { useState, useEffect, useCallback } from 'react';
import { useParams, useRouter } from 'next/navigation';
import Link from 'next/link';
import { ArrowLeft, Rocket, Play, Layers, Lightbulb, BarChart3, FileText, Zap, Loader, Settings, X, Save, ExternalLink, AlertTriangle, Trash2 } from 'lucide-react';
import { SwipeDeck } from '@/components/autopilot/SwipeDeck';
import { IdeasList } from '@/components/autopilot/IdeasList';
import { ResearchReport } from '@/components/autopilot/ResearchReport';
import { BuildQueue } from '@/components/autopilot/BuildQueue';
import { ProductProgramEditor } from '@/components/autopilot/ProductProgramEditor';
import { MaybePool } from '@/components/autopilot/MaybePool';
import { CostDashboard } from '@/components/costs/CostDashboard';
import { ActivityPanel } from '@/components/autopilot/ActivityPanel';
import { openErrorReport } from '@/components/ErrorReportModal';
import { useToast } from '@/components/Toast';
import type { Product } from '@/lib/types';

type Tab = 'swipe' | 'ideas' | 'research' | 'build' | 'costs' | 'program' | 'maybe';
type PipelineState = 'idle' | 'researching' | 'ideating' | 'done' | 'error';

export default function ProductDashboardPage() {
  const { productId } = useParams<{ productId: string }>();
  const router = useRouter();
  const [product, setProduct] = useState<Product | null>(null);
  const [tab, setTab] = useState<Tab>('swipe');
  const [loading, setLoading] = useState(true);
  const [pipeline, setPipeline] = useState<PipelineState>('idle');
  const [pipelineError, setPipelineError] = useState<string | null>(null);
  const [showSettings, setShowSettings] = useState(false);
  const [settingsForm, setSettingsForm] = useState<Record<string, string>>({});
  const [settingsSaving, setSettingsSaving] = useState(false);
  const [settingsSaved, setSettingsSaved] = useState(false);
  const [settingsError, setSettingsError] = useState<string | null>(null);
  const [deletingProduct, setDeletingProduct] = useState(false);
  const { addToast } = useToast();

  useEffect(() => {
    (async () => {
      try {
        const res = await fetch(`/api/products/${productId}`);
        if (res.ok) setProduct(await res.json());
      } catch (error) {
        console.error('Failed to load product:', error);
      } finally {
        setLoading(false);
      }
    })();
  }, [productId]);

  // Fire-and-forget: server handles research → ideation chaining
  const runNow = useCallback(async () => {
    if (pipeline !== 'idle') return;
    setPipeline('researching');
    setPipelineError(null);

    try {
      const researchRes = await fetch(`/api/products/${productId}/research/run`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ chainIdeation: true }),
      });
      if (!researchRes.ok) {
        const err = await researchRes.json().catch(() => ({ error: 'Research failed' }));
        throw new Error(err.error || `Research failed (${researchRes.status})`);
      }
    } catch (err) {
      const errMsg = (err as Error).message;
      setPipelineError(errMsg);
      setPipeline('error');
      addToast({
        type: 'error',
        title: 'Pipeline failed',
        message: errMsg,
        duration: 0,
        action: {
          label: 'Report this issue',
          onClick: () => openErrorReport({ errorType: 'autopilot_pipeline', errorMessage: errMsg, productId }),
        },
      });
    }
  }, [productId, pipeline, addToast]);

  // Poll server for pipeline status so UI reflects progress even after navigation
  useEffect(() => {
    if (pipeline !== 'researching' && pipeline !== 'ideating') return;

    const interval = setInterval(async () => {
      try {
        // Check latest research cycle
        const resRes = await fetch(`/api/products/${productId}/research/cycles`);
        if (!resRes.ok) return;
        const resCycles = await resRes.json();
        const latestResearch = resCycles[0];

        if (latestResearch?.status === 'failed' || latestResearch?.status === 'interrupted') {
          setPipelineError(latestResearch.error_message || 'Research failed');
          setPipeline('error');
          return;
        }

        if (latestResearch?.status === 'completed') {
          // Research done — check ideation
          const ideaRes = await fetch(`/api/products/${productId}/ideation/cycles`);
          if (!ideaRes.ok) return;
          const ideaCycles = await ideaRes.json();
          const latestIdeation = ideaCycles[0];

          if (!latestIdeation || latestIdeation.status === 'running') {
            setPipeline('ideating');
          } else if (latestIdeation.status === 'completed') {
            setPipeline('done');
          } else if (latestIdeation.status === 'failed' || latestIdeation.status === 'interrupted') {
            setPipelineError(latestIdeation.error_message || 'Ideation failed');
            setPipeline('error');
          }
        }
      } catch { /* ignore poll errors */ }
    }, 5000);

    return () => clearInterval(interval);
  }, [pipeline, productId]);

  // Auto-reset "done" state after 3 seconds so button is clickable again
  useEffect(() => {
    if (pipeline === 'done') {
      const t = setTimeout(() => setPipeline('idle'), 3000);
      return () => clearTimeout(t);
    }
  }, [pipeline]);

  function openSettings() {
    if (!product) return;
    setSettingsForm({
      name: product.name,
      description: product.description || '',
      repo_url: product.repo_url || '',
      canonical_program_path: product.canonical_program_path || '',
      live_url: product.live_url || '',
      default_branch: product.default_branch || 'main',
      build_mode: product.build_mode || 'plan_first',
      icon: product.icon || '📦',
    });
    setSettingsError(null);
    setSettingsSaved(false);
    setShowSettings(true);
  }

  async function saveSettings() {
    setSettingsSaving(true);
    setSettingsError(null);
    setSettingsSaved(false);
    try {
      const body: Record<string, unknown> = {
        name: settingsForm.name,
        description: settingsForm.description || undefined,
        repo_url: settingsForm.repo_url || null,
        canonical_program_path: settingsForm.canonical_program_path || null,
        live_url: settingsForm.live_url || null,
        default_branch: settingsForm.default_branch || 'main',
        build_mode: settingsForm.build_mode,
        icon: settingsForm.icon,
      };
      const res = await fetch(`/api/products/${productId}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      });
      if (!res.ok) {
        const err = await res.json().catch(() => ({ error: 'Save failed' }));
        throw new Error(err.error || `Save failed (${res.status})`);
      }
      const updated = await res.json();
      setProduct(updated);
      setSettingsSaved(true);
      setTimeout(() => { setSettingsSaved(false); setShowSettings(false); }, 800);
    } catch (err) {
      setSettingsError((err as Error).message);
    } finally {
      setSettingsSaving(false);
    }
  }

  async function handleDeleteProduct() {
    if (!product || deletingProduct) return;

    const confirmed = window.confirm(
      `Delete ${product.name}? This permanently removes the product, its Autopilot history, and any product-owned build tasks.`
    );
    if (!confirmed) return;

    setDeletingProduct(true);
    setSettingsError(null);

    try {
      const res = await fetch(`/api/products/${productId}`, { method: 'DELETE' });
      if (!res.ok) {
        const err = await res.json().catch(() => ({ error: 'Delete failed' }));
        throw new Error(err.error || `Delete failed (${res.status})`);
      }
      router.push('/autopilot');
      router.refresh();
    } catch (err) {
      setSettingsError((err as Error).message);
      setDeletingProduct(false);
    }
  }

  if (loading || !product) {
    return (
      <div className="min-h-screen bg-mc-bg flex items-center justify-center">
        <div className="text-mc-text-secondary animate-pulse">Loading product...</div>
      </div>
    );
  }

  const tabs: { id: Tab; label: string; icon: React.ReactNode }[] = [
    { id: 'swipe', label: 'Swipe', icon: <Play className="w-4 h-4" /> },
    { id: 'ideas', label: 'Ideas', icon: <Lightbulb className="w-4 h-4" /> },
    { id: 'research', label: 'Research', icon: <Layers className="w-4 h-4" /> },
    { id: 'build', label: 'Build Queue', icon: <Layers className="w-4 h-4" /> },
    { id: 'maybe', label: 'Maybe', icon: <Layers className="w-4 h-4" /> },
    { id: 'costs', label: 'Costs', icon: <BarChart3 className="w-4 h-4" /> },
    { id: 'program', label: 'Program', icon: <FileText className="w-4 h-4" /> },
  ];

  return (
    <div className="min-h-screen bg-mc-bg flex flex-col">
      {/* Header */}
      <header className="border-b border-mc-border bg-mc-bg-secondary px-4 py-3">
        <div className="flex items-center justify-between">
          <div className="flex items-center gap-3">
            <Link href="/autopilot" className="text-mc-text-secondary hover:text-mc-text">
              <ArrowLeft className="w-5 h-5" />
            </Link>
            <span className="text-2xl">{product.icon}</span>
            <div>
              <h1 className="font-semibold text-mc-text">{product.name}</h1>
              <div className="mt-1 flex flex-wrap items-center gap-2 text-xs">
                <span className={`${product.status === 'active' ? 'text-green-400' : 'text-mc-text-secondary'}`}>
                  {product.status}
                </span>
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
          <div className="flex items-center gap-2">
            {/* Run Now — fires research → ideation pipeline */}
            <button
              onClick={runNow}
              disabled={pipeline !== 'idle' && pipeline !== 'done' && pipeline !== 'error'}
              className={`min-h-11 px-4 rounded-lg flex items-center gap-2 text-sm font-medium transition-colors ${
                pipeline === 'idle' || pipeline === 'done' || pipeline === 'error'
                  ? 'bg-amber-500 text-black hover:bg-amber-400'
                  : 'bg-amber-500/30 text-amber-300 cursor-wait'
              }`}
            >
              {(pipeline === 'idle' || pipeline === 'done' || pipeline === 'error') && (
                <>
                  <Zap className="w-4 h-4" />
                  Run Now
                </>
              )}
              {pipeline === 'researching' && (
                <>
                  <Loader className="w-4 h-4 animate-spin" />
                  Researching...
                </>
              )}
              {pipeline === 'ideating' && (
                <>
                  <Loader className="w-4 h-4 animate-spin" />
                  Generating ideas...
                </>
              )}
            </button>
            {pipelineError && (
              <div className="flex items-center gap-2">
                <span className="text-xs text-red-400 max-w-48 truncate" title={pipelineError}>
                  {pipelineError}
                </span>
                <button
                  onClick={() => openErrorReport({ errorType: 'autopilot_pipeline', errorMessage: pipelineError, productId })}
                  className="flex items-center gap-1 text-xs text-amber-400 hover:text-amber-300 transition-colors"
                  title="Report this issue"
                >
                  <AlertTriangle size={12} />
                  Report
                </button>
              </div>
            )}
            <Link
              href={`/autopilot/${productId}/swipe`}
              className="min-h-11 px-4 rounded-lg bg-mc-accent text-white hover:bg-mc-accent/90 flex items-center gap-2 text-sm font-medium"
            >
              <Rocket className="w-4 h-4" />
              Full Screen Swipe
            </Link>
            <button
              onClick={openSettings}
              className="min-h-11 w-11 rounded-lg bg-mc-bg-tertiary border border-mc-border text-mc-text-secondary hover:text-mc-text flex items-center justify-center"
              title="Product Settings"
            >
              <Settings className="w-5 h-5" />
            </button>
          </div>
        </div>
      </header>

      {/* Tabs */}
      <div className="border-b border-mc-border bg-mc-bg-secondary px-4 overflow-x-auto">
        <div className="flex gap-1 min-w-max">
          {tabs.map(t => (
            <button
              key={t.id}
              onClick={() => setTab(t.id)}
              className={`flex items-center gap-2 px-4 py-3 text-sm font-medium border-b-2 transition-colors whitespace-nowrap ${
                tab === t.id
                  ? 'border-mc-accent text-mc-accent'
                  : 'border-transparent text-mc-text-secondary hover:text-mc-text'
              }`}
            >
              {t.icon}
              {t.label}
            </button>
          ))}
        </div>
      </div>

      {/* Content: two-column layout on desktop */}
      <div className="flex-1 flex min-h-0">
        <div className="flex-1 p-4 overflow-auto">
          {tab === 'swipe' && <SwipeDeck productId={productId} />}
          {tab === 'ideas' && <IdeasList productId={productId} />}
          {tab === 'research' && <ResearchReport productId={productId} />}
          {tab === 'build' && <BuildQueue productId={productId} />}
          {tab === 'maybe' && <MaybePool productId={productId} />}
          {tab === 'costs' && <CostDashboard productId={productId} workspaceId={product.workspace_id} />}
          {tab === 'program' && <ProductProgramEditor product={product} onSave={setProduct} />}
        </div>

        {/* Activity panel — desktop: right side column, mobile: floating button + drawer */}
        <ActivityPanel productId={productId} />
      </div>

      {/* Settings Modal */}
      {showSettings && (
        <div className="fixed inset-0 z-50 flex items-center justify-center">
          <div className="absolute inset-0 bg-black/60" onClick={() => setShowSettings(false)} />
          <div className="relative bg-mc-bg-secondary border border-mc-border rounded-xl w-full max-w-lg mx-4 max-h-[85vh] overflow-y-auto">
            <div className="sticky top-0 bg-mc-bg-secondary border-b border-mc-border px-5 py-4 flex items-center justify-between rounded-t-xl">
              <h2 className="text-lg font-semibold text-mc-text">Product Settings</h2>
              <button onClick={() => setShowSettings(false)} className="text-mc-text-secondary hover:text-mc-text">
                <X className="w-5 h-5" />
              </button>
            </div>

            <div className="p-5 space-y-4">
              {settingsError && (
                <div className="bg-red-500/10 border border-red-500/30 rounded-lg px-3 py-2 text-sm text-red-400">{settingsError}</div>
              )}

              <div className="flex gap-3">
                <div className="w-16">
                  <label className="block text-xs font-medium text-mc-text-secondary uppercase tracking-wider mb-1">Icon</label>
                  <input
                    type="text"
                    value={settingsForm.icon || ''}
                    onChange={e => setSettingsForm(f => ({ ...f, icon: e.target.value }))}
                    className="w-full bg-mc-bg border border-mc-border rounded-lg px-3 py-2 text-sm text-mc-text text-center text-xl focus:outline-none focus:border-mc-accent"
                    maxLength={4}
                  />
                </div>
                <div className="flex-1">
                  <label className="block text-xs font-medium text-mc-text-secondary uppercase tracking-wider mb-1">Name</label>
                  <input
                    type="text"
                    value={settingsForm.name || ''}
                    onChange={e => setSettingsForm(f => ({ ...f, name: e.target.value }))}
                    className="w-full bg-mc-bg border border-mc-border rounded-lg px-3 py-2 text-sm text-mc-text focus:outline-none focus:border-mc-accent"
                  />
                </div>
              </div>

              <div>
                <label className="block text-xs font-medium text-mc-text-secondary uppercase tracking-wider mb-1">Description</label>
                <textarea
                  value={settingsForm.description || ''}
                  onChange={e => setSettingsForm(f => ({ ...f, description: e.target.value }))}
                  className="w-full bg-mc-bg border border-mc-border rounded-lg px-3 py-2 text-sm text-mc-text resize-none focus:outline-none focus:border-mc-accent"
                  rows={2}
                />
              </div>

              <div>
                <label className="block text-xs font-medium text-mc-text-secondary uppercase tracking-wider mb-1">Repository URL</label>
                <div className="flex gap-2">
                  <input
                    type="url"
                    value={settingsForm.repo_url || ''}
                    onChange={e => setSettingsForm(f => ({ ...f, repo_url: e.target.value }))}
                    className="flex-1 bg-mc-bg border border-mc-border rounded-lg px-3 py-2 text-sm text-mc-text focus:outline-none focus:border-mc-accent"
                    placeholder="https://github.com/org/repo"
                  />
                  {settingsForm.repo_url && (
                    <a href={settingsForm.repo_url} target="_blank" rel="noopener noreferrer"
                      className="px-3 flex items-center bg-mc-bg border border-mc-border rounded-lg text-mc-text-secondary hover:text-mc-text">
                      <ExternalLink className="w-4 h-4" />
                    </a>
                  )}
                </div>
              </div>

              <div>
                <label className="block text-xs font-medium text-mc-text-secondary uppercase tracking-wider mb-1">Canonical Program Path</label>
                <input
                  type="text"
                  value={settingsForm.canonical_program_path || ''}
                  onChange={e => setSettingsForm(f => ({ ...f, canonical_program_path: e.target.value }))}
                  className="w-full bg-mc-bg border border-mc-border rounded-lg px-3 py-2 text-sm text-mc-text focus:outline-none focus:border-mc-accent"
                  placeholder="/Users/jordan/.openclaw/workspace/squti/docs/PRODUCT_PROGRAM.md"
                />
                <p className="mt-1 text-xs text-mc-text-secondary">
                  Used by the Program tab to audit and sync the repo-authored Product Program into Mission Control before research runs.
                </p>
              </div>

              <div>
                <label className="block text-xs font-medium text-mc-text-secondary uppercase tracking-wider mb-1">Live URL</label>
                <div className="flex gap-2">
                  <input
                    type="url"
                    value={settingsForm.live_url || ''}
                    onChange={e => setSettingsForm(f => ({ ...f, live_url: e.target.value }))}
                    className="flex-1 bg-mc-bg border border-mc-border rounded-lg px-3 py-2 text-sm text-mc-text focus:outline-none focus:border-mc-accent"
                    placeholder="https://yourproduct.com"
                  />
                  {settingsForm.live_url && (
                    <a href={settingsForm.live_url} target="_blank" rel="noopener noreferrer"
                      className="px-3 flex items-center bg-mc-bg border border-mc-border rounded-lg text-mc-text-secondary hover:text-mc-text">
                      <ExternalLink className="w-4 h-4" />
                    </a>
                  )}
                </div>
              </div>

              <div className="flex gap-3">
                <div className="flex-1">
                  <label className="block text-xs font-medium text-mc-text-secondary uppercase tracking-wider mb-1">Default Branch</label>
                  <input
                    type="text"
                    value={settingsForm.default_branch || ''}
                    onChange={e => setSettingsForm(f => ({ ...f, default_branch: e.target.value }))}
                    className="w-full bg-mc-bg border border-mc-border rounded-lg px-3 py-2 text-sm text-mc-text focus:outline-none focus:border-mc-accent"
                    placeholder="main"
                  />
                </div>
                <div className="flex-1">
                  <label className="block text-xs font-medium text-mc-text-secondary uppercase tracking-wider mb-1">Build Mode</label>
                  <select
                    value={settingsForm.build_mode || 'plan_first'}
                    onChange={e => setSettingsForm(f => ({ ...f, build_mode: e.target.value }))}
                    className="w-full bg-mc-bg border border-mc-border rounded-lg px-3 py-2 text-sm text-mc-text focus:outline-none focus:border-mc-accent"
                  >
                    <option value="plan_first">Plan First</option>
                    <option value="auto_build">Auto Build</option>
                  </select>
                </div>
              </div>

              <div className="rounded-lg border border-mc-border bg-mc-bg p-4">
                <h3 className="text-xs font-medium uppercase tracking-wider text-mc-text-secondary">Workspace</h3>
                <p className="mt-2 text-sm text-mc-text">
                  {product.workspace_name || product.workspace_slug || product.workspace_id}
                </p>
                <p className="mt-1 text-sm text-mc-text-secondary">
                  {product.workspace_mode === 'dedicated'
                    ? 'This product owns a dedicated Mission Control workspace. Approved ideas route new build tasks there by default.'
                    : 'This product uses an existing shared Mission Control workspace. If that destination was wrong, delete and recreate the product with a dedicated workspace.'}
                </p>
                <Link
                  href={`/workspace/${product.workspace_slug || product.workspace_id}`}
                  className="mt-3 inline-flex items-center gap-2 text-sm text-mc-accent hover:text-mc-accent/80"
                >
                  <ExternalLink className="h-4 w-4" />
                  Open workspace
                </Link>
              </div>

              <div className="rounded-lg border border-red-500/30 bg-red-500/10 p-4">
                <h3 className="text-xs font-medium uppercase tracking-wider text-red-300">Danger Zone</h3>
                <p className="mt-2 text-sm text-red-100/90">
                  Delete this product to reset a mistaken setup. This hard-deletes the product, its Autopilot history, and any product-owned tasks.
                </p>
                <button
                  type="button"
                  onClick={handleDeleteProduct}
                  disabled={deletingProduct}
                  className="mt-4 inline-flex min-h-11 items-center gap-2 rounded-lg border border-red-500/40 bg-red-500/20 px-4 text-sm font-medium text-red-200 transition-colors hover:bg-red-500/30 disabled:cursor-not-allowed disabled:opacity-60"
                >
                  {deletingProduct ? <Loader className="h-4 w-4 animate-spin" /> : <Trash2 className="h-4 w-4" />}
                  {deletingProduct ? 'Deleting product...' : 'Delete product'}
                </button>
              </div>
            </div>

            <div className="sticky bottom-0 bg-mc-bg-secondary border-t border-mc-border px-5 py-4 flex items-center justify-end gap-3 rounded-b-xl">
              <button
                onClick={() => setShowSettings(false)}
                className="min-h-9 px-4 rounded-lg text-sm text-mc-text-secondary hover:text-mc-text"
              >
                Cancel
              </button>
              <button
                onClick={saveSettings}
                disabled={settingsSaving}
                className={`min-h-9 px-4 rounded-lg flex items-center gap-2 text-sm font-medium ${
                  settingsSaved
                    ? 'bg-green-500/20 text-green-400'
                    : 'bg-mc-accent text-white hover:bg-mc-accent/90'
                }`}
              >
                {settingsSaving ? <Loader className="w-4 h-4 animate-spin" /> : <Save className="w-4 h-4" />}
                {settingsSaved ? 'Saved' : settingsSaving ? 'Saving...' : 'Save'}
              </button>
            </div>
          </div>
        </div>
      )}

    </div>
  );
}
