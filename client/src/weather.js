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
   * Set real-time weather conditions to dynamically cluster and tint clouds
   * AND auto-drive 3D precipitation from the WMO weather code.
   */
  setWeatherCondition(weatherCode, windSpeed) {
    this._currentWeatherCode = weatherCode;
    if (windSpeed !== undefined && windSpeed > 0) {
      this._cloudWindSpeed = windSpeed;
    }

    // ── Auto-clouds based on weather code ──────────────────────────────────
    // Any weather other than clear auto-enables clouds
    const cloudCodes = [1, 2, 3, 45, 48, 51, 53, 55, 56, 57,
                        61, 63, 65, 66, 67, 71, 73, 75, 77,
                        80, 81, 82, 85, 86, 95, 96, 99];
    const shouldHaveClouds = cloudCodes.includes(weatherCode);

    // If clouds were manually enabled leave them on; if weather demands them, turn on too
    if (shouldHaveClouds && !this._cloudsEnabled) {
      this._cloudsEnabled = true;
      if (this._cloudBillboardCollection) this._cloudBillboardCollection.show = true;
    } else if (!shouldHaveClouds && this._cloudsEnabled && !this._cloudsManuallyEnabled) {
      this._cloudsEnabled = false;
      if (this._cloudBillboardCollection) this._cloudBillboardCollection.show = false;
    }

    if (this._cloudsEnabled) {
      this._spawnVolumetricClouds();
    }

    // ── Auto-precipitation from weather code ───────────────────────────────
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
      this._set3DPrecipitation(autoType, autoIntensity);
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

  /* ─────────────────────────────────────────────────────────────────────────
     3D PARTICLE SYSTEM — RAIN & SNOW IN WORLD SPACE
  ───────────────────────────────────────────────────────────────────────── */

  /**
   * Destroy all active precipitation particle systems.
   */
  _clearPrecip() {
    if (this._precipPrimitive) {
      try { this.viewer.scene.primitives.remove(this._precipPrimitive); } catch (_) {}
      this._precipPrimitive = null;
    }
    // Legacy GLSL stages (in case old code path left them)
    if (this._rainStage) {
      try { this.viewer.scene.postProcessStages.remove(this._rainStage); } catch (_) {}
      this._rainStage = null;
    }
    if (this._snowStage) {
      try { this.viewer.scene.postProcessStages.remove(this._snowStage); } catch (_) {}
      this._snowStage = null;
    }
  }

  /**
   * Build a 1×1 white pixel data URI for use as the particle image.
   */
  _makeParticleImage(r, g, b, a) {
    const c = document.createElement('canvas');
    c.width = 8; c.height = 8;
    const ctx = c.getContext('2d');
    ctx.clearRect(0, 0, 8, 8);
    ctx.fillStyle = `rgba(${r},${g},${b},${a})`;
    // Rain: vertical thin line; Snow: soft dot
    if (this._precipType === 'rain') {
      ctx.fillRect(3, 0, 2, 8);
    } else {
      ctx.beginPath();
      ctx.arc(4, 4, 3.5, 0, Math.PI * 2);
      ctx.fill();
    }
    return c.toDataURL();
  }

  /**
   * Build a 3D Cesium ParticleSystem for rain or snow placed around the camera.
   * @param {'rain'|'snow'} type
   * @param {number} intensity  0..1
   */
  _build3DParticleSystem(type, intensity) {
    const scene  = this.viewer.scene;
    const camera = this.viewer.camera;

    // Spread box half-size and fall height above camera
    const spread   = 4000;   // ±4 km around camera (XY)
    const fallFrom = 1800;   // particles start 1800 m above camera
    const fallTo   = -200;   // fall 200 m below camera

    let emissionRate, speed, sizeMin, sizeMax, lifeMin, lifeMax, color;

    if (type === 'rain') {
      emissionRate = Math.round(300 + intensity * 900); // 300–1200 particles/s
      speed        = 60 + intensity * 60;               // 60–120 m/s downward
      sizeMin      = 1.5;  sizeMax = 3.0;
      lifeMin      = (fallFrom - fallTo) / (speed + 60);
      lifeMax      = lifeMin * 1.3;
      color        = new Cesium.Color(0.75, 0.88, 1.0, 0.55 + intensity * 0.30);
    } else { // snow
      emissionRate = Math.round(60 + intensity * 140);  // 60–200 particles/s (much less dense)
      speed        = 4 + intensity * 8;                 // 4–12 m/s gentle fall
      sizeMin      = 4;    sizeMax = 9;
      lifeMin      = (fallFrom - fallTo) / (speed + 5);
      lifeMax      = lifeMin * 1.8;
      color        = new Cesium.Color(1.0, 1.0, 1.0, 0.75);
    }

    // Build particle image canvas
    const canvas = document.createElement('canvas');
    canvas.width = 16; canvas.height = (type === 'rain') ? 24 : 16;
    const ctx = canvas.getContext('2d');
    ctx.clearRect(0, 0, canvas.width, canvas.height);

    if (type === 'rain') {
      // Thin vertical elongated streak
      const grad = ctx.createLinearGradient(0, 0, 0, canvas.height);
      grad.addColorStop(0, 'rgba(180,220,255,0)');
      grad.addColorStop(0.2, 'rgba(180,220,255,0.85)');
      grad.addColorStop(1, 'rgba(180,220,255,0)');
      ctx.fillStyle = grad;
      ctx.fillRect(6, 0, 4, canvas.height);
    } else {
      // Soft radial snow flake dot
      const grad = ctx.createRadialGradient(8, 8, 0, 8, 8, 7);
      grad.addColorStop(0,   'rgba(255,255,255,1)');
      grad.addColorStop(0.5, 'rgba(220,235,255,0.75)');
      grad.addColorStop(1,   'rgba(200,220,255,0)');
      ctx.fillStyle = grad;
      ctx.beginPath();
      ctx.arc(8, 8, 7, 0, Math.PI * 2);
      ctx.fill();
    }
    const imageUrl = canvas.toDataURL();

    // Emitter at camera position + fallFrom meters altitude
    const camPos  = camera.positionCartographic;
    if (!camPos) return null;

    const emitPos = Cesium.Cartesian3.fromRadians(
      camPos.longitude, camPos.latitude,
      camPos.height + fallFrom
    );

    // Gravity-aligned direction vectors (down relative to Earth surface at camera)
    // Use Cesium's east-north-up frame to get the "down" vector
    const enu    = Cesium.Transforms.eastNorthUpToFixedFrame(emitPos);
    const downEC = new Cesium.Cartesian3(-enu[8], -enu[9], -enu[10]); // -Z column = down
    Cesium.Cartesian3.normalize(downEC, downEC);

    // Box emitter — spread particles in a horizontal slab above camera
    const particleSystem = new Cesium.ParticleSystem({
      image: imageUrl,
      color: color,
      startColor: color,
      endColor:   new Cesium.Color(color.red, color.green, color.blue, 0.0),

      startScale: 1.0,
      endScale:   1.0,

      minimumParticleLife: Math.max(lifeMin, 2),
      maximumParticleLife: Math.max(lifeMax, 4),

      minimumMass: 0.1,
      maximumMass: 0.2,

      minimumSpeed: speed * 0.8,
      maximumSpeed: speed * 1.2,

      imageSize: new Cesium.Cartesian2(sizeMin, sizeMax),

      emissionRate: emissionRate,

      // Box emitter for wide horizontal spread
      emitter: new Cesium.BoxEmitter(new Cesium.Cartesian3(spread, spread, 200)),

      // Place emitter at the altitude slab above camera
      modelMatrix: Cesium.Transforms.eastNorthUpToFixedFrame(emitPos),

      // Emit particles downward with slight horizontal drift for snow
      emitterModelMatrix: Cesium.Matrix4.fromRotationTranslation(
        Cesium.Matrix3.IDENTITY,
        Cesium.Cartesian3.ZERO
      ),

      // Gravity-like acceleration — world-space down vector
      // Cesium ParticleSystem uses local gravity via accelerations
      lifetime: 1e9, // run forever
      loop: true,

      // Gravity acceleration in local ENU: -Z is down (negative up)
      forces: [
        type === 'snow'
          ? function(particle) {
              // Gentle downward + slight swirl
              const t = performance.now() / 1000;
              particle.velocity.x += Math.sin(t * 0.5 + particle.position.x * 0.0001) * 0.04;
              particle.velocity.y += Math.cos(t * 0.4 + particle.position.y * 0.0001) * 0.04;
              particle.velocity.z -= 0.5; // gentle down
            }
          : function(particle) {
              particle.velocity.z -= 9.8 * 0.016; // rain: gravity each frame
            }
      ]
    });

    return particleSystem;
  }

  /**
   * Internal: set 3D precipitation type + intensity, manage particle systems.
   * @param {'none'|'rain'|'snow'} type
   * @param {number} [intensity=0.5]
   */
  _set3DPrecipitation(type, intensity) {
    if (intensity !== undefined) this._precipIntensity = intensity;
    this._precipType = type;

    this._clearPrecip();

    if (type === 'none') return;

    try {
      const ps = this._build3DParticleSystem(type, this._precipIntensity);
      if (ps) {
        this._precipPrimitive = this.viewer.scene.primitives.add(ps);

        // Follow camera: re-anchor particle emitter as camera moves
        this._precipCameraListener = () => {
          if (!this._precipPrimitive) return;
          try {
            const cam = this.viewer.camera.positionCartographic;
            if (!cam) return;
            const fallFrom = 1800;
            const newPos = Cesium.Cartesian3.fromRadians(
              cam.longitude, cam.latitude, cam.height + fallFrom
            );
            this._precipPrimitive.modelMatrix =
              Cesium.Transforms.eastNorthUpToFixedFrame(newPos);
          } catch (_) {}
        };
        this.viewer.camera.moveEnd.addEventListener(this._precipCameraListener);
      }
    } catch (e) {
      console.warn('[Weather] Could not create 3D particle precipitation:', e);
    }
  }

  /**
   * Public: manually set precipitation type and intensity.
   * Marks as manually set so weather auto-drive won't override it.
   * @param {'none'|'rain'|'snow'} type
   * @param {number} [intensity=0.5]  0.0 – 1.0
   */
  setPrecipitation(type, intensity) {
    this._precipManual = (type !== 'none');
    this._set3DPrecipitation(type, intensity);
  }

  /** Update intensity without recreating the particle system. */
  setPrecipitationIntensity(intensity) {
    this._precipIntensity = intensity;
    // Recreate with new intensity for particle systems (emission rate changes)
    if (this._precipType && this._precipType !== 'none') {
      this._set3DPrecipitation(this._precipType, intensity);
    }
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
    this._clearPrecip();
    if (this._precipCameraListener) {
      this.viewer.camera.moveEnd.removeEventListener(this._precipCameraListener);
    }
  }
}

