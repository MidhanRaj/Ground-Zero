"""
datum_correct.py - Vertical Datum Transformation (EGM2008 Geoid -> WGS84 Ellipsoid)

Vertical Datum Context:
  - Copernicus DEM GLO-30 reports Orthometric Height (H) relative to the EGM2008 Geoid.
  - GEBCO 2024 reports depth relative to Mean Sea Level (MSL ~ EGM2008).
  - CesiumJS globe engine expects Ellipsoidal Height (h) relative to the WGS84 Ellipsoid.

Mathematical Relation:
  h_ellipsoid = H_orthometric + N_geoid_height
  where:
    h = WGS84 ellipsoidal height (meters)
    H = Orthometric height above geoid / EGM2008 (meters)
    N = Geoid undulation / separation (meters)

For the synthetic test region (~37.75 N, -122.45 W), the EGM2008 geoid undulation N is approximately -31.8 meters.
"""

import argparse
import os
import numpy as np
import rasterio


def correct_vertical_datum(input_path, output_path, simulated_geoid_offset=-31.8):
    """
    Applies vertical datum correction N (geoid height offset in meters) to convert EGM2008 DEM -> WGS84 ellipsoid.
    
    Parameters:
      input_path: Path to input DEM raster (EGM2008 orthometric height, meters)
      output_path: Path to output DEM raster (WGS84 ellipsoidal height, meters)
      simulated_geoid_offset: Geoid undulation N in meters (h = H + N). Default -31.8m for SF bay.
    """
    with rasterio.open(input_path) as src:
        dem = src.read(1)
        profile = src.profile.copy()

    # Apply vertical datum offset: h_ellipsoid = H_orthometric + N
    # Note: subtracting/adding explicit offset. In synthetic mode, N is constant across 2km.
    corrected_dem = dem.astype(np.float32) + simulated_geoid_offset

    os.makedirs(os.path.dirname(output_path), exist_ok=True)
    with rasterio.open(output_path, "w", **profile) as dst:
        dst.write(corrected_dem, 1)

    print(f"[Datum Correct] Applied EGM2008 -> WGS84 offset (N = {simulated_geoid_offset:.1f} m)")
    print(f"  Input:  {input_path}")
    print(f"  Output: {output_path}")
    return output_path


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description="Convert DEM from EGM2008 Geoid to WGS84 Ellipsoid")
    parser.add_argument("--input", default="data/processed/merged_surface.tif", help="Input EGM2008 DEM")
    parser.add_argument("--output", default="data/processed/corrected_surface.tif", help="Output WGS84 DEM")
    parser.add_argument("--offset", type=float, default=-31.8, help="Geoid undulation N in meters")
    args = parser.parse_args()

    correct_vertical_datum(args.input, args.output, args.offset)
