import React, { useCallback, useEffect, useState } from 'react';
import { Radar, Loader2, MapPin, Navigation, ShieldQuestion, Brain } from 'lucide-react';
import { Sheet } from './ui/Sheet';
import { useToast } from './ui/Feedback';
import { useAuth } from '../contexts/AuthContext';
import { queryBeacon } from '../services/beaconService';
import { fetchBeaconModelSummary } from '../services/dataService';
import {
  beaconTierStyle, beaconTokenLabel, SIGN_EVIDENCE_COPY, BEACON_CAVEAT
} from '../config/beacon';
import type { BeaconSpot, BeaconQueryResult, BeaconModelSummary } from '../types';

interface BeaconPanelProps {
  isOpen: boolean;
  onClose: () => void;
  /** Where the beacon was dropped. */
  at: [number, number] | null;
  onRequireAuth: () => void;
  /** Send the camper to a spot — reuses the map's existing destination flow. */
  onNavigate: (latitude: number, longitude: number, label: string) => void;
  /**
   * Fired after any scan that reached the server.
   *
   * The map's Beacon layer only reloads when the map moves more than 10 km or
   * when its refresh key changes, so without this a scan wrote new leads to the
   * database and the map underneath carried on showing nothing. Called even
   * when the panel itself lists no spots: the panel only surfaces the top three
   * above a score bar, while the map draws every lead that was persisted.
   */
  onScanComplete: () => void;
}

/**
 * The Beacon results panel.
 *
 * ---------------------------------------------------------------------------
 * WHAT THIS SCREEN IS ALLOWED TO IMPLY
 * ---------------------------------------------------------------------------
 *
 * Beacon finds places that public map data suggests you MIGHT be able to sleep.
 * It does not know the law, it cannot see a sign posted last Tuesday, and the
 * grey tier — which is every result the algorithm produces on its own — means
 * literally nobody has ever been there.
 *
 * So this panel leads with the tier's meaning rather than its name, keeps the
 * caveat visible without a tap, and never uses a word like "verified",
 * "approved" or "safe". A camper who reads this screen and gets a ticket
 * should be able to point at what it told them and find it was honest.
 */
export const BeaconPanel: React.FC<BeaconPanelProps> = ({
  isOpen, onClose, at, onRequireAuth, onNavigate, onScanComplete
}) => {
  const { user } = useAuth();
  const toast = useToast();
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState<BeaconQueryResult | null>(null);
  const [model, setModel] = useState<BeaconModelSummary | null>(null);

  // A new drop point is a new question. Clearing rather than leaving the old
  // answer on screen matters here: three spots from a different valley look
  // exactly like three spots from this one.
  useEffect(() => {
    setResult(null);
    setModel(null);
  }, [at?.[0], at?.[1]]);

  const runScan = useCallback(async () => {
    if (!at) return;
    setBusy(true);

    const data = await queryBeacon(at[0], at[1]);
    setResult(data);
    setBusy(false);

    /**
     * Tell the map to look again, whatever came back.
     *
     * Unconditional on purpose. A scan that surfaced nothing in this panel can
     * still have persisted leads — the panel shows the top three above a score
     * bar, the map draws every one that cleared the lower "worth remembering"
     * bar — so keying this off `data.spots.length` would leave exactly the case
     * that looks most broken: "it said it found nothing and then pins appeared
     * when I panned."
     */
    onScanComplete();

    // The panel already shows the note; the toast is for the two cases a
    // camper needs to notice even if they are looking at the map.
    if (!data.ok && data.note) {
      toast.info('Nothing solid nearby', data.note);
    }
    if (data.spots.length > 0) {
      const region = data.spots[0].region;
      setModel(await fetchBeaconModelSummary(region));
    }
  }, [at, toast, onScanComplete]);

  const handleSend = () => {
    if (!user) { onRequireAuth(); return; }
    void runScan();
  };

  if (!at) return null;

  const remaining = result?.remaining;

  return (
    <Sheet
      isOpen={isOpen}
      onClose={onClose}
      title="Beacon"
      subtitle={`${at[0].toFixed(4)}, ${at[1].toFixed(4)}`}
      icon={<Radar className="w-4 h-4 text-sky-400" />}
    >
      <div className="p-4 space-y-3">
        {/*
          The caveat sits above the results, not below them. Below, it reads as
          small print somebody has already scrolled past.
        */}
        <div className="rounded-xl border border-slate-700 bg-slate-800/40 p-3">
          <p className="text-xs text-slate-300 leading-snug">
            Beacon looks through public map data for places you might be able to
            sleep near here. It is guessing, and it cannot see a sign that went
            up last week.
          </p>
          <p className="text-xs font-bold text-amber-300 mt-1.5">{BEACON_CAVEAT}</p>
        </div>

        {!result && (
          <button
            onClick={handleSend}
            disabled={busy}
            className="w-full px-4 py-3 rounded-xl bg-sky-600 hover:bg-sky-500 text-white font-bold text-xs flex items-center justify-center gap-2 disabled:opacity-60"
          >
            {busy
              ? <><Loader2 className="w-4 h-4 animate-spin" /> Scanning around here…</>
              : <><Radar className="w-4 h-4" /> Send out a beacon</>}
          </button>
        )}

        {busy && (
          <p className="text-xs text-slate-400 text-center anim-in-up">
            Reading map data and checking street-level signs. This takes a few seconds.
          </p>
        )}

        {result?.spots.map((spot, i) => (
          <BeaconSpotCard
            key={spot.id}
            spot={spot}
            index={i}
            onNavigate={() => onNavigate(spot.latitude, spot.longitude, spot.label)}
          />
        ))}

        {result && result.spots.length === 0 && !busy && (
          <div className="rounded-xl border border-slate-700 bg-slate-800/40 p-3 anim-in-up">
            <p className="text-xs text-slate-300 leading-snug">{result.note}</p>
          </div>
        )}

        {result?.signageNote && (
          <div className="flex items-start gap-2 text-[12px] text-slate-400 leading-snug">
            <ShieldQuestion className="w-3.5 h-3.5 shrink-0 mt-px" />
            <span>{result.signageNote}</span>
          </div>
        )}

        {/*
          Where the rest of them went.

          The panel lists the best three; the scan usually persists more than
          that, and every one is drawn on the map for everybody — not just the
          camper who paid for the scan. Saying so is what makes the grey rings
          make sense instead of looking like clutter that appeared by itself.
        */}
        {result?.ok && (
          <p className="text-[12px] text-slate-400 leading-snug flex items-start gap-1.5">
            <MapPin className="w-3 h-3 shrink-0 mt-px" />
            <span>
              These and any others found are now grey rings on the map, for every
              camper. Grey means nobody has been there yet — go, and you can be
              the first to say what it is actually like.
            </span>
          </p>
        )}

        {result && (
          <p className="text-[12px] text-slate-500 leading-snug">{result.disclaimer}</p>
        )}

        {/*
          What the model has learned, shown to the camper.

          This is not decoration. Beacon ranks spots partly from a model trained
          on what campers reported back, and a ranking nobody can inspect is a
          ranking nobody should trust. When it has learned almost nothing, this
          block says so — which is the most useful thing it can say early on.
        */}
        {model && <ModelNote model={model} />}

        {result?.cached && (
          <p className="text-[12px] text-emerald-400/80">
            Someone swept this ground in the last two days, so this one was free.
          </p>
        )}

        {typeof remaining === 'number' && (
          <p className="text-[12px] text-slate-500">
            {remaining === 0
              ? 'That was your last beacon for now. Ground others have already scanned stays free.'
              : `${remaining} beacon${remaining === 1 ? '' : 's'} left in the next twelve hours.`}
          </p>
        )}

        {result && !busy && (
          <button
            onClick={handleSend}
            className="w-full px-3 py-2 rounded-xl border border-slate-700 text-slate-300 hover:border-slate-600 font-semibold text-xs"
          >
            Scan again
          </button>
        )}
      </div>
    </Sheet>
  );
};

/* ------------------------------------------------------------------ */

const BeaconSpotCard: React.FC<{
  spot: BeaconSpot;
  index: number;
  onNavigate: () => void;
}> = ({ spot, index, onNavigate }) => {
  const style = beaconTierStyle(spot.tier);

  return (
    <div
      data-stagger={Math.min(index, 8)}
      className="rounded-xl border p-3 anim-in-up"
      style={{ borderColor: style.ring, background: style.colorSoft }}
    >
      <div className="flex items-start justify-between gap-2">
        <div className="min-w-0">
          <p className="text-xs font-bold text-slate-100 truncate">{spot.label}</p>
          <p className="text-xs font-semibold mt-0.5" style={{ color: style.color }}>
            {style.emoji} {style.label}
          </p>
        </div>
        {typeof spot.metresAway === 'number' && (
          <span className="text-[12px] text-slate-400 shrink-0 flex items-center gap-1">
            <MapPin className="w-3 h-3" />
            {spot.metresAway < 1000
              ? `${spot.metresAway} m`
              : `${(spot.metresAway / 1000).toFixed(1)} km`}
          </span>
        )}
      </div>

      {/* The tier's MEANING, always — not just its name. */}
      <p className="text-xs text-slate-300 mt-1.5 leading-snug">{style.meaning}</p>

      {spot.landBasis && (
        <p className="text-[12px] text-slate-400 mt-1 leading-snug">{spot.landBasis}</p>
      )}

      <p className="text-[12px] text-slate-400 mt-1 leading-snug">
        {SIGN_EVIDENCE_COPY[spot.signEvidence]}
      </p>

      <button
        onClick={onNavigate}
        className="mt-2.5 w-full px-3 py-2 rounded-lg bg-slate-800/80 hover:bg-slate-700 text-slate-100 font-bold text-xs flex items-center justify-center gap-1.5"
      >
        <Navigation className="w-3 h-3" />
        Take me there
      </button>
    </div>
  );
};

/* ------------------------------------------------------------------ */

const ModelNote: React.FC<{ model: BeaconModelSummary }> = ({ model }) => {
  const thin = model.observations_here < 20;

  return (
    <div className="rounded-xl border border-slate-800 bg-slate-950/50 p-2.5">
      <div className="flex items-center gap-1.5 mb-1">
        <Brain className="w-3 h-3 text-slate-500" />
        <p className="text-[12px] font-bold text-slate-400 uppercase tracking-wide">
          What Wandrlust has learned here
        </p>
      </div>

      {thin ? (
        <p className="text-[12px] text-slate-400 leading-snug">
          Only {model.observations_here} camper report{model.observations_here === 1 ? '' : 's'} from
          around here so far, so the ranking above is mostly the plain rules rather
          than anything learned. It gets better as people check in.
        </p>
      ) : (
        <p className="text-[12px] text-slate-400 leading-snug">
          From {model.stays_recorded} recorded stay{model.stays_recorded === 1 ? '' : 's'} and{' '}
          {model.reports_recorded} bad outcome{model.reports_recorded === 1 ? '' : 's'}, it now
          leans toward {model.trusts_most.map(beaconTokenLabel).join(', ') || 'nothing in particular'}
          {model.trusts_least.length > 0 && (
            <> and away from {model.trusts_least.map(beaconTokenLabel).join(', ')}</>
          )}.
        </p>
      )}
    </div>
  );
};
