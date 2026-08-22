import React from 'react';
import { PlusCircle, Crosshair, Loader2, MapPin, Droplets } from 'lucide-react';
import { Sheet } from './ui/Sheet';

/**
 * "Add a spot where I'm standing?"
 *
 * The + in the top-right menu used to open an empty submission form, and the
 * first thing that form asked for was a latitude. Nobody knows their latitude.
 * Now the + means one specific thing — submit the ground under your feet — and
 * this asks before it commits to that, because it is easy to reach for + while
 * meaning "add that place over there", and the app can't tell the difference.
 *
 * Saying no is not a dead end: it points at the other way in, which is to drop
 * a pin on the map and add the spot from the card that opens.
 *
 * WHAT IT WILL NOT CLAIM. A phone's fix is where the phone is, to within
 * whatever accuracy it managed, which is not necessarily the pullout, and it
 * says so. The coordinates are shown before the tap, not after, so a wildly
 * wrong fix is caught here rather than published.
 */

interface AddHereConfirmProps {
  isOpen: boolean;
  onClose: () => void;
  /** The camper's position, when the browser has given us one. */
  userLocation: [number, number] | null;
  isLocating: boolean;
  /** Ask the browser for a position, for when we have none yet. */
  onLocateUser: () => void;
  /** Open the submission form seeded with these coordinates. */
  onConfirm: (latitude: number, longitude: number) => void;
  /**
   * Open the FACILITY form instead, at the same coordinates.
   *
   * Offered here because "add" is ambiguous at the moment somebody taps a
   * plus, and a camper standing at a dump station reaching for it means
   * something this dialog can now do. Without the second door they would
   * submit a campsite and then have to explain it was a toilet.
   */
  onAddFacility: (latitude: number, longitude: number) => void;
}

export const AddHereConfirm: React.FC<AddHereConfirmProps> = ({
  isOpen, onClose, userLocation, isLocating, onLocateUser, onConfirm, onAddFacility
}) => (
  <Sheet
    isOpen={isOpen}
    onClose={onClose}
    variant="dialog"
    title="Add a spot here?"
    subtitle={
      userLocation
        ? 'This submits the place you are standing right now.'
        : 'Wandrlust does not know where you are yet.'
    }
    icon={<PlusCircle className="w-5 h-5 text-emerald-400" />}
  >
    <div className="space-y-3 text-xs text-slate-300">
      {userLocation ? (
        <>
          <p className="flex items-center gap-2 font-mono text-xs text-slate-200 bg-slate-950 border border-slate-700 rounded-xl px-3 py-2">
            <Crosshair className="w-3.5 h-3.5 text-emerald-400 shrink-0" />
            {userLocation[0].toFixed(5)}, {userLocation[1].toFixed(5)}
          </p>
          <p className="text-xs text-slate-400 leading-snug">
            That is your phone&apos;s fix, as good as it managed — it may be a
            few dozen metres off, and it is where you are rather than where the
            pullout is. You can correct the numbers on the next screen.
          </p>

          <button
            type="button"
            onClick={() => onConfirm(userLocation[0], userLocation[1])}
            className="w-full py-3 rounded-xl bg-emerald-600 hover:bg-emerald-500 text-white font-bold text-xs flex items-center justify-center gap-2 shadow-lg shadow-emerald-950"
          >
            <PlusCircle className="w-4 h-4" />
            Yes, add my current location
          </button>

          {/*
            The second thing "add" can mean. Quieter than the primary button
            because a place to sleep is what the plus has always been for —
            but present, because a toilet is the other thing a camper is
            standing in front of when they reach for it.
          */}
          <button
            type="button"
            onClick={() => onAddFacility(userLocation[0], userLocation[1])}
            className="w-full py-2.5 rounded-xl bg-slate-800 border border-slate-700 text-slate-300 font-bold text-xs flex items-center justify-center gap-2 hover:bg-slate-700"
          >
            <Droplets className="w-3.5 h-3.5" />
            It&apos;s a toilet, tap or dump station — not a campsite
          </button>
        </>
      ) : (
        <>
          <p className="text-xs text-slate-400 leading-snug">
            Nothing has been located yet, or location is switched off for this
            site. Find your position first, or add the spot from the map.
          </p>

          <button
            type="button"
            onClick={onLocateUser}
            disabled={isLocating}
            className="w-full py-3 rounded-xl bg-emerald-600 hover:bg-emerald-500 text-white font-bold text-xs flex items-center justify-center gap-2 shadow-lg shadow-emerald-950 disabled:opacity-60"
          >
            {isLocating
              ? <Loader2 className="w-4 h-4 animate-spin" />
              : <Crosshair className="w-4 h-4" />}
            {isLocating ? 'Finding you…' : 'Find my location'}
          </button>
        </>
      )}

      {/*
        The other way in, spelled out rather than implied. This dialog is
        most often opened by someone who meant "add that place over there",
        and that is a real thing the app does — just not with this button.
      */}
      <button
        type="button"
        onClick={onClose}
        className="w-full py-2.5 rounded-xl bg-slate-800 border border-slate-700 text-slate-300 font-bold text-xs flex items-center justify-center gap-2 hover:bg-slate-700"
      >
        <MapPin className="w-3.5 h-3.5" />
        No — I&apos;ll tap the spot on the map
      </button>
      <p className="text-[12px] text-slate-500 leading-snug text-center">
        Tapping anywhere on the map drops a pin, and the card that opens has an
        Add spot button with those coordinates already in it.
      </p>
    </div>
  </Sheet>
);
