"""
carve.py - Carves DEM under OpenStreetMap bridge/tunnel footprints & interpolates true ground.

Thesis:
Photogrammetric and radar DEMs (such as Copernicus GLO-30 or SRTM) cannot separate bridge superstructures
from ground elevation. They record bridge decks as solid land masses, artificially damming river gorges.

This script:
1. Rasterizes bridge vector geometry (OpenStreetMap bridge/tunnel ways) into a pixel mask.
2. Buffers the bridge footprint by a configurable margin (default 15m).
3. Sets the masked bridge deck pixels in the DEM to NaN.
4. Interpolates true underlying river valley ground using 2D grid interpolation (SciPy GridData / Nearest-Bilinear).
5. Outputs the carved DEM, uncarved DEM copy, and a binary carve mask for provenance tagging.
"""

import argparse
import json
import os
import numpy as np
import rasterio
from rasterio.features import rasterize
from shapely.geometry import shape, LineString, Polygon
from scipy.interpolate import griddata


def carve_bridge_footprints(dem_path, bridge_geojson_path, output_dir="data/processed", buffer_m=15.0):
    os.makedirs(output_dir, exist_ok=True)

    with rasterio.open(dem_path) as src:
        dem = src.read(1)
        profile = src.profile.copy()
        transform = src.transform
        bounds = src.bounds
        height, width = dem.shape

    # 1. Read bridge GeoJSON features
    shapes_to_rasterize = []
    if os.path.exists(bridge_geojson_path):
        with open(bridge_geojson_path, "r") as f:
            geojson = json.load(f)

        features = geojson.get("features", [])
        for feat in features:
            geom = shape(feat["geometry"])
            props = feat.get("properties", {})
            width_m = props.get("width", 20.0) + buffer_m
            
            # Buffer LineString to create bridge polygon (width in degrees approx)
            # 1 deg lat ~= 111,000 meters
            buffer_deg = (width_m / 2.0) / 111000.0
            buffered_poly = geom.buffer(buffer_deg)
            shapes_to_rasterize.append((buffered_poly, 1))

    # 2. Rasterize bridge mask
    if shapes_to_rasterize:
        carve_mask = rasterize(
            shapes_to_rasterize,
            out_shape=(height, width),
            transform=transform,
            fill=0,
            dtype=np.uint8
        )
    else:
        carve_mask = np.zeros((height, width), dtype=np.uint8)

    # Save uncarved surface (as delivered)
    uncarved_path = os.path.join(output_dir, "uncarved_surface.tif")
    with rasterio.open(uncarved_path, "w", **profile) as dst:
        dst.write(dem, 1)

    # 3. Carve DEM: Mask bridge pixels & interpolate true valley floor ground
    carved_dem = dem.copy()
    carved_indices = np.where(carve_mask == 1)

    if len(carved_indices[0]) > 0:
        # Get coordinates of valid (uncarved) terrain pixels surrounding the bridge
        # Dilate mask slightly to find boundary pixels for interpolation
        valid_mask = (carve_mask == 0) & (~np.isnan(dem))
        valid_r, valid_c = np.where(valid_mask)
        valid_vals = dem[valid_r, valid_c]

        # Points needing interpolation
        target_r, target_c = carved_indices

        # 2D Grid Interpolation across the gorge
        # Fit linear/cubic surface using surrounding ground elevations
        grid_points = np.column_stack((valid_r, valid_c))
        target_points = np.column_stack((target_r, target_c))

        interpolated_vals = griddata(
            grid_points, valid_vals, target_points, method="linear"
        )
        
        # Fallback to nearest if linear produces NaN at edges
        nan_mask = np.isnan(interpolated_vals)
        if np.any(nan_mask):
            fallback_vals = griddata(
                grid_points, valid_vals, target_points[nan_mask], method="nearest"
            )
            interpolated_vals[nan_mask] = fallback_vals

        carved_dem[target_r, target_c] = interpolated_vals

    # Save carved DEM
    carved_path = os.path.join(output_dir, "carved_surface.tif")
    with rasterio.open(carved_path, "w", **profile) as dst:
        dst.write(carved_dem, 1)

    # Save carve mask
    mask_path = os.path.join(output_dir, "carve_mask.tif")
    profile.update(dtype=np.uint8, nodata=0)
    with rasterio.open(mask_path, "w", **profile) as dst:
        dst.write(carve_mask, 1)

    print(f"[Carve Terrain] Carved bridge footprints from DEM:")
    print(f"  - Carved DEM:   {carved_path} ({np.sum(carve_mask)} pixels modified)")
    print(f"  - Uncarved DEM: {uncarved_path}")
    print(f"  - Carve Mask:   {mask_path}")

    return carved_path, uncarved_path, mask_path


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description="Carve bridge footprints out of DEM")
    parser.add_argument("--dem", default="data/processed/corrected_surface.tif", help="Input DEM GeoTIFF")
    parser.add_argument("--bridges", default="data/synthetic/bridge.geojson", help="Bridge GeoJSON file")
    parser.add_argument("--output", default="data/processed", help="Output directory")
    args = parser.parse_args()

    carve_bridge_footprints(args.dem, args.bridges, args.output)
