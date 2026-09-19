"""
merge_surface.py - Merges land DEM and marine bathymetry rasters with coastline feathering.

Thesis: Elevation (e.g. Copernicus DEM) and bathymetry (e.g. GEBCO) are acquired by different
instruments, at different resolutions, and referenced to different vertical datums.
Stitching them directly creates an unphysical cliff/seam at the coastline.

This script:
1. Aligns and blends land elevation (z >= 0) and ocean bathymetry (z < 0).
2. Applies a distance-weighted linear feathering over a user-defined pixel buffer (default 5px)
   around the zero-crossing coastline.
3. Tags merged pixels in the provenance mask (0 = direct land observation, 1 = resampled/feathered bathymetry).
"""

import argparse
import os
import numpy as np
import rasterio
from scipy.ndimage import distance_transform_edt


def merge_land_bathymetry(land_dem_path, bathymetry_path, output_path, feather_px=5):
    """
    Merges land DEM (meters above vertical datum) and bathymetry DEM (meters below datum).
    Feathers the transition seam near the z=0 shoreline over a width of `feather_px`.
    """
    with rasterio.open(land_dem_path) as src_land:
        land_data = src_land.read(1)
        profile = src_land.profile.copy()
        nodata_land = src_land.nodata

    bathy_data = None
    if os.path.exists(bathymetry_path):
        with rasterio.open(bathymetry_path) as src_bathy:
            bathy_data = src_bathy.read(1)

    merged = land_data.copy()
    provenance_land = np.zeros(land_data.shape, dtype=np.uint8)  # 0 = measured direct

    if bathy_data is not None:
        # Create ocean mask where bathymetry is valid and land is near sea level or NaN
        valid_bathy = ~np.isnan(bathy_data)
        
        # Coastline mask: land > 0 vs bathymetry <= 0
        land_mask = (land_data > 0.0) & (~np.isnan(land_data))
        ocean_mask = valid_bathy & (~land_mask)

        # 1. Fill ocean areas with bathymetry data
        merged[ocean_mask] = bathy_data[ocean_mask]
        provenance_land[ocean_mask] = 1  # 1 = resampled / bathymetry source

        # 2. Feather seam near coastline boundary
        if feather_px > 0:
            # Distance transform to coastline boundary
            dist_land = distance_transform_edt(land_mask)
            dist_ocean = distance_transform_edt(ocean_mask)

            feather_zone = (dist_land <= feather_px) & (dist_ocean <= feather_px) & valid_bathy
            
            for r, c in zip(*np.where(feather_zone)):
                dl = dist_land[r, c]
                do = dist_ocean[r, c]
                total = dl + do
                if total > 0:
                    weight_land = dl / total
                    weight_ocean = do / total
                    l_val = land_data[r, c] if not np.isnan(land_data[r, c]) else 0.0
                    b_val = bathy_data[r, c]
                    merged[r, c] = (l_val * weight_land) + (b_val * weight_ocean)
                    provenance_land[r, c] = 1  # Feathered transition

    os.makedirs(os.path.dirname(output_path), exist_ok=True)
    with rasterio.open(output_path, "w", **profile) as dst:
        dst.write(merged, 1)

    print(f"[Merge Surface] Successfully merged DEM + Bathymetry -> {output_path}")
    return output_path, provenance_land


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description="Merge Land DEM and Sea Bathymetry")
    parser.add_argument("--land", default="data/synthetic/dem_raw.tif", help="Land DEM GeoTIFF")
    parser.add_argument("--bathymetry", default="data/synthetic/dem_bathymetry.tif", help="Bathymetry GeoTIFF")
    parser.add_argument("--output", default="data/processed/merged_surface.tif", help="Output GeoTIFF")
    parser.add_argument("--feather", type=int, default=5, help="Feather width in pixels")
    args = parser.parse_args()

    merge_land_bathymetry(args.land, args.bathymetry, args.output, args.feather)
