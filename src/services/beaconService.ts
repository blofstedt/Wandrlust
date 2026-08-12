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
  currentAccessToken
} from './dataService';
import type { BeaconQueryResult, BeaconDwellState } from '../types';

/* ------------------------------------------------------------------ */
/* The scan                                                            */
/* ------------------------------------------------------------------ */

const UNREACHABLE: BeaconQueryResult = {
  ok: false,
  spots: [],
  cached: false,
  disclaimer:
    'These are leads worked out from public map data, not permission to stay. ' +
    'Check the signs when you arrive.',
  note: 'Could not reach the server to send out a beacon.'
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
  try {
    const token = await currentAccessToken();

    const res = await fetch(
      `/api/beacon/query?lat=${latitude.toFixed(5)}&lon=${longitude.toFixed(5)}`,
      {
        signal,
        headers: token ? { Authorization: `Bearer ${token}` } : undefined
      }
    );

    // 429 and 401 carry a real body with a real explanation in it. Reading the
    // JSON rather than the status is what lets the panel say "that is all three
    // beacons for now" instead of "error 429".
    const data = (await res.json()) as BeaconQueryResult;
    if (!data || typeof data !== 'object') return UNREACHABLE;
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
