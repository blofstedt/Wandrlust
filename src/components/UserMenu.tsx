import React, { useState, useRef, useEffect } from 'react';
import { LogOut, User as UserIcon, Sparkles, ChevronDown, Loader2 } from 'lucide-react';
import { useAuth } from '../contexts/AuthContext';
import { AnimatedNumber } from './ui/Feedback';
import { Trophy, TierBadge } from './ui/Trophy';
import { TIERS, TIER_BY_ID, DEFAULT_TIER, nextTier, tierProgress } from '../config/tiers';

interface UserMenuProps {
  onOpenAuth: () => void;
  /**
   * `bar` is the header pill — avatar, points, chevron, room to breathe.
   * `fab` is the round 44px button that rides in the map's control stack on a
   * phone, where it has to be the same shape and weight as layers and locate
   * or it reads as a stray element sitting on the map.
   */
  variant?: 'bar' | 'fab';
  /**
   * Which way the panel opens. The map stack sits at the bottom of the
   * screen, and a menu that drops DOWN from there is a menu off the bottom
   * edge of the phone.
   */
  placement?: 'down' | 'up';
}

export const UserMenu: React.FC<UserMenuProps> = ({
  onOpenAuth, variant = 'bar', placement = 'down'
}) => {
  const { user, profile, pointsBalance, isLoading, isConfigured, signOut } = useAuth();
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement | null>(null);

  const fab = variant === 'fab';
  /* Same glass, border and size as the layers and locate buttons beside it. */
  const fabShell =
    'tap-safe w-11 h-11 rounded-full bg-slate-900/90 backdrop-blur-md border ' +
    'border-slate-700/80 shadow-xl flex items-center justify-center overflow-hidden';

  /*
   * `touchstart` as well as `mousedown`. iOS only synthesises mouse events for
   * elements it considers clickable, so tapping the MAP to dismiss this — the
   * obvious gesture once the button lives on the map — produced no mousedown
   * at all and the panel just sat there.
   */
  useEffect(() => {
    const onPointerDownOutside = (e: MouseEvent | TouchEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener('mousedown', onPointerDownOutside);
    document.addEventListener('touchstart', onPointerDownOutside);
    return () => {
      document.removeEventListener('mousedown', onPointerDownOutside);
      document.removeEventListener('touchstart', onPointerDownOutside);
    };
  }, []);

  if (isLoading) {
    return fab ? (
      <div className={`${fabShell} text-slate-400`}>
        <Loader2 className="w-[18px] h-[18px] animate-spin" />
      </div>
    ) : (
      <div className="p-2 rounded-xl bg-slate-800/80 border border-slate-700">
        <Loader2 className="w-4 h-4 text-slate-400 animate-spin" />
      </div>
    );
  }

  if (!user) {
    return fab ? (
      <button
        onClick={onOpenAuth}
        className={`${fabShell} text-slate-200 hover:text-white hover:bg-slate-800`}
        aria-label={isConfigured ? 'Sign in' : 'Authentication not configured'}
      >
        <UserIcon className="w-[18px] h-[18px]" />
      </button>
    ) : (
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
      {fab ? (
        /* The avatar fills the button, so what a thumb sees is a face rather
           than an icon of a face. The tier ring around it is the only badge
           there is room for at this size — the points, the ladder and the
           name are all one tap away inside. */
        <button
          onClick={() => setOpen((v) => !v)}
          className={fabShell}
          style={{ borderColor: tierDef.colorSoft }}
          aria-label={`Your account — ${tierDef.label}, ${pointsBalance} points`}
          aria-expanded={open}
        >
          {profile?.avatar_url ? (
            <img src={profile.avatar_url} alt="" className="w-full h-full object-cover" referrerPolicy="no-referrer" />
          ) : (
            <span className="w-full h-full bg-emerald-600 text-white text-sm font-extrabold flex items-center justify-center">
              {initial}
            </span>
          )}
        </button>
      ) : (
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
            className="hidden sm:flex items-center gap-1 text-xs font-bold"
            style={{ color: tierDef.colorSoft }}
            title={`${tierDef.label} — ${pointsBalance} points`}
          >
            <Trophy tier={tier} size={13} />
            <AnimatedNumber value={pointsBalance} />
          </span>
          <ChevronDown className="w-3 h-3 text-slate-400" />
        </button>
      )}

      {open && (
        <div
          className={`absolute right-0 w-72 max-h-[70vh] overflow-y-auto overscroll-contain scroll-soft bg-slate-900 border border-slate-700 rounded-xl shadow-2xl z-[1200] ${
            placement === 'up' ? 'bottom-full mb-2 anim-in-up' : 'mt-2 anim-in-down'
          }`}
        >
          <div className="p-3 border-b border-slate-800">
            <p className="text-sm font-bold text-slate-100 truncate">
              {profile?.display_name ?? profile?.handle ?? 'Camper'}
            </p>
            <p className="text-xs text-slate-400 truncate">{user.email}</p>

            <div className="flex items-center gap-2 mt-2">
              <TierBadge tier={tier} />
              <span className="text-[12px] font-bold text-slate-300 flex items-center gap-1">
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
                <p className="text-[12px] text-slate-400 leading-snug">{tierDef.blurb}</p>
              </div>
            </div>

            <div className="flex justify-between text-[12px] text-slate-400 mt-2.5 mb-1">
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
            <p className="text-[11px] font-bold text-slate-500 uppercase tracking-wider mb-2">
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
                      className="text-[10px] font-bold leading-none text-center"
                      style={{ color: reached ? t.colorSoft : '#64748b' }}
                    >
                      {t.label}
                    </span>
                  </div>
                );
              })}
            </div>
            <p className="text-[11px] text-slate-500 mt-2 leading-tight">
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
