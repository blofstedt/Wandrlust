import { Campsite } from '../types';

/**
 * Image helpers.
 *
 * Most curated campsites ship with an empty `images` array, so every consumer
 * needs a deterministic, key-free fallback. We use the Esri World Imagery
 * export endpoint, which renders a satellite JPEG for an arbitrary bounding
 * box without requiring an API token.
 */

const ESRI_EXPORT =
  'https://services.arcgisonline.com/arcgis/rest/services/World_Imagery/MapServer/export';

export const getSatelliteImageUrl = (
  latitude: number,
  longitude: number,
  spanDegrees = 0.02,
  width = 800,
  height = 500
): string => {
  const minLon = longitude - spanDegrees;
  const minLat = latitude - spanDegrees * (height / width);
  const maxLon = longitude + spanDegrees;
  const maxLat = latitude + spanDegrees * (height / width);

  const params = new URLSearchParams({
    bbox: `${minLon},${minLat},${maxLon},${maxLat}`,
    bboxSR: '4326',
    imageSR: '3857',
    size: `${width},${height}`,
    format: 'jpg',
    f: 'image'
  });

  return `${ESRI_EXPORT}?${params.toString()}`;
};

/** Tightly-cropped aerial view, used for the "Zoomed Aerial" toggle. */
export const getCloseSatelliteImageUrl = (latitude: number, longitude: number): string =>
  getSatelliteImageUrl(latitude, longitude, 0.004);

/**
 * Primary display image: first user/curated photo if one exists, otherwise a
 * satellite view of the actual coordinates.
 */
export const getCampsiteDisplayImage = (campsite: Campsite): string => {
  const firstUsable = campsite.images?.find(
    (src) => typeof src === 'string' && src.trim().length > 0
  );
  return firstUsable ?? getSatelliteImageUrl(campsite.latitude, campsite.longitude, 0.012);
};

export const getStreetViewUrl = (latitude: number, longitude: number): string =>
  `https://www.google.com/maps/@?api=1&map_action=pano&viewpoint=${latitude},${longitude}`;

// Directions moved to `src/utils/handoff.ts` — it is no longer a Google-only
// link, and it is now how the app gets you to a spot at all.
