"""
synthetic_source.py - Generates synthetic DEM, bathymetry, bridge GeoJSON, and gap mask.

Creates a ~2km x 2km test region centered near 37.75 N, 122.45 W (~8.8m pixel size, 256x256 grid).
Includes:
  - Base terrain (rolling hills via OpenSimplex)
  - River gorge running North-South
  - Bathymetry region on the western edge
  - Bridge deck baked into the raw DEM (simulating satellite photogrammetry/radar DEM damming)
  - Bridge GeoJSON extract (simulating OpenStreetMap bridge way)
  - Synthetic cloud/gap mask (simulating missing observation pixels)
"""

import os
import json
import argparse
import numpy as np
from opensimplex import OpenSimplex
import rasterio
from rasterio.transform import from_origin

# Coordinate Reference System (WGS84 ellipsoid)
CRS_EPSG = "EPSG:4326"

# Synthetic Region Boundaries (~2 km extent)
CENTER_LAT = 37.75
CENTER_LON = -122.45
GRID_SIZE = 256  # 256 x 256 cells
PIXEL_SIZE_DEG = 0.00008  # ~8.8 meters per pixel at lat 37.75

MIN_LON = CENTER_LON - (GRID_SIZE / 2.0) * PIXEL_SIZE_DEG
MAX_LAT = CENTER_LAT + (GRID_SIZE / 2.0) * PIXEL_SIZE_DEG


def generate_synthetic_data(output_dir="data/synthetic"):
    os.makedirs(output_dir, exist_ok=True)
    
    # 1. Base OpenSimplex noise elevation (150m to 400m)
    gen = OpenSimplex(seed=42)
    base_dem = np.zeros((GRID_SIZE, GRID_SIZE), dtype=np.float32)
    
    for r in range(GRID_SIZE):
        for c in range(GRID_SIZE):
            # Multi-octave noise for natural hills
            n1 = gen.noise2(r / 40.0, c / 40.0) * 100.0
            n2 = gen.noise2(r / 15.0, c / 15.0) * 25.0
            base_dem[r, c] = 250.0 + n1 + n2

    # 2. Add Bathymetry on western edge (cols 0 to 45)
    bathymetry = np.full((GRID_SIZE, GRID_SIZE), np.nan, dtype=np.float32)
    for r in range(GRID_SIZE):
        for c in range(GRID_SIZE):
            if c < 45:
                depth = -5.0 - (45 - c) * 1.2 + gen.noise2(r / 20.0, c / 20.0) * 3.0
                bathymetry[r, c] = float(depth)
                # Lower land DEM gradually near coast
                base_dem[r, c] = max(0.5, 15.0 - (45 - c) * 0.4)

    # 3. Carve river gorge (North-South through center at col ~128 with a sine curve)
    gorge_center_cols = [int(128 + 15 * np.sin(r / 30.0)) for r in range(GRID_SIZE)]
    gorge_bottom_dem = base_dem.copy()
    gorge_half_width = 16  # ~140 meters wide gorge
    
    for r in range(GRID_SIZE):
        gc = gorge_center_cols[r]
        for c in range(max(0, gc - gorge_half_width), min(GRID_SIZE, gc + gorge_half_width + 1)):
            dist = abs(c - gc)
            # Smooth canyon cross-section profile
            depth_factor = 0.5 * (1.0 + np.cos(np.pi * dist / gorge_half_width))
            drop = 90.0 * depth_factor
            gorge_bottom_dem[r, c] -= drop

    # 4. Create Baked Bridge DEM (bridge deck stays elevated over the gorge at r = 120..136)
    dem_raw = gorge_bottom_dem.copy()
    bridge_r_start, bridge_r_end = 122, 134
    bridge_c_start, bridge_c_end = 105, 150
    
    # Bridge height across the span: ~310 meters
    for r in range(bridge_r_start, bridge_r_end + 1):
        for c in range(bridge_c_start, bridge_c_end + 1):
            # Smooth bridge deck shape baked into ground DEM
            dem_raw[r, c] = 310.0 + (gen.noise2(r / 5.0, c / 5.0) * 1.5)

    # Transform for GeoTIFFs (North-Up, WGS84)
    transform = from_origin(MIN_LON, MAX_LAT, PIXEL_SIZE_DEG, PIXEL_SIZE_DEG)

    # Save dem_raw.tif
    dem_raw_path = os.path.join(output_dir, "dem_raw.tif")
    with rasterio.open(
        dem_raw_path, "w", driver="GTiff",
        height=GRID_SIZE, width=GRID_SIZE, count=1,
        dtype=np.float32, crs=CRS_EPSG, transform=transform
    ) as dst:
        dst.write(dem_raw, 1)

    # Save dem_bathymetry.tif
    bathy_path = os.path.join(output_dir, "dem_bathymetry.tif")
    with rasterio.open(
        bathy_path, "w", driver="GTiff",
        height=GRID_SIZE, width=GRID_SIZE, count=1,
        dtype=np.float32, crs=CRS_EPSG, transform=transform,
        nodata=np.nan
    ) as dst:
        dst.write(bathymetry, 1)

    # 5. Generate Cloud / Gap Mask (code 2 areas: synthetic temporal composite fill)
    cloud_mask = np.zeros((GRID_SIZE, GRID_SIZE), dtype=np.uint8)
    # Put a cloud patch in upper-right quadrant
    for r in range(30, 70):
        for c in range(180, 220):
            if gen.noise2(r / 10.0, c / 10.0) > -0.1:
                cloud_mask[r, c] = 1
                
    cloud_mask_path = os.path.join(output_dir, "cloud_mask.tif")
    with rasterio.open(
        cloud_mask_path, "w", driver="GTiff",
        height=GRID_SIZE, width=GRID_SIZE, count=1,
        dtype=np.uint8, crs=CRS_EPSG, transform=transform
    ) as dst:
        dst.write(cloud_mask, 1)

    # 6. Generate Synthetic Bridge GeoJSON (mimicking OpenStreetMap bridge way)
    # Bridge centerline coordinates from c_start to c_end at r = 128
    start_lon = MIN_LON + bridge_c_start * PIXEL_SIZE_DEG
    end_lon = MIN_LON + bridge_c_end * PIXEL_SIZE_DEG
    bridge_lat = MAX_LAT - 128 * PIXEL_SIZE_DEG

    geojson_data = {
        "type": "FeatureCollection",
        "features": [
            {
                "type": "Feature",
                "id": "way/1001",
                "properties": {
                    "name": "Synthetic River Gorge Bridge",
                    "highway": "primary",
                    "bridge": "yes",
                    "structure": "bridge",
                    "width": 24.0,  # width in meters
                    "deck_height_m": 310.0
                },
                "geometry": {
                    "type": "LineString",
                    "coordinates": [
                        [start_lon, bridge_lat],
                        [end_lon, bridge_lat]
                    ]
                }
            }
        ]
    }

    bridge_path = os.path.join(output_dir, "bridge.geojson")
    with open(bridge_path, "w") as f:
        json.dump(geojson_data, f, indent=2)

    print(f"[Synthetic Source] Created test rasters in {output_dir}/")
    print(f"  - Land DEM: {dem_raw_path} ({GRID_SIZE}x{GRID_SIZE}, {PIXEL_SIZE_DEG} deg/px)")
    print(f"  - Bathymetry: {bathy_path}")
    print(f"  - Cloud Mask: {cloud_mask_path}")
    print(f"  - Bridge Vector: {bridge_path}")


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description="Generate synthetic DEM test dataset")
    parser.add_argument("--output", default="data/synthetic", help="Output directory")
    args = parser.parse_args()
    generate_synthetic_data(args.output)
