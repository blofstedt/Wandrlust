import React, { useEffect, useState } from 'react';
import { Download, Zap, AlertTriangle, Check, Loader2, WifiOff } from 'lucide-react';
import {
  MapDataChoice,
  PackManifest,
  PackProgress,
  PackResult,
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
 * ONCE MEANS ONCE
 * ---------------------------------------------------------------------------
 *
 * It used to mean "once, if everything went perfectly". The choice was only
 * recorded after a download that finished with every single cell of a
 * continental grid intact — so one rate-limited request in three hundred, one
 * tunnel, one backgrounded phone, and nothing was written down. The pack was
 * on the device; the answer was not; and this blocking screen came back on
 * every launch asking a camper to download a map they already had.
 *
 * So the answer is written the moment it is given, before the first request
 * goes out. What the camper CHOSE and what the device HOLDS are two different
 * facts, and conflating them is what broke this. The choice lives here; the
 * holdings live in `getPackStatus`, and every screen that describes the data
 * reads that one instead — see the partial state below and in Offline Maps.
 */

interface MapDataChoiceScreenProps {
  onChosen: (choice: Exclude<MapDataChoice, null>) => void;
}

export const MapDataChoiceScreen: React.FC<MapDataChoiceScreenProps> = ({ onChosen }) => {
  const [manifest, setManifest] = useState<PackManifest | null>(null);
  const [progress, setProgress] = useState<PackProgress | null>(null);
  const [busy, setBusy] = useState(false);
  /** The last attempt's outcome, kept only when it fell short. */
  const [shortfall, setShortfall] = useState<PackResult | null>(null);

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

    /*
     * Recorded BEFORE the first request, not after the last one. See the note
     * at the top: this is the camper's answer to the question, and the
     * question must not be asked twice. It says nothing about how much of the
     * pack is on the phone — `getPackStatus` is the only thing that does.
     */
    await setMapDataChoice('full');

    /*
     * A second attempt keeps every cell the first one managed. Re-downloading
     * a continent to fill in the last handful of sections is how a five
     * minute job becomes a twenty minute one on a car park's wifi.
     */
    const resume = shortfall !== null;
    setShortfall(null);

    const result = await downloadLandPack((p) => setProgress(p), undefined, { resume });

    if (result.ok) {
      haptic('success');
      onChosen('full');
      return;
    }

    /*
     * Short. The camper is not trapped here over it — the sections that DID
     * download are exact and the map falls back to the quick outline
     * everywhere else — but they are told which of those they are getting
     * before they go anywhere, and offered the chance to finish it now.
     */
    haptic('warning');
    setShortfall(result);
    setBusy(false);
  };

  const packUnavailable = manifest !== null && !manifest.available;
  const percent = progress
    ? Math.round((progress.cellsDone / Math.max(progress.cellsTotal, 1)) * 100)
    : 0;

  /**
   * The two cards are laid out identically on purpose — same icon tile, same
   * two-line heading, same body, same notice, and an action button of the
   * same height at the bottom of each. Previously the quick option was one
   * enormous tappable card and the full one was a card with a button inside
   * it, which put every line of the two at a different indent and left the
   * eye with nothing to compare.
   */
  const CARD = 'p-5 rounded-3xl bg-slate-900 border border-slate-700 flex flex-col gap-3';
  const TILE = 'w-10 h-10 rounded-xl border flex items-center justify-center shrink-0';
  const ACTION =
    'w-full h-11 rounded-xl font-bold text-xs flex items-center justify-center gap-2 transition-colors disabled:opacity-40';

  return (
    <div
      role="dialog"
      aria-modal="true"
      aria-labelledby="map-data-title"
      className="fixed inset-0 z-[3000] bg-slate-950 overflow-y-auto anim-fade"
    >
      <div className="min-h-full flex items-center justify-center p-5">
        <div className="w-full max-w-lg space-y-4">
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
            <p className="text-xs text-slate-500 leading-relaxed">
              You’re only asked this once. Campsites, facilities and alerts keep
              updating either way — it’s the land boundaries that barely change.
            </p>
          </header>

          {/* ---------------------------------------------------------- */}
          {/* Quick                                                       */}
          {/* ---------------------------------------------------------- */}
          <div style={{ animationDelay: `${stagger(0)}ms` }} className={`${CARD} anim-in-up`}>
            <div className="flex items-center gap-3">
              <div className={`${TILE} bg-emerald-500/15 text-emerald-400 border-emerald-500/30`}>
                <Zap className="w-5 h-5" />
              </div>
              <div className="min-w-0">
                <div className="font-bold text-slate-100 leading-tight">Quick map</div>
                <div className="text-xs text-emerald-400 font-semibold leading-tight mt-0.5">
                  Already on your phone · nothing to download
                </div>
              </div>
            </div>

            <p className="text-xs text-slate-400 leading-relaxed">
              A rough outline of every BLM, National Forest and Crown land area in the
              coverage region. Opens instantly, works with no signal, and full detail
              loads in on its own whenever you do have signal.
            </p>

            {/* The honest part. Not a footnote. */}
            <div className="flex gap-2.5 p-3 rounded-xl bg-amber-950/40 border border-amber-800/50">
              <AlertTriangle className="w-4 h-4 text-amber-400 shrink-0 mt-0.5" />
              <p className="text-xs text-amber-200/90 leading-relaxed">
                Edges are approximate — up to about a kilometre out — and small areas
                are missing entirely.{' '}
                <strong className="text-amber-100">
                  With no signal this will not tell you where a boundary really is.
                </strong>{' '}
                Don’t use it alone to decide whether you’re allowed to camp somewhere.
              </p>
            </div>

            <button
              onClick={chooseQuick}
              disabled={busy}
              className={`${ACTION} bg-slate-800 hover:bg-slate-700 text-slate-200`}
            >
              <Zap className="w-4 h-4" />
              Use the quick map
            </button>
          </div>

          {/* ---------------------------------------------------------- */}
          {/* Full                                                        */}
          {/* ---------------------------------------------------------- */}
          <div style={{ animationDelay: `${stagger(1)}ms` }} className={`${CARD} anim-in-up`}>
            <div className="flex items-center gap-3">
              <div className={`${TILE} bg-sky-500/15 text-sky-400 border-sky-500/30`}>
                <Download className="w-5 h-5" />
              </div>
              <div className="min-w-0">
                <div className="font-bold text-slate-100 leading-tight">Full detail</div>
                <div className="text-xs text-sky-400 font-semibold leading-tight mt-0.5">
                  Large download · use wifi
                </div>
              </div>
            </div>

            <p className="text-xs text-slate-400 leading-relaxed">
              The real boundaries, at the resolution the map draws when you’re online,
              stored on your phone. This is the one to pick if you’ll be out of service
              and need to trust what you’re looking at. Downloaded once — public land
              boundaries change so rarely that the app never fetches them again on its
              own.
            </p>

            {busy ? (
              <div className="space-y-2">
                <div className="flex items-baseline justify-between gap-3 text-xs font-bold text-sky-300">
                  <span className="flex items-center gap-1.5 min-w-0">
                    <Loader2 className="w-3.5 h-3.5 shrink-0 animate-spin" />
                    Downloading…
                  </span>
                  <span className="shrink-0 tabular-nums">
                    {progress
                      ? `${progress.cellsDone}/${progress.cellsTotal} · ${progress.sizeMb} MB`
                      : 'starting'}
                  </span>
                </div>
                <div className="w-full bg-slate-950 rounded-full h-2 overflow-hidden border border-sky-900">
                  <div
                    className="bg-gradient-to-r from-sky-500 to-cyan-400 h-full"
                    style={{ width: `${percent}%` }}
                  />
                </div>
                <p className="text-xs text-slate-500 leading-relaxed">
                  Keep this screen open. Anything already saved is kept if you stop, and
                  picking it up later carries on from there.
                </p>
              </div>
            ) : packUnavailable ? (
              <div className="flex gap-2.5 p-3 rounded-xl bg-slate-950 border border-slate-800">
                <WifiOff className="w-4 h-4 text-slate-500 shrink-0 mt-0.5" />
                <p className="text-xs text-slate-400 leading-relaxed">
                  {manifest?.message ?? 'Full-detail maps aren’t available right now.'}
                </p>
              </div>
            ) : shortfall ? (
              /*
               * IT CAME UP SHORT, AND THAT GETS SAID BEFORE ANYTHING ELSE.
               *
               * What is on the device is exact; what is missing falls back to
               * the quick outline and the network. Both halves are stated,
               * because a camper told only the first would trust the map in
               * ground it cannot speak for.
               */
              <>
                <div className="flex gap-2.5 p-3 rounded-xl bg-amber-950/40 border border-amber-800/50">
                  <AlertTriangle className="w-4 h-4 text-amber-400 shrink-0 mt-0.5" />
                  <div className="text-xs text-amber-200/90 leading-relaxed space-y-1">
                    <p>{shortfall.message}</p>
                    <p>
                      The sections that saved are the real boundaries. Everywhere else
                      falls back to the rough outline, which needs signal to sharpen up.
                    </p>
                  </div>
                </div>
                <div className="flex gap-2">
                  <button
                    onClick={chooseFull}
                    className={`${ACTION} flex-1 bg-sky-600 hover:bg-sky-500 text-white`}
                  >
                    <Download className="w-4 h-4" />
                    Finish the download
                  </button>
                  <button
                    onClick={() => onChosen('full')}
                    className={`${ACTION} flex-1 bg-slate-800 hover:bg-slate-700 text-slate-200`}
                  >
                    Carry on for now
                  </button>
                </div>
              </>
            ) : (
              <button
                onClick={chooseFull}
                disabled={manifest === null}
                className={`${ACTION} bg-sky-600 hover:bg-sky-500 text-white`}
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
          </div>

          <p className="flex items-start justify-center gap-1.5 text-xs text-slate-500 leading-relaxed anim-fade">
            <Check className="w-3.5 h-3.5 shrink-0 mt-px" />
            <span>
              You can change this later in Offline Maps. Whichever you pick, boundaries
              are approximate and camping rules are set locally — always check signs on
              the ground.
            </span>
          </p>
        </div>
      </div>
    </div>
  );
};
