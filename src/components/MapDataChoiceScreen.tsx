import React, { useEffect, useState } from 'react';
import { Download, Zap, AlertTriangle, Check, Loader2, WifiOff } from 'lucide-react';
import {
  MapDataChoice,
  PackManifest,
  PackProgress,
  fetchPackManifest,
  downloadLandPack,
  setMapDataChoice
} from '../services/landOverlayService';
import { haptic, stagger } from '../utils/animation';

/**
 * The first-run map data choice.
 *
 * ---------------------------------------------------------------------------
 * WHY THIS IS NOT A `Sheet`, WHICH IS THE HOUSE PRIMITIVE FOR DIALOGS
 * ---------------------------------------------------------------------------
 *
 * `ui/Sheet.tsx` is the right answer for anything a camper can dismiss, and it
 * does the accessibility work properly. It also always offers a way out —
 * Escape, a backdrop press, a close button — and this screen must not have
 * one. A camper who taps past it would be carrying whichever map data the app
 * silently defaulted to, which is precisely the ambiguity the screen exists to
 * remove.
 *
 * So: a purpose-built first-run gate that does the same accessibility work
 * (dialog role, focus in, tab containment) minus the exits. It appears once,
 * and afterwards the same choice lives in the offline settings where it IS
 * dismissible and Sheet is used normally.
 *
 * ---------------------------------------------------------------------------
 * THE WARNING IS THE POINT
 * ---------------------------------------------------------------------------
 *
 * The quick map is generalised by about a kilometre and drops small parcels.
 * That is fine when there is signal, because real boundaries stream in over
 * the top of it. With no signal there is nothing to stream, and the coarse
 * shape is all the camper has — which is the exact moment they are most likely
 * to be standing at a gate deciding whether to drive through it.
 *
 * So the quick option says so, in those words, before it is chosen and again
 * in settings afterwards. It is not a footnote and it does not get softened.
 */

interface MapDataChoiceScreenProps {
  onChosen: (choice: Exclude<MapDataChoice, null>) => void;
}

export const MapDataChoiceScreen: React.FC<MapDataChoiceScreenProps> = ({ onChosen }) => {
  const [manifest, setManifest] = useState<PackManifest | null>(null);
  const [progress, setProgress] = useState<PackProgress | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    fetchPackManifest().then((result) => {
      if (!cancelled) setManifest(result);
    });
    return () => {
      cancelled = true;
    };
  }, []);

  const chooseQuick = async () => {
    haptic('tap');
    await setMapDataChoice('quick');
    onChosen('quick');
  };

  const chooseFull = async () => {
    haptic('tap');
    setBusy(true);
    setError(null);

    const result = await downloadLandPack((p) => setProgress(p));

    if (result.ok) {
      await setMapDataChoice('full');
      haptic('success');
      onChosen('full');
      return;
    }

    /*
     * A failed or partial download does NOT record the full choice. Recording
     * it would tell the camper they are carrying detailed maps for the whole
     * continent when they are carrying some of it, and they would find out
     * where it runs out by driving there.
     */
    haptic('warning');
    setError(result.message);
    setBusy(false);
  };

  const packUnavailable = manifest !== null && !manifest.available;

  return (
    <div
      role="dialog"
      aria-modal="true"
      aria-labelledby="map-data-title"
      className="fixed inset-0 z-[3000] bg-slate-950 overflow-y-auto anim-fade"
    >
      <div className="min-h-full flex items-center justify-center p-5">
        <div className="w-full max-w-lg space-y-5">
          <header className="text-center space-y-2 anim-in-up">
            <h1
              id="map-data-title"
              className="font-['Outfit'] font-bold text-2xl text-slate-50"
            >
              Choose your map data
            </h1>
            <p className="text-sm text-slate-400 leading-relaxed">
              Wandrlust shows public land you can camp on across the lower 48 and the
              Canadian provinces. Pick how much of it you want on your phone.
            </p>
          </header>

          {/* ---------------------------------------------------------- */}
          {/* Quick                                                       */}
          {/* ---------------------------------------------------------- */}
          <button
            onClick={chooseQuick}
            disabled={busy}
            style={{ animationDelay: `${stagger(0)}ms` }}
            className="w-full text-left p-5 rounded-3xl bg-slate-900 border border-slate-700 hover:border-emerald-500/60 disabled:opacity-40 transition-colors anim-in-up"
          >
            <div className="flex items-start gap-3">
              <div className="p-2 rounded-xl bg-emerald-500/15 text-emerald-400 border border-emerald-500/30 shrink-0">
                <Zap className="w-5 h-5" />
              </div>
              <div className="space-y-2 min-w-0">
                <div>
                  <div className="font-bold text-slate-100">Quick map</div>
                  <div className="text-xs text-emerald-400 font-semibold">
                    Already on your phone · nothing to download
                  </div>
                </div>
                <p className="text-xs text-slate-400 leading-relaxed">
                  A rough outline of every BLM, National Forest and Crown land area in
                  the coverage region. Opens instantly, works with no signal, and full
                  detail loads in on its own whenever you do have signal.
                </p>

                {/* The honest part. Not a footnote. */}
                <div className="flex gap-2 p-2.5 rounded-xl bg-amber-950/40 border border-amber-800/50">
                  <AlertTriangle className="w-4 h-4 text-amber-400 shrink-0 mt-px" />
                  <p className="text-xs text-amber-200/90 leading-relaxed">
                    Edges are approximate — up to about a kilometre out — and small
                    areas are missing entirely.{' '}
                    <strong className="text-amber-100">
                      With no signal this will not tell you where a boundary really is.
                    </strong>{' '}
                    Don’t use it alone to decide whether you’re allowed to camp somewhere.
                  </p>
                </div>
              </div>
            </div>
          </button>

          {/* ---------------------------------------------------------- */}
          {/* Full                                                        */}
          {/* ---------------------------------------------------------- */}
          <div
            style={{ animationDelay: `${stagger(1)}ms` }}
            className="w-full p-5 rounded-3xl bg-slate-900 border border-slate-700 anim-in-up"
          >
            <div className="flex items-start gap-3">
              <div className="p-2 rounded-xl bg-sky-500/15 text-sky-400 border border-sky-500/30 shrink-0">
                <Download className="w-5 h-5" />
              </div>
              <div className="space-y-2 min-w-0 flex-1">
                <div>
                  <div className="font-bold text-slate-100">Full detail</div>
                  <div className="text-xs text-sky-400 font-semibold">
                    Large download · use wifi
                  </div>
                </div>
                <p className="text-xs text-slate-400 leading-relaxed">
                  The real boundaries, at the resolution the map draws when you’re
                  online, stored on your phone. This is the one to pick if you’ll be
                  out of service and need to trust what you’re looking at.
                </p>

                {busy ? (
                  <div className="space-y-2 pt-1">
                    <div className="flex justify-between text-xs font-bold text-sky-300">
                      <span className="flex items-center gap-1.5">
                        <Loader2 className="w-3.5 h-3.5 animate-spin" />
                        Downloading…
                      </span>
                      <span>
                        {progress
                          ? `${progress.cellsDone}/${progress.cellsTotal} · ${progress.sizeMb} MB`
                          : 'starting'}
                      </span>
                    </div>
                    <div className="w-full bg-slate-950 rounded-full h-2 overflow-hidden border border-sky-900">
                      <div
                        className="bg-gradient-to-r from-sky-500 to-cyan-400 h-full"
                        style={{
                          width: progress
                            ? `${Math.round((progress.cellsDone / Math.max(progress.cellsTotal, 1)) * 100)}%`
                            : '0%'
                        }}
                      />
                    </div>
                    <p className="text-xs text-slate-500">
                      Keep this screen open. Anything already saved is kept if you stop.
                    </p>
                  </div>
                ) : packUnavailable ? (
                  <div className="flex gap-2 p-2.5 rounded-xl bg-slate-950 border border-slate-800">
                    <WifiOff className="w-4 h-4 text-slate-500 shrink-0 mt-px" />
                    <p className="text-xs text-slate-400 leading-relaxed">
                      {manifest?.message ??
                        'Full-detail maps aren’t available right now.'}
                    </p>
                  </div>
                ) : (
                  <button
                    onClick={chooseFull}
                    disabled={manifest === null}
                    className="w-full py-2.5 rounded-xl bg-sky-600 hover:bg-sky-500 disabled:opacity-40 text-white font-bold text-xs flex items-center justify-center gap-2 transition-colors"
                  >
                    {manifest === null ? (
                      <>
                        <Loader2 className="w-4 h-4 animate-spin" />
                        Checking…
                      </>
                    ) : (
                      <>
                        <Download className="w-4 h-4" />
                        Download full detail
                        {manifest.parcelCount > 0 &&
                          ` (${manifest.parcelCount.toLocaleString()} areas)`}
                      </>
                    )}
                  </button>
                )}

                {error && (
                  <p className="text-xs text-rose-300 leading-relaxed">{error}</p>
                )}
              </div>
            </div>
          </div>

          <p className="text-center text-xs text-slate-500 leading-relaxed anim-fade">
            <Check className="w-3 h-3 inline-block mr-1 -mt-px" />
            You can change this later in Offline Maps. Whichever you pick, boundaries
            are approximate and camping rules are set locally — always check signs on
            the ground.
          </p>
        </div>
      </div>
    </div>
  );
};
