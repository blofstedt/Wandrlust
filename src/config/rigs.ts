import type { RigType } from '../services/dataService';

/**
 * Rig avatars.
 *
 * Emoji, so this file has no assets, no licences and no React — which is what
 * lets both the presence panel and the Leaflet map (which builds its icons as
 * raw HTML strings) use the same table. Two copies of this would drift and a
 * camper's van would silently turn into a tent on one screen.
 */
export const RIG_AVATAR: Record<RigType, { emoji: string; label: string }> = {
  tent: { emoji: '⛺', label: 'Tent' },
  car: { emoji: '🚗', label: 'Car' },
  suv: { emoji: '🚙', label: 'SUV' },
  van: { emoji: '🚐', label: 'Van' },
  truck_camper: { emoji: '🛻', label: 'Truck camper' },
  travel_trailer: { emoji: '🚚', label: 'Travel trailer' },
  fifth_wheel: { emoji: '🚛', label: 'Fifth wheel' },
  class_a: { emoji: '🚌', label: 'Class A' },
  class_b: { emoji: '🚐', label: 'Class B' },
  class_c: { emoji: '🚍', label: 'Class C' },
  skoolie: { emoji: '🚌', label: 'Skoolie' },
  overland_rig: { emoji: '🛞', label: 'Overland rig' }
};

/** Shown for a camper who hasn't said what they drive. */
export const UNKNOWN_RIG_EMOJI = '📍';
