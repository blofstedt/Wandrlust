import React, { useEffect, useRef, useState } from 'react';
import type { TrustTier } from '../../types';
import { TIER_BY_ID, DEFAULT_TIER } from '../../config/tiers';

/**
 * The tier trophy.
 *
 * A chunky little cup that changes colour as you climb: dull grey, copper,
 * silver, gold, and then an emerald-to-cyan one at the top that is
 * deliberately not a metal, because arriving should look like arriving.
 *
 * When the tier goes UP it pops once — the moook curve, so it overshoots and
 * settles rather than easing. It stays quiet on first render and on any
 * downward change, since neither is a thing to celebrate.
 */

interface TrophyProps {
  tier: TrustTier;
  /** Pixel size of the square. Default 20. */
  size?: number;
  className?: string;
  /** Set false to suppress the promotion pop (e.g. in a static list). */
  animate?: boolean;
}

export const Trophy: React.FC<TrophyProps> = ({
  tier, size = 20, className = '', animate = true
}) => {
  const def = TIER_BY_ID[tier] ?? TIER_BY_ID[DEFAULT_TIER];
  const gradientId = useRef(`trophy-${Math.random().toString(36).slice(2, 8)}`);

  const [promoted, setPromoted] = useState(false);
  const prevRank = useRef<number | null>(null);

  useEffect(() => {
    const previous = prevRank.current;
    prevRank.current = def.rank;

    // First render establishes the baseline; only a genuine climb celebrates.
    if (previous === null || def.rank <= previous || !animate) return;

    setPromoted(true);
    const t = setTimeout(() => setPromoted(false), 700);
    return () => clearTimeout(t);
  }, [def.rank, animate]);

  const fill = def.isAurora ? `url(#${gradientId.current})` : def.color;

  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      role="img"
      aria-label={`${def.label} tier`}
      className={`${promoted ? 'anim-pop' : ''} ${className}`}
    >
      <defs>
        <linearGradient id={gradientId.current} x1="0" y1="0" x2="1" y2="1">
          <stop offset="0%" stopColor={def.color} />
          <stop offset="100%" stopColor={def.colorSoft} />
        </linearGradient>
      </defs>

      {/* Handles, behind the cup so they read as attached to it. */}
      <path
        d="M7.5 5.5H5.2a2.8 2.8 0 0 0 2.8 4.6M16.5 5.5h2.3a2.8 2.8 0 0 1-2.8 4.6"
        fill="none"
        stroke={fill}
        strokeWidth="1.7"
        strokeLinecap="round"
        opacity="0.75"
      />

      {/* Cup. */}
      <path
        d="M7 3.6h10v4.9a5 5 0 0 1-10 0z"
        fill={fill}
        stroke={fill}
        strokeWidth="1.2"
        strokeLinejoin="round"
      />

      {/* Stem and base. */}
      <path d="M11.1 14h1.8v2.4h-1.8z" fill={fill} />
      <rect x="7.6" y="16.6" width="8.8" height="2.3" rx="1.15" fill={fill} />

      {/* Shine — a single soft highlight so the metals read as metal. */}
      <path
        d="M9.2 5.3v2.9a2.6 2.6 0 0 0 1.1 2.1"
        fill="none"
        stroke="#ffffff"
        strokeWidth="0.9"
        strokeLinecap="round"
        opacity="0.32"
      />
    </svg>
  );
};

/** Trophy + label, the standard way a tier is shown inline. */
export const TierBadge: React.FC<{ tier: TrustTier; className?: string }> = ({
  tier, className = ''
}) => {
  const def = TIER_BY_ID[tier] ?? TIER_BY_ID[DEFAULT_TIER];
  return (
    <span
      className={`px-2 py-0.5 rounded-lg border text-[10px] font-bold inline-flex items-center gap-1 ${def.ring} ${className}`}
    >
      <Trophy tier={tier} size={12} />
      {def.label}
    </span>
  );
};
