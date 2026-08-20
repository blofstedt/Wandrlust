"""Extract NL water polygons (natural=water, waterway=riverbank) from the
GeoFabrik Newfoundland-and-Labrador PBF into a GeoJSON FeatureCollection.

Two passes: first collect water multipolygon relation members, then store
geometry only for water ways and those members (memory-safe). Handles closed
ways directly and multipolygon relations via member ways (outer = solid,
inner = holes). Linear waterway=river lines are skipped — only polygons
render as blue areas on the map. Output rings are [lon, lat].

Usage: python extract_nl_water.py nl-latest.osm.pbf nl-water.geojson
"""
import json
import sys

import osmium


class MemberCollector(osmium.SimpleHandler):
    def __init__(self):
        super().__init__()
        self.member_ways = set()
        self.water_rels = []

    def relation(self, r):
        tags = dict(r.tags)
        if tags.get("type") == "multipolygon" and (
            tags.get("natural") == "water" or tags.get("waterway") == "riverbank"
        ):
            members = [(m.role, m.ref) for m in r.members if m.type == "w"]
            self.water_rels.append(members)
            for _, ref in members:
                self.member_ways.add(ref)


class WayCollector(osmium.SimpleHandler):
    def __init__(self, member_ways: set):
        super().__init__()
        self.member_ways = member_ways
        self.water_ways = {}  # way id -> coords
        self.standalone = []  # closed water ways not in any relation

    def way(self, w):
        tags = dict(w.tags)
        is_water = (
            tags.get("natural") == "water" or tags.get("waterway") == "riverbank"
        )
        if not is_water and w.id not in self.member_ways:
            return
        coords = [(n.lon, n.lat) for n in w.nodes if n.location.valid()]
        if len(coords) < 4:
            return
        self.water_ways[w.id] = coords
        if is_water and w.id not in self.member_ways and coords[0] == coords[-1]:
            self.standalone.append(coords)


def main() -> int:
    src, dst = sys.argv[1], sys.argv[2]

    mc = MemberCollector()
    mc.apply_file(src)
    print(f"{len(mc.water_rels)} water relations, "
          f"{len(mc.member_ways)} member ways")

    wc = WayCollector(mc.member_ways)
    wc.apply_file(src, locations=True)

    polygons = [rings for rings in wc.standalone]
    for members in mc.water_rels:
        outers, inners = [], []
        for role, ref in members:
            coords = wc.water_ways.get(ref)
            if not coords or coords[0] != coords[-1]:
                continue  # open/partial member — skip
            (outers if role == "outer" else inners).append(coords)
        if outers:
            polygons.append(outers + inners)

    feats = [
        {
            "type": "Feature",
            "properties": {"n": i},
            "geometry": {"type": "Polygon", "coordinates": rings},
        }
        for i, rings in enumerate(polygons)
    ]
    with open(dst, "w") as fh:
        json.dump({"type": "FeatureCollection", "features": feats}, fh)
    print(f"{len(polygons)} water polygons -> {dst}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
