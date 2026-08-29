/**
 * Collapse the duplicated populations in `public/map/places-us-ca.json`.
 *
 * ---------------------------------------------------------------------------
 * WHAT WAS WRONG WITH THE FILE
 * ---------------------------------------------------------------------------
 *
 * It was built by taking GeoNames POSITIONS and attaching Natural Earth
 * POPULATIONS to them, "matched within 15 km" — see the `sources` note in the
 * file itself. Two things about that combine badly:
 *
 *   Natural Earth's population figure is a METRO total. New York carries
 *   19,040,000, not the eight million inside the city limits.
 *
 *   Every GeoNames point within 15 km of that city inherited the whole
 *   figure. New York's 19,040,000 ended up on 105 separate points. One value
 *   was on 233 of them. In total 96% of the populated places shared their
 *   population with at least one other point.
 *
 * The urban/suburban rule derives a settlement's radius from its population,
 * so a metro of nineteen million is a circle tens of kilometres across — and
 * there were a hundred and five of those circles stacked on one metro. Whole
 * regions came out urban or suburban on the strength of one city counted over
 * and over. That is what the "wilderness sites showing suburban" report was.
 *
 * ---------------------------------------------------------------------------
 * WHAT THIS DOES ABOUT IT
 * ---------------------------------------------------------------------------
 *
 * Points sharing a population AND sitting near each other are one settlement
 * counted many times. The most central of them keeps the figure; the rest are
 * set to 0, which the classifier reads as "a named place, size unknown" and
 * gives a few hundred metres rather than a city's worth of reach.
 *
 * That is the honest reading of what they are: a suburb inside a metro IS a
 * settlement, it just is not a nineteen-million-person one.
 *
 * Clustering is by proximity as well as by value, so two genuinely different
 * towns that happen to have the same population, in different states, are
 * left alone.
 *
 *   node scripts/dedupePlaces.mjs
 */
import { readFileSync, writeFileSync } from 'node:fs';

const FILE = new URL('../public/map/places-us-ca.json', import.meta.url);

/** Same settlement, counted twice, is never further apart than this. */
const SAME_PLACE_KM = 60;

const R = 6371;
const rad = (d) => (d * Math.PI) / 180;
const km = (a, b, c, d) => {
  const dLat = rad(c - a), dLon = rad(d - b);
  const x = Math.sin(dLat / 2) ** 2 +
            Math.cos(rad(a)) * Math.cos(rad(c)) * Math.sin(dLon / 2) ** 2;
  return 2 * R * Math.asin(Math.min(1, Math.sqrt(x)));
};

const data = JSON.parse(readFileSync(FILE, 'utf8'));
const places = data.places;

const byPop = new Map();
places.forEach((p, i) => {
  if (p[2] > 0) {
    if (!byPop.has(p[2])) byPop.set(p[2], []);
    byPop.get(p[2]).push(i);
  }
});

let zeroed = 0, clusters = 0;

for (const [, idx] of byPop) {
  if (idx.length === 1) continue;

  // Single-linkage clustering: same value, and reachable by hops of 60 km.
  const unseen = new Set(idx);
  while (unseen.size) {
    const seed = unseen.values().next().value;
    unseen.delete(seed);
    const cluster = [seed];
    const queue = [seed];
    while (queue.length) {
      const cur = queue.pop();
      for (const other of [...unseen]) {
        if (km(places[cur][0], places[cur][1], places[other][0], places[other][1]) <= SAME_PLACE_KM) {
          unseen.delete(other);
          cluster.push(other);
          queue.push(other);
        }
      }
    }
    if (cluster.length === 1) continue;
    clusters += 1;

    // Keep the one nearest the cluster's centre; it is the best single stand-in
    // for where the settlement actually is.
    const cLat = cluster.reduce((s, i) => s + places[i][0], 0) / cluster.length;
    const cLon = cluster.reduce((s, i) => s + places[i][1], 0) / cluster.length;
    let keep = cluster[0], bestKm = Infinity;
    for (const i of cluster) {
      const d = km(cLat, cLon, places[i][0], places[i][1]);
      if (d < bestKm) { bestKm = d; keep = i; }
    }
    for (const i of cluster) {
      if (i !== keep) { places[i][2] = 0; zeroed += 1; }
    }
  }
}

data.note =
  'Populated places for the urban/suburban/wilderness rule. ' +
  '[lat, lon, population]; population 0 means unknown and is treated as a ' +
  'small settlement. Populations are Natural Earth METRO totals and were ' +
  'originally copied onto every GeoNames point within 15 km, so one metro ' +
  'appeared as up to 233 separate cities of that size; scripts/dedupePlaces.mjs ' +
  'has collapsed each of those groups to its most central point.';

writeFileSync(FILE, JSON.stringify(data));

const withPop = places.filter((p) => p[2] > 0).length;
console.log(`clusters collapsed:      ${clusters}`);
console.log(`points set to unknown:   ${zeroed}`);
console.log(`places with a population: ${withPop} (was ${withPop + zeroed})`);
console.log(`total places:            ${places.length}`);
