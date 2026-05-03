const express = require('express');
const path = require('path');

const app = express();
const APP_HTML = 'alabama-wholesale-v9.html';

app.get('/', (_req, res) => {
  res.sendFile(path.join(__dirname, APP_HTML));
});

app.use(express.static(__dirname, { extensions: ['html'] }));

app.get('/healthz', (_req, res) => res.status(200).send('ok'));

const PORT = process.env.PORT || 8080;
app.listen(PORT, () => {
  console.log(`Alabama Wholesale listening on :${PORT}`);
});
