#!/usr/bin/env python3
"""
Build Newfoundland & Labrador Crown land as a campable-land GeoJSON.

WHY THIS SHAPE
--------------
NL does not publish a single "Crown Land" polygon layer anywhere (verified:
NL GeoHub org aCyQID5qQcyrJMm2 (576 items), opendata.gov.nl.ca, open.canada.ca,
U of T library, canadiangis, hunting-app data). What the province DOES publish
is the Land Use Atlas MapServer (LandUseDetails), which lists every alienated,
federal, municipal, Indigenous and restricted parcel. NL is ~95% Crown land,
so:

    Crown land = province outline − everything that isn't Crown

The province outline (CA-NL, 9-part MultiPolygon) ships with the app at
public/map/admin1-us-ca.json. The subtractions are the LandUseDetails layers
below. NL broadly allows free dispersed camping on Crown land ("unless
otherwise posted"), same class as BC/AB/SK/MB/NB, so the residual is campable
extent — drawn with an honest caveat chip (see coverage.ts).

SUBTRACTION LAYERS (LandUseDetails / MapServer)
  L2  Applications for Crown Title   (2,601)  pending alienation
  L3  Crown Titles                  (78,896)  alienated / private
  L6  Quieting of Titles             (2,979)  private titles
  L7  Quit Claims                    (1,998)  private claims
  L8  Bowater Land Sales               (460)  sold private
  L13 Indigenous 1   — filtered to NAME == "Labrador Inuit Lands" only
                       (fee-simple Inuit land, 13,093 km²). DROPPED from this
                       layer: "Harvesting Area" (49,680 km² — an Inuit
                       harvesting-RIGHTS zone over Crown land, not alienation),
                       "TORNGATS"/"WATERZONE"/"SPECMAT" management overlays.
  L19 Parks                             (71)  provincial parks (own rules)
  L20 Natural Areas                    (160)  protected, no camping
  L25 Federal Lands — DROPPED from this layer: "DND low-level flying area"
                       (89,218 km² — an AIRSPACE designation over Crown land;
                       the land below is still Crown and campable). Kept:
                       National Parks (21,187), DND ground training areas
                       (~2,200), federal parcels, historic parks.

LAYERS NOT SUBTRACTED (RESTRICTION=Information / referral overlays — the
land beneath remains Crown):
  L4  Expropriated Land  — expropriation makes land CROWN-owned, not private
  L14 Indigenous 2       — "CLAIM_AREA" (222,134 km²) is the land-claim
                           negotiation overlay; "Labrador Inuit Settlement
                           Area" (67,385 km²) is a co-management region whose
                           land is mostly Crown. Referral only.
  L24 Municipal Affairs  — planning/urban-region BOUNDARIES, not land title
  L28 Nalcor/NF Power    — hydro watersheds & developments (68,610 km²):
                           Crown land with power rights; camping still allowed

NOTE: L1 Title Details is the full cadastre (would erase everything — skip).
      L12 Indigenous Areas is a group layer (not queryable — skip).
      Water bodies stay INSIDE the result (they are Crown-owned; the app's
      other provinces include lakes too — consistent).

AREAS: all reported areas are GEODESIC (pyproj WGS84), projection-free.
       (EPSG:2151 Lambert overstates NL areas by ~23%: 486,892 vs 396,101 km²
       for the same outline — never use it for NL-wide area math.)

OUTPUT
------
data/nl-crown-land.json — EPSG:4326 FeatureCollection, one feature,
properties: {name, isoCode: CA-NL, ...}.
"""
import json
import os
import sys
import time
import urllib.parse
import urllib.request

import geopandas as gpd
import shapely
import shapely.geometry
import shapely.ops
from pyproj import Geod

GEOD = Geod(ellps="WGS84")

BASE = "https://www.gov.nl.ca/landuseatlasmaps/rest/services/LandUseDetails/MapServer"
PAGE = 2000
# Server-side generalisation in degrees (~11 m). The raw titles geometry is
# extremely dense (71 park polygons = 31 MB); the crown-land residual only
# needs title-accuracy at the app's display scales, and this cuts every page
# by ~60x while keeping all 78,896 parcels intact.
MAX_ALLOWABLE_OFFSET = "0.0001"

SUBTRACT_LAYERS = [2, 3, 6, 7, 8, 13, 19, 20, 25]
# Feature-level filters: some MapServer layers mix genuinely alienated /
# restricted parcels with pure REFERRAL overlays over Crown land. The
# referral features must NOT be subtracted. Keys are LANDUSE layer ids.
LAYER_FEATURE_FILTERS = {
    # Keep only fee-simple Inuit-owned land; drop harvesting-rights and
    # management overlays (the land beneath remains Crown).
    13: lambda p: (p.get("NAME") or "").strip() == "Labrador Inuit Lands",
    # Drop the DND low-level flying AIRSPACE zone + marine monitoring areas;
    # keep national parks, DND ground training areas, federal parcels.
    25: lambda p: (p.get("NAME") or "").strip() not in (
        "DND low-level flying area",
        "Water Monitoring Area",
        "PLACENTIA BAY - Harbour",
    ),
}

SIMPLIFY_DEGREES = float(os.environ.get("SIMPLIFY_DEGREES", "0.002"))
MIN_AREA_SQ_KM = float(os.environ.get("MIN_AREA_SQ_KM", "1"))
REPO_ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))


def fetch_layer(layer_id: int):
    """Page through a queryable MapServer layer, returning raw features.

    The gov.nl.ca server throws occasional transient HTTP 500s under load, so
    each page retries with backoff before giving up.
    """
    features = []
    offset = 0
    while True:
        params = {
            "where": "1=1",
            "returnGeometry": "true",
            "outSR": "4326",
            "f": "geojson",
            "maxAllowableOffset": MAX_ALLOWABLE_OFFSET,
            "resultOffset": str(offset),
            "resultRecordCount": str(PAGE),
        }
        url = f"{BASE}/{layer_id}/query?{urllib.parse.urlencode(params)}"
        last_err = None
        for attempt in range(4):
            try:
                # gov.nl.ca 500s the default Python-urllib UA but serves a
                # browser-like one fine — the one header this server insists on.
                req = urllib.request.Request(
                    url, headers={"User-Agent": "Wandrlust/1.0"}
                )
                with urllib.request.urlopen(req, timeout=180) as resp:
                    data = json.load(resp)
                break
            except Exception as err:  # HTTPError, URLError, timeout, json
                last_err = err
                time.sleep(5 * (attempt + 1))
        else:
            raise RuntimeError(f"layer {layer_id} offset {offset}: {last_err}")
        batch = data.get("features", [])
        features.extend(batch)
        if len(batch) < PAGE:
            break
        offset += PAGE
    return features


def area_km2(geom: "shapely.Geometry") -> float:
    """True surface area in km² via WGS84 geodesic (projection-free)."""
    if geom is None or geom.is_empty:
        return 0.0
    return abs(GEOD.geometry_area_perimeter(geom)[0]) * 1e-6


def dissolve(features: list, layer_id: int) -> "shapely.Geometry | None":
    """Union all features of a layer into a single (multi)polygon geometry."""
    filt = LAYER_FEATURE_FILTERS.get(layer_id)
    if filt:
        before = len(features)
        features = [f for f in features if filt(f.get("properties", {}))]
        print(f"    layer {layer_id}: {before} -> {len(features)} feats after filter")
    if not features:
        return None
    gdf = gpd.GeoDataFrame.from_features(features, crs="EPSG:4326")
    # Keep only polygon-ish geometries; drop points/lines.
    gdf = gdf[gdf.geometry.geom_type.isin(
        ["Polygon", "MultiPolygon"])].copy()
    if gdf.empty:
        return None
    # Repair invalid geometries before union.
    gdf["geometry"] = gdf.geometry.buffer(0)
    merged = gdf.geometry.union_all()
    return merged


def main() -> int:
    print("Loading CA-NL outline...")
    outline_path = os.path.join(REPO_ROOT, "public/map/admin1-us-ca.json")
    with open(outline_path) as fh:
        admin1 = json.load(fh)
    nl_geom = None
    for feat in admin1["features"]:
        if feat["properties"].get("isoCode") == "CA-NL":
            nl_geom = shapely.geometry.shape(feat["geometry"])
            break
    if nl_geom is None:
        print("CA-NL outline not found in admin1-us-ca.json")
        return 1
    print(f"  outline: {nl_geom.geom_type}, "
          f"area {area_km2(nl_geom):,.0f} km² (geodesic)")

    subtract_parts = []
    for layer_id in SUBTRACT_LAYERS:
        print(f"  fetching layer {layer_id}...", flush=True)
        feats = fetch_layer(layer_id)
        geom = dissolve(feats, layer_id)
        if geom is None or geom.is_empty:
            print(f"    layer {layer_id}: 0 usable features")
            continue
        area = area_km2(geom)
        print(f"    layer {layer_id}: {len(feats)} feats, "
              f"merged area {area:,.0f} km² (geodesic)")
        subtract_parts.append(geom)

    print("Unioning subtraction layers...")
    if subtract_parts:
        sub = shapely.ops.unary_union(subtract_parts)
    else:
        sub = None
    del subtract_parts

    print("Erasing subtractions from outline...")
    crown = nl_geom.difference(sub) if sub is not None else nl_geom
    crown = shapely.ops.unary_union([crown])  # drop any leftover slivers overlap

    print(f"  crown before filter: {crown.geom_type}, "
          f"{area_km2(crown):,.0f} km² (geodesic)")

    # Simplify + drop small islands/slivers (accurate area via geodesic).
    crown = crown.simplify(SIMPLIFY_DEGREES, preserve_topology=True)
    gdf = gpd.GeoDataFrame(geometry=[crown], crs="EPSG:4326")
    gdf = gdf.explode(index_parts=False).reset_index(drop=True)
    gdf["_area_km2"] = gdf.geometry.apply(area_km2)
    gdf = gdf[gdf["_area_km2"] >= MIN_AREA_SQ_KM]
    print(f"  after {MIN_AREA_SQ_KM} km² filter: {len(gdf)} polygons")

    result = gpd.GeoDataFrame(
        {
            "name": ["Newfoundland and Labrador"],
            "isoCode": ["CA-NL"],
            "geometry": [gdf.geometry.union_all()],
        },
        crs="EPSG:4326",
    )
    out_path = os.path.join(REPO_ROOT, "data/nl-crown-land.json")
    os.makedirs(os.path.dirname(out_path), exist_ok=True)
    result.to_file(out_path, driver="GeoJSON")
    size_mb = os.path.getsize(out_path) / (1024 * 1024)
    final_area = area_km2(result.geometry.iloc[0])
    print(f"Exported to {out_path} ({size_mb:.2f} MB, "
          f"{final_area:,.0f} km² geodesic)")
    return 0


if __name__ == "__main__":
    sys.exit(main())
