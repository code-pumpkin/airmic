// relay.js — runs on a VPS, brokers WSS between desktop host and phone clients
// Desktop connects outbound as 'host', phones connect as 'client'
// All traffic is end-to-end encrypted via WSS (TLS)

const https   = require('https');
const fs      = require('fs');
const path    = require('path');
const crypto  = require('crypto');
const WebSocket = require('ws');
const express = require('express');

const PORT         = process.env.PORT         || 4001;
const CERT_DIR     = process.env.CERT_DIR     || path.join(__dirname, 'certs');
const PUBLIC       = process.env.PUBLIC       || path.join(__dirname, 'public');
const RELAY_SECRET = process.env.RELAY_SECRET || '';
const MAX_CLIENTS  = parseInt(process.env.MAX_CLIENTS || '10', 10);
const PING_MS      = 25000;
const PING_TTL     = 10000;
const REG_TIMEOUT  = 8000;
const RATE_WINDOW  = 60000; // 1 minute window
const RATE_MAX     = 20;    // max connections per IP per window
const TOKEN_RE     = /^[a-f0-9]{8,64}$/; // valid urlToken format

// ─── Rate limiter ─────────────────────────────────────────────────────────────
// ip → { count, resetAt }
const ipRates = new Map();

function checkRate(ip) {
  const now  = Date.now();
  const entry = ipRates.get(ip) || { count: 0, resetAt: now + RATE_WINDOW };
  if (now > entry.resetAt) { entry.count = 0; entry.resetAt = now + RATE_WINDOW; }
  entry.count++;
  ipRates.set(ip, entry);
  return entry.count <= RATE_MAX;
}

// clean up stale rate entries every 5 minutes
setInterval(() => {
  const now = Date.now();
  ipRates.forEach((v, k) => { if (now > v.resetAt) ipRates.delete(k); });
}, 300000);

const MAX_MSG_BYTES = 64 * 1024; // 64 KB max message size

// ─── Rooms ────────────────────────────────────────────────────────────────────
// token → { host: ws|null, clients: Map<clientId, ws> }
const rooms = new Map();

function getRoom(token) {
  if (!rooms.has(token)) rooms.set(token, { host: null, clients: new Map() });
  return rooms.get(token);
}

function cleanRoom(token) {
  const room = rooms.get(token);
  if (!room) return;
  if (!room.host && room.clients.size === 0) rooms.delete(token);
}

// ─── HTTP ─────────────────────────────────────────────────────────────────────
const app = express();

// ─── Security headers ─────────────────────────────────────────────────────────
app.use((req, res, next) => {
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('X-Frame-Options', 'DENY');
  res.setHeader('Referrer-Policy', 'no-referrer');
  next();
});

// Cache index.html in memory — read once, serve forever (restart relay to pick up changes)
let indexHtmlCache = null;
function getIndexHtml() {
  if (indexHtmlCache !== null) return indexHtmlCache;
  const html = path.join(PUBLIC, 'index.html');
  if (!fs.existsSync(html)) return null;
  indexHtmlCache = fs.readFileSync(html, 'utf8');
  return indexHtmlCache;
}

app.get('/health', (req, res) => {
  // Require secret if one is configured — Bearer token or ?secret= query param
  if (RELAY_SECRET) {
    const auth = req.headers.authorization || '';
    const bearer = auth.startsWith('Bearer ') ? auth.slice(7) : null;
    const query  = req.query.secret || null;
    if (bearer !== RELAY_SECRET && query !== RELAY_SECRET) {
      res.status(401).json({ error: 'unauthorized' });
      return;
    }
  }
  const roomStats = [];
  rooms.forEach((room, token) => {
    roomStats.push({ token: token.slice(0,8) + '…', host: !!room.host, clients: room.clients.size });
  });
  res.json({ status: 'ok', uptime: process.uptime(), rooms: roomStats });
});

// Serve index.html with injected RELAY_TOKEN so phone knows it's in relay mode
app.get('/:token', (req, res) => {
  // Validate token format before injecting into HTML to prevent XSS
  if (!TOKEN_RE.test(req.params.token)) {
    res.status(400).send('Invalid token');
    return;
  }
  const content = getIndexHtml();
  if (!content) {
    res.status(503).send('index.html not found — copy public/ next to relay.js on the VPS');
    return;
  }
  const injected = content.replace('</head>', `<script>window.RELAY_TOKEN="${req.params.token}";</script>\n</head>`);
  res.setHeader('Content-Type', 'text/html');
  res.send(injected);
});
app.get('/{*path}', (req, res) => res.status(403).send('Forbidden'));

// ─── HTTPS server ─────────────────────────────────────────────────────────────
let serverOpts;
try {
  serverOpts = {
    key:  fs.readFileSync(path.join(CERT_DIR, 'key.pem')),
    cert: fs.readFileSync(path.join(CERT_DIR, 'cert.pem')),
  };
} catch {
  console.error('[relay] ERROR: certs/key.pem or certs/cert.pem not found.');
  console.error('[relay] Run:  bash gen-cert.sh   (self-signed, for testing)');
  console.error('[relay] Or install a Let\'s Encrypt cert and point CERT_DIR at it.');
  process.exit(1);
}

const server = https.createServer(serverOpts, app);
const wss    = new WebSocket.Server({ server, maxPayload: 64 * 1024 }); // 64KB max frame

// ─── Keepalive ────────────────────────────────────────────────────────────────
function startKeepalive(ws) {
  ws.isAlive = true;
  ws.on('pong', () => { ws.isAlive = true; });

  const timer = setInterval(() => {
    if (!ws.isAlive) {
      clearInterval(timer);
      ws.terminate();
      return;
    }
    ws.isAlive = false;
    ws.ping();
    // if pong doesn't arrive within TTL, terminate
    ws._pongTimeout = setTimeout(() => {
      if (!ws.isAlive) ws.terminate();
    }, PING_TTL);
  }, PING_MS);

  ws.on('pong', () => { clearTimeout(ws._pongTimeout); });
  ws.on('close', () => { clearInterval(timer); clearTimeout(ws._pongTimeout); });
}

// ─── WebSocket broker ─────────────────────────────────────────────────────────
wss.on('connection', (ws, req) => {
  const ip = req.socket.remoteAddress || 'unknown';
  if (!checkRate(ip)) {
    safeSend(ws, { type: 'error', reason: 'rate-limited' });
    ws.terminate();
    log(`rate-limited  ip=${ip}`);
    return;
  }

  startKeepalive(ws);
  let role = null, token = null, clientId = null;

  // drop unregistered connections that never send a first message
  const regTimer = setTimeout(() => {
    if (!role) { ws.terminate(); log('dropped unregistered socket (timeout)'); }
  }, REG_TIMEOUT);
  ws.on('close', () => clearTimeout(regTimer));

  ws.on('message', (data) => {
    if (data.length > MAX_MSG_BYTES) { ws.terminate(); log(`oversized message from ${role || 'unregistered'} — terminated`); return; }
    let msg;
    try { msg = JSON.parse(data.toString()); } catch { return; }
    if (!msg || typeof msg !== 'object' || Array.isArray(msg)) return;

    // ── First message must be a registration ──
    if (!role) {
      clearTimeout(regTimer);
      if (!msg.token || !TOKEN_RE.test(msg.token)) { ws.close(); return; }
      token = msg.token;
      const room = getRoom(token);

      if (msg.type === 'host-register') {
        if (RELAY_SECRET && (typeof msg.secret !== 'string' || msg.secret !== RELAY_SECRET)) {
          safeSend(ws, { type: 'error', reason: 'bad-secret' });
          ws.close();
          log(`host rejected — bad secret  token=${token.slice(0,8)}…`);
          return;
        }
        if (room.host && room.host !== ws) { try { room.host.terminate(); } catch {} }
        role = 'host';
        room.host = ws;
        safeSend(ws, { type: 'registered' });
        log(`host registered   token=${token.slice(0,8)}…`);
        room.clients.forEach((_, cid) => safeSend(ws, { type: 'client-connect', clientId: cid }));
        return;
      }

      if (msg.type === 'client-connect') {
        if (room.clients.size >= MAX_CLIENTS) {
          safeSend(ws, { type: 'error', reason: 'room-full' });
          ws.close();
          log(`client rejected — room full  token=${token.slice(0,8)}…`);
          return;
        }
        role     = 'client';
        clientId = crypto.randomBytes(6).toString('hex');
        room.clients.set(clientId, ws);
        if (room.host && room.host.readyState === WebSocket.OPEN) {
          safeSend(ws, { type: 'connected', clientId });
          safeSend(room.host, { type: 'client-connect', clientId });
        } else {
          safeSend(ws, { type: 'error', reason: 'host-unavailable' });
          room.clients.delete(clientId);
          ws.close();
        }
        log(`client connected  id=${clientId}  token=${token.slice(0,8)}…`);
        return;
      }

      ws.close(); return;
    }

    // ── Client → Host forwarding ──
    if (role === 'client') {
      const room = getRoom(token);
      safeSend(room.host, JSON.stringify({ type: 'client-message', clientId, data: data.toString() }));
      return;
    }

    // ── Host → Client forwarding ──
    if (role === 'host') {
      const room = getRoom(token);
      if (typeof msg.clientId !== 'string' || !/^[a-f0-9]{12}$/.test(msg.clientId)) return;
      if (msg.type === 'host-message') {
        const client = room.clients.get(msg.clientId);
        if (typeof msg.data === 'string') safeSend(client, msg.data);
      } else if (msg.type === 'host-close') {
        const client = room.clients.get(msg.clientId);
        if (client) client.close();
      }
    }
  });

  ws.on('close', () => {
    if (!token) return;
    const room = rooms.get(token);
    if (!room) return;

    if (role === 'host') {
      if (room.host === ws) {
        room.host = null;
        room.clients.forEach(c => { try { c.close(); } catch {} });
        room.clients.clear();
      }
      log(`host disconnected  token=${token.slice(0,8)}…`);
      cleanRoom(token);
    }

    if (role === 'client' && clientId) {
      room.clients.delete(clientId);
      safeSend(room.host, { type: 'client-disconnect', clientId });
      log(`client disconnected  id=${clientId}`);
      cleanRoom(token);
    }
  });
});

function log(msg) {
  const t = new Date().toISOString().slice(11,19);
  console.log(`[${t}] ${msg}`);
}

function safeSend(ws, data) {
  if (ws && ws.readyState === WebSocket.OPEN)
    try { ws.send(typeof data === 'string' ? data : JSON.stringify(data)); } catch {}
}

function gracefulShutdown(signal) {
  log(`${signal} received — closing all connections`);
  wss.clients.forEach(c => { try { c.close(1001, 'server shutting down'); } catch {} });
  server.close(() => { log('relay stopped'); process.exit(0); });
  setTimeout(() => process.exit(1), 5000); // force exit if close hangs
}
process.on('SIGTERM', () => gracefulShutdown('SIGTERM'));
process.on('SIGINT',  () => gracefulShutdown('SIGINT'));
process.on('uncaughtException',  (err) => log(`uncaughtException: ${err && err.message ? err.message : err}`));
process.on('unhandledRejection', (err) => log(`unhandledRejection: ${err && err.message ? err.message : err}`));

server.listen(PORT, () => log(`relay listening on :${PORT}`));
