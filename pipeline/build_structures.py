"""
build_structures.py - Rebuilds carved bridge decks as separate 3D structural geometry.

Thesis:
When terrain carving removes a bridge deck from the DEM, the structure must be restored as an independent
vector object (deck + supporting piers) anchored to the true carved valley ground.

This script:
1. Reads bridge vectors (GeoJSON).
2. Samples deck top elevation from the UNCARVED DEM (which preserved the bridge deck height).
3. Samples pier bottom elevation from the CARVED DEM (the restored river valley floor).
4. Outputs `bridge_structure.json` ready for 3D rendering in CesiumJS.
"""

import argparse
import json
import os
import numpy as np
import rasterio
from shapely.geometry import shape, LineString


def build_bridge_structures(bridge_geojson_path, uncarved_dem_path, carved_dem_path, output_json_path):
    os.makedirs(os.path.dirname(output_json_path), exist_ok=True)

    with rasterio.open(uncarved_dem_path) as src_uncarved:
        uncarved_dem = src_uncarved.read(1)
        transform = src_uncarved.transform
        bounds = src_uncarved.bounds

    with rasterio.open(carved_dem_path) as src_carved:
        carved_dem = src_carved.read(1)

    structures = []

    if os.path.exists(bridge_geojson_path):
        with open(bridge_geojson_path, "r") as f:
            geojson = json.load(f)

        for feat in geojson.get("features", []):
            geom = shape(feat["geometry"])
            props = feat.get("properties", {})
            bridge_name = props.get("name", "Bridge")
            width_m = props.get("width", 20.0)

            if isinstance(geom, LineString):
                coords = list(geom.coords)
                
                # Sample elevations along the bridge centerline
                deck_points = []
                piers = []

                # Convert buffer width to offset perpendicular lines for deck polygon
                width_deg = (width_m / 2.0) / 111000.0

                for i, (lon, lat) in enumerate(coords):
                    # Convert lon, lat to raster pixel coordinates
                    row, col = src_uncarved.index(lon, lat)
                    row = max(0, min(uncarved_dem.shape[0] - 1, row))
                    col = max(0, min(uncarved_dem.shape[1] - 1, col))

                    # Deck height from uncarved DEM (bridge top)
                    deck_h = float(uncarved_dem[row, col])
                    # Ground height from carved DEM (valley floor)
                    ground_h = float(carved_dem[row, col])

                    deck_points.append({"lon": lon, "lat": lat, "height": deck_h})

                    # Add structural piers at intermediate points along span
                    if 0 < i < len(coords) - 1 or len(coords) == 2:
                        # Place pier
                        piers.append({
                            "id": f"pier_{i}",
                            "lon": lon,
                            "lat": lat,
                            "ground_height": ground_h,
                            "deck_height": deck_h,
                            "clearance_m": deck_h - ground_h
                        })

                # Create 3D Deck boundary rectangle polygon
                # Offset vector perpendicular to centerline
                dx = coords[-1][0] - coords[0][0]
                dy = coords[-1][1] - coords[0][1]
                length = np.hypot(dx, dy)
                if length > 0:
                    nx = -dy / length * width_deg
                    ny = dx / length * width_deg
                else:
                    nx, ny = 0, width_deg

                deck_polygon_3d = [
                    [coords[0][0] + nx, coords[0][1] + ny, deck_points[0]["height"]],
                    [coords[-1][0] + nx, coords[-1][1] + ny, deck_points[-1]["height"]],
                    [coords[-1][0] - nx, coords[-1][1] - ny, deck_points[-1]["height"]],
                    [coords[0][0] - nx, coords[0][1] - ny, deck_points[0]["height"]]
                ]

                structures.append({
                    "id": feat.get("id", "bridge_1"),
                    "name": bridge_name,
                    "width_m": width_m,
                    "deck_polygon": deck_polygon_3d,
                    "centerline": deck_points,
                    "piers": piers
                })

    output_data = {
        "type": "BridgeStructureSet",
        "structures": structures
    }

    with open(output_json_path, "w") as f:
        json.dump(output_data, f, indent=2)

    print(f"[Build Structures] Rebuilt {len(structures)} bridge structure(s) -> {output_json_path}")
    return output_json_path


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description="Rebuild carved bridges as 3D vector geometry")
    parser.add_argument("--bridges", default="data/synthetic/bridge.geojson", help="Bridge GeoJSON")
    parser.add_argument("--uncarved", default="data/processed/uncarved_surface.tif", help="Uncarved DEM GeoTIFF")
    parser.add_argument("--carved", default="data/processed/carved_surface.tif", help="Carved DEM GeoTIFF")
    parser.add_argument("--output", default="data/processed/bridge_structure.json", help="Output JSON")
    args = parser.parse_args()

    build_bridge_structures(args.bridges, args.uncarved, args.carved, args.output)
