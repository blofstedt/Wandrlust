import React, { useState, useEffect } from 'react';
import {
  Shield, FileText, AlertTriangle, Check, Loader2, ExternalLink, Compass
} from 'lucide-react';
import { supabase } from '../lib/supabase';
import { useAuth } from '../contexts/AuthContext';

/**
 * First-run legal acceptance.
 *
 * Blocks the app until the user has accepted the current versions. Acceptance
 * is recorded per DOCUMENT VERSION, so amending the terms re-prompts everyone
 * rather than silently claiming they agreed to text that didn't exist when
 * they signed up.
 *
 * The safety disclaimer is shown as prose, not a checkbox buried in a wall of
 * legalese. If someone is going to rely on this app in the backcountry, the
 * "this is a tool, not a guardian angel" message needs to actually land.
 */

interface PendingDoc {
  document_id: number;
  kind: 'privacy_policy' | 'terms_of_service' | 'safety_disclaimer';
  version: string;
  summary: string;
}

interface LegalGateProps {
  onOpenFullText: (kind: PendingDoc['kind']) => void;
}

export const LegalGate: React.FC<LegalGateProps> = ({ onOpenFullText }) => {
  const { user } = useAuth();
  const [pending, setPending] = useState<PendingDoc[]>([]);
  const [checked, setChecked] = useState(false);
  const [busy, setBusy] = useState(false);
  const [loaded, setLoaded] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!user || !supabase) {
      setLoaded(true);
      return;
    }
    let cancelled = false;

    supabase
      .rpc('pending_legal_documents', { in_user: user.id })
      .then(({ data, error: rpcError }) => {
        if (cancelled) return;
        if (rpcError) setError(rpcError.message);
        setPending(Array.isArray(data) ? data : []);
        setLoaded(true);
      });

    return () => {
      cancelled = true;
    };
  }, [user]);

  const accept = async () => {
    if (!supabase || !checked) return;
    setBusy(true);
    setError(null);

    const { error: rpcError } = await supabase.rpc('accept_legal_documents', {
      in_user_agent: navigator.userAgent.slice(0, 300)
    });

    setBusy(false);
    if (rpcError) {
      setError(rpcError.message);
      return;
    }
    setPending([]);
  };

  // Nothing to show: not signed in, still loading, or already accepted.
  if (!user || !loaded || pending.length === 0) return null;

  return (
    <div className="fixed inset-0 z-[4000] bg-slate-950/90 backdrop-blur-sm flex items-center justify-center p-4 anim-backdrop">
      <div
        role="dialog"
        aria-modal="true"
        aria-labelledby="legal-gate-title"
        className="w-full max-w-md bg-slate-900 border border-slate-700 rounded-2xl shadow-2xl max-h-[90vh] flex flex-col anim-expand"
      >
        <header className="p-5 pb-3 shrink-0">
          <div className="flex items-center gap-2.5 mb-1">
            <div className="p-2 rounded-xl bg-emerald-600/20 border border-emerald-500/40">
              <Compass className="w-4 h-4 text-emerald-400" />
            </div>
            <h2 id="legal-gate-title" className="text-base font-bold text-slate-100">
              Before you head out
            </h2>
          </div>
          <p className="text-[11px] text-slate-400 leading-snug">
            Two minutes, once. Please actually read the middle bit.
          </p>
        </header>

        <div className="flex-1 overflow-y-auto px-5 space-y-3 scroll-soft">
          {/* The message that matters most */}
          <section className="rounded-xl border border-amber-700/50 bg-amber-950/40 p-3.5">
            <div className="flex items-center gap-2 mb-2">
              <AlertTriangle className="w-4 h-4 text-amber-400 shrink-0" />
              <h3 className="text-xs font-bold text-amber-200">
                Wandrlust is a tool, not a guardian angel
              </h3>
            </div>
            <div className="space-y-2 text-[11px] text-amber-100/90 leading-relaxed">
              <p>
                This app is built to <strong>augment</strong> your overlanding — not to
                keep you safe. It cannot summon help, it does not monitor you, and if
                nobody hears from you, it will not notice.
              </p>
              <p>
                <strong>Land boundaries are approximate.</strong> They are agency
                management areas, not surveyed property lines. That is why edges are
                drawn as a fade instead of a line. Near a boundary, assume you may be on
                private land.
              </p>
              <p>
                <strong>Alerts can fail.</strong> No signal, dead battery, push service
                outage — any of these mean a fire or flood warning never reaches you.
                Carry a satellite communicator if a missed alert would matter.
              </p>
              <p className="font-semibold">
                Use it to inform your decisions. Never to replace your own judgement.
              </p>
            </div>
          </section>

          {/* Privacy, in plain language */}
          <section className="rounded-xl border border-slate-700 bg-slate-800/50 p-3.5">
            <div className="flex items-center gap-2 mb-2">
              <Shield className="w-4 h-4 text-emerald-400 shrink-0" />
              <h3 className="text-xs font-bold text-slate-200">Your data</h3>
            </div>
            <p className="text-[11px] text-slate-300 leading-relaxed">
              We store your name, username, email, password and location so the app can
              work. Your password is hashed — we cannot read it. Shared location is
              rounded to about a kilometre before anyone else sees it, and presence
              records expire after four hours.
            </p>
            <p className="text-[11px] text-emerald-300 font-semibold mt-2">
              We never sell your data and never share it with third-party vendors.
            </p>
          </section>

          {/* Document links */}
          <section className="space-y-1.5">
            {pending.map((doc) => (
              <button
                key={doc.document_id}
                onClick={() => onOpenFullText(doc.kind)}
                className="w-full flex items-center justify-between gap-2 px-3 py-2 rounded-xl bg-slate-800/60 border border-slate-700 hover:border-slate-600 text-left transition-moook"
              >
                <span className="flex items-center gap-2 min-w-0">
                  <FileText className="w-3.5 h-3.5 text-slate-400 shrink-0" />
                  <span className="text-[11px] font-semibold text-slate-200 truncate">
                    {doc.kind === 'privacy_policy'
                      ? 'Privacy Policy'
                      : doc.kind === 'terms_of_service'
                      ? 'Terms of Service'
                      : 'Safety Disclaimer'}
                  </span>
                  <span className="text-[10px] text-slate-500 shrink-0">
                    v{doc.version}
                  </span>
                </span>
                <ExternalLink className="w-3 h-3 text-slate-500 shrink-0" />
              </button>
            ))}
          </section>

          {error && (
            <p className="text-[11px] text-rose-300 bg-rose-950/50 border border-rose-800/50 rounded-lg p-2">
              {error}
            </p>
          )}
        </div>

        <footer className="p-5 pt-3 shrink-0 border-t border-slate-800 mt-3">
          <label className="flex items-start gap-2.5 cursor-pointer mb-3 group">
            <input
              type="checkbox"
              checked={checked}
              onChange={(e) => setChecked(e.target.checked)}
              className="accent-emerald-500 w-4 h-4 mt-0.5 shrink-0"
            />
            <span className="text-[11px] text-slate-300 leading-snug group-hover:text-slate-200">
              I understand Wandrlust is a planning tool and that I am responsible for my
              own safety. I accept the Terms of Service and Privacy Policy.
            </span>
          </label>

          <button
            onClick={accept}
            disabled={!checked || busy}
            className="w-full px-4 py-2.5 rounded-xl bg-emerald-600 hover:bg-emerald-500 disabled:bg-slate-700 disabled:text-slate-500 text-white font-bold text-sm flex items-center justify-center gap-2 transition-moook"
          >
            {busy ? (
              <Loader2 className="w-4 h-4 animate-spin" />
            ) : (
              <Check className="w-4 h-4" />
            )}
            Agree and continue
          </button>
        </footer>
      </div>
    </div>
  );
};

/* ------------------------------------------------------------------ */
/* Full-text viewer                                                    */
/* ------------------------------------------------------------------ */

export const LegalDocumentModal: React.FC<{
  kind: 'privacy_policy' | 'terms_of_service' | 'safety_disclaimer' | null;
  onClose: () => void;
}> = ({ kind, onClose }) => {
  const [body, setBody] = useState<string>('');
  const [loading, setLoading] = useState(false);

  useEffect(() => {
    if (!kind) return;
    setLoading(true);

    // Documents ship as static markdown so they're readable offline.
    const file =
      kind === 'privacy_policy'
        ? '/legal/privacy-policy.md'
        : kind === 'terms_of_service'
        ? '/legal/terms-of-service.md'
        : '/legal/safety-disclaimer.md';

    fetch(file)
      .then((r) => (r.ok ? r.text() : 'Document unavailable.'))
      .then((t) => {
        setBody(t);
        setLoading(false);
      })
      .catch(() => {
        setBody('Document unavailable offline.');
        setLoading(false);
      });
  }, [kind]);

  if (!kind) return null;

  const title =
    kind === 'privacy_policy'
      ? 'Privacy Policy'
      : kind === 'terms_of_service'
      ? 'Terms of Service'
      : 'Safety Disclaimer';

  return (
    <div
      className="fixed inset-0 z-[4100] bg-slate-950/90 backdrop-blur-sm flex items-center justify-center p-4 anim-backdrop"
      onMouseDown={(e) => e.target === e.currentTarget && onClose()}
    >
      <div
        role="dialog"
        aria-modal="true"
        aria-label={title}
        className="w-full max-w-2xl bg-slate-900 border border-slate-700 rounded-2xl shadow-2xl max-h-[88vh] flex flex-col anim-expand"
      >
        <header className="flex items-center justify-between p-4 border-b border-slate-800 shrink-0">
          <h2 className="text-sm font-bold text-slate-100">{title}</h2>
          <button
            onClick={onClose}
            className="px-2 text-slate-500 hover:text-slate-100 text-sm font-bold"
            aria-label="Close"
          >
            ✕
          </button>
        </header>

        <div className="flex-1 overflow-y-auto p-5 scroll-soft">
          {loading ? (
            <div className="flex justify-center py-10">
              <Loader2 className="w-5 h-5 animate-spin text-slate-500" />
            </div>
          ) : (
            <pre className="text-[12px] text-slate-300 leading-relaxed whitespace-pre-wrap font-sans">
              {body}
            </pre>
          )}
        </div>
      </div>
    </div>
  );
};
