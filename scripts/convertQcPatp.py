#!/usr/bin/env python3
"""
Convert Quebec's PATP (Plans d'affectation du territoire public) shapefile
into the campable-land GeoJSON this repo ingests.

SOURCE
------
MRNF publishes the PATP as a plain file download — there is no queryable REST
service (the ArcGIS platform behind it requires an extranet login and answers
GeoJSON asks with attributes and null geometry). The official dataset page is
Données Québec: plans-d-affectation-du-territoire-public.

    https://diffusion.mern.gouv.qc.ca/Diffusion/RGQ/Vectoriel/Theme/Local/PATP/SHP/PATP_Affectation.zip

WHAT IS KEPT, AND WHY
---------------------
The shapefile's VOCATION field classifies every polygon of Quebec's public
domain (7,874 of them). Only one class is kept:

    "Utilisation multiple"   — 4,250 polygons

That is the "territoire public libre" the Gouvernement du Québec says free
wild camping is allowed on without authorisation (quebec.ca, "Profiter du
territoire public en toute légalité": camping sauvage sans autorisation on
the public free land, temporary stays, mobile gear). Everything else —
Protection, Protection stricte, Utilisation prioritaire, Affectation différée,
Privé, and the *projetée (proposed) variants — is dropped. This app's house
rule is to understate rather than overstate: multi-use land is campable,
protected or priority-use land is not, and no class is drawn as campable on
the strength of a guess.

OUTPUT
------
quebec_crown_land_camping.geojson — FeatureCollection, EPSG:4326, simplified
so the file stays a reasonable size for the repo. Properties kept: uuid (the
dataset's own id), nom_zone, vocation.
"""
import os
import sys
import tempfile
import urllib.request
import zipfile

import geopandas as gpd

DATA_URL = "https://diffusion.mern.gouv.qc.ca/Diffusion/RGQ/Vectoriel/Theme/Local/PATP/SHP/PATP_Affectation.zip"
OUTPUT_FILE = "quebec_crown_land_camping.geojson"

# Simplification tolerance in degrees (WGS84). ~0.002° ≈ 220 m at QC latitudes.
# The overview builder simplifies again (0.01°), so this only needs to keep the
# file itself sane; the full-detail seeder path can use the raw download.
SIMPLIFY_DEGREES = float(os.environ.get("SIMPLIFY_DEGREES", "0.002"))
# Drop polygons smaller than this many km² — slivers of multi-use land are
# noise at every zoom this app draws.
MIN_AREA_SQ_KM = float(os.environ.get("MIN_AREA_SQ_KM", "1"))

# The one vocation Quebec treats as freely campable. See header.
CAMPABLE_VOCATIONS = {"Utilisation multiple"}


def fetch_and_extract(tmp_dir: str) -> str:
    zip_path = os.path.join(tmp_dir, "patp.zip")
    extract_dir = os.path.join(tmp_dir, "extracted")

    print("Downloading Quebec Public Land Use (PATP) dataset...")
    urllib.request.urlretrieve(DATA_URL, zip_path)

    print("Extracting shapefile...")
    with zipfile.ZipFile(zip_path, "r") as zip_ref:
        zip_ref.extractall(extract_dir)

    shp_files = [
        os.path.join(dp, f)
        for dp, dn, filenames in os.walk(extract_dir)
        for f in filenames
        if f.endswith(".shp")
    ]
    if not shp_files:
        raise FileNotFoundError("No shapefile found in downloaded archive.")
    return shp_files[0]


def main() -> int:
    with tempfile.TemporaryDirectory() as tmp_dir:
        if len(sys.argv) > 1 and os.path.isfile(sys.argv[1]):
            shp_path = sys.argv[1]
            print(f"Using local shapefile: {shp_path}")
        else:
            shp_path = fetch_and_extract(tmp_dir)

        print("Reading shapefile...")
        gdf = gpd.read_file(shp_path)
        print(f"  {len(gdf)} records, crs={gdf.crs}")

        # VOCATION is the classifier. NAT_INTENT exists but is a free-text
        # sentence per polygon; VOCATION is the controlled vocabulary.
        print("Filtering to campable vocations...")
        voc = gdf["VOCATION"].fillna("").astype(str).str.strip()
        for v in sorted(voc.unique()):
            n = int((voc == v).sum())
            print(f"  {n:5d}  {v}")
        before = len(gdf)
        gdf = gdf[voc.isin(CAMPABLE_VOCATIONS)].copy()
        print(f"  kept {len(gdf)} of {before}")

        # Area in km², computed in the shapefile's own projected CRS BEFORE
        # reprojection — geometry.area in EPSG:4326 is square degrees, not m².
        orig_crs = gdf.crs
        print(f"  computing areas in source CRS ({orig_crs})...")
        gdf["_area_km2"] = gdf.geometry.to_crs(orig_crs).area * 1e-6
        gdf = gdf[gdf["_area_km2"] >= MIN_AREA_SQ_KM]
        print(f"  dropped {before - len(gdf)} under {MIN_AREA_SQ_KM} km² -> {len(gdf)}")

        if gdf.crs is None or gdf.crs.to_epsg() != 4326:
            print("Reprojecting to WGS84 (EPSG:4326)...")
            gdf = gdf.to_crs(epsg=4326)

        print(f"Simplifying (tolerance {SIMPLIFY_DEGREES}°)...")
        gdf["geometry"] = gdf.geometry.simplify(SIMPLIFY_DEGREES, preserve_topology=True)
        gdf = gdf[~gdf.geometry.is_empty]

        keep = ["UUID", "NOM_ZONE", "VOCATION"]
        gdf = gdf[keep + ["geometry"]]
        gdf = gdf.rename(columns={"UUID": "uuid", "NOM_ZONE": "nom_zone", "VOCATION": "vocation"})

        print(f"Exporting {len(gdf)} polygons to {OUTPUT_FILE}...")
        gdf.to_file(OUTPUT_FILE, driver="GeoJSON")

        size_mb = os.path.getsize(OUTPUT_FILE) / (1024 * 1024)
        print(f"Export completed: {size_mb:.1f} MB")
        return 0


if __name__ == "__main__":
    sys.exit(main())
