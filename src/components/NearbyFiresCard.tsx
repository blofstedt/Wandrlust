/**
 * Per-pin "active fire nearby" card.
 *
 * Reads fires for a small bbox around a point, filters to within
 * `radiusKm`, and renders a list. Used by the destination sheet
 * (a dropped pin) and the campsite bottom sheet (a saved spot) so
 * the rule is the same regardless of which kind of pin the user
 * is looking at.
 *
 *   - Independent of the on-map `showFires` toggle. A camper who
 *     has the layer off still gets "fire X km away" on the pin.
 *   - Two-tier visual: red within 10 km, amber within 25 km.
 *     10 km is roughly the radius at which smoke starts to affect
 *     a site; 25 km is the air-quality radius. The line is read
 *     at a glance and not buried in a list.
 *   - The fetch is debounced 250 ms, refetched on every pin change
 *     with a 25-km-padded bbox. Cancel the in-flight request on
 *     the next change so a slow older fetch does not overwrite a
 *     newer one.
 */
import React, { useEffect, useState } from 'react';
import { Flame, TriangleAlert } from 'lucide-react';
import { fetchActiveFires, findFiresNear, boxAround, ActiveFire } from '../services/fireService';

interface NearbyFiresCardProps {
  latitude: number;
  longitude: number;
  /** Search radius in km. 25 is the project's default. */
  radiusKm?: number;
}

const formatKm = (km: number): string => {
  if (km < 1) return `${Math.round(km * 1000)} m`;
  if (km < 10) return `${km.toFixed(1)} km`;
  return `${Math.round(km)} km`;
};

const formatSize = (fire: ActiveFire): string => {
  if (fire.sizeHa != null && fire.sizeHa >= 0.1) {
    return `${Math.round(fire.sizeHa).toLocaleString()} ha`;
  }
  if (fire.sizeAcres != null && fire.sizeAcres >= 0.5) {
    return `${Math.round(fire.sizeAcres).toLocaleString()} acres`;
  }
  return '';
};

/** How close is "scary" vs. "heads up". Tunable. */
const TIER_NEAR_KM = 10;

/**
 * The fetch, shared by both renderings below.
 *
 * Debounced 250 ms, refetched on every pin change with a padded bbox, and the
 * in-flight request is cancelled on the next change so a slow older fetch
 * cannot overwrite a newer one.
 */
const useNearbyFires = (latitude: number, longitude: number, radiusKm: number) => {
  const [loading, setLoading] = useState(false);
  const [fires, setFires] = useState<Array<{ fire: ActiveFire; distanceKm: number }>>([]);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    let controller: AbortController | null = null;
    setLoading(true);
    setError(null);

    const timer = setTimeout(async () => {
      controller = new AbortController();
      const box = boxAround(latitude, longitude, radiusKm);
      const data = await fetchActiveFires(box, controller.signal);
      if (cancelled) return;
      if (data.meta.errors.length > 0 && data.features.length === 0) {
        // Only surface an error if we got nothing back. A partial
        // response (one feed down) is still useful.
        setError(data.meta.errors.join('; '));
        setFires([]);
      } else {
        const nearby = findFiresNear(
          data.features.map((f) => f.properties),
          latitude, longitude, radiusKm
        );
        setFires(nearby);
        setError(null);
      }
      setLoading(false);
    }, 250);

    return () => {
      cancelled = true;
      controller?.abort();
      clearTimeout(timer);
    };
  }, [latitude, longitude, radiusKm]);

  return { loading, fires, error };
};

/**
 * The same answer, sized for the destination sheet's bento grid.
 *
 * Shares the fetch rules above but renders one tile instead of a list: the
 * closest fire, in words, because on a half-screen panel the second-closest
 * fire is not what decides anything. Renders nothing at all when there are no
 * fires nearby — a tile saying "no fires" would be claiming a clean bill of
 * health that a 25 km bbox query cannot give. A failed lookup does get a tile,
 * because "we couldn't check" and "nothing found" must not look the same.
 */
export const NearbyFiresTile: React.FC<NearbyFiresCardProps> = ({
  latitude,
  longitude,
  radiusKm = 25
}) => {
  const { loading, fires, error } = useNearbyFires(latitude, longitude, radiusKm);

  if (loading) {
    return (
      <div className="rounded-xl border border-slate-700/60 bg-slate-800/50 px-2.5 py-2 flex flex-col min-h-0">
        <p className="text-[9px] font-bold uppercase tracking-wider text-slate-400 flex items-center gap-1">
          <Flame className="w-3 h-3" />
          Active fires
        </p>
        <p className="text-[11px] text-slate-400 mt-0.5">Checking…</p>
      </div>
    );
  }

  if (error) {
    return (
      <div className="rounded-xl border border-slate-700/60 bg-slate-800/50 px-2.5 py-2 flex flex-col min-h-0">
        <p className="text-[9px] font-bold uppercase tracking-wider text-slate-400 flex items-center gap-1">
          <Flame className="w-3 h-3" />
          Active fires
        </p>
        <p className="text-[10px] text-slate-400 leading-snug mt-0.5 line-clamp-3">
          Couldn't check the fire feeds just now — this is not an all-clear.
        </p>
      </div>
    );
  }

  if (fires.length === 0) return null;

  const closest = fires[0];
  const near = closest.distanceKm <= TIER_NEAR_KM;

  return (
    <div
      className={`rounded-xl border px-2.5 py-2 flex flex-col min-h-0 ${
        near ? 'border-red-500/60 bg-red-950/30' : 'border-amber-500/50 bg-amber-950/20'
      }`}
    >
      <p
        className={`text-[9px] font-bold uppercase tracking-wider flex items-center gap-1 ${
          near ? 'text-red-300' : 'text-amber-300'
        }`}
      >
        {near ? <TriangleAlert className="w-3 h-3" /> : <Flame className="w-3 h-3" />}
        {fires.length > 1 ? `${fires.length} active fires` : 'Active fire'}
      </p>
      <p className="text-[11px] font-bold text-slate-100 leading-tight mt-0.5">
        {formatKm(closest.distanceKm)} away
      </p>
      <p className="text-[9px] text-slate-300 leading-tight line-clamp-2">
        {closest.fire.name}
        {formatSize(closest.fire) && ` · ${formatSize(closest.fire)}`}
        {closest.fire.status && ` · ${closest.fire.status}`}
      </p>
    </div>
  );
};

export const NearbyFiresCard: React.FC<NearbyFiresCardProps> = ({
  latitude,
  longitude,
  radiusKm = 25
}) => {
  const { loading, fires, error } = useNearbyFires(latitude, longitude, radiusKm);

  // Don't render anything if there are no fires and we're not loading
  // and there was no error. A blank section is just noise.
  if (!loading && fires.length === 0 && !error) return null;

  return (
    <section>
      <h3 className="text-[10px] font-bold uppercase tracking-wider text-slate-400 mb-2 flex items-center gap-1.5">
        <Flame className="w-3 h-3" />
        Active fire nearby
      </h3>
      {loading && (
        <div className="text-[11px] text-slate-400">Checking for fires…</div>
      )}
      {error && !loading && (
        <div className="text-[11px] text-slate-500">Fire data unavailable: {error}</div>
      )}
      {fires.length > 0 && (
        <ul className="space-y-1.5">
          {fires.map(({ fire, distanceKm }) => {
            const tier = distanceKm <= TIER_NEAR_KM ? 'near' : 'warn';
            const ringClass = tier === 'near'
              ? 'border-red-500/60 bg-red-950/30'
              : 'border-amber-500/50 bg-amber-950/20';
            const dotClass = tier === 'near' ? 'text-red-400' : 'text-amber-400';
            return (
              <li
                key={fire.id}
                className={`flex items-start gap-2 px-2.5 py-2 rounded-lg border ${ringClass}`}
              >
                {tier === 'near'
                  ? <TriangleAlert className={`w-3.5 h-3.5 mt-0.5 shrink-0 ${dotClass}`} />
                  : <Flame className={`w-3.5 h-3.5 mt-0.5 shrink-0 ${dotClass}`} />}
                <div className="min-w-0 flex-1">
                  <div className="text-[12px] text-slate-100 font-semibold leading-tight truncate">
                    {fire.name}
                  </div>
                  <div className="text-[10px] text-slate-400 mt-0.5 flex items-center gap-1.5 flex-wrap">
                    <span className={dotClass + ' font-bold'}>
                      {formatKm(distanceKm)} {tier === 'near' ? '· nearby' : '· in the area'}
                    </span>
                    <span>· {fire.region}</span>
                    {formatSize(fire) && <span>· {formatSize(fire)}</span>}
                    {fire.status && <span>· {fire.status}</span>}
                  </div>
                </div>
              </li>
            );
          })}
        </ul>
      )}
    </section>
  );
};
