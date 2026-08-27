import React, { useEffect, useState } from 'react';
import {
  Map as MapIcon, Download, BellRing, Route, Share, Plus, Check,
  ShieldQuestion, Signal
} from 'lucide-react';
import { PublicPage } from './PublicPage';
import { BrandMark } from './ui/BrandMark';

/**
 * `/home` — the page somebody lands on who has never seen the app.
 *
 * ---------------------------------------------------------------------------
 * WHAT THIS PAGE IS ALLOWED TO PROMISE
 * ---------------------------------------------------------------------------
 *
 * Everything the app refuses to overstate on the map, it also refuses to
 * overstate here. Marketing copy is where an honest app usually stops being
 * honest — "know exactly where you can camp" would convert better than
 * anything written below, and would be a lie about approximate boundaries
 * drawn from generalised government data.
 *
 * So the limits get their own section, above the fold on a phone, in the same
 * type size as the features. That is not a legal hedge bolted on at the
 * bottom; on this app it is the actual pitch. Anyone can draw a green blob
 * over a forest. Saying which blobs are guesses is the product.
 */

/** The `beforeinstallprompt` event, which TypeScript's DOM lib has no type for. */
interface InstallPromptEvent extends Event {
  prompt: () => Promise<void>;
  userChoice: Promise<{ outcome: 'accepted' | 'dismissed' }>;
}

const isStandalone = (): boolean => {
  try {
    return (
      window.matchMedia('(display-mode: standalone)').matches ||
      (navigator as unknown as { standalone?: boolean }).standalone === true
    );
  } catch {
    return false;
  }
};

const isIos = (): boolean => /iphone|ipad|ipod/i.test(navigator.userAgent);

export const LandingPage: React.FC = () => {
  /**
   * Chrome hands over an install prompt; Safari never will.
   *
   * So there are three states and the page has to tell them apart rather than
   * drawing one button that works on some phones. A button that does nothing
   * is worse than instructions that do.
   */
  const [installEvent, setInstallEvent] = useState<InstallPromptEvent | null>(null);
  const [installed, setInstalled] = useState(false);

  useEffect(() => {
    setInstalled(isStandalone());

    const onPrompt = (event: Event) => {
      // Keep it: calling `prompt()` later is what puts the install sheet up on
      // a tap, which is the only moment a browser will honour it.
      event.preventDefault();
      setInstallEvent(event as InstallPromptEvent);
    };
    const onInstalled = () => { setInstalled(true); setInstallEvent(null); };

    window.addEventListener('beforeinstallprompt', onPrompt);
    window.addEventListener('appinstalled', onInstalled);
    return () => {
      window.removeEventListener('beforeinstallprompt', onPrompt);
      window.removeEventListener('appinstalled', onInstalled);
    };
  }, []);

  const install = async () => {
    if (!installEvent) return;
    await installEvent.prompt();
    const { outcome } = await installEvent.userChoice;
    if (outcome === 'accepted') setInstalled(true);
    // A browser will not replay the same prompt, so it goes either way.
    setInstallEvent(null);
  };

  const CARD = 'rounded-2xl bg-slate-900 border border-slate-800 p-5';
  const TILE = 'w-10 h-10 rounded-xl border flex items-center justify-center shrink-0';

  return (
    <PublicPage title="Free camping on public land" bare>
      {/* ------------------------------------------------------------ */}
      {/* Hero                                                          */}
      {/* ------------------------------------------------------------ */}
      <section className="pt-2 pb-8">
        <BrandMark size={64} className="rounded-2xl shadow-xl shadow-emerald-900/40 mb-5" />

        <h1 className="font-['Outfit'] font-extrabold text-3xl sm:text-4xl leading-tight text-slate-50">
          Find free camping on public land.
        </h1>

        <p className="text-base text-slate-300 leading-relaxed mt-4 max-w-xl">
          Wandrlust maps dispersed camping on BLM, National Forest and Canadian Crown
          land — with offline maps for where there’s no signal, and live fire, flood
          and storm alerts for where there is.
        </p>

        <p className="text-sm text-slate-400 leading-relaxed mt-3 max-w-xl">
          No reservations, no fees, no account needed to look around. It’s free, and
          it stays free.
        </p>

        <div className="flex flex-wrap gap-2.5 mt-6">
          {installed ? (
            <span className="inline-flex items-center gap-2 h-11 px-4 rounded-xl bg-emerald-950/60 border border-emerald-700/50 text-emerald-200 text-sm font-bold">
              <Check className="w-4 h-4" />
              Installed on this device
            </span>
          ) : installEvent ? (
            <button
              onClick={install}
              className="inline-flex items-center gap-2 h-11 px-5 rounded-xl bg-emerald-600 hover:bg-emerald-500 text-white text-sm font-bold transition-colors"
            >
              <Download className="w-4 h-4" />
              Install Wandrlust
            </button>
          ) : null}

          <a
            href="/"
            className={`inline-flex items-center gap-2 h-11 px-5 rounded-xl text-sm font-bold transition-colors ${
              installed || installEvent
                ? 'bg-slate-800 hover:bg-slate-700 text-slate-100'
                : 'bg-emerald-600 hover:bg-emerald-500 text-white'
            }`}
          >
            <MapIcon className="w-4 h-4" />
            Open the map
          </a>
        </div>
      </section>

      {/* ------------------------------------------------------------ */}
      {/* What it does                                                  */}
      {/* ------------------------------------------------------------ */}
      <section className="grid gap-3 sm:grid-cols-2">
        <div className={CARD}>
          <div className={`${TILE} bg-emerald-500/15 text-emerald-400 border-emerald-500/30 mb-3`}>
            <MapIcon className="w-5 h-5" />
          </div>
          <h2 className="font-bold text-slate-100">Public land, drawn out</h2>
          <p className="text-sm text-slate-400 leading-relaxed mt-1.5">
            BLM, National Forest and Crown land across the lower 48 and Canada, pulled
            from the agencies that publish it. Tap any of it to see who manages it and
            what the camping rules probably are.
          </p>
        </div>

        <div className={CARD}>
          <div className={`${TILE} bg-sky-500/15 text-sky-400 border-sky-500/30 mb-3`}>
            <Download className="w-5 h-5" />
          </div>
          <h2 className="font-bold text-slate-100">Works with no signal</h2>
          <p className="text-sm text-slate-400 leading-relaxed mt-1.5">
            Download the map before you go and it keeps working down a canyon with no
            bars — boundaries, your saved spots and the tiles under them, all stored on
            your phone.
          </p>
        </div>

        <div className={CARD}>
          <div className={`${TILE} bg-amber-500/15 text-amber-400 border-amber-500/30 mb-3`}>
            <BellRing className="w-5 h-5" />
          </div>
          <h2 className="font-bold text-slate-100">Fire, flood and storm alerts</h2>
          <p className="text-sm text-slate-400 leading-relaxed mt-1.5">
            Official warnings from the National Weather Service and Environment Canada
            for the ground you’re actually standing on, plus active fire perimeters and
            the fire bans that come with them.
          </p>
        </div>

        <div className={CARD}>
          <div className={`${TILE} bg-orange-500/15 text-orange-400 border-orange-500/30 mb-3`}>
            <Route className="w-5 h-5" />
          </div>
          <h2 className="font-bold text-slate-100">The roads to get there</h2>
          <p className="text-sm text-slate-400 leading-relaxed mt-1.5">
            Gravel, dirt and two-track drawn separately from pavement, so you can see
            the way in before you commit a van to it. Record how rough a road was as
            you drive it and it colours in on your own map.
          </p>
        </div>
      </section>

      {/* ------------------------------------------------------------ */}
      {/* The limits — the actual pitch                                 */}
      {/* ------------------------------------------------------------ */}
      <section className="mt-8 rounded-2xl bg-slate-900 border border-slate-800 p-5 sm:p-6">
        <div className="flex items-center gap-2.5 mb-3">
          <ShieldQuestion className="w-5 h-5 text-emerald-400 shrink-0" />
          <h2 className="font-['Outfit'] font-bold text-xl text-slate-100">
            What it won’t pretend to know
          </h2>
        </div>

        <p className="text-sm text-slate-300 leading-relaxed">
          Most camping apps draw a confident line and let you find out the hard way.
          This one tells you how sure it is, everywhere, because the difference
          matters when you’re deciding whether to drive through a gate.
        </p>

        <ul className="space-y-2.5 mt-4">
          {[
            ['Boundaries are approximate.', 'They come from generalised government data and can be a good distance out. Every parcel says how rough its edges are.'],
            ['A green shape is not permission.', 'Camping rules are set locally and change. The app infers what they probably are; a sign on the ground beats it every time.'],
            ['A blank map means no data, never “private land”.', 'Coverage has real gaps — Quebec and Newfoundland among them — and the app names them instead of drawing empty country.'],
            ['Alerts can fail.', 'When a weather or fire service doesn’t answer, it says so rather than showing you an all-clear it hasn’t got.']
          ].map(([bold, rest]) => (
            <li key={bold} className="flex gap-2.5 text-sm text-slate-400 leading-relaxed">
              <span aria-hidden="true" className="text-emerald-500 shrink-0 mt-0.5">•</span>
              <span><strong className="text-slate-200 font-semibold">{bold}</strong> {rest}</span>
            </li>
          ))}
        </ul>
      </section>

      {/* ------------------------------------------------------------ */}
      {/* Install                                                       */}
      {/* ------------------------------------------------------------ */}
      <section className="mt-8 rounded-2xl bg-slate-900 border border-slate-800 p-5 sm:p-6">
        <div className="flex items-center gap-2.5 mb-3">
          <Signal className="w-5 h-5 text-sky-400 shrink-0" />
          <h2 className="font-['Outfit'] font-bold text-xl text-slate-100">
            Put it on your phone
          </h2>
        </div>

        <p className="text-sm text-slate-300 leading-relaxed">
          Wandrlust installs straight from the browser — no app store, no download
          queue. Installed, it opens full screen, keeps your offline maps, and can send
          you hazard alerts.
        </p>

        {installed ? (
          <p className="text-sm text-emerald-300 leading-relaxed mt-4 font-semibold">
            You’ve already got it installed on this device.
          </p>
        ) : installEvent ? (
          <button
            onClick={install}
            className="mt-4 inline-flex items-center gap-2 h-11 px-5 rounded-xl bg-emerald-600 hover:bg-emerald-500 text-white text-sm font-bold transition-colors"
          >
            <Download className="w-4 h-4" />
            Install Wandrlust
          </button>
        ) : isIos() ? (
          /*
            iOS has no install prompt to offer, and never has. Telling an
            iPhone owner to press a button that cannot exist is worse than
            telling them where the menu is.
          */
          <ol className="space-y-2 mt-4">
            <li className="flex gap-2.5 text-sm text-slate-400 leading-relaxed">
              <Share className="w-4 h-4 text-sky-400 shrink-0 mt-0.5" />
              <span>Tap the <strong className="text-slate-200">Share</strong> button in Safari’s toolbar.</span>
            </li>
            <li className="flex gap-2.5 text-sm text-slate-400 leading-relaxed">
              <Plus className="w-4 h-4 text-sky-400 shrink-0 mt-0.5" />
              <span>Choose <strong className="text-slate-200">Add to Home Screen</strong>.</span>
            </li>
            <li className="flex gap-2.5 text-sm text-slate-400 leading-relaxed">
              <Check className="w-4 h-4 text-sky-400 shrink-0 mt-0.5" />
              <span>
                Open it from the icon. On iPhone, hazard notifications only work once
                it’s installed this way.
              </span>
            </li>
          </ol>
        ) : (
          <p className="text-sm text-slate-400 leading-relaxed mt-4">
            On a phone, open this page in Chrome or Safari and use the browser menu —
            “Install app” on Android, “Add to Home Screen” on iPhone.
          </p>
        )}
      </section>

      <section className="mt-8">
        <a
          href="/"
          className="w-full sm:w-auto inline-flex items-center justify-center gap-2 h-12 px-6 rounded-xl bg-emerald-600 hover:bg-emerald-500 text-white text-sm font-bold transition-colors"
        >
          <MapIcon className="w-4 h-4" />
          Open the map
        </a>
      </section>
    </PublicPage>
  );
};
