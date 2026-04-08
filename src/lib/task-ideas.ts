export function normalizeIdeaTags(raw: unknown): string[] | undefined {
  if (typeof raw !== 'string' || raw.trim() === '') {
    return undefined;
  }

  try {
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed)) {
      return undefined;
    }

    const tags = parsed.filter((value): value is string => typeof value === 'string');
    return tags.length > 0 ? tags : undefined;
  } catch {
    return undefined;
  }
}

export interface TierBadgeInfo {
  tier: 1 | 2 | 3 | 4 | 5;
  label: string;
  textClass: string;
  bgClass: string;
  borderClass: string;
}

const TIER_BADGE_STYLES: Record<TierBadgeInfo['tier'], Omit<TierBadgeInfo, 'tier' | 'label'>> = {
  1: { textClass: 'text-emerald-400', bgClass: 'bg-emerald-500/15', borderClass: 'border-emerald-500/30' },
  2: { textClass: 'text-blue-400', bgClass: 'bg-blue-500/15', borderClass: 'border-blue-500/30' },
  3: { textClass: 'text-orange-400', bgClass: 'bg-orange-500/15', borderClass: 'border-orange-500/30' },
  4: { textClass: 'text-amber-400', bgClass: 'bg-amber-500/15', borderClass: 'border-amber-500/30' },
  5: { textClass: 'text-red-400', bgClass: 'bg-red-500/15', borderClass: 'border-red-500/30' },
};

export function getTierBadgeInfo(tags?: string[]): TierBadgeInfo | null {
  if (!tags || tags.length === 0) {
    return null;
  }

  for (const tag of tags) {
    const match = /^tier-([1-5])$/i.exec(tag);
    if (!match) {
      continue;
    }

    const tier = Number(match[1]) as TierBadgeInfo['tier'];
    return {
      tier,
      label: `T${tier}`,
      ...TIER_BADGE_STYLES[tier],
    };
  }

  return null;
}
