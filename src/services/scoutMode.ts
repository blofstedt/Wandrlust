/**
 * Scout Mode — passive road-roughness recording from phone motion sensors.
 *
 * ---------------------------------------------------------------------------
 * IT MEASURES ROUGHNESS. IT DOES NOT MEASURE SURFACE.
 * ---------------------------------------------------------------------------
 *
 * An accelerometer cannot tell dirt from gravel. Fresh-graded gravel rides
 * smoother than broken asphalt, and no amount of maths on a bump signal
 * recovers what the road is made of. Naming materials from this data would be
 * the app claiming to know something it does not — so it does not. Material
 * is OpenStreetMap's answer and the backroads layer draws it; roughness is
 * the answer nobody else has, and it is the one campers actually want:
 * can my rig get down there.
 *
 * ---------------------------------------------------------------------------
 * THE HARD PART IS FALSE POSITIVES
 * ---------------------------------------------------------------------------
 *
 * Picking the phone up generates far more motion than any road surface.
 * Uploading that as "road data" would poison the dataset. Three gates:
 *
 *   1. Orientation gate — the phone must be stable in a mount. We track the
 *      angular spread of the gravity vector; a mounted phone barely rotates.
 *   2. Speed gate — below 5 km/h you are not measuring a road.
 *   3. Distance gate — a segment shorter than 200 m is not a road either.
 *
 * ---------------------------------------------------------------------------
 * THREE THINGS THE FIRST VERSION GOT WRONG, AND WHAT REPLACED THEM
 * ---------------------------------------------------------------------------
 *
 * 1. IT MEASURED TOTAL ACCELERATION, NOT VERTICAL. The variance was taken
 *    over the magnitude of the whole acceleration vector, so braking,
 *    accelerating and cornering all leaked into "roughness" and stop-and-go
 *    traffic on smooth asphalt read as a rough road. Now every sample is
 *    projected onto the gravity axis, which is where road bumps actually
 *    live, and horizontal driving forces fall out almost entirely.
 *
 * 2. IT IGNORED SPEED. For a given road profile, vertical acceleration
 *    scales with the SQUARE of speed — cross a washboard at 60 km/h and it
 *    hits four times as hard as at 30. With absolute thresholds, the same
 *    road recorded at two speeds landed in two different classes, and
 *    crawling over rock recorded as smooth. Roughness is now divided by
 *    speed squared, which makes it a property of the road rather than of
 *    how you drove it.
 *
 * 3. IT THREW THE POTHOLES AWAY. Outliers beyond 4σ were discarded so a
 *    slammed door would not read as a pothole — but a pothole IS a 4σ spike,
 *    and it is the single most valuable thing in the recording. The window
 *    is short enough now (about a second) that a real impact raises its own
 *    span and nothing else, so it survives as a red twenty metres inside an
 *    otherwise calm road. The slammed door is excluded by the orientation
 *    gate instead, which is where that job belonged.
 *
 * ---------------------------------------------------------------------------
 * AND WHY THERE IS A CALIBRATION DRIVE
 * ---------------------------------------------------------------------------
 *
 * A stiff-sprung pickup and a soft-riding van record the same road quite
 * differently, and there is no absolute number that is right for both. So
 * roughness is reported RELATIVE to a baseline the camper records once, on a
 * road they know is smooth. Everything after that is "rougher than my own
 * smooth road", which is meaningful for one person on day one — and does not
 * need a crowd to become true.
 *
 * Without a baseline the app falls back to a default and SAYS SO. It never
 * silently pretends the uncalibrated number is the calibrated one.
 */

import { collapseRoughness } from '../config/scoutRoughness';
import { haversineM } from '../../shared/geoMath';

export interface MotionSample {
  t: number;
  /** Total acceleration magnitude including gravity, m/s². */
  magnitude: number;
  gx: number;
  gy: number;
  gz: number;
}

export interface GeoSample {
  t: number;
  lat: number;
  lon: number;
  speedMps: number | null;
}

/** One place on the ground, and how rough the ride was there. */
export interface ScoutPoint {
  lat: number;
  lon: number;
  /** Roughness index, 0–1. See `roughnessIndex`. */
  r: number;
}

export interface ScoutBatch {
  recordedAt: string;
  path: [number, number][];
  /**
   * The drive as the map draws it: one roughness reading per GPS fix, which
   * at driving speed is a point every ten to twenty metres. This is the
   * whole reason a pothole needs no marker — the bad span is its own point.
   */
  points: ScoutPoint[];
  sampleHz: number;
  meanSpeedKph: number;
  /** Vertical acceleration RMS, m/s², gravity and horizontal forces removed. */
  verticalRms: number;
  /** Speed-normalised roughness before calibration is applied. */
  rawRoughness: number;
  /** Was a camper-recorded baseline used, or the fallback default? */
  calibrated: boolean;
  /** Roughness index for the batch as a whole — the WORST span, not the mean. */
  roughness: number;
  dashMounted: boolean;
  rejectReason?: string;
  sampleCount: number;
  distanceM: number;
}

/**
 * A camper's own smooth-road baseline.
 *
 * Recorded once, on a road they know is smooth, in the vehicle they drive.
 * Everything afterwards is measured against it — see the note at the top.
 */
export interface ScoutCalibration {
  /** Speed-normalised roughness measured on the known-smooth road. */
  baseline: number;
  recordedAt: string;
  distanceM: number;
  meanSpeedKph: number;
}

/**
 * The measured roughness of one span, as an index from 0 to 1.
 *
 * Deliberately a NUMBER and not a set of named classes. The map draws it as
 * a continuous gradient, so bucketing it here would throw away the detail the
 * drawing depends on — and the old seven names (`smooth_paved`,
 * `good_gravel`, `rutted_dirt`…) named materials this sensor cannot see.
 * Words for humans live in `config/scoutRoughness.ts`, applied at the edge.
 */
export type RoughnessIndex = number;

/**
 * The fallback baseline, used until a camper records their own.
 *
 * Roughly what smooth asphalt produces once vertical RMS is divided by speed
 * squared. It is a guess at an average vehicle and it is wrong for every
 * specific one, which is exactly why the app says "uncalibrated" wherever a
 * number derived from it is shown.
 */
export const DEFAULT_BASELINE = 3.5e-4;

/**
 * Speed clamp for the normalisation divisor, in m/s (14–90 km/h).
 *
 * Dividing by v² is right across normal driving speeds and explodes outside
 * them: crawling at 4 km/h over boulders would otherwise be divided by
 * almost nothing and come out a hundred times worse than it is. Clamping
 * bounds the correction instead of letting it run away, and mean speed is
 * carried on every batch so a card can say how fast it was recorded.
 */
const SPEED_CLAMP_MPS = { min: 4, max: 25 };

/**
 * Ratios to the baseline that map onto the ends of the 0–1 index.
 *
 * PROVISIONAL. They are reasoned from what a vehicle plausibly produces on
 * asphalt versus a rock garden, not measured against real recordings —
 * because at the time of writing there were none. They are the first thing
 * to retune once a few hundred kilometres exist, and until then the honest
 * reading of a colour is "rougher or smoother than my own smooth road", not
 * an absolute grade.
 */
const RATIO_SMOOTH = 1.2;
const RATIO_PUNISHING = 40;

/**
 * Turn a speed-normalised roughness into the 0–1 index the map draws.
 *
 * Logarithmic, because the span from smooth asphalt to a rock garden is well
 * over an order of magnitude and a linear scale would paint everything short
 * of catastrophic in the same straw colour.
 */
export const roughnessIndex = (raw: number, baseline = DEFAULT_BASELINE): RoughnessIndex => {
  const base = baseline > 0 ? baseline : DEFAULT_BASELINE;
  const ratio = raw / base;
  if (!Number.isFinite(ratio) || ratio <= RATIO_SMOOTH) return 0;

  const t =
    (Math.log(ratio) - Math.log(RATIO_SMOOTH)) /
    (Math.log(RATIO_PUNISHING) - Math.log(RATIO_SMOOTH));

  return t < 0 ? 0 : t > 1 ? 1 : t;
};

/* ------------------------------------------------------------------ */
/* Maths                                                               */
/* ------------------------------------------------------------------ */

const mean = (xs: number[]): number =>
  xs.length === 0 ? 0 : xs.reduce((a, b) => a + b, 0) / xs.length;

const variance = (xs: number[]): number => {
  if (xs.length < 2) return 0;
  const m = mean(xs);
  return xs.reduce((acc, x) => acc + (x - m) ** 2, 0) / (xs.length - 1);
};

/**
 * The direction of "down", as this phone is currently sitting.
 *
 * The mean of the raw acceleration vectors points, to a very good
 * approximation, straight down: road bumps and driving forces average out
 * over time and gravity does not.
 *
 * MEASURE IT OVER THE LONGEST WINDOW AVAILABLE. Estimated from one second,
 * a slow surge of braking has not had time to average out, so the axis tilts
 * toward it and the horizontal force leaks into the vertical reading — about
 * 0.14 m/s² of phantom roughness under steady braking, which is a third of
 * what a genuinely smooth road produces. Estimated over the whole minute,
 * the same surge is a small wobble on a much longer average and the leak
 * drops by an order of magnitude. So the axis comes from the batch and the
 * spans are projected onto it.
 */
export const verticalAxis = (samples: MotionSample[]): [number, number, number] | null => {
  if (samples.length < 2) return null;

  const mx = mean(samples.map((s) => s.gx));
  const my = mean(samples.map((s) => s.gy));
  const mz = mean(samples.map((s) => s.gz));
  const norm = Math.hypot(mx, my, mz);
  if (norm === 0) return null;

  return [mx / norm, my / norm, mz / norm];
};

/**
 * Vertical acceleration, gravity and horizontal driving forces removed.
 *
 * Projecting every sample onto the "down" axis isolates the axis road
 * roughness actually lives on, and leaves braking and cornering — which are
 * perpendicular to it — behind. Subtracting the window mean then removes the
 * 9.81 itself, so what comes back is deviation about the vehicle's resting
 * state rather than a number with gravity buried in it.
 *
 * This is the fix for the first of the three things listed at the top of the
 * file: the old version took the variance of the total acceleration
 * magnitude, so every stop light looked like a washboard.
 *
 * Pass `axis` whenever a longer recording is available to estimate it from —
 * see `verticalAxis` for why that matters more than it looks.
 */
export const verticalDeviations = (
  samples: MotionSample[],
  axis?: [number, number, number] | null
): number[] => {
  if (samples.length < 2) return [];

  const unit = axis ?? verticalAxis(samples);
  if (!unit) return [];

  const projected = samples.map((s) => s.gx * unit[0] + s.gy * unit[1] + s.gz * unit[2]);
  const centre = mean(projected);
  return projected.map((v) => v - centre);
};

/** Root mean square — the size of the bumps, in m/s². */
export const rms = (xs: number[]): number =>
  xs.length === 0 ? 0 : Math.sqrt(xs.reduce((acc, x) => acc + x * x, 0) / xs.length);

/**
 * Roughness of one span, normalised for how fast it was driven.
 *
 * Vertical acceleration scales with the square of speed for a given road
 * profile, so dividing by v² turns "how hard this hit me" into "how rough
 * this road is" — the second of the three fixes at the top of the file.
 * The divisor is clamped; see `SPEED_CLAMP_MPS`.
 */
export const normalisedRoughness = (verticalRms: number, speedMps: number): number => {
  const v = Math.min(
    SPEED_CLAMP_MPS.max,
    Math.max(SPEED_CLAMP_MPS.min, Number.isFinite(speedMps) ? speedMps : 0)
  );
  return verticalRms / (v * v);
};

/**
 * Is the phone in a mount?
 *
 * A mounted phone's gravity vector stays put. We measure the angular spread
 * of that vector: low spread means mounted, high means it was being handled.
 *
 * This gate now carries more weight than it used to. The old spike filter
 * threw away every 4σ reading to keep a slammed door out of the data, and
 * took the potholes with it. Rejecting handled phones HERE, and keeping the
 * spikes, is the right division of labour: this test knows the difference
 * between a phone in a cradle and a phone in a hand, which is the actual
 * question. A pothole is not a phone being picked up.
 */
export const isDashMounted = (samples: MotionSample[]): boolean => {
  if (samples.length < 20) return false;

  const mx = mean(samples.map((s) => s.gx));
  const my = mean(samples.map((s) => s.gy));
  const mz = mean(samples.map((s) => s.gz));
  const norm = Math.hypot(mx, my, mz) || 1;
  const ax = mx / norm;
  const ay = my / norm;
  const az = mz / norm;

  const deviations = samples.map((s) => {
    const n = Math.hypot(s.gx, s.gy, s.gz) || 1;
    const dot = (s.gx / n) * ax + (s.gy / n) * ay + (s.gz / n) * az;
    return (Math.acos(Math.max(-1, Math.min(1, dot))) * 180) / Math.PI;
  });

  // A windscreen mount on a rough road still moves a few degrees; a handled
  // phone routinely swings 30°+.
  return mean(deviations) < 12;
};

/** Haversine distance in metres. */
const distanceM = (a: GeoSample, b: GeoSample): number =>
  haversineM(a.lat, a.lon, b.lat, b.lon);

/**
 * Turn raw sensor buffers into an upload-ready batch.
 *
 * The important part is that this does NOT produce one roughness number for
 * the minute. It cuts the drive at every GPS fix and scores each span on its
 * own, which at driving speed is a reading every ten to twenty metres. That
 * is what lets the map fade along a road, and it is why a pothole needs no
 * marker: the bad span is simply one point that goes red.
 *
 * The batch's own `roughness` is the WORST span, not the average — a road
 * with one axle-breaker in it is a road with an axle-breaker in it, and
 * averaging that away is the one thing this feature must not do.
 */
export const buildBatch = (
  motion: MotionSample[],
  geo: GeoSample[],
  sampleHz: number,
  calibration: ScoutCalibration | null = null
): ScoutBatch | null => {
  if (motion.length < 20 || geo.length < 2) return null;

  const baseline = calibration?.baseline ?? DEFAULT_BASELINE;

  let travelled = 0;
  for (let i = 1; i < geo.length; i += 1) travelled += distanceM(geo[i - 1], geo[i]);

  const speeds = geo
    .map((g) => g.speedMps)
    .filter((s): s is number => typeof s === 'number' && s >= 0);
  const meanSpeedKph = speeds.length > 0 ? mean(speeds) * 3.6 : 0;

  /*
   * One span per GPS fix. Motion samples are bucketed by the fix they fall
   * between, so each span is scored from the sensor readings taken while the
   * vehicle was actually on that stretch of ground.
   */
  // One "down" for the whole minute — see `verticalAxis`.
  const axis = verticalAxis(motion);

  const points: ScoutPoint[] = [];
  for (let i = 1; i < geo.length; i += 1) {
    const from = geo[i - 1];
    const to = geo[i];
    const window = motion.filter((m) => m.t >= from.t && m.t <= to.t);

    // Too few readings to say anything. Skipped rather than guessed at.
    if (window.length < 6) continue;

    const spanRms = rms(verticalDeviations(window, axis));
    const spanSpeed =
      typeof to.speedMps === 'number' && to.speedMps >= 0
        ? to.speedMps
        : distanceM(from, to) / Math.max(0.5, (to.t - from.t) / 1000);

    points.push({
      lat: to.lat,
      lon: to.lon,
      r: roughnessIndex(normalisedRoughness(spanRms, spanSpeed), baseline)
    });
  }

  // Whole-batch figures, kept for the upload and for the panel's live read-out.
  const verticalRms = rms(verticalDeviations(motion, axis));
  const rawRoughness = normalisedRoughness(verticalRms, (meanSpeedKph / 3.6) || 0);

  const mounted = isDashMounted(motion);

  let rejectReason: string | undefined;
  if (!mounted) rejectReason = 'Phone was not stable in a mount';
  else if (meanSpeedKph < 5) rejectReason = 'Not moving';
  else if (travelled < 200) rejectReason = 'Segment shorter than 200 m';

  return {
    recordedAt: new Date(geo[0].t).toISOString(),
    path: geo.map((g) => [g.lon, g.lat] as [number, number]),
    points,
    sampleHz,
    meanSpeedKph: Number(meanSpeedKph.toFixed(1)),
    verticalRms: Number(verticalRms.toFixed(4)),
    rawRoughness,
    calibrated: calibration !== null,
    // The worst span. See the note above.
    roughness: points.length > 0 ? collapseRoughness(points.map((p) => p.r)) : 0,
    dashMounted: mounted && meanSpeedKph >= 5 && travelled >= 200,
    rejectReason,
    sampleCount: motion.length,
    distanceM: Math.round(travelled)
  };
};

/* ------------------------------------------------------------------ */
/* Recorder                                                            */
/* ------------------------------------------------------------------ */

export interface ScoutRecorderOptions {
  batchSeconds?: number;
  onBatch: (batch: ScoutBatch) => void | Promise<void>;
  /**
   * The camper's own smooth-road baseline, when they have recorded one.
   * Null means the fallback default is in use and every number derived from
   * it is labelled uncalibrated on screen.
   */
  calibration?: ScoutCalibration | null;
  onStatus?: (status: {
    running: boolean;
    mounted: boolean;
    speedKph: number;
    /** 0–1, or null before there are enough readings to say. */
    roughness: number | null;
    samples: number;
  }) => void;
}

/** iOS 13+ requires an explicit prompt, triggered by a user gesture. */
export const requestMotionPermission = async (): Promise<boolean> => {
  const AnyMotion = (window as any).DeviceMotionEvent;
  if (!AnyMotion) return false;
  if (typeof AnyMotion.requestPermission !== 'function') return true;
  try {
    const result = await AnyMotion.requestPermission();
    return result === 'granted';
  } catch {
    return false;
  }
};

export const isMotionSupported = (): boolean =>
  typeof window !== 'undefined' && 'DeviceMotionEvent' in window;

export class ScoutRecorder {
  private motion: MotionSample[] = [];
  private geo: GeoSample[] = [];
  private watchId: number | null = null;
  private timer: ReturnType<typeof setInterval> | null = null;
  private running = false;
  /** When the last batch was cut, so the next one can measure real elapsed time. */
  private lastFlushAt: number | null = null;
  private readonly opts: Required<Pick<ScoutRecorderOptions, 'batchSeconds'>> &
    ScoutRecorderOptions;

  constructor(options: ScoutRecorderOptions) {
    this.opts = { batchSeconds: 60, ...options };
  }

  private handleMotion = (e: DeviceMotionEvent) => {
    const acc = e.accelerationIncludingGravity;
    if (!acc || acc.x == null || acc.y == null || acc.z == null) return;
    this.motion.push({
      t: Date.now(),
      magnitude: Math.hypot(acc.x, acc.y, acc.z),
      gx: acc.x,
      gy: acc.y,
      gz: acc.z
    });
    // Cap the buffer so a long drive can't exhaust memory.
    if (this.motion.length > 20000) this.motion.splice(0, this.motion.length - 20000);
  };

  private handlePosition = (pos: GeolocationPosition) => {
    this.geo.push({
      t: pos.timestamp,
      lat: pos.coords.latitude,
      lon: pos.coords.longitude,
      speedMps: pos.coords.speed
    });
    if (this.geo.length > 5000) this.geo.splice(0, this.geo.length - 5000);
  };

  private flush = async () => {
    const motion = this.motion;
    const geo = this.geo;
    this.motion = [];
    this.geo = geo.length > 0 ? [geo[geo.length - 1]] : [];

    /*
     * Sample rate from the time that actually passed, not the interval we
     * asked for. A backgrounded tab has its timers throttled hard — the
     * flush can arrive a minute late — and dividing by the configured
     * interval then reports a sample rate several times higher than the
     * sensor ever produced. sample_hz is stored with the batch and is part
     * of how a batch's plausibility is judged later.
     */
    const now = Date.now();
    const elapsedS = this.lastFlushAt
      ? Math.max(1, (now - this.lastFlushAt) / 1000)
      : this.opts.batchSeconds;
    this.lastFlushAt = now;

    const hz = motion.length > 0 ? Math.round(motion.length / elapsedS) : 0;
    const batch = buildBatch(motion, geo, hz || 50, this.opts.calibration ?? null);
    if (batch) await this.opts.onBatch(batch);
  };

  private emitStatus = () => {
    if (!this.opts.onStatus) return;
    const recent = this.motion.slice(-100);
    const lastSpeed = this.geo[this.geo.length - 1]?.speedMps ?? 0;

    /*
     * The live read-out runs the same maths the stored data does — vertical
     * only, normalised for speed, measured against the camper's own baseline.
     * A dial that disagreed with what later appears on the map would be worse
     * than no dial.
     */
    const roughness =
      recent.length > 8
        ? roughnessIndex(
            // Two seconds of buffer is all the live dial has to find "down"
            // with, so it is noisier than the stored figure by design. It is
            // a dial, not a record.
            normalisedRoughness(rms(verticalDeviations(recent)), lastSpeed ?? 0),
            this.opts.calibration?.baseline
          )
        : null;

    this.opts.onStatus({
      running: this.running,
      mounted: recent.length > 20 ? isDashMounted(recent) : false,
      speedKph: Number(((lastSpeed ?? 0) * 3.6).toFixed(0)),
      roughness: recent.length > 20 ? roughness : null,
      samples: this.motion.length
    });
  };

  async start(): Promise<{ ok: boolean; message: string }> {
    if (this.running) return { ok: true, message: 'Already running' };
    if (!isMotionSupported()) {
      return { ok: false, message: 'This device has no motion sensors' };
    }

    const granted = await requestMotionPermission();
    if (!granted) return { ok: false, message: 'Motion permission denied' };
    if (!('geolocation' in navigator)) {
      return { ok: false, message: 'Location unavailable' };
    }

    window.addEventListener('devicemotion', this.handleMotion);
    this.watchId = navigator.geolocation.watchPosition(this.handlePosition, () => undefined, {
      enableHighAccuracy: true,
      maximumAge: 1000,
      timeout: 10000
    });

    this.timer = setInterval(() => {
      this.flush();
      this.emitStatus();
    }, this.opts.batchSeconds * 1000);

    this.running = true;
    // The first batch measures from here, not from an earlier session.
    this.lastFlushAt = Date.now();
    this.emitStatus();
    return { ok: true, message: 'Scout Mode active' };
  }

  async stop(): Promise<void> {
    if (!this.running) return;
    window.removeEventListener('devicemotion', this.handleMotion);
    if (this.watchId !== null) navigator.geolocation.clearWatch(this.watchId);
    if (this.timer) clearInterval(this.timer);
    this.watchId = null;
    this.timer = null;
    this.running = false;
    await this.flush();
    this.lastFlushAt = null;
    this.emitStatus();
  }

  isRunning(): boolean {
    return this.running;
  }
}
