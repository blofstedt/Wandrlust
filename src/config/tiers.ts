import type { TrustTier, TierDefinition } from '../types';

/**
 * The five-rung ladder.
 *
 * Single source of truth for the client. The thresholds are mirrored by
 * recompute_trust() in supabase_migration_08 — if you change a number here,
 * change it there too, or the badge will disagree with the database.
 *
 * Colours are the trophy's fill. They read as a progression you can see at a
 * glance across a room: dull grey, copper, silver, gold, then the one that
 * isn't a metal at all.
 */
export const TIERS: TierDefinition[] = [
  {
    id: 'tourist',
    rank: 1,
    label: 'Tourist',
    minScore: 0,
    blurb: 'Just arrived. Public-land sites and the full field guide.',
    color: '#64748b',
    colorSoft: '#94a3b8',
    ring: 'border-slate-600 bg-slate-700/40 text-slate-300'
  },
  {
    id: 'camper',
    rank: 2,
    label: 'Camper',
    minScore: 20,
    blurb: 'You have checked in and reported back. Copper.',
    color: '#b87333',
    colorSoft: '#d99058',
    ring: 'border-orange-800/60 bg-orange-900/30 text-orange-300'
  },
  {
    id: 'scout',
    rank: 3,
    label: 'Scout',
    minScore: 70,
    blurb: 'You map roads and verify amenities. Stealth pins become visible.',
    color: '#cbd5e1',
    colorSoft: '#e2e8f0',
    ring: 'border-slate-400/50 bg-slate-300/10 text-slate-200'
  },
  {
    id: 'trailblazer',
    rank: 4,
    label: 'Trailblazer',
    minScore: 180,
    blurb: 'You find sites before anyone else. Exact stealth coordinates unlock.',
    color: '#f5b301',
    colorSoft: '#fcd34d',
    ring: 'border-amber-500/50 bg-amber-500/15 text-amber-300'
  },
  {
    id: 'nomad',
    rank: 5,
    label: 'Nomad',
    minScore: 400,
    blurb: 'The top of the ladder. You built a good part of this map.',
    color: '#34d399',
    colorSoft: '#22d3ee',
    ring: 'border-emerald-400/50 bg-emerald-500/15 text-emerald-300',
    isAurora: true
  }
];

export const TIER_BY_ID: Record<TrustTier, TierDefinition> = TIERS.reduce(
  (acc, t) => ({ ...acc, [t.id]: t }),
  {} as Record<TrustTier, TierDefinition>
);

export const DEFAULT_TIER: TrustTier = 'tourist';

/** The rung above `id`, or null at the top. */
export const nextTier = (id: TrustTier): TierDefinition | null => {
  const current = TIER_BY_ID[id] ?? TIER_BY_ID[DEFAULT_TIER];
  return TIERS.find((t) => t.rank === current.rank + 1) ?? null;
};

/**
 * Progress toward the next rung, 0–100.
 *
 * Measured across the current band rather than from zero, so the bar fills
 * steadily instead of crawling for the last two thousand points.
 */
export const tierProgress = (id: TrustTier, score: number): number => {
  const current = TIER_BY_ID[id] ?? TIER_BY_ID[DEFAULT_TIER];
  const next = nextTier(id);
  if (!next) return 100;

  const span = next.minScore - current.minScore;
  if (span <= 0) return 100;
  return Math.max(0, Math.min(100, Math.round(((score - current.minScore) / span) * 100)));
};