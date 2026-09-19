/**
 * flight.js — First-Person Flight Simulator Mode for CesiumJS
 *
 * Controls (active in Flight Mode):
 *   W / S       — Throttle up / down
 *   A / D       — Yaw left / right (turn)
 *   ↑ / ↓       — Pitch up / down
 *   Shift       — Speed boost (4×)
 *   Space       — Level out (auto-reset pitch)
 *   F / Esc     — Exit flight mode
 */

class FlightSystem {
  constructor(viewer) {
    this.viewer = viewer;

    // ── Flight state ──────────────────────────────────────────────────────
    this._active   = false;
    this._speed    = 150;   // m/s
    this._heading  = 0;     // radians
    this._pitch    = 0;     // radians (positive = nose up)
    this._roll     = 0;     // radians (cosmetic bank)
    this._minAlt   = 80;    // metres AGL floor
    this._prevAlt  = 0;
    this._lastTime = null;
    this._keys     = {};

    // Stored handlers for cleanup
    this._preRenderHandler = null;
    this._keyDownHandler   = null;
    this._keyUpHandler     = null;

    // Build the HUD once, hidden by default
    this._hudEl = null;
    this._buildHUD();
  }

  get active() { return this._active; }

  /* ─────────────────────────────────────────────────────────────────────────
     PUBLIC API
  ───────────────────────────────────────────────────────────────────────── */

  toggle() { this._active ? this.exit() : this.enter(); }

  enter() {
    if (this._active) return;

    const camera = this.viewer.camera;

    // Capture current camera orientation as starting state
    this._heading  = camera.heading;
    this._pitch    = Math.max(Math.min(camera.pitch, 0.3), -0.4);
    this._roll     = 0;
    this._speed    = 150;
    this._keys     = {};
    this._lastTime = null;
    this._prevAlt  = Cesium.Cartographic.fromCartesian(camera.position).height;

    // Disable all default navigation so we own the camera
    this._setNavEnabled(false);

    // Key listeners
    this._keyDownHandler = e => {
      this._keys[e.code] = true;
      if (e.code === 'Space')  { e.preventDefault(); this._pitch = 0; }
      if (e.code === 'Escape' || e.code === 'KeyF') this.exit();
    };
    this._keyUpHandler = e => { this._keys[e.code] = false; };
    document.addEventListener('keydown', this._keyDownHandler);
    document.addEventListener('keyup',   this._keyUpHandler);

    // Main flight loop — runs every frame via Cesium's preRender
    this._preRenderHandler = () => this._update();
    this.viewer.scene.preRender.addEventListener(this._preRenderHandler);

    // Show HUD
    this._hudEl.style.display = 'flex';
    this._active = true;

    this._dispatchChange();
    console.log('[FlightMode] Entered');
  }

  exit() {
    if (!this._active) return;

    this._setNavEnabled(true);

    document.removeEventListener('keydown', this._keyDownHandler);
    document.removeEventListener('keyup',   this._keyUpHandler);
    this.viewer.scene.preRender.removeEventListener(this._preRenderHandler);

    this._hudEl.style.display = 'none';
    this._active = false;
    this._keys   = {};

    this._dispatchChange();
    console.log('[FlightMode] Exited');
  }

  destroy() {
    this.exit();
    if (this._hudEl) this._hudEl.remove();
  }

  /* ─────────────────────────────────────────────────────────────────────────
     INTERNAL — FLIGHT LOOP
  ───────────────────────────────────────────────────────────────────────── */

  _update() {
    const camera = this.viewer.camera;
    const now    = performance.now();
    const dt     = this._lastTime ? Math.min((now - this._lastTime) / 1000, 0.05) : 1 / 60;
    this._lastTime = now;

    const boost = (this._keys['ShiftLeft'] || this._keys['ShiftRight']) ? 4 : 1;

    // ── Throttle ─────────────────────────────────────────────────
    if (this._keys['KeyW']) this._speed = Math.min(this._speed + 100 * dt, 2500);
    if (this._keys['KeyS']) this._speed = Math.max(this._speed - 100 * dt, 15);

    // ── Yaw ──────────────────────────────────────────────────────
    const yawRate = 0.90 * dt;
    if (this._keys['KeyA'] || this._keys['ArrowLeft'])  this._heading -= yawRate;
    if (this._keys['KeyD'] || this._keys['ArrowRight']) this._heading += yawRate;

    // ── Pitch ────────────────────────────────────────────────────
    const pitchRate = 0.75 * dt;
    if (this._keys['ArrowUp'])   this._pitch = Math.min(this._pitch + pitchRate,  0.45);
    if (this._keys['ArrowDown']) this._pitch = Math.max(this._pitch - pitchRate, -0.55);

    // Natural pitch decay — planes want to fly level
    if (!this._keys['ArrowUp'] && !this._keys['ArrowDown']) {
      this._pitch *= Math.pow(0.02, dt);   // exponential decay towards 0
    }

    // ── Cosmetic bank for turns ───────────────────────────────────
    let targetRoll = 0;
    if (this._keys['KeyA'] || this._keys['ArrowLeft'])  targetRoll = -0.25;
    if (this._keys['KeyD'] || this._keys['ArrowRight']) targetRoll =  0.25;
    this._roll += (targetRoll - this._roll) * Math.min(6.0 * dt, 1.0);

    // ── Apply orientation then move ───────────────────────────────
    camera.setView({
      orientation: {
        heading: this._heading,
        pitch:   this._pitch,
        roll:    this._roll
      }
    });

    const moveAmount = this._speed * boost * dt;
    camera.move(camera.direction, moveAmount);

    // ── Terrain floor ─────────────────────────────────────────────
    const carto = Cesium.Cartographic.fromCartesian(camera.position);
    if (carto.height < this._minAlt) {
      carto.height = this._minAlt;
      camera.position = Cesium.Ellipsoid.WGS84.cartographicToCartesian(carto);
      if (this._pitch < 0.05) this._pitch = 0.05;
    }

    // ── Update HUD ────────────────────────────────────────────────
    this._updateHUD(carto);
    this._prevAlt = carto.height;
  }

  /* ─────────────────────────────────────────────────────────────────────────
     INTERNAL — HUD
  ───────────────────────────────────────────────────────────────────────── */

  _buildHUD() {
    const hud = document.createElement('div');
    hud.id = 'flightHUD';
    hud.innerHTML = `
      <!-- Top: Compass / Heading tape -->
      <div class="hud-top">
        <div class="hud-compass-wrap">
          <div class="hud-compass-tape" id="hudTape"></div>
          <div class="hud-compass-pointer">▼</div>
          <div class="hud-hdg-box" id="hudHdgBox">000°</div>
        </div>
      </div>

      <!-- Middle: Left data · Horizon · Right data -->
      <div class="hud-middle">

        <div class="hud-side hud-left">
          <div class="hud-data-block">
            <div class="hud-lbl">SPD</div>
            <div class="hud-val" id="hudSpeed">---</div>
            <div class="hud-unit">kts</div>
          </div>
          <div class="hud-data-block" style="margin-top:14px">
            <div class="hud-lbl">MACH</div>
            <div class="hud-val hud-val-sm" id="hudMach">0.00</div>
          </div>
          <div class="hud-data-block" style="margin-top:14px">
            <div class="hud-lbl">THR</div>
            <div class="hud-thr-bar">
              <div class="hud-thr-fill" id="hudThrFill"></div>
            </div>
          </div>
        </div>

        <div class="hud-horizon-wrap" id="hudHorizonWrap">
          <!-- Pitch ladder (background) -->
          <div class="hud-pitch-ladder" id="hudLadder"></div>
          <!-- Horizon line (rotates for bank) -->
          <div class="hud-horizon-line" id="hudHorizonLine"></div>
          <!-- Fixed aircraft symbol -->
          <div class="hud-aircraft-symbol">
            <span>——</span>
            <span class="hud-dot">◆</span>
            <span>——</span>
          </div>
          <!-- Flight path vector marker -->
          <div class="hud-fpv" id="hudFPV">⊕</div>
        </div>

        <div class="hud-side hud-right">
          <div class="hud-data-block">
            <div class="hud-lbl">ALT</div>
            <div class="hud-val" id="hudAlt">---</div>
            <div class="hud-unit">m</div>
          </div>
          <div class="hud-data-block" style="margin-top:14px">
            <div class="hud-lbl">V/S</div>
            <div class="hud-val hud-val-sm" id="hudVS">+0</div>
            <div class="hud-unit">m/s</div>
          </div>
          <div class="hud-data-block" style="margin-top:14px">
            <div class="hud-lbl">AGL</div>
            <div class="hud-val hud-val-sm" id="hudAGL">---</div>
            <div class="hud-unit">m</div>
          </div>
        </div>

      </div>

      <!-- Bottom: Controls hint -->
      <div class="hud-bottom">
        <div class="hud-hint">
          <span><kbd>W</kbd><kbd>S</kbd> Throttle</span>
          <span><kbd>A</kbd><kbd>D</kbd> Turn</span>
          <span><kbd>↑↓</kbd> Pitch</span>
          <span><kbd>⇧</kbd> Boost</span>
          <span><kbd>Space</kbd> Level</span>
          <span><kbd>F</kbd><kbd>Esc</kbd> Exit</span>
        </div>
        <div class="hud-mode-tag">✈ FLIGHT MODE</div>
      </div>
    `;

    hud.style.display = 'none';
    document.body.appendChild(hud);
    this._hudEl = hud;

    // Pre-build pitch ladder lines
    this._buildPitchLadder();
  }

  _buildPitchLadder() {
    const ladder = document.getElementById('hudLadder');
    if (!ladder) return;
    let html = '';
    for (let deg = -30; deg <= 30; deg += 5) {
      if (deg === 0) continue;
      const isLong = deg % 10 === 0;
      const w = isLong ? 80 : 50;
      // Each degree of pitch ≈ 4px offset in the 200px tall horizon area
      const y = -deg * 4; // positive deg (up) → negative y (up on screen)
      html += `<div class="hud-ladder-line${isLong ? ' hud-ladder-major' : ''}"
                    style="width:${w}px;top:calc(50% + ${y}px)">
                 ${isLong ? `<span class="hud-ladder-lbl">${deg > 0 ? '+' : ''}${deg}</span>` : ''}
               </div>`;
    }
    ladder.innerHTML = html;
  }

  _updateHUD(carto) {
    const speedMS  = this._speed;
    const speedKts = (speedMS * 1.94384).toFixed(0);
    const mach     = (speedMS / 340.29).toFixed(2);
    const altM     = carto.height.toFixed(0);
    const hdgDeg   = Math.round((Cesium.Math.toDegrees(this._heading) + 360) % 360);
    const vs       = ((carto.height - this._prevAlt) / (this._lastTime ? Math.min((performance.now() - this._lastTime) / 1000, 0.05) : 0.016));
    const vsVal    = isFinite(vs) ? vs.toFixed(0) : '0';

    // Text readouts
    const el = id => document.getElementById(id);
    el('hudSpeed').textContent  = speedKts;
    el('hudMach').textContent   = mach;
    el('hudAlt').textContent    = parseFloat(altM).toLocaleString();
    el('hudVS').textContent     = (vs > 0 ? '+' : '') + vsVal;
    el('hudAGL').textContent    = Math.max(0, carto.height - 0).toFixed(0);
    el('hudHdgBox').textContent = String(hdgDeg).padStart(3, '0') + '°';

    // Throttle bar
    const thrPct = Math.min(speedMS / 2500, 1);
    const thrFill = el('hudThrFill');
    if (thrFill) {
      thrFill.style.width = (thrPct * 100).toFixed(1) + '%';
      thrFill.style.background = thrPct > 0.75
        ? 'linear-gradient(90deg,#00e5ff,#ff4444)'
        : 'linear-gradient(90deg,#00e5ff,#22d3ee)';
    }

    // Horizon line — rotates with bank, shifts with pitch
    const rollDeg  = Cesium.Math.toDegrees(this._roll);
    const pitchPx  = Cesium.Math.toDegrees(this._pitch) * 4;
    const hLine = el('hudHorizonLine');
    if (hLine) {
      hLine.style.transform = `translateY(${-pitchPx}px) rotate(${rollDeg}deg)`;
    }

    // Pitch ladder shifts opposite to horizon
    const ladder = el('hudLadder');
    if (ladder) {
      ladder.style.transform = `translateY(${-pitchPx}px) rotate(${rollDeg}deg)`;
    }

    // Flight path vector — shows actual flight path angle
    const fpv = el('hudFPV');
    if (fpv) {
      const fpvPx = -pitchPx * 0.5;
      fpv.style.transform = `translateY(${fpvPx}px)`;
    }

    // Compass tape
    this._updateCompassTape(hdgDeg);
  }

  _updateCompassTape(hdgDeg) {
    const tape = document.getElementById('hudTape');
    if (!tape) return;

    const DIRS = { 0: 'N', 45: 'NE', 90: 'E', 135: 'SE',
                   180: 'S', 225: 'SW', 270: 'W', 315: 'NW' };
    let html = '';
    for (let i = hdgDeg - 40; i <= hdgDeg + 40; i++) {
      const d    = ((i % 360) + 360) % 360;
      const off  = (i - hdgDeg) * 5;   // 5 px per degree
      if (d % 5 !== 0) continue;
      const lbl  = DIRS[d] !== undefined ? DIRS[d] : (d % 10 === 0 ? d : '│');
      const big  = DIRS[d] !== undefined || d % 10 === 0;
      html += `<span class="hud-tape-mark${big ? ' hud-tape-major' : ''}"
                     style="left:calc(50% + ${off}px)">${lbl}</span>`;
    }
    tape.innerHTML = html;
  }

  /* ─────────────────────────────────────────────────────────────────────────
     HELPERS
  ───────────────────────────────────────────────────────────────────────── */

  _setNavEnabled(on) {
    const ctrl = this.viewer.scene.screenSpaceCameraController;
    ctrl.enableRotate    = on;
    ctrl.enableTranslate = on;
    ctrl.enableZoom      = on;
    ctrl.enableTilt      = on;
    ctrl.enableLook      = on;
  }

  _dispatchChange() {
    window.dispatchEvent(new CustomEvent('flightModeChange', {
      detail: { active: this._active }
    }));
  }
}
