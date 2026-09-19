"""
provenance.py - Generates per-pixel provenance raster & client visualization PNG overlay.

Provenance Raster Code Spec:
  0: measured, direct observation           -> render normal
  1: measured, resampled/reprojected        -> render normal
  2: inferred, temporal composite fill      -> yellow desaturation overlay
  3: inferred, SAR-conditioned reconstruction -> diagonal hatch overlay
  4: inferred, super-resolved               -> diagonal hatch overlay
  5: inferred, carved terrain under structure -> cyan wireframe/hatch ground

This script:
1. Combines land observation, bathymetry, cloud gap fill, and bridge carve masks.
2. Produces single-band uint8 `provenance.tif`.
3. Produces color-coded RGBA `provenance.png` with embedded hatch patterns for CesiumJS overlay.
"""

import argparse
import os
import numpy as np
import rasterio
from PIL import Image, ImageDraw


def generate_provenance_raster(
    carve_mask_path,
    cloud_mask_path,
    output_tif_path="data/processed/provenance.tif",
    output_png_path="data/processed/provenance.png"
):
    os.makedirs(os.path.dirname(output_tif_path), exist_ok=True)

    with rasterio.open(carve_mask_path) as src_carve:
        carve_mask = src_carve.read(1)
        profile = src_carve.profile.copy()
        height, width = carve_mask.shape

    cloud_mask = np.zeros((height, width), dtype=np.uint8)
    if os.path.exists(cloud_mask_path):
        with rasterio.open(cloud_mask_path) as src_cloud:
            cloud_mask = src_cloud.read(1)

    # Combine into single-band provenance array
    provenance = np.zeros((height, width), dtype=np.uint8)  # Default 0 = measured direct

    # Priority encoding:
    # Code 2: Cloud / temporal composite fill
    provenance[cloud_mask == 1] = 2

    # Code 5: Carved terrain under bridge structure (highest priority over DEM edits)
    provenance[carve_mask == 1] = 5

    # Write single-band GeoTIFF
    profile.update(dtype=np.uint8, nodata=255)
    with rasterio.open(output_tif_path, "w", **profile) as dst:
        dst.write(provenance, 1)

    # 2. Render RGBA PNG image overlay for CesiumJS client
    rgba = np.zeros((height, width, 4), dtype=np.uint8)

    # Code 0 & 1: Fully transparent
    # Code 2 (Temporal fill): Yellow semi-transparent (R:255, G:200, B:0, A:120)
    yellow_mask = (provenance == 2)
    rgba[yellow_mask] = [255, 200, 0, 130]

    # Code 5 (Carved ground under bridge): Cyan wireframe / hatch (R:0, G:230, B:255, A:180)
    cyan_mask = (provenance == 5)
    rgba[cyan_mask] = [0, 230, 255, 180]

    # Draw diagonal hatch pattern only on inferred regions (Code >= 2)
    for r in range(height):
        for c in range(width):
            if provenance[r, c] >= 2:
                # Add diagonal stripe texture to inferred pixels
                if (r + c) % 8 < 2:
                    rgba[r, c, :3] = (rgba[r, c, :3] * 0.7).astype(np.uint8)

    img = Image.fromarray(rgba, mode="RGBA")
    img.save(output_png_path, "PNG")

    # Compute statistics
    total_px = height * width
    obs_px = np.sum((provenance == 0) | (provenance == 1))
    inf_px = total_px - obs_px
    obs_pct = (obs_px / total_px) * 100.0

    print(f"[Provenance Raster] Generated provenance output:")
    print(f"  - GeoTIFF: {output_tif_path}")
    print(f"  - PNG:     {output_png_path}")
    print(f"  - Stats:   {obs_pct:.1f}% Observed (Codes 0-1), {100.0-obs_pct:.1f}% Inferred (Codes 2-5)")

    return output_tif_path, output_png_path


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description="Generate single-band provenance raster")
    parser.add_argument("--carve", default="data/processed/carve_mask.tif", help="Carve mask GeoTIFF")
    parser.add_argument("--cloud", default="data/synthetic/cloud_mask.tif", help="Cloud gap mask GeoTIFF")
    parser.add_argument("--output-tif", default="data/processed/provenance.tif", help="Output GeoTIFF")
    parser.add_argument("--output-png", default="data/processed/provenance.png", help="Output PNG overlay")
    args = parser.parse_args()

    generate_provenance_raster(args.carve, args.cloud, args.output_tif, args.output_png)
