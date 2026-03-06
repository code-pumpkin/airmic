// relay.js — runs on a VPS, brokers WSS between desktop host and phone clients
// Desktop connects outbound as 'host', phones connect as 'client'
// All traffic is end-to-end encrypted via WSS (TLS)

const https   = require('https');
const fs      = require('fs');
const path    = require('path');
const crypto  = require('crypto');
const WebSocket = require('ws');
const express = require('express');

const _port        = parseInt(process.env.PORT || '4001', 10);
const PORT         = Number.isFinite(_port) && _port > 0 && _port < 65536 ? _port : 4001;
const CERT_DIR     = process.env.CERT_DIR     || path.join(__dirname, 'certs');
const PUBLIC       = process.env.PUBLIC       || path.join(__dirname, 'public');
const _rawSecret   = typeof process.env.RELAY_SECRET === 'string' ? process.env.RELAY_SECRET : '';
const RELAY_SECRET = _rawSecret.slice(0, 500); // cap before any Buffer.from usage
const _maxClients  = parseInt(process.env.MAX_CLIENTS || '10', 10);
const MAX_CLIENTS  = Number.isFinite(_maxClients) && _maxClients > 0 ? _maxClients : 10;
const PING_MS      = 25000;
const PING_TTL     = 10000;
const REG_TIMEOUT  = 8000;
const RATE_WINDOW  = 60000; // 1 minute window
const RATE_MAX     = 20;    // max connections per IP per window
const MSG_RATE_WINDOW = 1000; // 1 second window for message rate
const MSG_RATE_MAX    = 30;   // max messages per second per socket
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
  // cap map size to prevent unbounded growth from many unique IPs
  if (ipRates.size > 10000) {
    const oldest = [...ipRates.entries()].sort((a, b) => a[1].resetAt - b[1].resetAt)[0];
    if (oldest) ipRates.delete(oldest[0]);
  }
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

const MAX_ROOMS = 1000; // prevent unbounded room map growth

function getRoom(token) {
  if (!rooms.has(token)) {
    if (rooms.size >= MAX_ROOMS) return null; // reject new rooms when at cap
    rooms.set(token, { host: null, clients: new Map() });
  }
  return rooms.get(token);
}

function cleanRoom(token) {
  const room = rooms.get(token);
  if (!room) return;
  if (!room.host && room.clients.size === 0) rooms.delete(token);
}

// ─── HTTP ─────────────────────────────────────────────────────────────────────
const app = express();

// ─── HTTP rate limiting (per IP, 60 req/min) ─────────────────────────────────
const httpRates = new Map();
const HTTP_RATE_WINDOW = 60000;
const HTTP_RATE_MAX = 60;
app.use((req, res, next) => {
  const ip = req.ip || req.socket.remoteAddress || 'unknown';
  const now = Date.now();
  const entry = httpRates.get(ip) || { count: 0, resetAt: now + HTTP_RATE_WINDOW };
  if (now > entry.resetAt) { entry.count = 0; entry.resetAt = now + HTTP_RATE_WINDOW; }
  entry.count++;
  httpRates.set(ip, entry);
  if (entry.count > HTTP_RATE_MAX) { res.status(429).send('Too Many Requests'); return; }
  next();
});
setInterval(() => { const now = Date.now(); httpRates.forEach((v, k) => { if (now > v.resetAt) httpRates.delete(k); }); }, 300000);

// ─── Security headers ─────────────────────────────────────────────────────────
app.use((req, res, next) => {
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('X-Frame-Options', 'DENY');
  res.setHeader('Referrer-Policy', 'no-referrer');
  res.setHeader('X-XSS-Protection', '1; mode=block');
  res.setHeader('Strict-Transport-Security', 'max-age=31536000; includeSubDomains');
  res.setHeader('Permissions-Policy', 'camera=(), geolocation=(), payment=()');
  res.setHeader('Content-Security-Policy', "default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; connect-src 'self' wss: https:; base-uri 'self'; form-action 'none'; frame-ancestors 'none'");
  // CORS — restrict to same-origin; no cross-origin requests needed for relay-served pages
  const allowedOrigin = `https://${req.hostname || 'localhost'}:${PORT}`;
  res.setHeader('Access-Control-Allow-Origin', allowedOrigin);
  res.setHeader('Access-Control-Allow-Methods', 'GET');
  res.setHeader('Access-Control-Allow-Headers', 'Authorization');
  next();
});

// Read index.html fresh each time — ensures deploys take effect immediately
function getIndexHtml() {
  const html = path.join(PUBLIC, 'index.html');
  try { return fs.readFileSync(html, 'utf8'); } catch { return null; }
}

app.get('/health', (req, res) => {
  // Require secret if one is configured — Bearer token or ?secret= query param
  if (RELAY_SECRET) {
    const auth = (typeof req.headers.authorization === 'string' ? req.headers.authorization : '') || '';
    const bearer = auth.startsWith('Bearer ') ? auth.slice(7, 7 + 500) : null;
    const query  = typeof req.query.secret === 'string' ? req.query.secret.slice(0, 500) : null;
    const expected = Buffer.from(RELAY_SECRET);
    const bearerBuf = bearer !== null ? Buffer.from(bearer) : null;
    const queryBuf  = query  !== null ? Buffer.from(query)  : null;
    const bearerOk = bearerBuf !== null && bearerBuf.length === expected.length &&
      crypto.timingSafeEqual(bearerBuf, expected);
    const queryOk  = queryBuf  !== null && queryBuf.length  === expected.length &&
      crypto.timingSafeEqual(queryBuf,  expected);
    if (!bearerOk && !queryOk) {
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
  // Verify room exists — don't serve page for non-existent rooms
  if (!rooms.has(req.params.token)) {
    res.status(404).send('Room not found — the host may not be connected yet');
    return;
  }
  const content = getIndexHtml();
  if (!content) {
    res.status(503).send('index.html not found — copy public/ next to relay.js on the VPS');
    return;
  }
  const injected = content.replace('</head>', `<script>window.RELAY_TOKEN="${req.params.token}";</script>\n</head>`);
  res.setHeader('Content-Type', 'text/html');
  res.setHeader('Cache-Control', 'no-store, no-cache, must-revalidate');
  res.setHeader('Pragma', 'no-cache');
  res.setHeader('Expires', '0');
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
  ws.on('pong', () => { ws.isAlive = true; clearTimeout(ws._pongTimeout); });

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
    // Per-socket message rate limiting
    const now = Date.now();
    if (!ws._msgCount) { ws._msgCount = 0; ws._msgWindowStart = now; }
    if (now - ws._msgWindowStart > MSG_RATE_WINDOW) { ws._msgCount = 0; ws._msgWindowStart = now; }
    ws._msgCount++;
    if (ws._msgCount > MSG_RATE_MAX) {
      safeSend(ws, { type: 'error', reason: 'rate-limited' });
      ws.terminate();
      log(`message rate-limited  role=${role || 'unregistered'}`);
      return;
    }
    let msg;
    try { msg = JSON.parse(data.toString()); } catch { return; }
    if (!msg || typeof msg !== 'object' || Array.isArray(msg)) return;

    // ── First message must be a registration ──
    if (!role) {
      clearTimeout(regTimer);
      if (!msg.token || !TOKEN_RE.test(msg.token)) { ws.close(); return; }
      token = msg.token;
      const room = getRoom(token);
      if (!room) {
        safeSend(ws, { type: 'error', reason: 'server-full' });
        ws.close();
        log(`rejected — room cap reached  token=${token.slice(0,8)}…`);
        return;
      }

      if (msg.type === 'host-register') {
        if (RELAY_SECRET) {
          const secretBuf  = typeof msg.secret === 'string' ? Buffer.from(msg.secret.slice(0, 500)) : null;
          const expectedBuf = Buffer.from(RELAY_SECRET);
          const secretOk = secretBuf !== null && secretBuf.length === expectedBuf.length &&
            crypto.timingSafeEqual(secretBuf, expectedBuf);
          if (!secretOk) {
            safeSend(ws, { type: 'error', reason: 'bad-secret' });
            ws.close();
            log(`host rejected — bad secret  token=${token.slice(0,8)}…`);
            return;
          }
        }
        // Generate a unique room token for this host session
        // The host sent its local urlToken, but we assign a relay-specific one
        // so different desktops never collide
        const roomToken = crypto.randomBytes(12).toString('hex');
        // Re-key the room under the new roomToken
        rooms.delete(token);
        token = roomToken;
        const room = getRoom(token);
        if (!room) {
          safeSend(ws, { type: 'error', reason: 'server-full' });
          ws.close();
          return;
        }
        if (room.host && room.host !== ws) { try { room.host.terminate(); } catch {} }
        role = 'host';
        room.host = ws;
        room.localUrl = (typeof msg.localUrl === 'string' && msg.localUrl.length < 200) ? msg.localUrl : null;
        safeSend(ws, { type: 'registered', roomToken });
        log(`host registered   roomToken=${roomToken.slice(0,8)}…  localUrl=${room.localUrl || 'none'}`);
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
          safeSend(ws, { type: 'connected', clientId, localUrl: room.localUrl || null });
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
      const room = rooms.get(token);
      if (!room || !room.host) return;
      // Verify this client actually belongs to this room
      if (!room.clients.has(clientId)) { ws.terminate(); return; }
      safeSend(room.host, JSON.stringify({ type: 'client-message', clientId, data: data.toString() }));
      return;
    }

    // ── Host → Client forwarding ──
    if (role === 'host') {
      const room = rooms.get(token);
      if (!room) return;
      if (typeof msg.clientId !== 'string' || !/^[a-f0-9]{12}$/.test(msg.clientId)) return;
      // Only forward to clients that belong to THIS room
      const client = room.clients.get(msg.clientId);
      if (!client) return;
      if (msg.type === 'host-message') {
        if (typeof msg.data === 'string') safeSend(client, msg.data);
      } else if (msg.type === 'host-close') {
        client.close();
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
