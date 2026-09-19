/**
 * app.js - CesiumJS Terrain Viewer with Honest Provenance
 */

(async function () {
  // ── Cesium Ion Access Token — set by user via token modal ──────────────────
  const ionToken = localStorage.getItem('cesiumIonToken') || '';
  if (!ionToken) {
    // Show token modal and wait for it to be submitted before proceeding
    await new Promise(resolve => {
      const modal = document.getElementById('tokenModal');
      const input = document.getElementById('tokenInput');
      const btn   = document.getElementById('tokenSubmitBtn');
      if (modal) modal.style.display = 'flex';
      const submit = () => {
        const val = (input ? input.value : '').trim();
        if (!val) return;
        localStorage.setItem('cesiumIonToken', val);
        Cesium.Ion.defaultAccessToken = val;
        if (modal) modal.style.display = 'none';
        resolve();
      };
      if (btn) btn.addEventListener('click', submit);
      if (input) input.addEventListener('keydown', e => { if (e.key === 'Enter') submit(); });
    });
  } else {
    Cesium.Ion.defaultAccessToken = ionToken;
  }

  // ── 1. Fetch Pipeline Metadata & Heightmaps ─────────────────────────────────
  const metaRes = await fetch('data/processed/metadata.json');
  const meta = await metaRes.json();

  const extentRectangle = Cesium.Rectangle.fromDegrees(meta.west, meta.south, meta.east, meta.north);

  const carvedBuffer = await (await fetch('data/processed/carved_heightmap.bin')).arrayBuffer();
  const carvedHeightmap = new Float32Array(carvedBuffer);

  const uncarvedBuffer = await (await fetch('data/processed/uncarved_heightmap.bin')).arrayBuffer();
  const uncarvedHeightmap = new Float32Array(uncarvedBuffer);

  const structRes = await fetch('data/processed/bridge_structure.json');
  const bridgeData = await structRes.json();

  // ── 2. Build Custom Terrain Providers (demo patch only) ─────────────────────
  function getSampledHeight(heightmap, lon, lat) {
    if (lon < meta.west || lon > meta.east || lat < meta.south || lat > meta.north) return null;
    const u = (lon - meta.west) / (meta.east - meta.west);
    const v = (meta.north - lat) / (meta.north - meta.south);
    const col = Math.max(0, Math.min(meta.width - 1, Math.floor(u * (meta.width - 1))));
    const row = Math.max(0, Math.min(meta.height - 1, Math.floor(v * (meta.height - 1))));
    return heightmap[row * meta.width + col];
  }

  const tilingScheme = new Cesium.GeographicTilingScheme();

  function createTerrainProvider(heightmapArray) {
    return new Cesium.CustomHeightmapTerrainProvider({
      width: meta.width,
      height: meta.height,
      tilingScheme,
      callback: function (x, y, level) {
        const tileRect = tilingScheme.tileXYToRectangle(x, y, level);
        const tileData = new Float32Array(meta.width * meta.height);
        
        // Fast non-intersection check: return immediately if tile does not touch the heightmap patch
        if (tileRect.east < meta.west || tileRect.west > meta.east ||
            tileRect.north < meta.south || tileRect.south > meta.north) {
          return tileData;
        }

        const latStep = (tileRect.north - tileRect.south) / (meta.height - 1);
        const lonStep = (tileRect.east - tileRect.west) / (meta.width - 1);

        for (let r = 0; r < meta.height; r++) {
          const lat = tileRect.north - r * latStep;
          if (lat < meta.south || lat > meta.north) continue;

          for (let c = 0; c < meta.width; c++) {
            const lon = tileRect.west + c * lonStep;
            if (lon < meta.west || lon > meta.east) continue;

            const u = (lon - meta.west) / (meta.east - meta.west);
            const v = (meta.north - lat) / (meta.north - meta.south);
            const col = Math.max(0, Math.min(meta.width - 1, Math.floor(u * (meta.width - 1))));
            const row = Math.max(0, Math.min(meta.height - 1, Math.floor(v * (meta.height - 1))));
            tileData[r * meta.width + c] = heightmapArray[row * meta.width + col] ?? 0;
          }
        }
        return tileData;
      }
    });
  }

  const carvedTerrainProvider   = createTerrainProvider(carvedHeightmap);
  const uncarvedTerrainProvider = createTerrainProvider(uncarvedHeightmap);

  // ── 3. Load Cesium World Terrain (real global 3D) ───────────────────────────
  let worldTerrainProvider;
  try {
    worldTerrainProvider = await Cesium.CesiumTerrainProvider.fromIonAssetId(1, {
      requestVertexNormals: true,
      requestWaterMask: true
    });
  } catch (e) {
    console.warn('[Cesium] World Terrain unavailable, using ellipsoid.', e);
    worldTerrainProvider = new Cesium.EllipsoidTerrainProvider();
  }

  // ── 4. Initialize Viewer ────────────────────────────────────────────────────
  // CRITICAL: Do NOT pass imageryProvider to constructor — deprecated in ≥1.104
  const viewer = new Cesium.Viewer('cesiumContainer', {
    terrainProvider: worldTerrainProvider,  // Real 3D globally by default
    baseLayerPicker: false,
    geocoder: false,          // We add our own search bar
    homeButton: false,
    infoBox: false,
    sceneModePicker: false,
    selectionIndicator: false,
    timeline: false,
    animation: false,
    navigationHelpButton: false
  });

  // Performance: cap resolution on HiDPI, limit shadow quality
  viewer.resolutionScale = Math.min(window.devicePixelRatio || 1, 1.0);
  viewer.targetFrameRate = 60;
  viewer.scene.requestRenderMode = false; // Always render for smooth feel
  viewer.scene.maximumRenderTimeChange = Infinity;

  // Shadow quality — keep distance short for perf
  if (viewer.shadowMap) {
    viewer.shadowMap.maximumDistance = 1500.0;
    viewer.shadowMap.size = 512;
    viewer.shadowMap.softShadows = false;
    viewer.shadowMap.normalOffset = true;
  }

  // Remove default imagery and add Bing Aerial satellite
  viewer.imageryLayers.removeAll();
  try {
    const satellite = await Cesium.IonImageryProvider.fromAssetId(2);
    viewer.imageryLayers.addImageryProvider(satellite);
  } catch (e) {
    console.warn('[Cesium] Bing Aerial unavailable, using OSM.', e);
    viewer.imageryLayers.addImageryProvider(new Cesium.UrlTemplateImageryProvider({
      url: 'https://tile.openstreetmap.org/{z}/{x}/{y}.png',
      credit: '© OpenStreetMap contributors',
      maximumLevel: 19
    }));
  }

  // ── Globe & Atmosphere (Flight Sim look) ──────────────────────────────────
  viewer.scene.globe.enableLighting = false;
  viewer.scene.globe.depthTestAgainstTerrain = true;
  viewer.scene.globe.showGroundAtmosphere = true;

  // Shadows off for max performance & smooth 60 FPS rendering like Google Earth
  viewer.shadows = false;
  viewer.terrainShadows = Cesium.ShadowMode.DISABLED;

  // Atmospheric scattering & fog
  viewer.scene.skyAtmosphere.show = true;
  viewer.scene.fog.enabled = false;

  // ── Google Photorealistic 3D Tiles ─────────────────────────────────────────
  // Ion asset 2275207 — real photogrammetry textures from Google Maps aerial
  // imagery. Covers the globe including India.
  let buildingsTileset = null;
  try {
    buildingsTileset = await Cesium.Cesium3DTileset.fromIonAssetId(2275207, {
      shadows: Cesium.ShadowMode.DISABLED,   // Shadows off = large GPU saving
      maximumScreenSpaceError: 24,           // Smooth balance of detail and rendering speed
      maximumMemoryUsage: 2048,              // 2GB VRAM cache prevents tile eviction stutter
      skipLevelOfDetail: true,
      preloadAncestors: true,
      preloadSiblings: true,
      cullWithChildrenBounds: true,
      dynamicScreenSpaceError: true,         // Reduce quality of distant tiles
      dynamicScreenSpaceErrorDensity: 0.002,
      dynamicScreenSpaceErrorFactor: 5.0,
      dynamicScreenSpaceErrorHeightFalloff: 0.25
    });
    viewer.scene.primitives.add(buildingsTileset);
    // Google tiles carry their own terrain — avoid z-fighting
    viewer.scene.globe.depthTestAgainstTerrain = false;
    console.log('[Cesium] Google Photorealistic 3D Tiles loaded.');
  } catch (e) {
    console.warn('[Cesium] Google Photorealistic 3D Tiles unavailable:', e);
  }

  // ── 5. Google Earth–style Navigation ────────────────────────────────────────
  // Google Earth: left-drag = pan/rotate, right-drag = TILT, scroll = zoom
  const ctrl = viewer.scene.screenSpaceCameraController;
  ctrl.rotateEventTypes  = Cesium.CameraEventType.LEFT_DRAG;
  ctrl.tiltEventTypes    = [
    Cesium.CameraEventType.RIGHT_DRAG,
    Cesium.CameraEventType.MIDDLE_DRAG,
    { eventType: Cesium.CameraEventType.LEFT_DRAG, modifier: Cesium.KeyboardEventModifier.CTRL }
  ];
  ctrl.zoomEventTypes    = [
    Cesium.CameraEventType.WHEEL,
    Cesium.CameraEventType.PINCH
  ];
  ctrl.lookEventTypes    = { eventType: Cesium.CameraEventType.LEFT_DRAG, modifier: Cesium.KeyboardEventModifier.SHIFT };
  ctrl.enableCollisionDetection = true;
  ctrl.minimumZoomDistance = 50;   // Don't zoom below 50 m

  // ── 6. Initial Camera Position ──────────────────────────────────────────────
  // Automatic flyTo on load removed so Cesium defaults to global view.

  // ── 7. Sea Surface Entity ────────────────────────────────────────────────────
  const oceanWest = meta.west;
  const oceanEast = meta.west + (45 / 256.0) * (meta.east - meta.west);
  const seaEntity = viewer.entities.add({
    name: 'Sea Surface',
    show: false,
    rectangle: {
      coordinates: Cesium.Rectangle.fromDegrees(oceanWest, meta.south, oceanEast, meta.north),
      material: new Cesium.ColorMaterialProperty(new Cesium.Color(0.0, 0.4, 0.85, 0.4)),
      height: -31.8
    }
  });

  // ── 8. 3D Bridge Entities ────────────────────────────────────────────────────
  const bridgeEntities = [];
  if (bridgeData.structures && bridgeData.structures.length > 0) {
    const bridge = bridgeData.structures[0];

    // Deck polygon — use perPositionHeight so Z values are respected
    const deckCoords = [];
    bridge.deck_polygon.forEach(pt => deckCoords.push(pt[0], pt[1], pt[2]));

    bridgeEntities.push(viewer.entities.add({
      name: bridge.name + ' Deck',
      show: false,
      polygon: {
        hierarchy: new Cesium.PolygonHierarchy(
          Cesium.Cartesian3.fromDegreesArrayHeights(deckCoords)
        ),
        perPositionHeight: true,
        material: new Cesium.ColorMaterialProperty(new Cesium.Color(0.9, 0.38, 0.12, 0.97)),
        outline: true,
        outlineColor: Cesium.Color.WHITE,
        outlineWidth: 2,
        shadows: Cesium.ShadowMode.ENABLED
      }
    }));

    // Piers — bottom = lower of the two heights, top = higher
    bridge.piers.forEach(pier => {
      const lo = Math.min(pier.ground_height, pier.deck_height);
      const hi = Math.max(pier.ground_height, pier.deck_height);
      bridgeEntities.push(viewer.entities.add({
        name: bridge.name + ' Pier',
        show: false,
        polyline: {
          positions: Cesium.Cartesian3.fromDegreesArrayHeights([
            pier.lon, pier.lat, lo,
            pier.lon, pier.lat, hi
          ]),
          width: 14,
          material: new Cesium.ColorMaterialProperty(Cesium.Color.fromCssColorString('#cbd5e1')),
          clampToGround: false,
          shadows: Cesium.ShadowMode.ENABLED
        }
      }));
    });
  }

  // ── 9. Provenance Overlay ────────────────────────────────────────────────────
  let provenanceLayer;
  try {
    const prov = await Cesium.SingleTileImageryProvider.fromUrl(
      'data/processed/provenance.png', { rectangle: extentRectangle }
    );
    provenanceLayer = viewer.imageryLayers.addImageryProvider(prov);
  } catch (e) {
    const prov = new Cesium.SingleTileImageryProvider({
      url: 'data/processed/provenance.png', rectangle: extentRectangle
    });
    provenanceLayer = viewer.imageryLayers.addImageryProvider(prov);
  }
  provenanceLayer.alpha = 0.75;

  // ── 10. UI Controls ──────────────────────────────────────────────────────────

  // Terrain source radio — NOTE: custom providers only affect the 2km demo patch.
  // Outside that patch the Globe is flat (returns 0) from the custom provider.
  // World Terrain is the global default; radio buttons swap to demo-patch providers.
  const radioAsDelivered  = document.getElementById('radioAsDelivered');
  const radioAfterCarving = document.getElementById('radioAfterCarving');
  const labelAsDelivered  = document.getElementById('labelAsDelivered');
  const labelAfterCarving = document.getElementById('labelAfterCarving');

  // Start with World Terrain active — do NOT pre-set custom provider on load
  function updateElevationSource(source) {
    if (source === 'carved') {
      viewer.terrainProvider = carvedTerrainProvider;
      labelAfterCarving.classList.add('active');
      labelAsDelivered.classList.remove('active');
      setStructuresVisible(document.getElementById('chkStructures').checked);
    } else {
      viewer.terrainProvider = uncarvedTerrainProvider;
      labelAsDelivered.classList.add('active');
      labelAfterCarving.classList.remove('active');
      setStructuresVisible(false);
    }
  }

  radioAsDelivered.addEventListener('change',  () => updateElevationSource('uncarved'));
  radioAfterCarving.addEventListener('change', () => updateElevationSource('carved'));

  // Layer toggles
  const chkProvenance = document.getElementById('chkProvenance');
  const chkStructures = document.getElementById('chkStructures');
  const chkSeaSurface = document.getElementById('chkSeaSurface');

  chkProvenance.addEventListener('change', e => { provenanceLayer.show = e.target.checked; });

  function setStructuresVisible(v) { bridgeEntities.forEach(e => e.show = v); }
  chkStructures.addEventListener('change', e => setStructuresVisible(e.target.checked));
  chkSeaSurface.addEventListener('change', e => { seaEntity.show = e.target.checked; });

  // Buildings toggle
  const chkBuildings = document.getElementById('chkBuildings');
  chkBuildings.addEventListener('change', e => {
    if (buildingsTileset) buildingsTileset.show = e.target.checked;
  });

  // Obs-only toggle
  const btnObsOnly = document.getElementById('btnObsOnly');
  let obsOnlyActive = false;
  btnObsOnly.addEventListener('click', () => {
    obsOnlyActive = !obsOnlyActive;
    btnObsOnly.classList.toggle('active', obsOnlyActive);
    document.getElementById('btnObsOnlyText').innerText = obsOnlyActive
      ? 'Showing Observations Only' : 'Show Observations Only';
    provenanceLayer.alpha = obsOnlyActive ? 1.0 : 0.75;
  });

  // Sync every layer/entity to what the UI actually shows checked on startup
  const initialSourceRadio = document.querySelector('input[name="elevationSource"]:checked');
  const initialSource = initialSourceRadio ? initialSourceRadio.value : 'carved';
  updateElevationSource(initialSource === 'carved' ? 'carved' : 'uncarved');
  if (provenanceLayer) provenanceLayer.show = chkProvenance.checked;
  setStructuresVisible(chkStructures.checked && initialSource === 'carved');
  seaEntity.show = chkSeaSurface.checked;

  // Vertical exaggeration
  const sliderExaggeration = document.getElementById('sliderExaggeration');
  const exaggerationVal    = document.getElementById('exaggerationVal');
  sliderExaggeration.addEventListener('input', e => {
    const f = parseFloat(e.target.value);
    exaggerationVal.innerText = f.toFixed(1) + 'x';
    viewer.scene.verticalExaggeration = f;
  });

  // Live stats
  const obsPercentVal = document.getElementById('obsPercentVal');
  const obsBarFill    = document.getElementById('obsBarFill');
  function updateLiveStats() {
    if (!obsPercentVal || !obsBarFill || !meta || typeof meta.observed_percent === 'undefined') return;
    const pct = meta.observed_percent.toFixed(1);
    obsPercentVal.innerText = pct + '%';
    obsBarFill.style.width  = pct + '%';
  }
  if (obsPercentVal && obsBarFill) {
    viewer.camera.moveEnd.addEventListener(updateLiveStats);
    updateLiveStats();
  }

  // ── 11. Search Bar (Nominatim geocoder) ──────────────────────────────────────
  const searchInput    = document.getElementById('searchInput');
  const searchBtn      = document.getElementById('searchBtn');
  const searchResults  = document.getElementById('searchResults');
  let searchDebounce   = null;

  async function geocode(query) {
    if (!query.trim()) { searchResults.style.display = 'none'; return; }
    try {
      const url = `https://nominatim.openstreetmap.org/search?q=${encodeURIComponent(query)}&format=json&limit=5`;
      const res  = await fetch(url, { headers: { 'Accept-Language': 'en' } });
      const data = await res.json();
      renderResults(data);
    } catch (err) {
      console.warn('[Search] Geocoding error', err);
    }
  }

  function renderResults(places) {
    searchResults.innerHTML = '';
    if (!places.length) {
      searchResults.innerHTML = '<div class="search-empty">No results found</div>';
      searchResults.style.display = 'block';
      return;
    }
    places.forEach(place => {
      const item = document.createElement('div');
      item.className = 'search-result-item';
      item.innerHTML = `
        <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M21 10c0 7-9 13-9 13s-9-6-9-13a9 9 0 0118 0z"/><circle cx="12" cy="10" r="3"/></svg>
        <span>${place.display_name}</span>
      `;
      item.addEventListener('click', () => {
        const lon = parseFloat(place.lon);
        const lat = parseFloat(place.lat);
        const bb  = place.boundingbox; // [south, north, west, east]
        const heightEst = 5000;

        viewer.camera.flyTo({
          destination: bb
            ? Cesium.Rectangle.fromDegrees(
                parseFloat(bb[2]), parseFloat(bb[0]),
                parseFloat(bb[3]), parseFloat(bb[1])
              )
            : Cesium.Cartesian3.fromDegrees(lon, lat, heightEst),
          orientation: {
            heading: Cesium.Math.toRadians(0),
            pitch:   Cesium.Math.toRadians(-55),
            roll:    0
          },
          duration: 2.0
        });

        searchInput.value           = place.display_name.split(',')[0];
        searchResults.style.display = 'none';
      });
      searchResults.appendChild(item);
    });
    searchResults.style.display = 'block';
  }

  searchInput.addEventListener('input', () => {
    clearTimeout(searchDebounce);
    searchDebounce = setTimeout(() => geocode(searchInput.value), 350);
  });

  searchInput.addEventListener('keydown', e => {
    if (e.key === 'Enter') { clearTimeout(searchDebounce); geocode(searchInput.value); }
    if (e.key === 'Escape') { searchResults.style.display = 'none'; }
  });

  searchBtn.addEventListener('click', () => {
    clearTimeout(searchDebounce);
    geocode(searchInput.value);
  });

  // Close results when clicking outside
  document.addEventListener('click', e => {
    if (!e.target.closest('#searchWrapper')) searchResults.style.display = 'none';
  });

  // ── 12. Weather & Sky System ──────────────────────────────────────────────────
  const weather = new WeatherSystem(viewer);

  // Collapsible section toggle
  const weatherHeader = document.getElementById('weatherToggleHeader');
  const weatherBody   = document.getElementById('weatherBody');
  const weatherIcon   = document.getElementById('weatherCollapseIcon');
  weatherHeader.addEventListener('click', () => {
    const collapsed = weatherBody.classList.toggle('collapsed');
    weatherIcon.classList.toggle('collapsed', collapsed);
  });

  // ── Day/Night Cycle ───────────────────────────────────────────────────────────
  const chkDayNight      = document.getElementById('chkDayNight');
  const dnSpeedRow       = document.getElementById('dnSpeedRow');
  const manualHourRow    = document.getElementById('manualHourRow');
  const manualHourSlider = document.getElementById('sliderManualHour');
  const manualHourVal    = document.getElementById('manualHourVal');
  let   currentMult      = 1;
  let   isManualMode     = false;

  function formatHour(h) {
    const hh = Math.floor(h) % 24;
    const mm = Math.round((h % 1) * 60);
    return `${String(hh).padStart(2, '0')}:${String(mm).padStart(2, '0')}`;
  }

  chkDayNight.addEventListener('change', e => {
    dnSpeedRow.style.display = e.target.checked ? '' : 'none';
    if (e.target.checked) {
      if (isManualMode) {
        weather.setManualHour(parseFloat(manualHourSlider.value));
      } else {
        weather.setDayNight(true, currentMult);
      }
    } else {
      weather.setDayNight(false);
      manualHourRow.style.display = 'none';
    }
  });

  // Speed pill buttons (Real-time / 10× / 100× / Manual)
  const speedBtns = document.querySelectorAll('.weather-pill[data-mult]');
  speedBtns.forEach(btn => {
    btn.addEventListener('click', () => {
      speedBtns.forEach(b => b.classList.remove('active'));
      btn.classList.add('active');
      const mult = parseInt(btn.dataset.mult, 10);

      if (mult === 0) {
        isManualMode = true;
        manualHourRow.style.display = '';
        weather.setManualHour(parseFloat(manualHourSlider.value));
      } else {
        isManualMode = false;
        currentMult  = mult;
        manualHourRow.style.display = 'none';
        if (chkDayNight.checked) weather.setTimeMultiplier(mult);
      }
    });
  });

  manualHourSlider.addEventListener('input', e => {
    const h = parseFloat(e.target.value);
    manualHourVal.innerText = formatHour(h);
    if (chkDayNight.checked && isManualMode) weather.setManualHour(h);
  });

  // ── Procedural & Satellite Clouds ─────────────────────────────────────────────
  const chkClouds          = document.getElementById('chkClouds');
  const chkSatClouds       = document.getElementById('chkSatClouds');
  const cloudDensityRow    = document.getElementById('cloudDensityRow');
  const sliderCloudDensity = document.getElementById('sliderCloudDensity');
  const cloudDensityVal    = document.getElementById('cloudDensityVal');

  if (chkClouds) {
    chkClouds.addEventListener('change', e => {
      cloudDensityRow.style.display = e.target.checked ? '' : 'none';
      weather.setClouds(e.target.checked, parseFloat(sliderCloudDensity.value) / 100);
    });
  }

  if (chkSatClouds) {
    chkSatClouds.addEventListener('change', e => {
      weather.setSatelliteClouds(e.target.checked);
    });
  }

  if (sliderCloudDensity) {
    sliderCloudDensity.addEventListener('input', e => {
      const pct = parseInt(e.target.value, 10);
      cloudDensityVal.innerText = pct + '%';
      weather.setCloudDensity(pct / 100);
    });
  }

  // ── Precipitation ─────────────────────────────────────────────────────────────
  const precipIntensityRow    = document.getElementById('precipIntensityRow');
  const sliderPrecipIntensity = document.getElementById('sliderPrecipIntensity');
  const precipIntensityVal    = document.getElementById('precipIntensityVal');

  const precipBtns = [
    { el: document.getElementById('precipNone'), type: 'none' },
    { el: document.getElementById('precipRain'), type: 'rain' },
    { el: document.getElementById('precipSnow'), type: 'snow' }
  ];

  precipBtns.forEach(({ el, type }) => {
    el.addEventListener('click', () => {
      precipBtns.forEach(b => b.el.classList.remove('active'));
      el.classList.add('active');
      precipIntensityRow.style.display = type !== 'none' ? '' : 'none';
      weather.setPrecipitation(type, parseFloat(sliderPrecipIntensity.value) / 100);
    });
  });

  sliderPrecipIntensity.addEventListener('input', e => {
    const pct = parseInt(e.target.value, 10);
    precipIntensityVal.innerText = pct + '%';
    weather.setPrecipitationIntensity(pct / 100);
  });

  // ── 13. Flight Simulator Mode ──────────────────────────────────────────────────
  const flight = new FlightSystem(viewer);
  const btnFlightMode     = document.getElementById('btnFlightMode');
  const btnFlightModeText = document.getElementById('btnFlightModeText');

  if (btnFlightMode) {
    btnFlightMode.addEventListener('click', () => flight.toggle());
  }

  window.addEventListener('flightModeChange', e => {
    const active = e.detail.active;
    if (btnFlightMode) {
      btnFlightMode.classList.toggle('active', active);
      if (btnFlightModeText) {
        btnFlightModeText.textContent = active ? 'Exit Flight Mode (F)' : 'Flight Mode (F)';
      }
    }
  });

  // ── 14. Live Location, Timezone Clock & Weather System ────────────────────────
  const hudCityText       = document.getElementById('hudCityText');
  const hudLocalTimeVal   = document.getElementById('hudLocalTimeVal');
  const hudWeatherVal     = document.getElementById('hudWeatherVal');
  const hudWeatherSubText = document.getElementById('hudWeatherSubText');

  let activeTimezone      = null;
  let hudClockInterval    = null;
  let moveDebounceTimeout = null;

  function updateLocalClock() {
    if (!hudLocalTimeVal) return;
    try {
      const now = new Date();
      if (activeTimezone) {
        const timeStr = new Intl.DateTimeFormat('en-US', {
          timeZone: activeTimezone,
          hour: '2-digit',
          minute: '2-digit',
          second: '2-digit',
          hour12: false
        }).format(now);
        
        const zoneShort = new Intl.DateTimeFormat('en-US', {
          timeZone: activeTimezone,
          timeZoneName: 'short'
        }).format(now).split(' ').pop();
        
        hudLocalTimeVal.innerText = `${timeStr} ${zoneShort}`;
      } else {
        hudLocalTimeVal.innerText = now.toLocaleTimeString([], { hour12: false });
      }
    } catch (e) {
      hudLocalTimeVal.innerText = new Date().toLocaleTimeString([], { hour12: false });
    }
  }

  if (hudClockInterval) clearInterval(hudClockInterval);
  hudClockInterval = setInterval(updateLocalClock, 1000);
  updateLocalClock();

  function decodeWmoCode(code, isDay = 1, windSpeed = 0) {
    const isNight = (isDay === 0);
    const dayNightCaption = isNight ? 'Night 🌙' : 'Day ☀️';

    let conditionText = 'Clear';
    let icon = isNight ? '🌙' : '☀️';

    if (code === 0) {
      conditionText = isNight ? 'Clear Night' : 'Clear Sky';
      icon = isNight ? '🌙' : '☀️';
    } else if ([1, 2, 3].includes(code)) {
      conditionText = 'Partly Cloudy';
      icon = isNight ? '🌙☁️' : '⛅';
    } else if ([45, 48].includes(code)) {
      conditionText = 'Foggy';
      icon = isNight ? '🌙🌫️' : '🌫️';
    } else if ([51, 53, 55, 56, 57, 61, 63, 65, 66, 67, 80, 81, 82].includes(code)) {
      conditionText = 'Rainy';
      icon = isNight ? '🌙🌧️' : '🌧️';
    } else if ([71, 73, 75, 77, 85, 86].includes(code)) {
      conditionText = 'Snowy';
      icon = isNight ? '🌙❄️' : '❄️';
    } else if ([95, 96, 99].includes(code)) {
      conditionText = 'Thunderstorm';
      icon = '🌩️';
    } else {
      conditionText = 'Overcast';
      icon = isNight ? '🌙☁️' : '☁️';
    }

    let weatherCaption = conditionText;
    if (windSpeed >= 20 && !['Rainy', 'Snowy', 'Thunderstorm'].includes(conditionText)) {
      weatherCaption += ' • Windy 🌬️';
    }

    return {
      label: weatherCaption,
      icon,
      dayNightCaption,
      isNight
    };
  }

  async function updateLocationAndWeather() {
    try {
      let cart = null;
      if (viewer && viewer.canvas && viewer.scene) {
        const center = new Cesium.Cartesian2(viewer.canvas.clientWidth / 2, viewer.canvas.clientHeight / 2);
        const ray = viewer.camera.getPickRay(center);
        const position = viewer.scene.globe.pick(ray, viewer.scene);
        if (position) {
          cart = Cesium.Cartographic.fromCartesian(position);
        } else {
          cart = viewer.camera.positionCartographic;
        }
      }
      if (!cart) return;

      const lon = Cesium.Math.toDegrees(cart.longitude);
      const lat = Cesium.Math.toDegrees(cart.latitude);

      // 1. Fetch Weather & Timezone via Open-Meteo (including is_day indicator)
      const weatherUrl = `https://api.open-meteo.com/v1/forecast?latitude=${lat.toFixed(4)}&longitude=${lon.toFixed(4)}&current=temperature_2m,relative_humidity_2m,weather_code,wind_speed_10m,is_day&timezone=auto`;
      const wRes = await fetch(weatherUrl);
      if (wRes.ok) {
        const wData = await wRes.json();
        if (wData && wData.current) {
          const temp = Math.round(wData.current.temperature_2m);
          const isDay = wData.current.is_day !== undefined ? wData.current.is_day : 1;
          const wind = Math.round(wData.current.wind_speed_10m);
          const humidity = wData.current.relative_humidity_2m;

          const codeInfo = decodeWmoCode(wData.current.weather_code, isDay, wind);

          if (hudWeatherVal) hudWeatherVal.innerText = `${temp}°C ${codeInfo.icon}`;
          if (hudWeatherSubText) hudWeatherSubText.innerText = `${codeInfo.label} • Wind ${wind} km/h • Humidity ${humidity}%`;

          const hudDayNightTag = document.getElementById('hudDayNightTag');
          if (hudDayNightTag) {
            hudDayNightTag.innerText = codeInfo.dayNightCaption;
            if (codeInfo.isNight) {
              hudDayNightTag.classList.add('night');
            } else {
              hudDayNightTag.classList.remove('night');
            }
          }

          // Sync real-time weather & wind speed to 3D volumetric moving clouds
          if (weather && weather.setWeatherCondition) {
            weather.setWeatherCondition(wData.current.weather_code, wData.current.wind_speed_10m);
          }
        }
        if (wData && wData.timezone) {
          activeTimezone = wData.timezone;
          updateLocalClock();
        }
      }

      // 2. Reverse Geocode via Nominatim
      const geoUrl = `https://nominatim.openstreetmap.org/reverse?lat=${lat.toFixed(4)}&lon=${lon.toFixed(4)}&format=json&zoom=10`;
      const gRes = await fetch(geoUrl, { headers: { 'Accept-Language': 'en' } });
      if (gRes.ok) {
        const gData = await gRes.json();
        if (gData && gData.address) {
          const city = gData.address.city || gData.address.town || gData.address.village || gData.address.county || gData.address.state || gData.address.country || 'Earth Surface';
          const country = gData.address.country || '';
          const name = (country && city !== country) ? `${city}, ${country}` : city;
          if (hudCityText) hudCityText.innerText = name;
        } else if (gData && gData.display_name) {
          const parts = gData.display_name.split(',');
          if (hudCityText) hudCityText.innerText = parts.slice(0, 2).join(',').trim();
        }
      }
    } catch (err) {
      console.warn('[LocationHUD] Error updating location & weather:', err);
    }
  }

  // Update on camera movement end
  viewer.camera.moveEnd.addEventListener(() => {
    clearTimeout(moveDebounceTimeout);
    moveDebounceTimeout = setTimeout(updateLocationAndWeather, 450);
  });

  // Initial update
  setTimeout(updateLocationAndWeather, 1000);

  console.log('[Cesium] Ready — Bing Aerial | World Terrain | Google Photorealistic 3D | Weather & Location Systems');
})();
