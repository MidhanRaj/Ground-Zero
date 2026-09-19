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
    this._cloudCollection     = null;
    this._cloudMoveHandler    = null;
    this._rainStage           = null;
    this._snowStage           = null;
    this._cloudsEnabled       = false;
    this._cloudDensity        = 0.5;
    this._precipType          = 'none';
    this._precipIntensity     = 0.5;
    this._dayNightEnabled     = false;
    this._timeMultiplier      = 1;

    this._initSky();
    this._initClock();
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
      if (!scene.skyBox) return;
      const cameraPos = scene.camera.positionCartographic;
      if (cameraPos && cameraPos.height < 150000) {
        // Below 150km: check if camera location is illuminated by the sun
        const currentTime = (this.viewer && this.viewer.clock) ? this.viewer.clock.currentTime : Cesium.JulianDate.now();
        const sunPos = Cesium.Simon1994PlanetaryPositions.computeSunPositionInEarthInertialFrame(currentTime);
        if (sunPos) {
          const normal = Cesium.Cartesian3.normalize(scene.camera.position, new Cesium.Cartesian3());
          const sunNormal = Cesium.Cartesian3.normalize(sunPos, new Cesium.Cartesian3());
          const dot = Cesium.Cartesian3.dot(normal, sunNormal);
          scene.skyBox.show = dot < -0.05; // Hide stars on sunlit daytime side
        }
      } else {
        scene.skyBox.show = true; // Always show stars in deep space
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
     PROCEDURAL CLOUDS
  ───────────────────────────────────────────────────────────────────────── */

  _spawnClouds() {
    if (!this._cloudCollection) return;
    this._cloudCollection.removeAll();

    const cart  = this.viewer.camera.positionCartographic;
    const lat   = Cesium.Math.toDegrees(cart.latitude);
    const lon   = Cesium.Math.toDegrees(cart.longitude);
    const count = Math.round(15 + this._cloudDensity * 120);

    for (let i = 0; i < count; i++) {
      const dLon   = (Math.random() - 0.5) * 4.5;
      const dLat   = (Math.random() - 0.5) * 4.5;
      const alt    = 1800 + Math.random() * 3200;
      const w      = 1200 + Math.random() * 4500;
      const bright = 0.85 + Math.random() * 0.15;

      try {
        this._cloudCollection.add({
          position:    Cesium.Cartesian3.fromDegrees(lon + dLon, lat + dLat, alt),
          scale:       new Cesium.Cartesian2(w, w * 0.35),
          maximumSize: new Cesium.Cartesian3(w * 0.6, w * 0.2, w * 0.35),
          slice:       0.2 + Math.random() * 0.6,
          brightness:  bright
        });
      } catch (e) {
        break;
      }
    }
  }

  /**
   * Toggle clouds on/off and optionally set density.
   * @param {boolean} enabled
   * @param {number}  [density=0.5]  0.0 – 1.0
   */
  setClouds(enabled, density) {
    this._cloudsEnabled = enabled;
    if (density !== undefined) this._cloudDensity = density;

    if (enabled) {
      if (typeof Cesium.CloudCollection === 'undefined') {
        console.warn('[WeatherSystem] CloudCollection not available in this Cesium version.');
        return;
      }

      if (!this._cloudCollection) {
        this._cloudCollection = new Cesium.CloudCollection({ show: true });
        this.viewer.scene.primitives.add(this._cloudCollection);

        // Refresh cloud field when user pans to a new area
        this._cloudMoveHandler = () => {
          if (this._cloudsEnabled) this._spawnClouds();
        };
        this.viewer.camera.moveEnd.addEventListener(this._cloudMoveHandler);
      }

      this._cloudCollection.show = true;
      this._spawnClouds();
    } else {
      if (this._cloudCollection) this._cloudCollection.show = false;
    }
  }

  /** Update cloud density while clouds are visible. */
  setCloudDensity(density) {
    this._cloudDensity = density;
    if (this._cloudsEnabled && this._cloudCollection) this._spawnClouds();
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
