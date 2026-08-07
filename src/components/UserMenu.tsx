import React, { useState, useRef, useEffect } from 'react';
import { LogOut, User as UserIcon, Sparkles, ChevronDown, Loader2 } from 'lucide-react';
import { useAuth } from '../contexts/AuthContext';
import { AnimatedNumber } from './ui/Feedback';
import { Trophy, TierBadge } from './ui/Trophy';
import { TIERS, TIER_BY_ID, DEFAULT_TIER, nextTier, tierProgress } from '../config/tiers';

interface UserMenuProps { onOpenAuth: () => void; }

export const UserMenu: React.FC<UserMenuProps> = ({ onOpenAuth }) => {
  const { user, profile, pointsBalance, isLoading, isConfigured, signOut } = useAuth();
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    const onClickOutside = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener('mousedown', onClickOutside);
    return () => document.removeEventListener('mousedown', onClickOutside);
  }, []);

  if (isLoading) {
    return (
      <div className="p-2 rounded-xl bg-slate-800/80 border border-slate-700">
        <Loader2 className="w-4 h-4 text-slate-400 animate-spin" />
      </div>
    );
  }

  if (!user) {
    return (
      <button
        onClick={onOpenAuth}
        className="px-3 py-1.5 rounded-xl bg-emerald-600 hover:bg-emerald-500 text-white font-bold text-xs flex items-center gap-1.5"
        title={isConfigured ? 'Sign in' : 'Authentication not configured'}
      >
        <UserIcon className="w-3.5 h-3.5" />
        Sign in
      </button>
    );
  }

  const tier = profile?.trust_tier ?? DEFAULT_TIER;
  const tierDef = TIER_BY_ID[tier] ?? TIER_BY_ID[DEFAULT_TIER];
  const next = nextTier(tier);
  const score = profile?.trust_score ?? 0;
  const progress = tierProgress(tier, score);

  const initial = (profile?.display_name ?? profile?.handle ?? user.email ?? '?')
    .charAt(0).toUpperCase();

  return (
    <div className="relative" ref={ref}>
      <button
        onClick={() => setOpen((v) => !v)}
        className="flex items-center gap-2 pl-1 pr-2 py-1 rounded-xl bg-slate-800/80 hover:bg-slate-700 border border-slate-700"
      >
        {profile?.avatar_url ? (
          <img src={profile.avatar_url} alt="" className="w-6 h-6 rounded-lg object-cover" referrerPolicy="no-referrer" />
        ) : (
          <div className="w-6 h-6 rounded-lg bg-emerald-600 text-white text-xs font-bold flex items-center justify-center">
            {initial}
          </div>
        )}
        <span
          className="hidden sm:flex items-center gap-1 text-[11px] font-bold"
          style={{ color: tierDef.colorSoft }}
          title={`${tierDef.label} — ${pointsBalance} points`}
        >
          <Trophy tier={tier} size={13} />
          <AnimatedNumber value={pointsBalance} />
        </span>
        <ChevronDown className="w-3 h-3 text-slate-400" />
      </button>

      {open && (
        <div className="absolute right-0 mt-2 w-72 bg-slate-900 border border-slate-700 rounded-xl shadow-2xl overflow-hidden z-[1200] anim-in-down">
          <div className="p-3 border-b border-slate-800">
            <p className="text-sm font-bold text-slate-100 truncate">
              {profile?.display_name ?? profile?.handle ?? 'Camper'}
            </p>
            <p className="text-[11px] text-slate-400 truncate">{user.email}</p>

            <div className="flex items-center gap-2 mt-2">
              <TierBadge tier={tier} />
              <span className="text-[10px] font-bold text-slate-300 flex items-center gap-1">
                <Sparkles className="w-3 h-3 text-amber-300" />
                {pointsBalance} points
              </span>
            </div>
          </div>

          {/* The big trophy, and how far it is to the next one. */}
          <div className="p-3 border-b border-slate-800">
            <div className="flex items-center gap-3">
              <Trophy tier={tier} size={44} className="shrink-0" />
              <div className="min-w-0 flex-1">
                <p className="text-xs font-bold" style={{ color: tierDef.colorSoft }}>
                  {tierDef.label}
                </p>
                <p className="text-[10px] text-slate-400 leading-snug">{tierDef.blurb}</p>
              </div>
            </div>

            <div className="flex justify-between text-[10px] text-slate-400 mt-2.5 mb-1">
              <span>Trust score {score}</span>
              {next ? (
                <span>
                  <strong className="text-slate-300">{Math.max(0, next.minScore - score)}</strong> to{' '}
                  {next.label}
                </span>
              ) : (
                <span className="text-emerald-300 font-bold">Top tier</span>
              )}
            </div>
            <div className="h-1.5 rounded-full bg-slate-800 overflow-hidden">
              <div
                className="h-full rounded-full transition-moook"
                style={{
                  width: `${progress}%`,
                  background: tierDef.isAurora
                    ? `linear-gradient(90deg, ${tierDef.color}, ${tierDef.colorSoft})`
                    : tierDef.color
                }}
              />
            </div>
          </div>

          {/* The whole ladder, so there is something to climb toward. */}
          <div className="p-3 border-b border-slate-800">
            <p className="text-[9px] font-bold text-slate-500 uppercase tracking-wider mb-2">
              The ladder
            </p>
            <div className="flex items-end justify-between gap-1">
              {TIERS.map((t) => {
                const reached = t.rank <= tierDef.rank;
                return (
                  <div
                    key={t.id}
                    className={`flex flex-col items-center gap-1 flex-1 ${reached ? '' : 'opacity-35 grayscale'}`}
                    title={`${t.label} — ${t.minScore} points`}
                  >
                    <Trophy tier={t.id} size={reached && t.rank === tierDef.rank ? 22 : 16} animate={false} />
                    <span
                      className="text-[8px] font-bold leading-none text-center"
                      style={{ color: reached ? t.colorSoft : '#64748b' }}
                    >
                      {t.label}
                    </span>
                  </div>
                );
              })}
            </div>
            <p className="text-[9px] text-slate-500 mt-2 leading-tight">
              Points come from checking in, scouting new sites, and verifying amenities.
              They are earned only — never sold.
            </p>
          </div>

          <button
            onClick={async () => { setOpen(false); await signOut(); }}
            className="w-full px-3 py-2.5 text-left text-xs font-semibold text-slate-300 hover:bg-slate-800 hover:text-rose-300 flex items-center gap-2"
          >
            <LogOut className="w-3.5 h-3.5" />
            Sign out
          </button>
        </div>
      )}
    </div>
  );
};