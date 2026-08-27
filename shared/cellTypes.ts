/**
 * Cell-coverage vocabulary shared by the client and the server.
 *
 * `CarrierId`, `CellTechnology` and `SignalStrength` used to be defined twice
 * — once in src/types.ts, once in server/cellSources.ts — kept in sync only
 * by whoever remembered to edit both. `CellTower` itself is deliberately NOT
 * unified here: the server's pre-measurement shape (`RawCellTower` in
 * cellSources.ts) and the client's wire shape (`CellTower` in src/types.ts,
 * which additionally carries `distanceKm`) are genuinely different stages of
 * the same pipeline, and giving them the same name is what let the client's
 * required `distanceKm` field silently drift out of sync with the server's
 * copy in the first place.
 */

export type CarrierId = 'verizon' | 'att' | 'tmobile' | 'rogers' | 'telus' | 'bell';

/** The word a camper reads. Bars are the drawing; this is the answer. */
export type SignalStrength = 'strong' | 'good' | 'weak' | 'none';

/**
 * Which generation the nearest transmitter serves.
 *
 * Absent whenever nobody recorded it, which is most masts. It is never
 * inferred from the carrier or the era — an untagged mast gets no label.
 */
export type CellTechnology = '5G' | '4G LTE' | '3G' | '2G';
