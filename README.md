# Ground Zeros — NASA Space Apps 2026

Building a browser-based 3D terrain viewer for the NASA Space Apps Challenge. Most "AI-enhanced satellite globe" projects drape generative upscaling over imagery with no way to tell measured pixels from invented ones. This project does the opposite — real elevation data corrected against its actual source, bridges modelled as 3D structures instead of baked into the terrain, and every AI-filled or interpolated pixel tagged and rendered differently from a direct observation.

## Solved Problems

1. **Bridge Baked-in Terrain / Damming**: Global DEMs (radar/photogrammetric) capture bridge decks as solid ground, damming valleys or creating fake trenches. We carve bridge footprints out of the DEM, restore true ground elevation, and build bridge decks/piers as separate 3D structures.
2. **Vertical Datum & Coastline Seams**: Elevation and bathymetry come from different instruments, resolutions, and vertical datums (EGM2008 geoid vs WGS84 ellipsoid). Stitched without correction, the coastline seam is wrong. We apply explicit vertical datum transforms before merging.

## Repository Structure

```
/pipeline
  synthetic_source.py   # Generates test region DEM, bathymetry, cloud mask, & synthetic bridge GeoJSON
  merge_surface.py      # Land + sea raster merge with coastline feathering
  datum_correct.py      # EGM2008 geoid -> WGS84 ellipsoid conversion
  carve.py              # Masks DEM under bridge/tunnel ways, interpolates ground, writes carve mask
  build_structures.py   # Builds 3D bridge deck + pier geometry from carve mask & uncarved DEM
  provenance.py         # Combines carve mask + gap mask into single-band provenance raster & PNG overlay
  run_pipeline.py       # Orchestrates full data pipeline execution
/client
  index.html            # Main web UI layout with CesiumJS viewport & control panel
  server.js             # Node.js Express server providing heightmap tiles & API endpoints
  src/
    app.js              # CesiumJS viewer setup, layer controls, provenance shader/overlay, exaggeration
    styles.css          # Dark glassmorphic styling
/data                   # Data directory (synthetic & processed rasters)
README.md               # Setup, data lineage, licences, and operational guide
```

## Provenance Raster Specification (Single Band)

| Code | Meaning | Visualization / Rendering |
|---|---|---|
| `0` | Measured, direct observation | Render normal |
| `1` | Measured, resampled/reprojected | Render normal |
| `2` | Inferred, temporal composite fill | Desaturated / Yellow overlay |
| `3` | Inferred, SAR-conditioned reconstruction | Diagonal hatch overlay |
| `4` | Inferred, super-resolved | Diagonal hatch overlay |
| `5` | Inferred, carved terrain under structure | Cyan wireframe / hatch ground overlay |

## Data Sources & Licences (Real Pipeline Integration)

- **Elevation**: Copernicus DEM GLO-30 (30m, AWS Open Data) — *Licence: Copernicus Sentinel data policy / CC-BY-1.0*
- **Bathymetry**: GEBCO 2024 Grid (GeoTIFF, gebco.net) — *Licence: GEBCO Data Licence / Open Data*
- **Structures**: OpenStreetMap bridge/tunnel ways via Geofabrik / Overpass — *Licence: Open Database License (ODbL)*
- **Imagery**: NASA GIBS (WMTS) & Sentinel-2 L2A via Earth Search STAC — *Licence: NASA Open Data Policy / Creative Commons*
- **Validation**: ICESat-2 ATL06/ATL08 ground-truth points — *Licence: NASA Earthdata Open Access*

## How to Swap Synthetic Data for Real Rasters

1. Download Copernicus GLO-30 DEM tile, GEBCO GeoTIFF, and OSM bridge extracts into `data/raw/`.
2. In `pipeline/run_pipeline.py`, replace `synthetic_source.generate_all()` with direct file paths to your raw Copernicus DEM, GEBCO bathymetry, and OSM GeoJSON extract.
3. Pipeline scripts accept CLI arguments (e.g. `python pipeline/carve.py --input data/raw/copernicus.tif --bridges data/raw/bridges.geojson`).

## Quick Start (Synthetic Scaffold)

### 1. Install Python dependencies & run pipeline
```bash
pip install -r requirements.txt
python pipeline/run_pipeline.py
```

### 2. Start Client Server
```bash
cd client
npm install
npm start
```
Open `http://localhost:3000` in your web browser.
