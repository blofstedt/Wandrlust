import React, { useState } from 'react';
import { Mail, Loader2, Check, AlertCircle, Tent, KeyRound, Link2 } from 'lucide-react';
import { useAuth } from '../contexts/AuthContext';
import { Sheet } from './ui/Sheet';

interface AuthModalProps {
  isOpen: boolean;
  onClose: () => void;
}

type Mode = 'signin' | 'signup' | 'magic';

/** Google's brand mark. Inline so there's no external asset dependency. */
const GoogleMark: React.FC = () => (
  <svg width="16" height="16" viewBox="0 0 48 48" aria-hidden="true">
    <path
      fill="#FFC107"
      d="M43.6 20.1H42V20H24v8h11.3C33.7 32.7 29.3 36 24 36c-6.6 0-12-5.4-12-12s5.4-12 12-12c3.1 0 5.9 1.2 8 3.1l5.7-5.7C34.0 6.1 29.3 4 24 4 12.9 4 4 12.9 4 24s8.9 20 20 20 20-8.9 20-20c0-1.3-.1-2.6-.4-3.9z"
    />
    <path
      fill="#FF3D00"
      d="M6.3 14.7l6.6 4.8C14.7 15.1 19 12 24 12c3.1 0 5.9 1.2 8 3.1l5.7-5.7C34.0 6.1 29.3 4 24 4 16.3 4 9.7 8.3 6.3 14.7z"
    />
    <path
      fill="#4CAF50"
      d="M24 44c5.2 0 9.9-2 13.4-5.2l-6.2-5.2C29.2 35.1 26.7 36 24 36c-5.3 0-9.7-3.3-11.3-8l-6.5 5C9.6 39.6 16.2 44 24 44z"
    />
    <path
      fill="#1976D2"
      d="M43.6 20.1H42V20H24v8h11.3c-.8 2.2-2.2 4.1-4.1 5.6l6.2 5.2C39.9 36.7 44 31 44 24c0-1.3-.1-2.6-.4-3.9z"
    />
  </svg>
);

export const AuthModal: React.FC<AuthModalProps> = ({ isOpen, onClose }) => {
  const { isConfigured, signInWithGoogle, signInWithEmail, signInWithPassword, signUpWithPassword } =
    useAuth();

  const [mode, setMode] = useState<Mode>('signin');
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState<{ ok: boolean; message: string } | null>(null);

  const handleGoogle = async () => {
    setBusy(true);
    setNotice(null);
    try {
      await signInWithGoogle();
      // Browser navigates to Google; nothing to do on success.
    } catch (err: any) {
      setNotice({ ok: false, message: err.message ?? 'Google sign-in failed' });
    } finally {
      setBusy(false);
    }
  };

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!email.trim()) return;

    setBusy(true);
    setNotice(null);

    let result: { ok: boolean; message: string };
    if (mode === 'magic') {
      result = await signInWithEmail(email.trim());
    } else if (mode === 'signup') {
      if (password.length < 8) {
        setBusy(false);
        setNotice({ ok: false, message: 'Password must be at least 8 characters.' });
        return;
      }
      result = await signUpWithPassword(email.trim(), password);
    } else {
      result = await signInWithPassword(email.trim(), password);
    }

    setNotice(result);
    setBusy(false);
    if (result.ok && mode === 'signin') onClose();
  };

  return (
    <Sheet
      isOpen={isOpen}
      onClose={onClose}
      variant="dialog"
      maxWidthClass="sm:max-w-sm"
      title={mode === 'signup' ? 'Create your account' : 'Sign in to Wandrlust'}
      subtitle="Save spots, check in, and earn points"
      icon={<Tent className="w-4 h-4 text-emerald-400" />}
      /**
       * This dialog is the one panel that can be triggered from inside almost
       * any other sheet ("save this while signed out"), including several
       * mounted after it in App.tsx — DOM order alone wouldn't guarantee it
       * lands on top of those, so it asks for a higher stacking order.
       */
      zIndexClass="z-[2000]"
      /**
       * Sign-in isn't part of the Tools-panel rhythm the fixed dialog height
       * exists for (see Sheet.tsx) — it's a short, one-off interruption, and
       * the fixed height just left a mostly-empty box under it.
       */
      fitContent
    >
      {!isConfigured ? (
        <div className="p-5">
          <div className="p-3 rounded-xl bg-amber-950/50 border border-amber-700/50 flex gap-2.5">
            <AlertCircle className="w-4 h-4 text-amber-400 shrink-0 mt-0.5" />
            <div>
              <p className="text-xs font-semibold text-amber-200">
                Authentication isn&apos;t configured
              </p>
              <p className="text-xs text-amber-300/80 mt-1 leading-snug">
                Set <code className="font-mono">VITE_SUPABASE_URL</code> and{' '}
                <code className="font-mono">VITE_SUPABASE_ANON_KEY</code> in your{' '}
                <code className="font-mono">.env</code>, then restart the dev server.
              </p>
            </div>
          </div>
        </div>
      ) : (
        <div className="p-5">
          <button
            onClick={handleGoogle}
            disabled={busy}
            className="w-full flex items-center justify-center gap-2.5 px-4 py-2.5 rounded-xl bg-white hover:bg-slate-100 text-slate-800 font-semibold text-sm disabled:opacity-60"
          >
            <GoogleMark />
            Continue with Google
          </button>

          <div className="flex items-center gap-3 my-4">
            <div className="flex-1 h-px bg-slate-700" />
            <span className="text-[12px] uppercase tracking-wider text-slate-500 font-bold">or</span>
            <div className="flex-1 h-px bg-slate-700" />
          </div>

          <form onSubmit={handleSubmit} className="space-y-3">
            <div>
              <label className="text-xs font-semibold text-slate-400">Email</label>
              <input
                type="email"
                required
                value={email}
                onChange={(e) => setEmail(e.target.value)}
                placeholder="you@example.com"
                autoComplete="email"
                className="w-full mt-1 bg-slate-950 border border-slate-700 rounded-xl px-3 py-2 text-sm text-slate-100 placeholder-slate-500 focus:outline-none focus:ring-1 focus:ring-emerald-500 focus:border-emerald-500"
              />
            </div>

            {mode !== 'magic' && (
              <div>
                <label className="text-xs font-semibold text-slate-400">Password</label>
                <input
                  type="password"
                  required
                  value={password}
                  onChange={(e) => setPassword(e.target.value)}
                  placeholder={mode === 'signup' ? 'At least 8 characters' : '••••••••'}
                  autoComplete={mode === 'signup' ? 'new-password' : 'current-password'}
                  className="w-full mt-1 bg-slate-950 border border-slate-700 rounded-xl px-3 py-2 text-sm text-slate-100 placeholder-slate-500 focus:outline-none focus:ring-1 focus:ring-emerald-500 focus:border-emerald-500"
                />
              </div>
            )}

            <button
              type="submit"
              disabled={busy}
              className="w-full flex items-center justify-center gap-2 px-4 py-2.5 rounded-xl bg-emerald-600 hover:bg-emerald-500 text-white font-bold text-sm disabled:opacity-60"
            >
              {busy ? (
                <Loader2 className="w-4 h-4 animate-spin" />
              ) : mode === 'magic' ? (
                <Link2 className="w-4 h-4" />
              ) : (
                <Mail className="w-4 h-4" />
              )}
              {mode === 'magic'
                ? 'Send me a sign-in link'
                : mode === 'signup'
                ? 'Create account'
                : 'Sign in'}
            </button>
          </form>

          {notice && (
            <div
              className={`mt-3 p-2.5 rounded-xl flex gap-2 text-xs ${
                notice.ok
                  ? 'bg-emerald-950/60 border border-emerald-700/50 text-emerald-200'
                  : 'bg-rose-950/60 border border-rose-700/50 text-rose-200'
              }`}
            >
              {notice.ok ? (
                <Check className="w-3.5 h-3.5 shrink-0 mt-0.5" />
              ) : (
                <AlertCircle className="w-3.5 h-3.5 shrink-0 mt-0.5" />
              )}
              <span>{notice.message}</span>
            </div>
          )}

          <div className="mt-4 pt-3 border-t border-slate-800 flex flex-wrap gap-x-3 gap-y-1 text-xs">
            {mode !== 'magic' && (
              <button
                onClick={() => { setMode('magic'); setNotice(null); }}
                className="text-slate-400 hover:text-emerald-400 font-semibold flex items-center gap-1"
              >
                <KeyRound className="w-3 h-3" />
                Email me a link instead
              </button>
            )}
            {mode === 'magic' && (
              <button
                onClick={() => { setMode('signin'); setNotice(null); }}
                className="text-slate-400 hover:text-emerald-400 font-semibold"
              >
                Use a password instead
              </button>
            )}
            <button
              onClick={() => { setMode(mode === 'signup' ? 'signin' : 'signup'); setNotice(null); }}
              className="text-slate-400 hover:text-emerald-400 font-semibold ml-auto"
            >
              {mode === 'signup' ? 'Have an account? Sign in' : 'Create an account'}
            </button>
          </div>
        </div>
      )}
    </Sheet>
  );
};
