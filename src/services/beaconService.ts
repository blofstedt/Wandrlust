/**
 * Beacon, client side: the scan call, and the dwell recorder.
 *
 * ---------------------------------------------------------------------------
 * WHAT THE DWELL RECORDER CAN AND CANNOT PROVE
 * ---------------------------------------------------------------------------
 *
 * A browser has no background geolocation. `watchPosition` stops the moment
 * the tab is backgrounded on most phones and stops entirely when it is closed,
 * and the Periodic Background Sync API that could help exists on exactly one
 * browser on one platform. There is no way around this and pretending
 * otherwise would be the worst kind of lie for this app to tell — somebody
 * would rely on a four-hour stay being logged while they slept.
 *
 * So this records what it honestly can:
 *
 *   - a ping the moment the camper says "I'm here", which fixes the arrival
 *   - a ping whenever the app is open and the position updates
 *   - a ping when the tab comes back to the foreground
 *   - the submission ping four hours later
 *
 * The arrival is mirrored into IndexedDB as well as the server, so closing the
 * app and coming back does not lose the clock. What the server ends up able to
 * assert is "this device was inside a 50 m circle at two moments four hours
 * apart", and every string the UI shows says exactly that and no more.
 *
 * Nothing here throws. Every method resolves to a result object.
 */
import localforage from 'localforage';
import {
  recordBeaconPing,
  currentAccessToken,
  refreshedAccessToken,
  signOutStaleSession
} from './dataService';
import type { BeaconQueryResult, BeaconDwellState } from '../types';

/* ------------------------------------------------------------------ */
/* The scan                                                            */
/* ------------------------------------------------------------------ */

const DISCLAIMER =
  'These are leads worked out from public map data, not permission to stay. ' +
  'Check the signs when you arrive.';

const UNREACHABLE: BeaconQueryResult = {
  ok: false,
  spots: [],
  cached: false,
  disclaimer: DISCLAIMER,
  note: 'Could not reach the server to send out a beacon.'
};

/**
 * THE SCAN RAN AND THE PLATFORM CUT IT OFF, WHICH IS NOT THE SAME THING.
 *
 * A beacon scan that overran its thirty seconds came back as the hosting
 * platform's own gateway error page — HTML, not JSON — so `res.json()` threw,
 * the catch below ran, and every camper was told the server could not be
 * reached. It could. It was working on their answer when it was killed, and
 * "try again" is the useful thing to say about that, not "you have no
 * connection", which sends somebody looking for signal they already have.
 */
const TIMED_OUT: BeaconQueryResult = {
  ok: false,
  spots: [],
  cached: false,
  disclaimer: DISCLAIMER,
  note:
    'The scan took too long and was cut off before it finished, so no ground ' +
    'here was ruled out. Give it another go in a moment.'
};

/** Status codes a gateway returns when it gave up waiting on the function. */
const GATEWAY_TIMEOUT = new Set([408, 502, 503, 504]);

/** The server answered, and what came back was not the answer. */
const UNREADABLE: BeaconQueryResult = {
  ok: false,
  spots: [],
  cached: false,
  disclaimer: DISCLAIMER,
  note:
    'The server answered with something this app could not read, so nothing ' +
    'here was scanned or ruled out. Try again in a moment.'
};

/**
 * The server refused, in words it did not explain.
 *
 * The status is carried because "500" and "403" send whoever is helping to
 * two completely different places, and a camper reporting "it just says it
 * failed" has nothing anybody can act on.
 */
const serverSaidNo = (status: number): BeaconQueryResult => ({
  ok: false,
  spots: [],
  cached: false,
  disclaimer: DISCLAIMER,
  note:
    `The beacon service refused this request (error ${status}) and gave no ` +
    'reason, so nothing here was scanned or ruled out. Try again shortly.'
});

/**
 * The session is gone, whatever the rest of the app believes.
 *
 * `needsAuth` rather than a note, because the panel has to DO something about
 * this — open the sign-in sheet — and a sentence cannot.
 */
const SIGNED_OUT: BeaconQueryResult = {
  ok: false,
  spots: [],
  cached: false,
  disclaimer: DISCLAIMER,
  needsAuth: true,
  note:
    'Your sign-in has expired, so this beacon was not sent. Sign in again and ' +
    'it will go out — ground somebody has already swept stays free either way.'
};

/**
 * Drop a beacon and see what comes back.
 *
 * The access token rides along because the server claims the rate-limit token
 * as the caller — see `currentAccessToken` in dataService. A signed-out camper
 * still gets an answer for ground somebody else already swept, because that
 * costs nobody anything.
 */
export const queryBeacon = async (
  latitude: number,
  longitude: number,
  signal?: AbortSignal
): Promise<BeaconQueryResult> => {
  const url = `/api/beacon/query?lat=${latitude.toFixed(5)}&lon=${longitude.toFixed(5)}`;
  const send = (token: string | null) =>
    fetch(url, {
      signal,
      headers: token ? { Authorization: `Bearer ${token}` } : undefined
    });

  try {
    let res = await send(await currentAccessToken());

    /*
     * ONE 401 IS NOT PROOF OF BEING SIGNED OUT.
     *
     * The server refuses when no usable token reached it, and the commonest
     * reason for that is not a camper who signed out — it is an access token
     * that expired while the app sat in a background tab, with the refresh not
     * yet run. Measured against the real account: a session refreshed seven
     * seconds before the request, and the request still arrived with nothing
     * on it. Believing the first 401 turned that into "your sign-in has
     * expired" and a sign-in sheet, for somebody who was signed in the whole
     * time and only wanted a beacon.
     *
     * So a refusal buys exactly one forced refresh and one retry. If the
     * second attempt is refused too, the session really is gone and the
     * existing path below is right.
     */
    if (res.status === 401) {
      const fresh = await refreshedAccessToken();
      if (fresh) res = await send(fresh);
    }

    // 429 and 401 carry a real body with a real explanation in it. Reading the
    // JSON rather than the status is what lets the panel say "that is all three
    // beacons for now" instead of "error 429".
    //
    // A gateway timeout carries no body worth reading, and parsing its HTML
    // would throw into the catch and be reported as an unreachable server —
    // see TIMED_OUT.
    if (GATEWAY_TIMEOUT.has(res.status)) return TIMED_OUT;

    /*
     * 401 IS ABOUT THE SESSION, NOT ABOUT THE GROUND.
     *
     * The server only sends it when no usable token arrived, which means this
     * device thinks it is signed in and is not. Say so as something the panel
     * can act on, and put the app's own idea of who is signed in back in step
     * with the server's — see `signOutStaleSession` in dataService.ts.
     */
    if (res.status === 401) {
      await signOutStaleSession();
      return SIGNED_OUT;
    }

    const data = (await res.json().catch(() => null)) as BeaconQueryResult | null;
    /*
     * A REPLY WE COULD NOT READ IS NOT A SERVER WE COULD NOT REACH.
     *
     * Both used to print "Could not reach the server to send out a beacon",
     * which sends a camper looking for signal they already have — and sent
     * this investigation after a network fault that was never there. If bytes
     * came back, say that.
     */
    if (!data || typeof data !== 'object') {
      return res.ok ? UNREADABLE : serverSaidNo(res.status);
    }
    return data;
  } catch {
    return UNREACHABLE;
  }
};

/* ------------------------------------------------------------------ */
/* Arrival memory                                                      */
/* ------------------------------------------------------------------ */

/**
 * Its own localforage instance rather than a key in the shared data store.
 *
 * `offlineStorage.ts` keeps whole lists under one key and rewrites the list on
 * every change, which is right for saved campsites and wrong for something
 * written every few minutes while parked.
 */
const dwellStore = localforage.createInstance({
  name: 'wandrlust',
  storeName: 'wandrlust_dwell',
  description: 'Arrival times for spots this device is currently parked at'
});

interface StoredArrival {
  spotId: string;
  arrivedAt: number;
  lastPingAt: number;
}

const arrivalKey = (spotId: string) => `dwell:${spotId}`;

export const readStoredArrival = async (spotId: string): Promise<StoredArrival | null> => {
  try {
    const stored = await dwellStore.getItem<StoredArrival>(arrivalKey(spotId));
    if (!stored) return null;
    // A stay older than 36 hours is a different trip. The server applies the
    // same window; keeping them in step means the two never disagree.
    if (Date.now() - stored.arrivedAt > 36 * 60 * 60 * 1000) {
      await dwellStore.removeItem(arrivalKey(spotId));
      return null;
    }
    return stored;
  } catch {
    return null;
  }
};

const writeStoredArrival = async (value: StoredArrival): Promise<void> => {
  try {
    await dwellStore.setItem(arrivalKey(value.spotId), value);
  } catch {
    // Storage full or unavailable. The server still holds the real arrival —
    // this copy only exists so the UI can show a clock before the first round
    // trip comes back.
  }
};

export const clearStoredArrival = async (spotId: string): Promise<void> => {
  try {
    await dwellStore.removeItem(arrivalKey(spotId));
  } catch {
    // Nothing to do. A stale local arrival is corrected by the next ping.
  }
};

/* ------------------------------------------------------------------ */
/* Spoof heuristics, client side                                       */
/* ------------------------------------------------------------------ */

/**
 * What a browser can notice about a faked position, which is not much.
 *
 * There is no mock-provider flag in the web platform. Everything the client
 * could check is also editable by whoever is faking the location, so this is
 * reported to the server as a hint and NEVER treated as a verdict — the checks
 * that decide anything live in `beacon_record_ping`. Its value is that casual
 * spoofing usually produces one of these tells without meaning to.
 */
export const positionTells = (position: GeolocationPosition): string[] => {
  const tells: string[] = [];
  const { latitude, longitude, accuracy, speed, heading } = position.coords;

  // A real fix is never a round number. A typed-in one usually is.
  if (Number.isInteger(latitude * 10000) && Number.isInteger(longitude * 10000)) {
    tells.push('coordinates land exactly on a grid');
  }
  // Simulated positions frequently report an implausibly perfect fix.
  if (accuracy != null && accuracy < 1) tells.push('accuracy is implausibly good');
  // A device sitting still reports null or a jittering small number, not a
  // clean zero with a heading attached.
  if (speed === 0 && heading != null) tells.push('stationary but reporting a heading');

  return tells;
};

/* ------------------------------------------------------------------ */
/* The recorder                                                        */
/* ------------------------------------------------------------------ */

export interface DwellRecorderOptions {
  spotId: string;
  /** Called whenever the server tells us where the stay stands. */
  onUpdate: (state: BeaconDwellState) => void;
  /** How often to ping while the app is open. Four minutes by default. */
  pingIntervalMs?: number;
}

/**
 * Tracks a stay at one spot.
 *
 * Modelled on `ScoutRecorder` in `scoutMode.ts` — a class holding a
 * `watchPosition` id and an interval timer, `start()` returning a
 * `{ ok, message }` shape, and a `stop()` that is safe to call twice. The
 * owning component holds it in a ref and stops it on unmount.
 */
export class DwellRecorder {
  private opts: Required<DwellRecorderOptions>;
  private watchId: number | null = null;
  private timer: ReturnType<typeof setInterval> | null = null;
  private running = false;
  private lastPosition: GeolocationPosition | null = null;

  constructor(opts: DwellRecorderOptions) {
    this.opts = { pingIntervalMs: 4 * 60 * 1000, ...opts };
  }

  private handlePosition = (position: GeolocationPosition) => {
    this.lastPosition = position;
  };

  /** Send whatever the last fix was to the server and report back. */
  private ping = async () => {
    const position = this.lastPosition;
    if (!position) return;

    const state = await recordBeaconPing(
      this.opts.spotId,
      position.coords.latitude,
      position.coords.longitude,
      position.coords.accuracy
    );

    if (state.ok) {
      const stored = await readStoredArrival(this.opts.spotId);
      await writeStoredArrival({
        spotId: this.opts.spotId,
        // The server's arrival wins; the local copy only fills the gap before
        // the first round trip.
        arrivedAt: state.arrivedAt ? Date.parse(state.arrivedAt) : stored?.arrivedAt ?? Date.now(),
        lastPingAt: Date.now()
      });
    }

    this.opts.onUpdate(state);
  };

  /**
   * A tab coming back to the foreground is the most valuable moment to ping:
   * it is usually the camper picking the phone up after hours of nothing, and
   * it is the only sample we will get from that stretch.
   */
  private handleVisibility = () => {
    if (document.visibilityState === 'visible') void this.ping();
  };

  async start(): Promise<{ ok: boolean; message: string }> {
    if (this.running) return { ok: true, message: 'Already tracking this spot' };

    if (!('geolocation' in navigator)) {
      return { ok: false, message: 'This device cannot report its location.' };
    }

    // Get a fix before the first ping, so the arrival is logged with a real
    // position rather than skipped for want of one.
    const first = await new Promise<GeolocationPosition | null>((resolve) => {
      navigator.geolocation.getCurrentPosition(
        resolve,
        () => resolve(null),
        { enableHighAccuracy: true, timeout: 10000 }
      );
    });

    if (!first) {
      return {
        ok: false,
        message: 'Could not get your location. Check that location access is allowed.'
      };
    }
    this.lastPosition = first;

    this.watchId = navigator.geolocation.watchPosition(
      this.handlePosition,
      () => undefined,
      { enableHighAccuracy: true, maximumAge: 30_000, timeout: 15_000 }
    );

    document.addEventListener('visibilitychange', this.handleVisibility);
    this.timer = setInterval(() => void this.ping(), this.opts.pingIntervalMs);
    this.running = true;

    await this.ping();
    return { ok: true, message: 'Tracking your stay at this spot' };
  }

  async stop(): Promise<void> {
    if (!this.running) return;

    if (this.watchId !== null) navigator.geolocation.clearWatch(this.watchId);
    if (this.timer) clearInterval(this.timer);
    document.removeEventListener('visibilitychange', this.handleVisibility);

    this.watchId = null;
    this.timer = null;
    this.running = false;
  }

  /** The last fix, for the submission call. Null until the first one lands. */
  currentPosition(): GeolocationPosition | null {
    return this.lastPosition;
  }

  isRunning(): boolean {
    return this.running;
  }
}
