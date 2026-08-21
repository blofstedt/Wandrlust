"""Snapshot stats for data/nl-crown-land.json (old build)."""
import json
import sys

from shapely.geometry import shape
from pyproj import Geod

geod = Geod(ellps="WGS84")

path = sys.argv[1] if len(sys.argv) > 1 else "data/nl-crown-land.json"
with open(path) as f:
    data = json.load(f)

feats = data.get("features", [])
total_km2 = 0.0
for ft in feats:
    geom = shape(ft["geometry"])
    area_m2, _perim = geod.geometry_area_perimeter(geom)
    total_km2 += abs(area_m2) / 1e6

print(f"{path}: {len(feats)} feature(s), geodesic area {total_km2:,.0f} km²")
