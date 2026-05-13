// Otuburu demo server.
// Express REST API + WebSocket fan-out for the live dashboard.

const path = require('path');
const http = require('http');
const express = require('express');
const { WebSocketServer } = require('ws');

const feeds = require('./generators');
const engine = require('./engine');

const PORT = process.env.PORT || 8080;
const app = express();
app.use(express.json());
app.use(express.static(path.join(__dirname, '..', 'web')));

// --- REST ---
app.get('/api/symbols', (_, res) => res.json({ symbols: feeds.symbols() }));
app.get('/api/state', (_, res) => res.json(engine.snapshot()));

app.post('/api/order', (req, res) => {
  const { symbol, side, lots } = req.body || {};
  const result = engine.placeCfdOrder({ symbol, side, lots: Number(lots) });
  if (result.error) return res.status(400).json(result);
  res.json(result);
});

app.post('/api/close', (req, res) => {
  const { id } = req.body || {};
  const result = engine.closeCfd(Number(id));
  if (result.error) return res.status(400).json(result);
  res.json(result);
});

app.post('/api/binary', (req, res) => {
  const { symbol, direction, stake, ticks } = req.body || {};
  const result = engine.placeBinary({
    symbol, direction,
    stake: Number(stake),
    ticks: Number(ticks),
  });
  if (result.error) return res.status(400).json(result);
  res.json(result);
});

// --- HTTP + WebSocket server ---
const server = http.createServer(app);
const wss = new WebSocketServer({ server, path: '/ws' });

function broadcast(payload) {
  const msg = JSON.stringify(payload);
  for (const client of wss.clients) {
    if (client.readyState === 1) client.send(msg);
  }
}

engine.bus.on('tick', (t) => broadcast({ type: 'tick', tick: t }));
engine.bus.on('position-open', (p) => broadcast({ type: 'position-open', position: p }));
engine.bus.on('position-close', (p) => broadcast({ type: 'position-close', position: p }));
engine.bus.on('binary-open', (b) => broadcast({ type: 'binary-open', binary: b }));
engine.bus.on('binary-settled', (b) => broadcast({ type: 'binary-settled', binary: b }));

// State pulse every 500ms (cheap, single-account demo).
setInterval(() => broadcast({ type: 'state', state: engine.snapshot() }), 500);

wss.on('connection', (ws) => {
  ws.send(JSON.stringify({ type: 'hello', symbols: feeds.symbols() }));
  ws.send(JSON.stringify({ type: 'state', state: engine.snapshot() }));
});

feeds.start();
server.listen(PORT, () => {
  console.log('Otuburu demo running on http://localhost:' + PORT);
  console.log('Symbols:', feeds.symbols().join(', '));
});
