import type { FacilityKind } from '../types';

/**
 * "DID YOU FIND IT?" — ASKED AFTERWARDS, NOT BEFOREHAND.
 *
 * ---------------------------------------------------------------------------
 * WHY THE QUESTION MOVED
 * ---------------------------------------------------------------------------
 *
 * "It's there" and "Not there" used to sit on the facility card, which is the
 * card you open BEFORE you go. Nobody knows the answer at that point. What you
 * get from asking then is either silence, or worse, somebody pressing "it's
 * there" to mean "the pin is there" — which is the map confirming itself and
 * the one kind of evidence this app must never collect.
 *
 * The moment a camper actually knows is after they have been handed to Google
 * Maps, driven there, and come back to this app. So that is when it asks: the
 * handoff is remembered here, and the app raises the question — with a buzz,
 * because the phone has been in a pocket — the next time it is looked at.
 *
 * ---------------------------------------------------------------------------
 * THE TWO WINDOWS, AND WHY BOTH ENDS MATTER
 * ---------------------------------------------------------------------------
 *
 * Under `MIN_AGE_MS` nobody has been anywhere. Tapping navigate and flicking
 * straight back — the wrong pin, a mistake, checking the distance — is common,
 * and being asked "did you find it?" ten seconds later is the app not paying
 * attention.
 *
 * Past `MAX_AGE_MS` the memory is not worth trusting. A camper opening the app
 * two days later has been to a dozen places, and an answer given from a hazy
 * recollection is worse than no answer, because it goes on the map as fact.
 *
 * Only ever ONE handoff is remembered. If somebody navigates to a second
 * facility before answering for the first, the first is gone — the newer one
 * is the one they can actually speak to.
 */

export interface PendingFacilityCheck {
  /** The pin's id: `osm-node-123` or the `pois` row id. */
  id: string;
  /** The `pois` row, when there is one. Only then is there anything to vote on. */
  poiId?: string;
  kind: FacilityKind;
  name?: string;
  latitude: number;
  longitude: number;
  /** When they were handed off, in epoch ms. */
  at: number;
}

const KEY = 'wl.facility.pendingCheck';

/** Three minutes. Long enough that they actually went. */
const MIN_AGE_MS = 3 * 60 * 1000;
/** Twelve hours. Past that, ask nobody to remember. */
const MAX_AGE_MS = 12 * 60 * 60 * 1000;

/**
 * The least a thing must be to be worth asking about later.
 *
 * Deliberately not `MapFacility`: the same handoff happens from the "hop to a
 * facility" card, whose facility is a `NearbyFacility` — an OpenStreetMap
 * lookup around one spot, with no row of ours and so no `poiId`. Both are a
 * place the camper was just sent to, which is all this needs to know.
 */
export interface HandoffTarget {
  id: string;
  kind: FacilityKind;
  name?: string;
  latitude: number;
  longitude: number;
  poiId?: string;
}

/**
 * Everything below swallows its own errors.
 *
 * `localStorage` throws in a private window on some browsers, and this is a
 * convenience — a camper who cannot be asked whether they found the toilet has
 * lost nothing they came for.
 */
export const rememberFacilityHandoff = (facility: HandoffTarget): void => {
  try {
    const pending: PendingFacilityCheck = {
      id: facility.id,
      poiId: facility.poiId,
      kind: facility.kind,
      name: facility.name,
      latitude: facility.latitude,
      longitude: facility.longitude,
      at: Date.now()
    };
    window.localStorage.setItem(KEY, JSON.stringify(pending));
  } catch {
    /* No storage, no question. Nothing else is affected. */
  }
};

export const clearFacilityCheck = (): void => {
  try { window.localStorage.removeItem(KEY); } catch { /* see above */ }
};

/**
 * The handoff worth asking about, or null.
 *
 * Anything outside the window is DELETED rather than left to ripen. A record
 * that is too old to ask about will never become one that is not.
 */
export const readFacilityCheck = (): PendingFacilityCheck | null => {
  let raw: string | null = null;
  try { raw = window.localStorage.getItem(KEY); } catch { return null; }
  if (!raw) return null;

  try {
    const pending = JSON.parse(raw) as PendingFacilityCheck;
    if (typeof pending?.at !== 'number' || typeof pending?.id !== 'string') {
      clearFacilityCheck();
      return null;
    }

    const age = Date.now() - pending.at;
    if (age > MAX_AGE_MS) { clearFacilityCheck(); return null; }
    if (age < MIN_AGE_MS) return null;

    return pending;
  } catch {
    clearFacilityCheck();
    return null;
  }
};
