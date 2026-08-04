import React, { useState, useRef, useEffect } from 'react';
import { LogOut, User as UserIcon, Coins, Shield, ChevronDown, Loader2 } from 'lucide-react';
import { useAuth, TrustTier } from '../contexts/AuthContext';
import { AnimatedNumber } from './ui/Feedback';

interface UserMenuProps { onOpenAuth: () => void; }

const TIER_STYLE: Record<TrustTier, { label: string; className: string }> = {
  tourist: { label: 'Tourist', className: 'bg-slate-700/60 text-slate-300 border-slate-600' },
  contributor: { label: 'Contributor', className: 'bg-cyan-600/20 text-cyan-300 border-cyan-500/40' },
  nomad: { label: 'Nomad', className: 'bg-emerald-600/20 text-emerald-300 border-emerald-500/40' }
};

/** Points needed for the next tier, mirroring recompute_trust() in SQL. */
const NEXT_TIER_AT: Record<TrustTier, number | null> = {
  tourist: 30, contributor: 150, nomad: null
};

export const UserMenu: React.FC<UserMenuProps> = ({ onOpenAuth }) => {
  const { user, profile, tokenBalance, isLoading, isConfigured, signOut } = useAuth();
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

  const tier = profile?.trust_tier ?? 'tourist';
  const tierStyle = TIER_STYLE[tier];
  const nextAt = NEXT_TIER_AT[tier];
  const score = profile?.trust_score ?? 0;
  const progress = nextAt ? Math.min(100, Math.round((score / nextAt) * 100)) : 100;

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
        <span className="hidden sm:flex items-center gap-1 text-[11px] font-bold text-amber-300">
          <Coins className="w-3 h-3" />
          <AnimatedNumber value={tokenBalance} />
        </span>
        <ChevronDown className="w-3 h-3 text-slate-400" />
      </button>

      {open && (
        <div className="absolute right-0 mt-2 w-64 bg-slate-900 border border-slate-700 rounded-xl shadow-2xl overflow-hidden z-[1200] anim-in-down">
          <div className="p-3 border-b border-slate-800">
            <p className="text-sm font-bold text-slate-100 truncate">
              {profile?.display_name ?? profile?.handle ?? 'Camper'}
            </p>
            <p className="text-[11px] text-slate-400 truncate">{user.email}</p>

            <div className="flex items-center gap-2 mt-2">
              <span className={`px-2 py-0.5 rounded-lg border text-[10px] font-bold flex items-center gap-1 ${tierStyle.className}`}>
                <Shield className="w-2.5 h-2.5" />
                {tierStyle.label}
              </span>
              <span className="text-[10px] font-bold text-amber-300 flex items-center gap-1">
                <Coins className="w-3 h-3" />
                {tokenBalance} tokens
              </span>
            </div>
          </div>

          <div className="p-3 border-b border-slate-800">
            <div className="flex justify-between text-[10px] text-slate-400 mb-1">
              <span>Trust score {score}</span>
              {nextAt ? <span>{nextAt} for next tier</span> : <span>Max tier</span>}
            </div>
            <div className="h-1.5 rounded-full bg-slate-800 overflow-hidden">
              <div className="h-full bg-emerald-500 rounded-full transition-moook" style={{ width: `${progress}%` }} />
            </div>
            <p className="text-[9px] text-slate-500 mt-1.5 leading-tight">
              Earn trust by checking in, scouting new sites, and verifying amenities.
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
