import React, { useEffect, useState } from 'react';
import { Loader2, AlertCircle, Tent } from 'lucide-react';
import { supabase } from '../lib/supabase';

/**
 * Landing screen for the OAuth / magic-link redirect.
 *
 * The client is configured with `detectSessionInUrl: true`, so it exchanges
 * the code automatically. This component waits for that, scrubs credentials
 * out of the address bar, and hands control back to the app.
 */
export const AuthCallback: React.FC = () => {
  const [status, setStatus] = useState<'working' | 'error'>('working');
  const [message, setMessage] = useState('Finishing sign-in…');

  useEffect(() => {
    let cancelled = false;

    const finish = async () => {
      if (!supabase) {
        setStatus('error');
        setMessage('Supabase is not configured.');
        return;
      }

      // Providers report failures in the query string or the hash fragment.
      const query = new URLSearchParams(window.location.search);
      const hash = new URLSearchParams(window.location.hash.replace(/^#/, ''));
      const providerError =
        query.get('error_description') ?? query.get('error') ??
        hash.get('error_description') ?? hash.get('error');

      if (providerError) {
        if (cancelled) return;
        setStatus('error');
        setMessage(decodeURIComponent(providerError));
        return;
      }

      const { data, error } = await supabase.auth.getSession();
      if (cancelled) return;

      if (error) { setStatus('error'); setMessage(error.message); return; }

      if (!data.session) {
        // PKCE exchange can land a beat after mount; give it one retry.
        await new Promise((r) => setTimeout(r, 800));
        const retry = await supabase.auth.getSession();
        if (cancelled) return;
        if (!retry.data.session) {
          setStatus('error');
          setMessage('No session was returned. Try signing in again.');
          return;
        }
      }

      // Never leave tokens sitting in the address bar or browser history.
      window.history.replaceState({}, document.title, '/');
      window.location.replace('/');
    };

    finish();
    return () => { cancelled = true; };
  }, []);

  return (
    <div className="min-h-screen bg-slate-950 flex items-center justify-center p-6">
      <div className="w-full max-w-sm bg-slate-900 border border-slate-800 rounded-2xl p-6 text-center anim-expand">
        <div className="inline-flex p-3 rounded-2xl bg-emerald-600/20 border border-emerald-500/40 mb-4">
          <Tent className="w-5 h-5 text-emerald-400" />
        </div>

        {status === 'working' ? (
          <>
            <Loader2 className="w-5 h-5 text-emerald-400 animate-spin mx-auto mb-3" />
            <p className="text-sm font-semibold text-slate-200">{message}</p>
          </>
        ) : (
          <>
            <AlertCircle className="w-5 h-5 text-rose-400 mx-auto mb-3" />
            <p className="text-sm font-semibold text-slate-200 mb-1">Sign-in didn&apos;t complete</p>
            <p className="text-xs text-slate-400 mb-4 leading-snug">{message}</p>
            <a
              href="/"
              className="inline-block px-4 py-2 rounded-xl bg-emerald-600 hover:bg-emerald-500 text-white font-bold text-xs"
            >
              Back to the map
            </a>
          </>
        )}
      </div>
    </div>
  );
};