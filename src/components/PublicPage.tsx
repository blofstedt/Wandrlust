import React from 'react';
import { ArrowLeft } from 'lucide-react';
import { BrandMark } from './ui/BrandMark';

/**
 * The shell around the three pages that exist outside the app.
 *
 * ---------------------------------------------------------------------------
 * WHY THERE ARE PAGES OUTSIDE THE APP AT ALL
 * ---------------------------------------------------------------------------
 *
 * Google's OAuth branding review will not verify a sign-in button without a
 * home page, a privacy policy and terms of service, each reachable at a plain
 * public URL on the same domain, with nobody signed in. The app is a map that
 * opens at `/`; none of those three things is a map. So they are their own
 * pages at `/home`, `/privacy` and `/terms`.
 *
 * They are not a separate website. Same palette, same Outfit headings, same
 * rounded cards and safe-area handling as everything else — somebody who taps
 * "Privacy" inside the app and lands here should not feel they have left.
 *
 * ---------------------------------------------------------------------------
 * NO ROUTER
 * ---------------------------------------------------------------------------
 *
 * `src/main.tsx` branches on `window.location.pathname`, and these pages are
 * three more branches on it. Links between them are ordinary `<a href>` full
 * page loads, which is correct here and not a shortcut: these are documents,
 * they are visited once, and a document that loads in one request is a
 * document a verification reviewer and a search crawler can both read.
 */

interface PublicPageProps {
  /** Sits in the browser tab and at the top of the page. */
  title: string;
  /** One line under the title. Optional — the landing page has its own hero. */
  subtitle?: string;
  /** Hide the inner title block when the page draws its own opening. */
  bare?: boolean;
  children: React.ReactNode;
}

export const PublicPage: React.FC<PublicPageProps> = ({
  title, subtitle, bare = false, children
}) => {
  React.useEffect(() => {
    document.title = `${title} — Wandrlust`;
  }, [title]);

  return (
    <div
      className="min-h-[100dvh] bg-slate-950 text-slate-100 font-['Plus_Jakarta_Sans',sans-serif]
                 pl-[env(safe-area-inset-left)] pr-[env(safe-area-inset-right)]"
    >
      {/*
        The header owns the cut-out, the same way the app's own does — its
        background runs up behind the clock instead of leaving a blank strip
        above it. See the note in Navbar.tsx.

        Logo only — no "Open the map" here. The landing page already puts one
        clear version of that button in its hero, and a second copy up here
        competed with it instead of reinforcing it. `/privacy` and `/terms`
        keep a way back to the app too: the footer's "The map" link below,
        and `BackHome` at the foot of the document itself.
      */}
      <header
        className="sticky top-0 z-50 bg-slate-900/95 backdrop-blur-md border-b border-slate-800
                   px-4 sm:px-6 pb-3 pt-[calc(0.75rem+env(safe-area-inset-top))]"
      >
        <div className="max-w-3xl mx-auto flex items-center gap-3">
          <a href="/home" className="flex items-center gap-2.5 min-w-0">
            <BrandMark size={34} className="shrink-0 rounded-xl shadow-lg shadow-emerald-900/40" />
            <span className="font-['Outfit'] font-extrabold text-lg tracking-tight bg-gradient-to-r from-emerald-400 via-teal-200 to-amber-300 bg-clip-text text-transparent">
              Wandrlust
            </span>
          </a>
        </div>
      </header>

      <main className="max-w-3xl mx-auto px-4 sm:px-6 py-8">
        {!bare && (
          <div className="mb-6">
            <h1 className="font-['Outfit'] font-extrabold text-3xl text-slate-50">{title}</h1>
            {subtitle && (
              <p className="text-sm text-slate-400 leading-relaxed mt-2">{subtitle}</p>
            )}
          </div>
        )}
        {children}
      </main>

      <footer className="border-t border-slate-800 mt-8">
        <div
          className="max-w-3xl mx-auto px-4 sm:px-6 py-8
                     pb-[calc(2rem+env(safe-area-inset-bottom))]"
        >
          <nav className="flex flex-wrap gap-x-5 gap-y-2 text-xs font-semibold">
            <a href="/home" className="text-slate-400 hover:text-slate-100">Home</a>
            <a href="/privacy" className="text-slate-400 hover:text-slate-100">Privacy</a>
            <a href="/terms" className="text-slate-400 hover:text-slate-100">Terms</a>
            <a href="/" className="text-slate-400 hover:text-slate-100">The map</a>
          </nav>
          <p className="text-[12px] text-slate-500 leading-relaxed mt-4">
            Wandrlust shows approximate public land boundaries and community reports.
            It is a planning aid, not permission to camp and not a safety service —
            always check the signs on the ground.
          </p>
        </div>
      </footer>
    </div>
  );
};

/** Back-to-the-top-of-the-site link, used at the foot of the legal pages. */
export const BackHome: React.FC = () => (
  <a
    href="/home"
    className="mt-8 inline-flex items-center gap-1.5 text-xs font-bold text-slate-400 hover:text-slate-100"
  >
    <ArrowLeft className="w-3.5 h-3.5" />
    Back to the home page
  </a>
);
