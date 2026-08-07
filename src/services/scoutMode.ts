/**
 * Scout Mode — passive road-surface mapping from phone motion sensors.
 *
 * Vertical acceleration variance is a decent proxy for road roughness. A
 * smooth paved road produces near-constant 9.81 m/s²; washboard gravel
 * produces high-frequency oscillation; potholes produce sharp spikes.
 *
 * THE HARD PART IS FALSE POSITIVES
 *
 * Picking the phone up generates far more motion than any road surface.
 * Uploading that as "road data" would poison the dataset. Three filters:
 *
 *   1. Orientation gate — the phone must be stable in a mount. We track the
 *      angular spread of the gravity vector; a mounted phone barely rotates.
 *   2. Speed gate — below 5 km/h you are not measuring a road.
 *   3. Spike rejection — outliers beyond 4σ are discarded before computing
 *      variance, so one slammed door isn't recorded as a pothole.
 *
 * Failed batches are still uploaded with `dash_mounted: false` so the server
 * records them without paying points, letting thresholds be retuned later.
 */

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

export interface ScoutBatch {
  recordedAt: string;
  path: [number, number][];
  sampleHz: number;
  meanSpeedKph: number;
  verticalVariance: number;
  dashMounted: boolean;
  rejectReason?: string;
  sampleCount: number;
  distanceM: number;
}

export type SurfaceQuality =
  | 'smooth_paved' | 'rough_paved' | 'good_gravel'
  | 'washboard' | 'rutted_dirt' | 'rock_crawl' | 'impassable';

/** Variance thresholds, m²/s⁴. Tuned conservatively — err toward smoother. */
export const classifySurface = (variance: number): SurfaceQuality => {
  if (variance < 0.35) return 'smooth_paved';
  if (variance < 1.2) return 'rough_paved';
  if (variance < 3.0) return 'good_gravel';
  if (variance < 7.0) return 'washboard';
  if (variance < 15.0) return 'rutted_dirt';
  if (variance < 30.0) return 'rock_crawl';
  return 'impassable';
};

export const SURFACE_LABEL: Record<SurfaceQuality, string> = {
  smooth_paved: 'Smooth pavement',
  rough_paved: 'Rough pavement',
  good_gravel: 'Good gravel',
  washboard: 'Washboard',
  rutted_dirt: 'Rutted dirt',
  rock_crawl: 'Rock crawling',
  impassable: 'Impassable'
};

export const SURFACE_COLOR: Record<SurfaceQuality, string> = {
  smooth_paved: '#10B981',
  rough_paved: '#84CC16',
  good_gravel: '#EAB308',
  washboard: '#F59E0B',
  rutted_dirt: '#F97316',
  rock_crawl: '#EF4444',
  impassable: '#7F1D1D'
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

/** Drop samples beyond nσ so one slammed door isn't recorded as a pothole. */
const rejectOutliers = (xs: number[], sigmas = 4): number[] => {
  if (xs.length < 8) return xs;
  const m = mean(xs);
  const sd = Math.sqrt(variance(xs));
  if (sd === 0) return xs;
  return xs.filter((x) => Math.abs(x - m) <= sigmas * sd);
};

/**
 * Is the phone in a mount?
 *
 * A mounted phone's gravity vector stays put. We measure the angular spread
 * of that vector: low spread means mounted, high means it was being handled.
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
const distanceM = (a: GeoSample, b: GeoSample): number => {
  const R = 6371000;
  const dLat = ((b.lat - a.lat) * Math.PI) / 180;
  const dLon = ((b.lon - a.lon) * Math.PI) / 180;
  const la1 = (a.lat * Math.PI) / 180;
  const la2 = (b.lat * Math.PI) / 180;
  const h =
    Math.sin(dLat / 2) ** 2 + Math.cos(la1) * Math.cos(la2) * Math.sin(dLon / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(h));
};

/** Turn raw sensor buffers into an upload-ready batch. */
export const buildBatch = (
  motion: MotionSample[],
  geo: GeoSample[],
  sampleHz: number
): ScoutBatch | null => {
  if (motion.length < 20 || geo.length < 2) return null;

  const cleaned = rejectOutliers(motion.map((s) => s.magnitude));
  const v = variance(cleaned);

  let travelled = 0;
  for (let i = 1; i < geo.length; i += 1) travelled += distanceM(geo[i - 1], geo[i]);

  const speeds = geo
    .map((g) => g.speedMps)
    .filter((s): s is number => typeof s === 'number' && s >= 0);
  const meanSpeedKph = speeds.length > 0 ? mean(speeds) * 3.6 : 0;

  const mounted = isDashMounted(motion);

  let rejectReason: string | undefined;
  if (!mounted) rejectReason = 'Phone was not stable in a mount';
  else if (meanSpeedKph < 5) rejectReason = 'Not moving';
  else if (travelled < 200) rejectReason = 'Segment shorter than 200 m';

  return {
    recordedAt: new Date(geo[0].t).toISOString(),
    path: geo.map((g) => [g.lon, g.lat] as [number, number]),
    sampleHz,
    meanSpeedKph: Number(meanSpeedKph.toFixed(1)),
    verticalVariance: Number(v.toFixed(4)),
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
  onStatus?: (status: {
    running: boolean;
    mounted: boolean;
    speedKph: number;
    surface: SurfaceQuality | null;
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

    const elapsedS = this.opts.batchSeconds;
    const hz = motion.length > 0 ? Math.round(motion.length / elapsedS) : 0;
    const batch = buildBatch(motion, geo, hz || 50);
    if (batch) await this.opts.onBatch(batch);
  };

  private emitStatus = () => {
    if (!this.opts.onStatus) return;
    const recent = this.motion.slice(-100);
    const v = recent.length > 8 ? variance(rejectOutliers(recent.map((s) => s.magnitude))) : 0;
    const lastSpeed = this.geo[this.geo.length - 1]?.speedMps ?? 0;
    this.opts.onStatus({
      running: this.running,
      mounted: recent.length > 20 ? isDashMounted(recent) : false,
      speedKph: Number(((lastSpeed ?? 0) * 3.6).toFixed(0)),
      surface: recent.length > 20 ? classifySurface(v) : null,
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
    this.emitStatus();
  }

  isRunning(): boolean {
    return this.running;
  }
}