#!/usr/bin/env python3
"""
Convert Quebec's NORTHERN PATP services (Nord-du-Québec) into the same
campable-land GeoJSON schema as scripts/convertQcPatp.py.

SOURCE
------
The provincial PATP shapefile only covers the managed territory south of
~55°N. The Nord-du-Québec planning territory is published separately as two
ArcGIS REST services on the same MRNF server:

    PATP_NdQ_EIBJ_WMS    Eeyou Istchee Baie-James (James Bay region)
    PATP_NdQ_Kativik_WMS Kativik (Nunavik region)

Both are real queryable MapServers (unlike PATP_prov_WMS, which answers
attribute queries with null geometry). Layer 3 of each service is the
"Utilisation multiple" class — the same VOCATION this repo already treats as
campable in the south. EIBJ's layer 3 cannot be queried at full resolution
(server 500s), so those layers are fetched with maxAllowableOffset=0.01.

OUTPUT
------
data/qc-patp-north-campable.json — FeatureCollection, EPSG:4326, with the
same properties as the southern file: uuid (Numéro_zone), nom_zone, vocation.
"""
import json
import os
import sys
import urllib.parse
import urllib.request

import geopandas as gpd

SERVICES = {
    "PATP_NdQ_EIBJ_WMS": "eibj",
    "PATP_NdQ_Kativik_WMS": "kativik",
}
# Layer 3 in both services = "Utilisation multiple" (the campable class).
LAYER = 3
OUTPUT_FILE = os.path.join(
    os.path.dirname(__file__), "..", "data", "qc-patp-north-campable.json"
)
SIMPLIFY_DEGREES = float(os.environ.get("SIMPLIFY_DEGREES", "0.002"))
MIN_AREA_SQ_KM = float(os.environ.get("MIN_AREA_SQ_KM", "1"))


def fetch_layer(service: str) -> dict:
    params = {
        "where": "1=1",
        "outFields": "Num\u00e9ro_zone,Nom_zone,Vocation",
        "returnGeometry": "true",
        "outSR": "4326",
        "f": "geojson",
        "resultRecordCount": "500",
        # EIBJ layer 3 500s at full resolution; the tolerance fixes it.
        "maxAllowableOffset": "0.01",
    }
    url = (
        "https://servicescarto.mrnf.gouv.qc.ca/pes/rest/services/Territoire/"
        f"{service}/MapServer/{LAYER}/query?{urllib.parse.urlencode(params)}"
    )
    print(f"  fetching {service} layer {LAYER}...")
    with urllib.request.urlopen(url, timeout=120) as resp:
        return json.load(resp)


def main() -> int:
    features = []
    for service, label in SERVICES.items():
        data = fetch_layer(service)
        feats = data.get("features", [])
        print(f"  {label}: {len(feats)} features")
        for f in feats:
            props = f.get("properties", {})
            features.append(
                {
                    "type": "Feature",
                    "geometry": f.get("geometry"),
                    "properties": {
                        "uuid": str(props.get("Num\u00e9ro_zone") or f"{label}-{len(features)+1}"),
                        "nom_zone": props.get("Nom_zone") or "Multi-use public land",
                        "vocation": props.get("Vocation") or "Utilisation multiple",
                    },
                }
            )

    if not features:
        print("No features fetched — aborting.")
        return 1

    gdf = gpd.GeoDataFrame.from_features(features, crs="EPSG:4326")
    print(f"  {len(gdf)} features total")

    # Area in km² computed in the native Québec Lambert CRS before reprojection.
    gdf["_area_km2"] = gdf.geometry.to_crs(epsg=32198).area * 1e-6
    gdf = gdf[gdf["_area_km2"] >= MIN_AREA_SQ_KM]
    print(f"  after {MIN_AREA_SQ_KM} km² filter: {len(gdf)} features")
    for _, row in gdf.iterrows():
        print(f"    {row['nom_zone'][:45]:45s} {row['_area_km2']:>12,.0f} km²")

    gdf["geometry"] = gdf.geometry.simplify(SIMPLIFY_DEGREES, preserve_topology=True)
    gdf = gdf[~gdf.geometry.is_empty]

    gdf = gdf[["uuid", "nom_zone", "vocation", "geometry"]]
    os.makedirs(os.path.dirname(OUTPUT_FILE), exist_ok=True)
    gdf.to_file(OUTPUT_FILE, driver="GeoJSON")
    size_mb = os.path.getsize(OUTPUT_FILE) / (1024 * 1024)
    print(f"Exported {len(gdf)} polygons to {OUTPUT_FILE} ({size_mb:.2f} MB)")
    return 0


if __name__ == "__main__":
    sys.exit(main())
