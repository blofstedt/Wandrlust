"""Filter the raw OSM water extract down to polygons >= 1 km2 (geodesic)
and write data/nl-water.geojson for the NL crown-land builder.

Usage: python scripts/filterNlWater.py <raw.geojson> [<out.geojson>]
"""
import json
import os
import sys

import shapely
from shapely.geometry import shape, mapping
from shapely.set_operations import union_all
from pyproj import Geod

GEOD = Geod(ellps="WGS84")


def area_km2(geom):
    if geom.is_empty:
        return 0.0
    return abs(GEOD.geometry_area_perimeter(geom)[0]) * 1e-6


def load_geom(gj):
    """shape() with repair for flat-ring GeoJSON (coordinates = list of pairs
    missing the ring wrapper — a quirk of the extractor's output)."""
    try:
        return shapely.make_valid(shape(gj))
    except Exception:
        g = gj or {}
        coords = g.get("coordinates")
        if g.get("type") == "Polygon" and isinstance(coords, list) and coords \
                and isinstance(coords[0], list) and len(coords[0]) == 2 \
                and isinstance(coords[0][0], float):
            return shapely.make_valid(shape({"type": "Polygon",
                                             "coordinates": [coords]}))
        if g.get("type") == "MultiPolygon" and isinstance(coords, list):
            fixed = []
            for poly in coords:
                if poly and isinstance(poly[0], list) and len(poly[0]) == 2 \
                        and isinstance(poly[0][0], float):
                    fixed.append([poly])
                else:
                    fixed.append(poly)
            return shapely.make_valid(shape({"type": "MultiPolygon",
                                             "coordinates": fixed}))
        raise


def main():
    src = sys.argv[1]
    out = sys.argv[2] if len(sys.argv) > 2 else os.path.join(
        os.path.dirname(__file__), "..", "data", "nl-water.geojson")

    print(f"loading {src} ...")
    with open(src) as f:
        fc = json.load(f)

    kept = []        # validated geometries >= 1 km2 (as shapely objects)
    skipped = 0
    dropped = 0
    for feat in fc["features"]:
        try:
            g = load_geom(feat["geometry"])
        except Exception:
            skipped += 1
            continue
        if g.is_empty:
            skipped += 1
            continue
        try:
            a = area_km2(g)
        except Exception:
            # geodesic area failed even after repair — keep by rough degree area
            a = g.area * 111 * 111
        if a >= 1.0:
            kept.append(g)
        else:
            dropped += 1
    print(f"{len(fc['features'])} -> kept {len(kept)} polygons >= 1 km2 "
          f"({skipped} unrecoverable skipped, {dropped} small dropped)")

    # union to kill overlaps (OSM water often overlaps), keeping it small.
    # grid_size (~1e-4 deg ≈ 10 m) then lets overlapping holes node cleanly.
    merged = union_all(kept, grid_size=1e-4)
    geoms = [merged] if merged.geom_type == "Polygon" else list(merged.geoms)
    feats = [{"type": "Feature", "properties": {"n": i},
              "geometry": mapping(g)} for i, g in enumerate(geoms)]
    with open(out, "w") as f:
        json.dump({"type": "FeatureCollection", "features": feats}, f)
    total = sum(area_km2(g) for g in geoms)
    print(f"wrote {out}: {len(feats)} merged polys, {total:,.0f} km2 water")

    if len(geoms) != len(kept):
        print("note: overlapping water merged, poly count changed")


if __name__ == "__main__":
    main()
