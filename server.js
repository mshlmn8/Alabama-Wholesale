const express = require('express');
const path = require('path');

const app = express();
const APP_HTML = 'alabama-wholesale-v9.html';

// The service worker has to bypass the browser's HTTP cache so updated
// builds can ship. Send no-store and the SW MIME type explicitly.
app.get('/service-worker.js', (_req, res) => {
  res.set('Cache-Control', 'no-store, no-cache, must-revalidate');
  res.set('Service-Worker-Allowed', '/');
  res.type('application/javascript');
  res.sendFile(path.join(__dirname, 'service-worker.js'));
});

app.get('/', (_req, res) => {
  res.sendFile(path.join(__dirname, APP_HTML));
});

// Long-cache static assets (images, fonts, etc.). The service worker layers
// on top of this for offline.
app.use(express.static(__dirname, {
  extensions: ['html'],
  setHeaders: (res, filePath) => {
    if (filePath.includes(`${path.sep}images${path.sep}`)) {
      res.set('Cache-Control', 'public, max-age=31536000, immutable');
    }
  }
}));

app.get('/healthz', (_req, res) => res.status(200).send('ok'));

const PORT = process.env.PORT || 8080;
app.listen(PORT, () => {
  console.log(`Alabama Wholesale listening on :${PORT}`);
});
