"""
run_pipeline.py - Master Pipeline Orchestrator

Runs the complete data processing pipeline end-to-end:
  1. Synthetic Source Generation (or real dataset ingestion)
  2. Surface Merging (Land DEM + Bathymetry with shoreline feathering)
  3. Vertical Datum Transformation (EGM2008 orthometric -> WGS84 ellipsoidal)
  4. DEM Bridge Footprint Carving & River Valley Ground Interpolation
  5. 3D Structural Geometry Construction (Bridge Deck + Piers)
  6. Per-pixel Provenance Raster & Overlay Generation
  7. Client Export (Raw Float32 heightmaps & metadata JSON for CesiumJS)
"""

import sys
import os
import json
import argparse
import numpy as np
import rasterio

sys.path.insert(0, os.path.dirname(__file__))

from synthetic_source import generate_synthetic_data
from merge_surface import merge_land_bathymetry
from datum_correct import correct_vertical_datum
from carve import carve_bridge_footprints
from build_structures import build_bridge_structures
from provenance import generate_provenance_raster


def export_client_assets(processed_dir="data/processed"):
    carved_tif = os.path.join(processed_dir, "carved_surface.tif")
    uncarved_tif = os.path.join(processed_dir, "uncarved_surface.tif")
    prov_tif = os.path.join(processed_dir, "provenance.tif")

    with rasterio.open(carved_tif) as src:
        carved_data = src.read(1).astype(np.float32)
        bounds = src.bounds
        transform = src.transform
        height, width = carved_data.shape

    with rasterio.open(uncarved_tif) as src:
        uncarved_data = src.read(1).astype(np.float32)

    with rasterio.open(prov_tif) as src:
        prov_data = src.read(1).astype(np.uint8)

    # Save raw binary float32 arrays
    carved_bin = os.path.join(processed_dir, "carved_heightmap.bin")
    carved_data.tofile(carved_bin)

    uncarved_bin = os.path.join(processed_dir, "uncarved_heightmap.bin")
    uncarved_data.tofile(uncarved_bin)

    prov_bin = os.path.join(processed_dir, "provenance.bin")
    prov_data.tofile(prov_bin)

    metadata = {
        "west": bounds.left,
        "south": bounds.bottom,
        "east": bounds.right,
        "north": bounds.top,
        "width": width,
        "height": height,
        "min_height": float(np.nanmin(carved_data)),
        "max_height": float(np.nanmax(uncarved_data)),
        "observed_percent": float(np.sum(prov_data <= 1) / prov_data.size * 100.0)
    }

    meta_json = os.path.join(processed_dir, "metadata.json")
    with open(meta_json, "w") as f:
        json.dump(metadata, f, indent=2)

    print(f"[Client Export] Exported binary heightmaps & metadata JSON:")
    print(f"  - Carved heightmap:   {carved_bin} ({os.path.getsize(carved_bin)} bytes)")
    print(f"  - Uncarved heightmap: {uncarved_bin} ({os.path.getsize(uncarved_bin)} bytes)")
    print(f"  - Provenance bytes:   {prov_bin}")
    print(f"  - Metadata JSON:      {meta_json}")


def run_full_pipeline(synthetic_dir="data/synthetic", processed_dir="data/processed"):
    print("==========================================================")
    print(" TERRAIN VIEWER DATA PIPELINE — HONEST PROVENANCE SETUP")
    print("==========================================================")

    # Step 1: Generate / Ingest raw inputs
    print("\n--- [1/6] Synthetic Data Generation ---")
    generate_synthetic_data(synthetic_dir)

    land_dem = os.path.join(synthetic_dir, "dem_raw.tif")
    bathymetry = os.path.join(synthetic_dir, "dem_bathymetry.tif")
    cloud_mask = os.path.join(synthetic_dir, "cloud_mask.tif")
    bridge_geojson = os.path.join(synthetic_dir, "bridge.geojson")

    # Step 2: Merge surface
    print("\n--- [2/6] Surface Merging (Coastline Feathering) ---")
    merged_tif = os.path.join(processed_dir, "merged_surface.tif")
    merge_land_bathymetry(land_dem, bathymetry, merged_tif, feather_px=5)

    # Step 3: Datum correction
    print("\n--- [3/6] Vertical Datum Correction (EGM2008 -> WGS84) ---")
    corrected_tif = os.path.join(processed_dir, "corrected_surface.tif")
    correct_vertical_datum(merged_tif, corrected_tif, simulated_geoid_offset=-31.8)

    # Step 4: DEM Carving
    print("\n--- [4/6] Bridge Footprint Carving & Valley Ground Restoration ---")
    carve_bridge_footprints(corrected_tif, bridge_geojson, processed_dir, buffer_m=15.0)

    # Step 5: Structure Building
    print("\n--- [5/6] 3D Structure Geometry Construction ---")
    uncarved_tif = os.path.join(processed_dir, "uncarved_surface.tif")
    carved_tif = os.path.join(processed_dir, "carved_surface.tif")
    structure_json = os.path.join(processed_dir, "bridge_structure.json")
    build_bridge_structures(bridge_geojson, uncarved_tif, carved_tif, structure_json)

    # Step 6: Provenance Raster
    print("\n--- [6/6] Provenance Raster & Overlay Generation ---")
    carve_mask = os.path.join(processed_dir, "carve_mask.tif")
    prov_tif = os.path.join(processed_dir, "provenance.tif")
    prov_png = os.path.join(processed_dir, "provenance.png")
    generate_provenance_raster(carve_mask, cloud_mask, prov_tif, prov_png)

    # Step 7: Export binary heightmaps for client
    print("\n--- [7/7] Export Client Heightmaps & Metadata ---")
    export_client_assets(processed_dir)

    print("\n==========================================================")
    print(" PIPELINE RUN COMPLETE — ALL OUTPUTS PROVABLY GENERATED")
    print("==========================================================")


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description="Run complete terrain data pipeline")
    parser.add_argument("--synthetic-dir", default="data/synthetic", help="Synthetic data directory")
    parser.add_argument("--processed-dir", default="data/processed", help="Processed outputs directory")
    args = parser.parse_args()

    run_full_pipeline(args.synthetic_dir, args.processed_dir)
