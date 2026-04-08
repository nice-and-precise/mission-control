export const COST_LEDGER_TYPES = ['provider_actual', 'mission_estimate', 'legacy_mixed'] as const;
export type CostLedgerType = typeof COST_LEDGER_TYPES[number];

export const COST_PRICING_BASES = ['token_priced', 'request_estimate', 'manual_estimate', 'legacy'] as const;
export type CostPricingBasis = typeof COST_PRICING_BASES[number];

export interface CostLedgerWindowTotals {
  today: number;
  this_week: number;
  this_month: number;
  total: number;
}

export function emptyLedgerWindowTotals(): CostLedgerWindowTotals {
  return {
    today: 0,
    this_week: 0,
    this_month: 0,
    total: 0,
  };
}
