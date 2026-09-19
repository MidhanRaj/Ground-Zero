/**
 * weather.js â€” Realistic Sky, Procedural Clouds, Weather & Day/Night Cycle
 * Exposes a global WeatherSystem class consumed by app.js
 *
 * Features:
 *  â€¢ Realistic sky atmosphere (Rayleigh + Mie scattering, sun/moon/stars)
 *  â€¢ Day/Night cycle driven by Cesium Clock (real-time / 10Ã— / 100Ã— / manual)
 *  â€¢ Procedural cumulus clouds via Cesium.CloudCollection
 *  â€¢ GLSL post-process rain & snow shaders (altitude-aware, disappear in space)
 *  â€¢ All features individually toggleable
 */

class WeatherSystem {
  constructor(viewer) {
    this.viewer = viewer;

    // Internal state
    this._cloudBillboardCollection = null;
    this._activeCloudsData         = [];
    this._cloudTextures            = [
      'data/clouds/FX_CloudAlpha01.png',
      'data/clouds/FX_CloudAlpha02.png',
      'data/clouds/FX_CloudAlpha03.png',
      'data/clouds/FX_CloudAlpha04.png',
      'data/clouds/FX_CloudAlpha05.png',
      'data/clouds/FX_CloudAlpha06.png',
      'data/clouds/FX_CloudAlpha07.png',
      'data/clouds/FX_CloudAlpha08.png',
      'data/clouds/FX_CloudAlpha09.png',
      'data/clouds/FX_CloudAlpha10.png'
    ];
    this._cloudWindSpeed   = 18;  // km/h
    this._cloudWindHeading = 45;  // NE drift
    this._currentWeatherCode = 1;

    this._rainStage       = null;
    this._snowStage       = null;
    this._cloudsEnabled   = false;
    this._cloudDensity    = 0.5;
    this._precipType      = 'none';
    this._precipIntensity = 0.5;
    this._dayNightEnabled = false;
    this._timeMultiplier  = 1;

    this._initSky();
    this._initClock();
    this._initVolumetricClouds();
  }

  /* â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
     SKY & ATMOSPHERE
  â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€ */

  _initSky() {
    const scene = this.viewer.scene;

    // Standard crisp sky atmosphere without overexposure
    scene.highDynamicRange = false;
    scene.skyAtmosphere.show = true;

    try {
      scene.skyAtmosphere.perFragmentAtmosphere = true;
    } catch (e) {
      // Safe fallback
    }

    // Stars (SkyBox) & Sun/Moon
    if (scene.skyBox) scene.skyBox.show = true;
    scene.sun.show  = true;
    scene.moon.show = true;

    // Dynamic Day/Night Starfield: Hide background stars during daytime atmosphere facing, show at night or space
    scene.preRender.addEventListener(() => {
      try {
        if (!scene || !scene.skyBox) return;
        const cameraPos = scene.camera ? scene.camera.positionCartographic : null;
        if (cameraPos && cameraPos.height < 150000) {
          const clock = (this.viewer && this.viewer.clock) ? this.viewer.clock : null;
          const time = clock ? clock.currentTime : (scene.frameState ? scene.frameState.time : Cesium.JulianDate.now());
          if (time && Cesium.Simon1994PlanetaryPositions) {
            const sunPos = Cesium.Simon1994PlanetaryPositions.computeSunPositionInEarthInertialFrame(time);
            if (sunPos && scene.camera) {
              const normal = Cesium.Cartesian3.normalize(scene.camera.position, new Cesium.Cartesian3());
              const sunNormal = Cesium.Cartesian3.normalize(sunPos, new Cesium.Cartesian3());
              const dot = Cesium.Cartesian3.dot(normal, sunNormal);
              scene.skyBox.show = dot < -0.05; // Hide stars on sunlit daytime side
            }
          }
        } else if (scene.skyBox) {
          scene.skyBox.show = true; // Always show stars in deep space
        }
      } catch (e) {
        // Safe guard: prevent preRender error from halting Cesium render loop
      }
    });

    // Globe receives correct sun lighting
    scene.globe.enableLighting = true;
  }

  /* â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
     DAY / NIGHT CYCLE
  â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€ */

  _initClock() {
    const clock = this.viewer.clock;
    // Sync to current real-world time but keep paused until user enables
    clock.currentTime = Cesium.JulianDate.fromDate(new Date());
    clock.shouldAnimate = false;
    clock.multiplier    = 1;
    clock.clockStep     = Cesium.ClockStep.SYSTEM_CLOCK_MULTIPLIER;
  }

  /**
   * Enable or disable the day/night cycle.
   * @param {boolean} enabled
   * @param {number}  [multiplier=1]  1 = realtime, 10 = 10Ã—, 100 = 100Ã—
   */
  setDayNight(enabled, multiplier) {
    this._dayNightEnabled = enabled;
    const clock = this.viewer.clock;

    if (enabled) {
      // Snap to current real time and start running
      clock.currentTime   = Cesium.JulianDate.fromDate(new Date());
      clock.multiplier    = multiplier ?? this._timeMultiplier;
      clock.shouldAnimate = true;
      clock.clockStep     = Cesium.ClockStep.SYSTEM_CLOCK_MULTIPLIER;
    } else {
      clock.shouldAnimate = false;
    }
  }

  /** Change speed while cycle is running (no restart). */
  setTimeMultiplier(multiplier) {
    this._timeMultiplier      = multiplier;
    this.viewer.clock.multiplier = multiplier;
    if (this._dayNightEnabled) this.viewer.clock.shouldAnimate = true;
  }

  /**
   * Jump to a specific local hour (0â€“24) and pause the clock.
   * @param {number} hour  e.g. 6.5 = 06:30 local time
   */
  setManualHour(hour) {
    const date = new Date();
    date.setHours(Math.floor(hour), Math.round((hour % 1) * 60), 0, 0);
    this.viewer.clock.currentTime = Cesium.JulianDate.fromDate(date);
    this.viewer.clock.shouldAnimate = false;
  }

  /* â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
  /* â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
     MOVING VOLUMETRIC CLOUDS WITH SHADOW CASTING (Custom PNG Textures)
  â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€ */

  _initVolumetricClouds() {
    const scene = this.viewer.scene;

    // BillboardCollection for volumetric textured cloud particles
    this._cloudBillboardCollection = scene.primitives.add(new Cesium.BillboardCollection({
      scene: scene
    }));

    // Enable dynamic cloud shadows cast onto ground & 3D buildings
    try {
      this._cloudBillboardCollection.shadows = Cesium.ShadowMode.ENABLED;
    } catch (_) {}

    // Pre-render drift animation loop: continuously move clouds according to wind speed/heading
    let lastTime = performance.now();
    scene.preRender.addEventListener(() => {
      try {
        if (!this._cloudsEnabled || !this._activeCloudsData.length) return;

        const now = performance.now();
        const dt = Math.min((now - lastTime) / 1000, 0.1);
        lastTime = now;

        const rad = Cesium.Math.toRadians(this._cloudWindHeading);
        const speedMps = (this._cloudWindSpeed * 1000) / 3600;
        const dEast  = Math.sin(rad) * speedMps * dt;
        const dNorth = Math.cos(rad) * speedMps * dt;

        const cameraPos = this.viewer.camera.positionCartographic;
        if (!cameraPos) return;

        const centerLon = Cesium.Math.toDegrees(cameraPos.longitude);
        const centerLat = Cesium.Math.toDegrees(cameraPos.latitude);

        const metersPerDegLat = 111000;
        const metersPerDegLon = Math.max(1000, 111000 * Math.cos(cameraPos.latitude));

        const dLon = dEast / metersPerDegLon;
        const dLat = dNorth / metersPerDegLat;
        const maxRadiusDeg = 0.25; // 25km radius

        for (let i = 0; i < this._activeCloudsData.length; i++) {
          const item = this._activeCloudsData[i];
          item.lon += dLon;
          item.lat += dLat;

          if (item.lon > centerLon + maxRadiusDeg) item.lon = centerLon - maxRadiusDeg;
          if (item.lon < centerLon - maxRadiusDeg) item.lon = centerLon + maxRadiusDeg;
          if (item.lat > centerLat + maxRadiusDeg) item.lat = centerLat - maxRadiusDeg;
          if (item.lat < centerLat - maxRadiusDeg) item.lat = centerLat + maxRadiusDeg;

          item.billboard.position = Cesium.Cartesian3.fromDegrees(item.lon, item.lat, item.height);
        }
      } catch (e) {
        // Safe guard
      }
    });

    // Re-cluster clouds when camera moves to a new region
    this.viewer.camera.moveEnd.addEventListener(() => {
      if (this._cloudsEnabled) this._spawnVolumetricClouds();
    });
  }

  _spawnVolumetricClouds() {
    if (!this._cloudBillboardCollection) return;
    this._cloudBillboardCollection.removeAll();
    this._activeCloudsData = [];

    const cameraPos = this.viewer.camera.positionCartographic;
    if (!cameraPos) return;

    const centerLat = Cesium.Math.toDegrees(cameraPos.latitude);
    const centerLon = Cesium.Math.toDegrees(cameraPos.longitude);

    // Moderate, non-intrusive cloud count
    let count = 12;
    let minAlt = 3500, maxAlt = 6000;
    let cloudColor = new Cesium.Color(1.0, 1.0, 1.0, 0.45);

    const code = this._currentWeatherCode;
    if (code === 0) {
      count = Math.round(5 + this._cloudDensity * 5);
      minAlt = 6000; maxAlt = 8000;
      cloudColor = new Cesium.Color(1.0, 1.0, 1.0, 0.35);
    } else if ([1, 2, 3].includes(code)) {
      count = Math.round(10 + this._cloudDensity * 12);
      minAlt = 3500; maxAlt = 5500;
      cloudColor = new Cesium.Color(0.98, 0.98, 1.0, 0.50);
    } else if ([45, 48, 80].includes(code)) {
      count = Math.round(15 + this._cloudDensity * 15);
      minAlt = 2500; maxAlt = 4500;
      cloudColor = new Cesium.Color(0.85, 0.88, 0.92, 0.55);
    } else {
      count = Math.round(18 + this._cloudDensity * 15);
      minAlt = 2200; maxAlt = 4000;
      cloudColor = new Cesium.Color(0.55, 0.58, 0.65, 0.60);
    }

    for (let i = 0; i < count; i++) {
      const dLon = (Math.random() - 0.5) * 0.45;
      const dLat = (Math.random() - 0.5) * 0.45;
      const lon  = centerLon + dLon;
      const lat  = centerLat + dLat;
      const height = minAlt + Math.random() * (maxAlt - minAlt);

      const texturePath = this._cloudTextures[i % this._cloudTextures.length];

      try {
        const bb = this._cloudBillboardCollection.add({
          position: Cesium.Cartesian3.fromDegrees(lon, lat, height),
          image: texturePath,
          sizeInMeters: true,
          width: 3500 + Math.random() * 3000,
          height: 2000 + Math.random() * 2000,
          color: cloudColor,
          rotation: Math.random() * Math.PI * 2,
          alignedAxis: Cesium.Cartesian3.UNIT_Z,
          distanceDisplayCondition: new Cesium.DistanceDisplayCondition(4000.0, 300000.0)
        });

        this._activeCloudsData.push({
          billboard: bb,
          lon,
          lat,
          height
        });
      } catch (e) {
        break;
      }
    }
  }

  /**
   * Set real-time weather conditions to dynamically cluster and tint clouds
   * AND auto-drive 3D precipitation from the WMO weather code.
   */
  setWeatherCondition(weatherCode, windSpeed) {
    this._currentWeatherCode = weatherCode;
    if (windSpeed !== undefined && windSpeed > 0) {
      this._cloudWindSpeed = windSpeed;
    }

    // Auto-clouds: only spawn if clouds were manually toggled on by user
    if (this._cloudsManuallyEnabled && this._cloudsEnabled) {
      this._spawnVolumetricClouds();
    }

    // â”€â”€ Auto-precipitation from weather code â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
    const rainCodes  = [51, 53, 55, 56, 57, 61, 63, 65, 66, 67, 80, 81, 82];
    const snowCodes  = [71, 73, 75, 77, 85, 86];
    const stormCodes = [95, 96, 99];

    let autoType      = 'none';
    let autoIntensity = 0.0;

    if (rainCodes.includes(weatherCode) || stormCodes.includes(weatherCode)) {
      autoType = 'rain';
      // Light drizzle = 51/53/56, moderate = 61/63, heavy = 65/67/80/81/82/storm
      if ([51, 53, 56].includes(weatherCode))          autoIntensity = 0.35;
      else if ([55, 57, 61, 63, 66, 80].includes(weatherCode)) autoIntensity = 0.60;
      else                                              autoIntensity = 0.90;
    } else if (snowCodes.includes(weatherCode)) {
      autoType = 'snow';
      if ([71, 77, 85].includes(weatherCode))          autoIntensity = 0.35;
      else if ([73, 86].includes(weatherCode))         autoIntensity = 0.60;
      else                                              autoIntensity = 0.85;
    }

    // Only update precipitation if it's weather-driven (don't override manual choice)
    if (!this._precipManual) {
      this._setGLSLPrecipitation(autoType, autoIntensity);
    }
  }

  /**
   * Toggle global satellite cloud imagery layer (NASA GIBS).
   */
  setSatelliteClouds(enabled) {
    if (enabled) {
      if (!this._satCloudLayer) {
        try {
          const provider = new Cesium.UrlTemplateImageryProvider({
            url: 'https://gibs.earthdata.nasa.gov/wmts/epsg4326/best/MODIS_Terra_CorrectedReflectance_TrueColor/default/2024-05-01/250m/{z}/{y}/{x}.jpg',
            credit: 'NASA GIBS / Cesium Satellite Cloud Imagery',
            maximumLevel: 9
          });
          this._satCloudLayer = this.viewer.imageryLayers.addImageryProvider(provider);
          this._satCloudLayer.alpha = 0.65;
        } catch (e) {
          console.warn('[Weather] Could not load satellite cloud layer:', e);
        }
      } else {
        this._satCloudLayer.show = true;
      }
    } else if (this._satCloudLayer) {
      this._satCloudLayer.show = false;
    }
  }

  /**
   * Toggle 3D procedural/textured clouds on/off and optionally set density.
   * Marks clouds as manually enabled so weather won't auto-disable them.
   */
  setClouds(enabled, density) {
    this._cloudsManuallyEnabled = enabled;
    this._cloudsEnabled = enabled;
    if (density !== undefined) this._cloudDensity = density;

    if (this._cloudBillboardCollection) {
      this._cloudBillboardCollection.show = enabled;
    }

    if (enabled) {
      this._spawnVolumetricClouds();
    }
  }

  /** Update cloud density while clouds are visible. */
  setCloudDensity(density) {
    this._cloudDensity = density;
    if (this._cloudsEnabled) this._spawnVolumetricClouds();
  }

  /* â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
     RAIN GLSL SHADER  (post-process HUD overlay)
  â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€ */

  _rainGLSL() {
    return `
uniform sampler2D colorTexture;
in vec2 v_textureCoordinates;
uniform float u_intensity;
uniform float u_time;

float hash(vec2 p) {
  return fract(sin(dot(p, vec2(127.1, 311.7))) * 43758.5453);
}

void main() {
  vec2 uv  = v_textureCoordinates;
  vec4 col = texture(colorTexture, uv);

  float rain = 0.0;

  // Eight depth layers for rich parallax effect
  for (float i = 0.0; i < 8.0; i++) {
    float spd    = 0.55 + i * 0.12;
    float scale  = 0.28 + i * 0.07;
    float slant  = -0.0015 * (i + 1.0);
    vec2  offset = vec2(slant * u_time + i * 0.17, u_time * spd * 0.25);

    vec2  cellSz = vec2(0.007 * scale, 0.055 * scale);
    vec2  cell   = floor((uv + offset) / cellSz);
    vec2  r      = vec2(hash(cell), hash(cell + 5.7));
    vec2  pos    = fract((uv + offset) / cellSz) - vec2(r.x, 0.0);

    float streak = smoothstep(0.0014 * scale, 0.0, abs(pos.x - 0.003 * scale))
                 * smoothstep(0.0, 0.004, pos.y)
                 * smoothstep(cellSz.y, cellSz.y * 0.80, pos.y);

    rain += streak * (0.50 + r.y * 0.50);
  }

  // Brighter rain: multiply by 3.5 (was 2.2) so it's clearly visible
  rain = clamp(rain * u_intensity * 3.5, 0.0, 1.0);

  // Wet-lens darkening at bottom of frame
  float wetLens = smoothstep(0.7, 0.0, uv.y) * 0.25 * u_intensity;

  // Tint streaks a light blue-white
  vec3 wetColor = mix(col.rgb, vec3(0.75, 0.88, 1.00), rain * 0.55);
  wetColor      = wetColor * (1.0 - wetLens * 0.12);

  out_FragColor = vec4(wetColor, col.a);
}`;
  }

  /* â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
     SNOW GLSL SHADER  (post-process HUD overlay)
  â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€ */

  _snowGLSL() {
    return `
uniform sampler2D colorTexture;
in vec2 v_textureCoordinates;
uniform float u_intensity;
uniform float u_time;

float hash(vec2 p) {
  return fract(sin(dot(p, vec2(127.1, 311.7))) * 43758.5453);
}

void main() {
  vec2 uv  = v_textureCoordinates;
  vec4 col = texture(colorTexture, uv);

  float snow = 0.0;

  // Four layers â€” fewer than before, less dense by default
  for (float i = 0.0; i < 4.0; i++) {
    float spd   = 0.020 + i * 0.008;
    float scale = 0.55  + i * 0.18;
    float drift = sin(u_time * 0.18 + i * 2.3) * 0.0025 * scale;

    vec2  offset = vec2(drift + i * 0.11, u_time * spd);
    // Larger cell size = fewer flakes per screen
    float cSz    = 0.038 * scale;
    vec2  cell   = floor((uv + offset) / cSz);
    vec2  r      = vec2(hash(cell), hash(cell + vec2(4.7, 2.1)));
    vec2  pos    = fract((uv + offset) / cSz) - 0.5 + (r - 0.5) * 0.55;

    // Smaller flake radius (0.10 instead of 0.15) â†’ less blob coverage
    float flake  = smoothstep(0.10 * scale, 0.0, length(pos) * (0.70 + r.x * 0.45));
    snow += flake * (0.40 + r.y * 0.50);
  }

  // Cap at 1.4 instead of 1.9 â†’ significantly less dense
  snow = clamp(snow * u_intensity * 1.4, 0.0, 0.88);

  // Gentle white blend + subtle cold blue tint
  vec3 snowColor = mix(col.rgb, vec3(1.0, 1.0, 1.0), snow);
  snowColor      = mix(snowColor, snowColor * vec3(0.90, 0.95, 1.00),
                       0.15 * u_intensity);

  out_FragColor = vec4(snowColor, col.a);
}`;
  }

  /* â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
     PRECIPITATION CONTROL  (GLSL post-process)
  â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€ */

  /**
   * Internal helper â€” apply GLSL HUD shader for rain or snow.
   * Also called by setWeatherCondition for auto-driven precipitation.
   * @param {'none'|'rain'|'snow'} type
   * @param {number} [intensity=0.5]  0.0 â€“ 1.0
   */
  _setGLSLPrecipitation(type, intensity) {
    if (intensity !== undefined) this._precipIntensity = intensity;
    this._precipType = type;

    // Remove existing stages
    if (this._rainStage) {
      try { this.viewer.scene.postProcessStages.remove(this._rainStage); } catch (_) {}
      this._rainStage = null;
    }
    if (this._snowStage) {
      try { this.viewer.scene.postProcessStages.remove(this._snowStage); } catch (_) {}
      this._snowStage = null;
    }

    if (type === 'rain') {
      this._rainStage = new Cesium.PostProcessStage({
        name: 'weatherRain',
        fragmentShader: this._rainGLSL(),
        uniforms: {
          u_intensity: () => this._precipIntensity,
          u_time:      () => performance.now() / 1000.0
        }
      });
      this.viewer.scene.postProcessStages.add(this._rainStage);

    } else if (type === 'snow') {
      this._snowStage = new Cesium.PostProcessStage({
        name: 'weatherSnow',
        fragmentShader: this._snowGLSL(),
        uniforms: {
          u_intensity: () => this._precipIntensity,
          u_time:      () => performance.now() / 1000.0
        }
      });
      this.viewer.scene.postProcessStages.add(this._snowStage);
    }
  }

  /**
   * Public: manually set precipitation type and intensity.
   * Marks as manually set so weather auto-drive won't override it.
   * @param {'none'|'rain'|'snow'} type
   * @param {number} [intensity=0.5]  0.0 â€“ 1.0
   */
  setPrecipitation(type, intensity) {
    this._precipManual = (type !== 'none');
    this._setGLSLPrecipitation(type, intensity);
  }

  /** Update intensity without recreating the shader stage (uniforms are closures). */
  setPrecipitationIntensity(intensity) {
    this._precipIntensity = intensity;
    // Uniforms are closures â€” automatically pick up the new value next frame.
    // No need to recreate the stage.
  }

  /* â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
     CLEANUP
  â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€ */

  destroy() {
    if (this._cloudCollection) {
      if (this._cloudMoveHandler)
        this.viewer.camera.moveEnd.removeEventListener(this._cloudMoveHandler);
      this.viewer.scene.primitives.remove(this._cloudCollection);
      this._cloudCollection = null;
    }
    if (this._rainStage) {
      try { this.viewer.scene.postProcessStages.remove(this._rainStage); } catch (_) {}
      this._rainStage = null;
    }
    if (this._snowStage) {
      try { this.viewer.scene.postProcessStages.remove(this._snowStage); } catch (_) {}
      this._snowStage = null;
    }
  }
}
