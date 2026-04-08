import { v4 as uuidv4 } from 'uuid';
import { queryAll, run } from '@/lib/db';
import type { ProviderBillingReconciliation, ProviderBillingReconciliationItem, ProviderBillingSnapshot } from '@/lib/types';
import type { CreateProviderBillingSnapshotInput } from '@/lib/validation';

function periodBounds(billingPeriod: string): { start: string; end: string } {
  const [year, month] = billingPeriod.split('-').map(Number);
  const start = new Date(year, month - 1, 1).toISOString();
  const end = new Date(year, month, 1).toISOString();
  return { start, end };
}

export function createProviderBillingSnapshot(input: CreateProviderBillingSnapshotInput): ProviderBillingSnapshot {
  const id = uuidv4();
  const importedAt = input.imported_at || new Date().toISOString();

  run(
    `INSERT INTO provider_billing_snapshots (
       id, workspace_id, product_id, provider, provider_account_label, billing_period,
       imported_total_usd, source, notes, imported_at
     ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      id,
      input.workspace_id,
      input.product_id || null,
      input.provider,
      input.provider_account_label || null,
      input.billing_period,
      input.imported_total_usd,
      input.source || null,
      input.notes || null,
      importedAt,
    ],
  );

  return queryAll<ProviderBillingSnapshot>(
    'SELECT * FROM provider_billing_snapshots WHERE id = ?',
    [id],
  )[0]!;
}

export function getProviderBillingReconciliation(workspaceId: string, productId?: string): ProviderBillingReconciliation {
  const snapshots = queryAll<ProviderBillingSnapshot>(
    `SELECT *
     FROM provider_billing_snapshots
     WHERE workspace_id = ?
       AND (? IS NULL OR product_id = ? OR product_id IS NULL)
     ORDER BY billing_period DESC, imported_at DESC`,
    [workspaceId, productId || null, productId || null],
  );

  const latestByScope = new Map<string, ProviderBillingSnapshot>();
  for (const snapshot of snapshots) {
    const key = [snapshot.provider, snapshot.billing_period, snapshot.product_id || 'workspace'].join(':');
    if (!latestByScope.has(key)) {
      latestByScope.set(key, snapshot);
    }
  }

  const items: ProviderBillingReconciliationItem[] = Array.from(latestByScope.values()).map((snapshot) => {
    const { start, end } = periodBounds(snapshot.billing_period);
    const providerActual = queryAll<{ total: number }>(
      `SELECT COALESCE(SUM(cost_usd), 0) AS total
       FROM cost_events
       WHERE workspace_id = ?
         AND (? IS NULL OR product_id = ?)
         AND provider = ?
         AND ledger_type = 'provider_actual'
         AND created_at >= ?
         AND created_at < ?`,
      [
        workspaceId,
        snapshot.product_id || null,
        snapshot.product_id || null,
        snapshot.provider,
        start,
        end,
      ],
    )[0]?.total || 0;

    return {
      provider: snapshot.provider,
      billing_period: snapshot.billing_period,
      imported_total_usd: snapshot.imported_total_usd,
      provider_actual_total_usd: providerActual,
      delta_usd: snapshot.imported_total_usd - providerActual,
      imported_at: snapshot.imported_at,
      provider_account_label: snapshot.provider_account_label,
      source: snapshot.source,
      notes: snapshot.notes,
      product_id: snapshot.product_id,
    };
  });

  return {
    scope: {
      workspace_id: workspaceId,
      product_id: productId,
    },
    items,
  };
}
