/**
 * A small in-memory cache with a time limit and a size limit.
 *
 * WHY THIS EXISTS
 *
 * The map asks Overpass for facilities every time the viewport moves past
 * the zoom gate, and for campsites every time a place is searched. Overpass
 * is volunteer-run, rate-limited, and entitled to stop answering us. Panning
 * back to where you just were, or re-opening a pin, is the same question with
 * the same answer, and asking it again spends someone else's server.
 *
 * A Map iterates in insertion order, so evicting the oldest entry is
 * `delete(keys().next().value)` and nothing more elaborate is needed at these
 * sizes.
 *
 * WHAT IT IS NOT: a store. Nothing here survives a reload, and nothing here
 * is a source of truth. Callers decide what is worth remembering — and in
 * this app that never includes a failure, because a cached "we could not
 * check" would keep telling a camper there is nothing there long after the
 * network came back.
 */
export class TtlCache<T> {
  private readonly entries = new Map<string, { at: number; value: T }>();

  constructor(
    private readonly ttlMs: number,
    private readonly maxEntries = 60
  ) {}

  get(key: string): T | undefined {
    const hit = this.entries.get(key);
    if (!hit) return undefined;
    if (Date.now() - hit.at > this.ttlMs) {
      this.entries.delete(key);
      return undefined;
    }
    return hit.value;
  }

  set(key: string, value: T): void {
    this.entries.set(key, { at: Date.now(), value });
    while (this.entries.size > this.maxEntries) {
      const oldest = this.entries.keys().next().value;
      if (oldest === undefined) break;
      this.entries.delete(oldest);
    }
  }

  clear(): void {
    this.entries.clear();
  }
}
