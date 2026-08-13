/**
 * What the app knows about a coordinate before it asks the camper anything.
 *
 * One call to `/api/spot/context` gets back a name built from OpenStreetMap
 * and a list of facilities within 5 km. That is what lets the report sheet
 * drop the name field entirely and skip any facility question the map can
 * already answer.
 *
 * Nothing here throws. A failure comes back as `poiLookupFailed: true`, and
 * that flag is load-bearing: with it set, the sheet must ASK about facilities
 * rather than reporting there are none. "We could not check" and "there is
 * nothing here" are different facts.
 */
import type { SpotContext } from '../types';

const UNREACHABLE: SpotContext = {
  ok: false,
  name: '',
  pois: [],
  poiLookupFailed: true,
  note: 'Could not reach the server to look this place up.'
};

export const fetchSpotContext = async (
  latitude: number,
  longitude: number,
  signal?: AbortSignal
): Promise<SpotContext> => {
  try {
    const res = await fetch(
      `/api/spot/context?lat=${latitude.toFixed(5)}&lon=${longitude.toFixed(5)}`,
      { signal }
    );

    const data = (await res.json()) as SpotContext;
    if (!data || typeof data !== 'object') return UNREACHABLE;

    return {
      ok: data.ok === true,
      name: typeof data.name === 'string' ? data.name : '',
      nameBasis: data.nameBasis,
      nearestTown: data.nearestTown,
      stateProvince: data.stateProvince,
      pois: Array.isArray(data.pois) ? data.pois : [],
      poiLookupFailed: data.poiLookupFailed === true,
      note: data.note
    };
  } catch {
    return UNREACHABLE;
  }
};

/**
 * A fallback name for when the lookup fails.
 *
 * Deliberately dull and obviously provisional. The alternative — inventing
 * something that sounds like a place name — would put a claim on the map that
 * nothing supports, which is the exact failure mode the whole naming design
 * exists to avoid.
 */
export const fallbackSpotName = (latitude: number, longitude: number): string =>
  `Spot at ${latitude.toFixed(3)}, ${longitude.toFixed(3)}`;
