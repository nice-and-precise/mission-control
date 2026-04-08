'use client';

import { useState, useEffect, useCallback } from 'react';
import { CostCapManager } from './CostCapManager';
import type { CostBreakdown, CostOverview, Product, ProviderBillingReconciliation, Workspace } from '@/lib/types';

interface CostDashboardProps {
  productId?: string;
  workspaceId?: string;
}

function formatUsd(n: number): string {
  return `$${n.toFixed(2)}`;
}

function prettifyReason(reason?: string | null): string | null {
  if (!reason) return null;
  switch (reason) {
    case 'workspace_daily_cap_exceeded':
      return 'Workspace daily cap exceeded.';
    case 'workspace_monthly_cap_exceeded':
      return 'Workspace monthly cap exceeded.';
    case 'product_monthly_cap_exceeded':
      return 'Product monthly cap exceeded.';
    case 'task_cap_exceeded':
      return 'Product per-task cap exceeded.';
    case 'missing_workspace_daily_cap':
      return 'Workspace daily cap is required.';
    case 'missing_workspace_monthly_cap':
      return 'Workspace monthly cap is required.';
    case 'missing_product_monthly_cap':
      return 'Product monthly cap is required.';
    case 'missing_task_cap':
      return 'Product per-task cap is required for dispatch.';
    case 'model_unpriced':
      return 'The selected model does not expose accountable pricing metadata.';
    case 'usage_missing_accountable_pricing':
      return 'Build usage could not be priced from current provider metadata.';
    default:
      return reason.replace(/_/g, ' ');
  }
}

function isWorkspaceReason(reason?: string | null): boolean {
  return !!reason && (reason.startsWith('workspace_') || reason.startsWith('missing_workspace_'));
}

function isProductReason(reason?: string | null): boolean {
  return !!reason && (
    reason === 'product_monthly_cap_exceeded'
    || reason === 'task_cap_exceeded'
    || reason === 'missing_product_monthly_cap'
    || reason === 'missing_task_cap'
  );
}

function buildBudgetBanner(args: {
  overview: CostOverview | null;
  workspaceCaps: Workspace | null;
  productCaps: Product | null;
}): { title: string; body: string } | null {
  const { overview, workspaceCaps, productCaps } = args;
  const workspaceReason = workspaceCaps?.budget_block_reason;
  const productReason = productCaps?.budget_block_reason;
  const reason = workspaceReason || productReason;
  if (!reason) return null;

  const blockedEstimated = overview?.active_blocked_provider_estimated_usd || 0;
  const blockedTasks = overview?.active_blocked_task_count || 0;
  const source = isWorkspaceReason(reason) ? 'Workspace cap policy' : 'Product cap policy';
  const demand = blockedEstimated > 0
    ? `Active blocked estimated demand: ${formatUsd(blockedEstimated)} across ${blockedTasks} task${blockedTasks === 1 ? '' : 's'}.`
    : 'No active blocked estimated demand is currently attached to this product.';

  return {
    title: `${source} is blocking new spend-producing work.`,
    body: `${prettifyReason(reason)} ${demand} Mission Control is enforcing local provider-priced spend caps here, not subscription quota windows, legacy mixed history, or imported billing snapshots.`,
  };
}

function prettifyLedger(ledger: string): string {
  switch (ledger) {
    case 'provider_actual':
      return 'Provider Actual';
    case 'mission_estimate':
      return 'Mission Estimate';
    case 'legacy_mixed':
      return 'Legacy Mixed';
    default:
      return ledger.replace(/_/g, ' ');
  }
}

export function CostDashboard({ productId, workspaceId = 'default' }: CostDashboardProps) {
  const [overview, setOverview] = useState<CostOverview | null>(null);
  const [breakdown, setBreakdown] = useState<(CostBreakdown & {
    per_feature: {
      avg_cost_per_idea: number;
      avg_cost_per_shipped_feature: number;
      total_ideas_cost: number;
      total_build_cost: number;
    };
  }) | null>(null);
  const [loading, setLoading] = useState(true);
  const [showCaps, setShowCaps] = useState(false);
  const [effectiveWorkspaceId, setEffectiveWorkspaceId] = useState(workspaceId);
  const [productCaps, setProductCaps] = useState<Product | null>(null);
  const [workspaceCaps, setWorkspaceCaps] = useState<Workspace | null>(null);
  const [savingProductCaps, setSavingProductCaps] = useState(false);
  const [savingWorkspaceCaps, setSavingWorkspaceCaps] = useState(false);
  const [productCapExceeded, setProductCapExceeded] = useState(false);
  const [reconciliation, setReconciliation] = useState<ProviderBillingReconciliation | null>(null);
  const [savingReconciliation, setSavingReconciliation] = useState(false);
  const [reconciliationForm, setReconciliationForm] = useState({
    provider: 'qwen',
    provider_account_label: '',
    billing_period: new Date().toISOString().slice(0, 7),
    imported_total_usd: '',
    source: 'manual_import',
    notes: '',
  });

  const loadBudgetContext = useCallback(async () => {
    try {
      let resolvedWorkspaceId = workspaceId;
      if (productId) {
        const productRes = await fetch(`/api/products/${productId}`);
        if (productRes.ok) {
          const product = await productRes.json() as Product;
          setProductCaps(product);
          if (product.workspace_id) {
            resolvedWorkspaceId = product.workspace_id;
          }
        }
      }
      setEffectiveWorkspaceId(resolvedWorkspaceId || 'default');
    } catch (error) {
      console.error('Failed to load product caps:', error);
    }
  }, [productId, workspaceId]);

  const loadWorkspaceCaps = useCallback(async (currentWorkspaceId: string) => {
    try {
      const workspaceRes = await fetch(`/api/workspaces/${currentWorkspaceId}`);
      if (workspaceRes.ok) {
        setWorkspaceCaps(await workspaceRes.json() as Workspace);
      }
    } catch (error) {
      console.error('Failed to load workspace caps:', error);
    }
  }, []);

  const loadCosts = useCallback(async (currentWorkspaceId: string) => {
    setLoading(true);
    try {
      const query = new URLSearchParams({ workspace_id: currentWorkspaceId });
      if (productId) query.set('product_id', productId);
      const [overviewRes, breakdownRes] = await Promise.all([
        fetch(`/api/costs?${query.toString()}`),
        fetch(`/api/costs/breakdown?${query.toString()}`),
      ]);
      if (overviewRes.ok) setOverview(await overviewRes.json());
      if (breakdownRes.ok) setBreakdown(await breakdownRes.json());
    } catch (error) {
      console.error('Failed to load costs:', error);
    } finally {
      setLoading(false);
    }
  }, [productId]);

  const loadReconciliation = useCallback(async (currentWorkspaceId: string) => {
    try {
      const query = new URLSearchParams({ workspace_id: currentWorkspaceId });
      if (productId) query.set('product_id', productId);
      const response = await fetch(`/api/costs/reconciliation?${query.toString()}`);
      if (response.ok) {
        setReconciliation(await response.json() as ProviderBillingReconciliation);
      }
    } catch (error) {
      console.error('Failed to load reconciliation:', error);
    }
  }, [productId]);

  useEffect(() => {
    loadBudgetContext();
  }, [loadBudgetContext]);

  useEffect(() => {
    if (!effectiveWorkspaceId) return;
    loadWorkspaceCaps(effectiveWorkspaceId);
    loadCosts(effectiveWorkspaceId);
    loadReconciliation(effectiveWorkspaceId);
  }, [effectiveWorkspaceId, loadCosts, loadReconciliation, loadWorkspaceCaps]);

  useEffect(() => {
    if (productCaps?.cost_cap_monthly != null && overview) {
      setProductCapExceeded((overview.provider_actual.this_month + overview.provider_reserved_total) >= productCaps.cost_cap_monthly);
      return;
    }
    setProductCapExceeded(false);
  }, [overview, productCaps]);

  const refreshBudgetViews = useCallback(async () => {
    await loadBudgetContext();
    const currentWorkspaceId = productCaps?.workspace_id || effectiveWorkspaceId || workspaceId || 'default';
    if (currentWorkspaceId) {
      await loadWorkspaceCaps(currentWorkspaceId);
      await loadCosts(currentWorkspaceId);
      await loadReconciliation(currentWorkspaceId);
    }
  }, [effectiveWorkspaceId, loadBudgetContext, loadCosts, loadReconciliation, loadWorkspaceCaps, productCaps?.workspace_id, workspaceId]);

  const saveProductCaps = async () => {
    if (!productId || !productCaps) return;
    setSavingProductCaps(true);
    try {
      await fetch(`/api/products/${productId}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          cost_cap_per_task: productCaps.cost_cap_per_task ?? null,
          cost_cap_monthly: productCaps.cost_cap_monthly ?? null,
        }),
      });
      await refreshBudgetViews();
    } catch (error) {
      console.error('Failed to save product caps:', error);
    } finally {
      setSavingProductCaps(false);
    }
  };

  const saveWorkspaceCaps = async () => {
    if (!workspaceCaps) return;
    setSavingWorkspaceCaps(true);
    try {
      await fetch(`/api/workspaces/${workspaceCaps.id}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          cost_cap_daily: workspaceCaps.cost_cap_daily ?? null,
          cost_cap_monthly: workspaceCaps.cost_cap_monthly ?? null,
        }),
      });
      await refreshBudgetViews();
    } catch (error) {
      console.error('Failed to save workspace caps:', error);
    } finally {
      setSavingWorkspaceCaps(false);
    }
  };

  const saveReconciliationSnapshot = async () => {
    if (!effectiveWorkspaceId || !reconciliationForm.imported_total_usd) return;
    setSavingReconciliation(true);
    try {
      await fetch('/api/costs/reconciliation', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          workspace_id: effectiveWorkspaceId,
          product_id: productId || null,
          provider: reconciliationForm.provider,
          provider_account_label: reconciliationForm.provider_account_label || null,
          billing_period: reconciliationForm.billing_period,
          imported_total_usd: Number(reconciliationForm.imported_total_usd),
          source: reconciliationForm.source || null,
          notes: reconciliationForm.notes || null,
        }),
      });
      await loadReconciliation(effectiveWorkspaceId);
      setReconciliationForm(current => ({ ...current, imported_total_usd: '', notes: '' }));
    } catch (error) {
      console.error('Failed to save reconciliation snapshot:', error);
    } finally {
      setSavingReconciliation(false);
    }
  };

  if (loading) {
    return <div className="text-mc-text-secondary animate-pulse">Loading costs...</div>;
  }

  const budgetBanner = buildBudgetBanner({ overview, workspaceCaps, productCaps });
  const productSectionReason = isProductReason(productCaps?.budget_block_reason)
    ? productCaps?.budget_block_reason
    : null;
  const showProductSectionWarning = productCapExceeded || !!productSectionReason;

  return (
    <div className="space-y-6">
      {overview && (
        <div className="grid grid-cols-2 md:grid-cols-8 gap-3">
          {[
            { label: 'Provider Today', value: overview.provider_actual.today },
            { label: 'Provider Month', value: overview.provider_actual.this_month },
            { label: 'Provider Total', value: overview.provider_actual.total },
            { label: 'Provider Reserved', value: overview.provider_reserved_total },
            { label: 'Mission Est. Month', value: overview.mission_estimate.this_month },
            { label: 'Legacy Mixed', value: overview.legacy_mixed.total },
            { label: 'Blocked Provider Demand', value: overview.active_blocked_provider_estimated_usd },
            { label: 'Active Blocked Tasks', value: overview.active_blocked_task_count, isCount: true },
            { label: 'Unpriced Builds', value: overview.unpriced_build_runs_count, isCount: true },
          ].map(item => (
            <div key={item.label} className="bg-mc-bg-secondary border border-mc-border rounded-lg p-4">
              <div className="text-xs text-mc-text-secondary uppercase mb-1">{item.label}</div>
              <div className="text-xl font-bold text-mc-text">
                {'isCount' in item && item.isCount ? item.value : formatUsd(item.value)}
              </div>
            </div>
          ))}
        </div>
      )}

      <div className="bg-mc-bg-secondary border border-mc-border rounded-lg p-4 space-y-2">
        <div className="text-sm font-medium text-mc-text">Provider vs Mission Control accounting</div>
        <div className="text-sm text-mc-text-secondary">
          Provider Actual is the only budget-enforced ledger. Mission Estimate covers local normalized planning costs such as subscription or quota-style providers, and Legacy Mixed preserves older blended accounting without using it for cap enforcement.
        </div>
        <div className="rounded-lg border border-mc-border bg-mc-bg px-3 py-3 text-xs font-mono text-mc-text-secondary">
          openclaw status --usage<br />
          /usage cost<br />
          /usage full
        </div>
      </div>

      {breakdown && breakdown.by_ledger.length > 0 && (
        <div className="bg-mc-bg-secondary border border-mc-border rounded-lg p-5">
          <h3 className="font-semibold text-mc-text mb-4">Cost by Ledger</h3>
          <div className="space-y-3">
            {breakdown.by_ledger.map(item => {
              const maxTotal = Math.max(...breakdown.by_ledger.map(i => i.total));
              const pct = maxTotal > 0 ? (item.total / maxTotal) * 100 : 0;
              const label = prettifyLedger(item.ledger_type);
              return (
                <div key={item.ledger_type} className="flex items-center gap-3">
                  <span className="text-sm text-mc-text-secondary w-32 truncate">{label}</span>
                  <div className="flex-1 h-5 bg-mc-bg-tertiary rounded overflow-hidden">
                    <div
                      className="h-full bg-mc-accent-cyan/60 rounded"
                      style={{ width: `${pct}%` }}
                    />
                  </div>
                  <span className="text-sm font-medium text-mc-text w-20 text-right">{formatUsd(item.total)}</span>
                  <span className="text-xs text-mc-text-secondary w-12 text-right">({item.count})</span>
                </div>
              );
            })}
          </div>
        </div>
      )}

      {breakdown && breakdown.by_event_type.length > 0 && (
        <div className="bg-mc-bg-secondary border border-mc-border rounded-lg p-5">
          <h3 className="font-semibold text-mc-text mb-4">Cost by Category</h3>
          <div className="space-y-3">
            {breakdown.by_event_type.map(item => {
              const maxTotal = Math.max(...breakdown.by_event_type.map(i => i.total));
              const pct = maxTotal > 0 ? (item.total / maxTotal) * 100 : 0;
              const label = `${item.event_type.replace(/_/g, ' ')} · ${prettifyLedger(item.ledger_type)}`;
              return (
                <div key={`${item.event_type}-${item.ledger_type}`} className="flex items-center gap-3">
                  <span className="text-sm text-mc-text-secondary w-44 capitalize truncate">{label}</span>
                  <div className="flex-1 h-5 bg-mc-bg-tertiary rounded overflow-hidden">
                    <div
                      className="h-full bg-mc-accent-cyan/60 rounded"
                      style={{ width: `${pct}%` }}
                    />
                  </div>
                  <span className="text-sm font-medium text-mc-text w-20 text-right">{formatUsd(item.total)}</span>
                  <span className="text-xs text-mc-text-secondary w-12 text-right">({item.count})</span>
                </div>
              );
            })}
          </div>
        </div>
      )}

      {breakdown?.per_feature && (
        <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
          <div className="bg-mc-bg-secondary border border-mc-border rounded-lg p-4">
            <div className="text-xs text-mc-text-secondary mb-1">Avg Cost / Idea</div>
            <div className="text-lg font-bold text-mc-text">{formatUsd(breakdown.per_feature.avg_cost_per_idea)}</div>
          </div>
          <div className="bg-mc-bg-secondary border border-mc-border rounded-lg p-4">
            <div className="text-xs text-mc-text-secondary mb-1">Avg Cost / Feature</div>
            <div className="text-lg font-bold text-mc-text">{formatUsd(breakdown.per_feature.avg_cost_per_shipped_feature)}</div>
          </div>
          <div className="bg-mc-bg-secondary border border-mc-border rounded-lg p-4">
            <div className="text-xs text-mc-text-secondary mb-1">Total Ideas Cost</div>
            <div className="text-lg font-bold text-mc-text">{formatUsd(breakdown.per_feature.total_ideas_cost)}</div>
          </div>
          <div className="bg-mc-bg-secondary border border-mc-border rounded-lg p-4">
            <div className="text-xs text-mc-text-secondary mb-1">Total Build Cost</div>
            <div className="text-lg font-bold text-mc-text">{formatUsd(breakdown.per_feature.total_build_cost)}</div>
          </div>
        </div>
      )}

      {breakdown?.summary && (
        <div className="grid grid-cols-1 md:grid-cols-3 gap-3">
          <div className="bg-mc-bg-secondary border border-mc-border rounded-lg p-4">
            <div className="text-xs text-mc-text-secondary mb-1">Provider Actual</div>
            <div className="text-lg font-bold text-mc-text">{formatUsd(breakdown.summary.provider_actual_usd)}</div>
          </div>
          <div className="bg-mc-bg-secondary border border-mc-border rounded-lg p-4">
            <div className="text-xs text-mc-text-secondary mb-1">Mission Estimate</div>
            <div className="text-lg font-bold text-mc-text">{formatUsd(breakdown.summary.mission_estimate_usd)}</div>
          </div>
          <div className="bg-mc-bg-secondary border border-mc-border rounded-lg p-4">
            <div className="text-xs text-mc-text-secondary mb-1">Legacy Mixed</div>
            <div className="text-lg font-bold text-mc-text">{formatUsd(breakdown.summary.legacy_mixed_usd)}</div>
          </div>
          <div className="bg-mc-bg-secondary border border-mc-border rounded-lg p-4">
            <div className="text-xs text-mc-text-secondary mb-1">Provider Reserved</div>
            <div className="text-lg font-bold text-mc-text">{formatUsd(breakdown.summary.provider_reserved_usd)}</div>
          </div>
          <div className="bg-mc-bg-secondary border border-mc-border rounded-lg p-4">
            <div className="text-xs text-mc-text-secondary mb-1">Unpriced / Unknown</div>
            <div className="text-lg font-bold text-mc-text">{breakdown.summary.blocked_unknown_cost_count}</div>
          </div>
          <div className="bg-mc-bg-secondary border border-mc-border rounded-lg p-4">
            <div className="text-xs text-mc-text-secondary mb-1">Blocked Provider Demand</div>
            <div className="text-lg font-bold text-mc-text">{formatUsd(breakdown.summary.active_blocked_provider_estimated_usd)}</div>
          </div>
        </div>
      )}

      <div className="bg-mc-bg-secondary border border-mc-border rounded-lg p-5 space-y-4">
        <div>
          <h3 className="font-semibold text-mc-text">Provider Reconciliation</h3>
          <div className="text-xs text-mc-text-secondary mt-1">
            Imported provider totals are comparison-only. They never rewrite task allocations or drive cap enforcement. Alibaba current-month bills can lag by roughly 24 hours or more and remain reference-only until the next-month reconciliation window.
          </div>
        </div>

        <div className="grid grid-cols-1 md:grid-cols-5 gap-3">
          <input
            type="text"
            value={reconciliationForm.provider}
            onChange={e => setReconciliationForm(current => ({ ...current, provider: e.target.value }))}
            className="bg-mc-bg-tertiary border border-mc-border rounded-lg px-3 py-2 text-mc-text text-sm"
            placeholder="provider"
          />
          <input
            type="text"
            value={reconciliationForm.provider_account_label}
            onChange={e => setReconciliationForm(current => ({ ...current, provider_account_label: e.target.value }))}
            className="bg-mc-bg-tertiary border border-mc-border rounded-lg px-3 py-2 text-mc-text text-sm"
            placeholder="account label"
          />
          <input
            type="month"
            value={reconciliationForm.billing_period}
            onChange={e => setReconciliationForm(current => ({ ...current, billing_period: e.target.value }))}
            className="bg-mc-bg-tertiary border border-mc-border rounded-lg px-3 py-2 text-mc-text text-sm"
          />
          <input
            type="number"
            min="0"
            step="0.01"
            value={reconciliationForm.imported_total_usd}
            onChange={e => setReconciliationForm(current => ({ ...current, imported_total_usd: e.target.value }))}
            className="bg-mc-bg-tertiary border border-mc-border rounded-lg px-3 py-2 text-mc-text text-sm"
            placeholder="imported total"
          />
          <button
            onClick={saveReconciliationSnapshot}
            disabled={savingReconciliation}
            className="text-sm px-4 py-2 bg-mc-accent text-white rounded-lg hover:bg-mc-accent/90 disabled:opacity-50"
          >
            {savingReconciliation ? 'Saving...' : 'Import Snapshot'}
          </button>
        </div>

        <input
          type="text"
          value={reconciliationForm.source}
          onChange={e => setReconciliationForm(current => ({ ...current, source: e.target.value }))}
          className="w-full bg-mc-bg-tertiary border border-mc-border rounded-lg px-3 py-2 text-mc-text text-sm"
          placeholder="source"
        />
        <textarea
          value={reconciliationForm.notes}
          onChange={e => setReconciliationForm(current => ({ ...current, notes: e.target.value }))}
          className="w-full bg-mc-bg-tertiary border border-mc-border rounded-lg px-3 py-2 text-mc-text text-sm min-h-[88px]"
          placeholder="notes"
        />

        <div className="space-y-3">
          {reconciliation?.items.length ? reconciliation.items.map(item => (
            <div key={`${item.provider}-${item.billing_period}-${item.product_id || 'workspace'}`} className="rounded-lg border border-mc-border bg-mc-bg px-4 py-3">
              <div className="flex flex-wrap items-center justify-between gap-3">
                <div>
                  <div className="text-sm font-medium text-mc-text">
                    {item.provider} · {item.billing_period} {item.product_id ? '· product scope' : '· workspace scope'}
                  </div>
                  <div className="text-xs text-mc-text-secondary">
                    Imported {formatUsd(item.imported_total_usd)} vs Mission Control provider actual {formatUsd(item.provider_actual_total_usd)}. Delta {formatUsd(item.delta_usd)}.
                  </div>
                </div>
                <div className="text-xs text-mc-text-secondary">
                  Imported {new Date(item.imported_at).toLocaleString()}
                </div>
              </div>
              {(item.provider_account_label || item.source || item.notes) && (
                <div className="mt-2 text-xs text-mc-text-secondary">
                  {[item.provider_account_label, item.source, item.notes].filter(Boolean).join(' · ')}
                </div>
              )}
            </div>
          )) : (
            <div className="rounded-lg border border-dashed border-mc-border px-4 py-5 text-sm text-mc-text-secondary">
              No provider reconciliation imports yet for this scope.
            </div>
          )}
        </div>
      </div>

      {productId && budgetBanner && (
        <div className="bg-mc-bg-secondary border border-mc-border rounded-lg p-5 space-y-2">
          <div className="rounded-lg border border-amber-500/20 bg-amber-500/10 px-4 py-3">
            <div className="text-sm font-medium text-amber-200">{budgetBanner.title}</div>
            <div className="mt-1 text-sm text-amber-300">{budgetBanner.body}</div>
          </div>
        </div>
      )}

      {workspaceCaps && (
        <div className="bg-mc-bg-secondary border border-mc-border rounded-lg p-5 space-y-4">
          <h3 className="font-semibold text-mc-text">Workspace Cost Caps</h3>

          {workspaceCaps.budget_status === 'blocked' && (
            <div className="p-3 bg-amber-500/10 border border-amber-500/20 rounded-lg text-sm text-amber-300">
              {prettifyReason(workspaceCaps.budget_block_reason) || 'Workspace cap policy is blocking new spend-producing work.'}
            </div>
          )}

          <div className="text-xs text-mc-text-secondary">
            Dedicated workspaces currently default to a daily cap of $20.00 and a monthly cap of $100.00. XL tasks can exceed that before execution starts.
          </div>

          <div className="grid grid-cols-2 gap-4">
            <div>
              <label className="block text-xs text-mc-text-secondary mb-1">Daily cap ($)</label>
              <input
                type="number"
                min="0"
                step="0.01"
                value={workspaceCaps.cost_cap_daily ?? ''}
                onChange={e => setWorkspaceCaps(current => current ? ({ ...current, cost_cap_daily: e.target.value ? Number(e.target.value) : undefined }) : current)}
                className="w-full bg-mc-bg-tertiary border border-mc-border rounded-lg px-3 py-2 text-mc-text text-sm focus:outline-none focus:border-mc-accent"
                placeholder="20"
              />
            </div>
            <div>
              <label className="block text-xs text-mc-text-secondary mb-1">Monthly cap ($)</label>
              <input
                type="number"
                min="0"
                step="0.01"
                value={workspaceCaps.cost_cap_monthly ?? ''}
                onChange={e => setWorkspaceCaps(current => current ? ({ ...current, cost_cap_monthly: e.target.value ? Number(e.target.value) : undefined }) : current)}
                className="w-full bg-mc-bg-tertiary border border-mc-border rounded-lg px-3 py-2 text-mc-text text-sm focus:outline-none focus:border-mc-accent"
                placeholder="100"
              />
            </div>
          </div>

          <button
            onClick={saveWorkspaceCaps}
            disabled={savingWorkspaceCaps}
            className="text-sm px-4 py-2 bg-mc-accent text-white rounded-lg hover:bg-mc-accent/90 disabled:opacity-50"
          >
            {savingWorkspaceCaps ? 'Saving...' : 'Save Workspace Caps'}
          </button>
        </div>
      )}

      {productId && productCaps && (
        <div className="bg-mc-bg-secondary border border-mc-border rounded-lg p-5 space-y-4">
          <h3 className="font-semibold text-mc-text">Product Cost Caps</h3>

          {showProductSectionWarning && (
            <div className="p-3 bg-amber-500/10 border border-amber-500/20 rounded-lg text-sm text-amber-300">
              {prettifyReason(productSectionReason) || 'Product cap policy is blocking new spend-producing work for this product.'}
            </div>
          )}

          {productCaps.cost_cap_monthly != null && overview && (
            <div>
              <div className="flex justify-between text-xs text-mc-text-secondary mb-1">
                <span>Monthly spend + reservations</span>
                <span>{formatUsd(overview.provider_actual.this_month + overview.provider_reserved_total)} / {formatUsd(productCaps.cost_cap_monthly)}</span>
              </div>
              <div className="h-2 bg-mc-bg-tertiary rounded overflow-hidden">
                <div
                  className={`h-full rounded ${productCapExceeded ? 'bg-amber-500' : 'bg-mc-accent-cyan/60'}`}
                  style={{ width: `${Math.min((((overview.provider_actual.this_month + overview.provider_reserved_total) / productCaps.cost_cap_monthly) * 100), 100)}%` }}
                />
              </div>
            </div>
          )}

          <div className="text-xs text-mc-text-secondary">
            Provider-priced reserved spend currently attached to product tasks: {formatUsd(productCaps.reserved_cost_usd || 0)}
          </div>

          <div className="grid grid-cols-2 gap-4">
            <div>
              <label className="block text-xs text-mc-text-secondary mb-1">Per-task cap ($)</label>
              <input
                type="number"
                min="0"
                step="0.01"
                value={productCaps.cost_cap_per_task ?? ''}
                onChange={e => setProductCaps(current => current ? ({ ...current, cost_cap_per_task: e.target.value ? Number(e.target.value) : undefined }) : current)}
                className="w-full bg-mc-bg-tertiary border border-mc-border rounded-lg px-3 py-2 text-mc-text text-sm focus:outline-none focus:border-mc-accent"
                placeholder="15"
              />
            </div>
            <div>
              <label className="block text-xs text-mc-text-secondary mb-1">Monthly cap ($)</label>
              <input
                type="number"
                min="0"
                step="0.01"
                value={productCaps.cost_cap_monthly ?? ''}
                onChange={e => setProductCaps(current => current ? ({ ...current, cost_cap_monthly: e.target.value ? Number(e.target.value) : undefined }) : current)}
                className="w-full bg-mc-bg-tertiary border border-mc-border rounded-lg px-3 py-2 text-mc-text text-sm focus:outline-none focus:border-mc-accent"
                placeholder="40"
              />
            </div>
          </div>
          <button
            onClick={saveProductCaps}
            disabled={savingProductCaps}
            className="text-sm px-4 py-2 bg-mc-accent text-white rounded-lg hover:bg-mc-accent/90 disabled:opacity-50"
          >
            {savingProductCaps ? 'Saving...' : 'Save Product Caps'}
          </button>
        </div>
      )}

      <div>
        <button
          onClick={() => setShowCaps(!showCaps)}
          className="text-sm text-mc-accent hover:text-mc-accent/80 mb-3"
        >
          {showCaps ? 'Hide' : 'Manage'} Cost Caps
        </button>
        {showCaps && <CostCapManager workspaceId={effectiveWorkspaceId || workspaceId} productId={productId} />}
      </div>
    </div>
  );
}
