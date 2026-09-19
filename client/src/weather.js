/**
 * weather.js — Realistic Sky, Procedural Clouds, Weather & Day/Night Cycle
 * Exposes a global WeatherSystem class consumed by app.js
 *
 * Features:
 *  • Realistic sky atmosphere (Rayleigh + Mie scattering, sun/moon/stars)
 *  • Day/Night cycle driven by Cesium Clock (real-time / 10× / 100× / manual)
 *  • Procedural cumulus clouds via Cesium.CloudCollection
 *  • GLSL post-process rain & snow shaders (altitude-aware, disappear in space)
 *  • All features individually toggleable
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
    this._initNightLights();
  }

  /* ─────────────────────────────────────────────────────────────────────────
     SKY & ATMOSPHERE
  ───────────────────────────────────────────────────────────────────────── */

  _initSky() {
    const scene = this.viewer.scene;

    // Enable High Dynamic Range & Per-Fragment Rayleigh/Mie Atmosphere Scattering
    scene.highDynamicRange = true;
    scene.skyAtmosphere.show = true;

    try {
      scene.skyAtmosphere.perFragmentAtmosphere = true;
      scene.skyAtmosphere.atmosphereRayleighCoefficient =
        new Cesium.Cartesian3(5.5e-6, 13.0e-6, 28.4e-6);
      scene.skyAtmosphere.atmosphereMieCoefficient =
        new Cesium.Cartesian3(2.1e-5, 2.1e-5, 2.1e-5);
      scene.skyAtmosphere.atmosphereMieAnisotropy      = 0.85;
      scene.skyAtmosphere.atmosphereRayleighScaleHeight = 10000.0;
      scene.skyAtmosphere.atmosphereMieScaleHeight      = 3200.0;
      scene.skyAtmosphere.atmosphereLightIntensity      = 15.0;
    } catch (e) {
      // Older Cesium builds safe fallback
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
    try { scene.globe.atmosphereLightIntensity = 15.0; } catch (_) {}
  }

  /* ─────────────────────────────────────────────────────────────────────────
     DAY / NIGHT CYCLE
  ───────────────────────────────────────────────────────────────────────── */

  _initClock() {
    const clock = this.viewer.clock;
    // Sync to current real-world time but keep paused until user enables
    clock.currentTime = Cesium.JulianDate.fromDate(new Date());
    clock.shouldAnimate = false;
    clock.multiplier    = 1;
    clock.clockStep     = Cesium.ClockStep.SYSTEM_CLOCK_MULTIPLIER;
  }

  /* ─────────────────────────────────────────────────────────────────────────
     NIGHT CITY LIGHTS (NASA Black Marble / Cesium Ion Asset 3812)
  ───────────────────────────────────────────────────────────────────────── */

  async _initNightLights() {
    const scene = this.viewer.scene;
    try {
      let nightProvider;
      try {
        // Cesium Ion Asset 3812 (Earth at Night / Black Marble)
        nightProvider = await Cesium.IonImageryProvider.fromAssetId(3812);
      } catch (e) {
        nightProvider = new Cesium.UrlTemplateImageryProvider({
          url: 'https://gibs.earthdata.nasa.gov/wmts/epsg4326/best/VIIRS_Black_Marble/default/2016-01-01/500m/{z}/{y}/{x}.png',
          credit: 'NASA Black Marble Night City Lights',
          maximumLevel: 8
        });
      }

      this._nightLightsLayer = this.viewer.imageryLayers.addImageryProvider(nightProvider);
      this._nightLightsLayer.alpha = 0.85;

      // Dynamic Day/Night fading: city lights glow brightly at night and fade out during daytime
      scene.preRender.addEventListener(() => {
        try {
          if (!this._nightLightsLayer) return;
          const clockTime = (this.viewer && this.viewer.clock) ? this.viewer.clock.currentTime : Cesium.JulianDate.now();
          if (Cesium.Simon1994PlanetaryPositions && this.viewer.camera) {
            const sunPos = Cesium.Simon1994PlanetaryPositions.computeSunPositionInEarthInertialFrame(clockTime);
            if (sunPos) {
              const cameraPosNorm = Cesium.Cartesian3.normalize(this.viewer.camera.position, new Cesium.Cartesian3());
              const sunNorm = Cesium.Cartesian3.normalize(sunPos, new Cesium.Cartesian3());
              const dot = Cesium.Cartesian3.dot(cameraPosNorm, sunNorm);

              // Fade in city lights as sun sets (dot < 0.25)
              if (dot < 0.25) {
                const nightFactor = Math.min(1.0, (0.25 - dot) / 0.5);
                this._nightLightsLayer.alpha = 0.85 * nightFactor;
                this._nightLightsLayer.show = true;
              } else {
                this._nightLightsLayer.show = false;
              }
            }
          }
        } catch (err) {}
      });
    } catch (err) {
      console.warn('[NightLights] Could not initialize night lights:', err);
    }
  }

  /**
   * Enable or disable the day/night cycle.
   * @param {boolean} enabled
   * @param {number}  [multiplier=1]  1 = realtime, 10 = 10×, 100 = 100×
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
   * Jump to a specific local hour (0–24) and pause the clock.
   * @param {number} hour  e.g. 6.5 = 06:30 local time
   */
  setManualHour(hour) {
    const date = new Date();
    date.setHours(Math.floor(hour), Math.round((hour % 1) * 60), 0, 0);
    this.viewer.clock.currentTime = Cesium.JulianDate.fromDate(date);
    this.viewer.clock.shouldAnimate = false;
  }

  /* ─────────────────────────────────────────────────────────────────────────
  /* ─────────────────────────────────────────────────────────────────────────
     MOVING VOLUMETRIC CLOUDS WITH SHADOW CASTING (Custom PNG Textures)
  ───────────────────────────────────────────────────────────────────────── */

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

    // Weather-aware clustering configuration
    let count = 40;
    let minAlt = 2000, maxAlt = 4000;
    let cloudColor = new Cesium.Color(1.0, 1.0, 1.0, 0.85);

    const code = this._currentWeatherCode;
    if (code === 0) {
      // Clear / Sunny: sparse high-altitude cirrus
      count = Math.round(8 + this._cloudDensity * 12);
      minAlt = 5000; maxAlt = 7500;
      cloudColor = new Cesium.Color(1.0, 1.0, 1.0, 0.45);
    } else if ([1, 2, 3].includes(code)) {
      // Partly Cloudy: medium scattered cumulus clusters
      count = Math.round(25 + this._cloudDensity * 55);
      minAlt = 2200; maxAlt = 4500;
      cloudColor = new Cesium.Color(0.98, 0.98, 1.0, 0.82);
    } else if ([45, 48, 80].includes(code)) {
      // Foggy / Overcast: dense multi-layered cloud strata
      count = Math.round(60 + this._cloudDensity * 70);
      minAlt = 1500; maxAlt = 3500;
      cloudColor = new Cesium.Color(0.85, 0.88, 0.92, 0.90);
    } else {
      // Rain / Snow / Thunderstorm: dense dark storm clouds
      count = Math.round(80 + this._cloudDensity * 80);
      minAlt = 1200; maxAlt = 2800;
      cloudColor = new Cesium.Color(0.35, 0.38, 0.45, 0.95);
    }

    for (let i = 0; i < count; i++) {
      const dLon = (Math.random() - 0.5) * 0.35;
      const dLat = (Math.random() - 0.5) * 0.35;
      const lon  = centerLon + dLon;
      const lat  = centerLat + dLat;
      const height = minAlt + Math.random() * (maxAlt - minAlt);

      const texturePath = this._cloudTextures[i % this._cloudTextures.length];
      const scaleFactor = 12.0 + Math.random() * 24.0; // Dynamic cluster scale

      try {
        const bb = this._cloudBillboardCollection.add({
          position: Cesium.Cartesian3.fromDegrees(lon, lat, height),
          image: texturePath,
          scale: scaleFactor,
          color: cloudColor,
          rotation: Math.random() * Math.PI * 2,
          alignedAxis: Cesium.Cartesian3.UNIT_Z
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
   * Set real-time weather conditions to dynamically cluster and tint clouds.
   */
  setWeatherCondition(weatherCode, windSpeed) {
    this._currentWeatherCode = weatherCode;
    if (windSpeed !== undefined && windSpeed > 0) {
      this._cloudWindSpeed = windSpeed;
    }
    if (this._cloudsEnabled) {
      this._spawnVolumetricClouds();
    }
  }

  /**
   * Toggle global satellite cloud imagery layer (Ion / NASA GIBS).
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
   */
  setClouds(enabled, density) {
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

  /* ─────────────────────────────────────────────────────────────────────────
     RAIN GLSL SHADER
  ───────────────────────────────────────────────────────────────────────── */

  _rainGLSL() {
    /* Uses Cesium WebGL2 / GLSL 300 es conventions:
       - `in vec2 v_textureCoordinates` instead of varying
       - `out_FragColor` instead of gl_FragColor
       - `texture()` instead of texture2D()                   */
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

  // Six depth layers — far streaks are thinner and faster
  for (float i = 0.0; i < 6.0; i++) {
    float spd    = 0.65 + i * 0.14;
    float scale  = 0.32 + i * 0.08;
    float slant  = -0.0018 * i;              // slight diagonal slant
    vec2  offset = vec2(slant * u_time + i * 0.13, u_time * spd * 0.22);

    vec2 cellSz  = vec2(0.009 * scale, 0.060 * scale);
    vec2 cell    = floor((uv + offset) / cellSz);
    vec2 r       = vec2(hash(cell), hash(cell + 7.3));
    vec2 pos     = fract((uv + offset) / cellSz) - vec2(r.x, 0.0);

    float streak = smoothstep(0.0018 * scale, 0.0, abs(pos.x - 0.0045 * scale))
                 * smoothstep(0.0,  0.003, pos.y)
                 * smoothstep(cellSz.y, cellSz.y * 0.82, pos.y);

    rain += streak * (0.35 + r.y * 0.65);
  }

  rain = clamp(rain * u_intensity * 2.2, 0.0, 1.0);

  // Wet-lens darkening at bottom of frame
  float wetLens = smoothstep(0.6, 0.0, uv.y) * 0.22 * u_intensity;

  vec3 wetColor = mix(col.rgb, vec3(0.70, 0.82, 1.00), rain * 0.45);
  wetColor      = wetColor * (1.0 - wetLens * 0.15);

  out_FragColor = vec4(wetColor, col.a);
}`;
  }

  /* ─────────────────────────────────────────────────────────────────────────
     SNOW GLSL SHADER
  ───────────────────────────────────────────────────────────────────────── */

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

  for (float i = 0.0; i < 5.0; i++) {
    float spd   = 0.028 + i * 0.010;
    float scale = 0.50  + i * 0.16;
    float drift = sin(u_time * 0.22 + i * 2.1) * 0.003 * scale;

    vec2  offset = vec2(drift + i * 0.09, u_time * spd);
    float cSz    = 0.026 * scale;
    vec2  cell   = floor((uv + offset) / cSz);
    vec2  r      = vec2(hash(cell), hash(cell + vec2(4.7, 2.1)));
    vec2  pos    = fract((uv + offset) / cSz) - 0.5 + (r - 0.5) * 0.60;

    float flake  = smoothstep(0.15 * scale, 0.0, length(pos) * (0.65 + r.x * 0.50));
    snow += flake * (0.45 + r.y * 0.55);
  }

  snow = clamp(snow * u_intensity * 1.9, 0.0, 0.95);

  // Blend towards white; add subtle cold blue tint to whole scene
  vec3 snowColor = mix(col.rgb, vec3(1.0, 1.0, 1.0), snow);
  snowColor      = mix(snowColor, snowColor * vec3(0.88, 0.94, 1.00),
                       0.20 * u_intensity);

  out_FragColor = vec4(snowColor, col.a);
}`;
  }

  /* ─────────────────────────────────────────────────────────────────────────
     PRECIPITATION CONTROL
  ───────────────────────────────────────────────────────────────────────── */

  /**
   * Set precipitation type and intensity.
   * @param {'none'|'rain'|'snow'} type
   * @param {number} [intensity=0.5]  0.0 – 1.0
   */
  setPrecipitation(type, intensity) {
    if (intensity !== undefined) this._precipIntensity = intensity;
    this._precipType = type;

    // Always remove both stages first
    if (this._rainStage) {
      this.viewer.scene.postProcessStages.remove(this._rainStage);
      this._rainStage = null;
    }
    if (this._snowStage) {
      this.viewer.scene.postProcessStages.remove(this._snowStage);
      this._snowStage = null;
    }

    if (type === 'rain') {
      this._rainStage = new Cesium.PostProcessStage({
        name: 'weatherRain',
        fragmentShader: this._rainGLSL(),
        uniforms: {
          // Dynamic functions: re-evaluated every frame automatically
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

  /** Update intensity without recreating the shader stage. */
  setPrecipitationIntensity(intensity) {
    this._precipIntensity = intensity;
    // Uniforms are closures — they read _precipIntensity automatically next frame
  }

  /* ─────────────────────────────────────────────────────────────────────────
     CLEANUP
  ───────────────────────────────────────────────────────────────────────── */

  destroy() {
    if (this._cloudCollection) {
      if (this._cloudMoveHandler)
        this.viewer.camera.moveEnd.removeEventListener(this._cloudMoveHandler);
      this.viewer.scene.primitives.remove(this._cloudCollection);
      this._cloudCollection = null;
    }
    if (this._rainStage) {
      this.viewer.scene.postProcessStages.remove(this._rainStage);
      this._rainStage = null;
    }
    if (this._snowStage) {
      this.viewer.scene.postProcessStages.remove(this._snowStage);
      this._snowStage = null;
    }
  }
}
