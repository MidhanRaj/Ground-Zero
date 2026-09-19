const express = require('express');
const path    = require('path');
const https   = require('https');

const app  = express();
const PORT = process.env.PORT || 3000;

// Enable CORS
app.use((req, res, next) => {
  res.header('Access-Control-Allow-Origin', '*');
  res.header('Access-Control-Allow-Headers', 'Origin, X-Requested-With, Content-Type, Accept');
  next();
});

// Serve CesiumJS build files
app.use('/Cesium', express.static(path.join(__dirname, 'node_modules/cesium/Build/Cesium')));

// Serve processed data outputs
app.use('/data', express.static(path.join(__dirname, '../data'), {
  setHeaders: (res, filepath) => {
    if (filepath.endsWith('.bin')) {
      res.setHeader('Content-Type', 'application/octet-stream');
    }
  }
}));

// ── Satellite Tile Proxy ─────────────────────────────────────────────────────
// Proxies ESRI World Imagery tiles so the browser can sample them via canvas
// without CORS errors. Tiles are cached by the browser for 24 hours.
// Source: ESRI World Imagery (free, no API key required)
app.get('/tileproxy/:z/:y/:x', (req, res) => {
  const { z, y, x } = req.params;
  if (!/^\d+$/.test(z) || !/^\d+$/.test(y) || !/^\d+$/.test(x)) {
    return res.status(400).send('Invalid tile coordinates');
  }
  const url = `https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/${z}/${y}/${x}`;
  const proxyReq = https.get(url, (tileRes) => {
    res.setHeader('Content-Type', 'image/jpeg');
    res.setHeader('Cache-Control', 'public, max-age=86400'); // 24h browser cache
    res.setHeader('Access-Control-Allow-Origin', '*');
    tileRes.pipe(res);
  });
  proxyReq.on('error', (e) => {
    console.error('[TileProxy] Error:', e.message);
    res.status(502).send('Tile fetch failed');
  });
  proxyReq.setTimeout(8000, () => {
    proxyReq.destroy();
    res.status(504).send('Tile timeout');
  });
});

// Serve static client assets
app.use(express.static(__dirname));

app.get('/', (req, res) => {
  res.sendFile(path.join(__dirname, 'index.html'));
});

app.listen(PORT, () => {
  console.log(`\n==================================================`);
  console.log(` TERRAIN VIEWER CLIENT SERVER RUNNING`);
  console.log(` URL: http://localhost:${PORT}`);
  console.log(` Tile proxy: http://localhost:${PORT}/tileproxy/{z}/{y}/{x}`);
  console.log(`==================================================\n`);
});

