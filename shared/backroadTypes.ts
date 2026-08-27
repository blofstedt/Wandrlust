/**
 * Backroads vocabulary shared by the client and the server.
 *
 * These types used to be defined twice — once in src/types.ts, once in
 * server/backroadRoutes.ts, kept in sync only because both files' comments
 * pointed at each other. Still byte-identical when this was written, but
 * that is exactly the state CellTower's client/server copies were in right
 * before they drifted — see shared/cellTypes.ts.
 *
 * The unpaved and minor roads drawn as an overlay on the map. Sourced from
 * OpenStreetMap, which means a line here is a road SOMEBODY RECORDED — not a
 * road that is passable, maintained, ungated or legal to drive.
 *
 * `surface` has three states on purpose. OSM leaves the surface tag off far
 * more often than it fills it in, so "nobody wrote it down" is the common
 * case and it must never be rendered as either paved or unpaved.
 */

export type BackroadSurface = 'unpaved' | 'paved' | 'unrecorded';

/** What OSM says about driving it. `open` means nothing says otherwise. */
export type BackroadAccess = 'open' | 'permit' | 'private';

/**
 * Four fields, because four fields are what the map draws. What OSM knows
 * and this deliberately does not carry — the name, the gate, `4wd_only`,
 * seasonal access, the exact surface word — is listed in
 * `server/backroadRoutes.ts`, along with where to pick it back up.
 */
export interface BackroadWay {
  /** The raw `highway` value — `track`, `service`, `unclassified`… */
  kind: string;
  /** What OSM records about the surface. `unrecorded` is a real answer. */
  surface: BackroadSurface;
  /** OSM says a permit or permission is needed, or that it is private. */
  access: BackroadAccess;
  /** [lat, lon] pairs, simplified for drawing. */
  line: [number, number][];
}

export interface BackroadScan {
  /** False means we could not check — never "there are no roads here". */
  ok: boolean;
  /** The box asked about was too big to answer. */
  tooWide: boolean;
  /** Roads were dropped to keep the answer drawable. */
  truncated: boolean;
  roads: BackroadWay[];
}
