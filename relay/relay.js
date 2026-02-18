// relay.js — runs on a VPS, brokers WSS between desktop host and phone clients
// Desktop connects outbound as 'host', phones connect as 'client'
// All traffic is end-to-end encrypted via WSS (TLS)

const https   = require('https');
const fs      = require('fs');
const path    = require('path');
const crypto  = require('crypto');
const WebSocket = require('ws');
const express = require('express');

const PORT      = process.env.PORT     || 4001;
const CERT_DIR  = process.env.CERT_DIR || path.join(__dirname, 'certs');
const PUBLIC    = process.env.PUBLIC   || path.join(__dirname, 'public');
const RELAY_SECRET = process.env.RELAY_SECRET || ''; // set this on the VPS
const PING_MS   = 25000;
const PING_TTL  = 10000;

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

app.get('/health', (req, res) => {
  const roomStats = [];
  rooms.forEach((room, token) => {
    roomStats.push({ token: token.slice(0,8) + '…', host: !!room.host, clients: room.clients.size });
  });
  res.json({ status: 'ok', uptime: process.uptime(), rooms: roomStats });
});

// Serve index.html with injected RELAY_TOKEN so phone knows it's in relay mode
app.get('/:token', (req, res) => {
  const html = path.join(PUBLIC, 'index.html');
  if (!fs.existsSync(html)) {
    res.status(503).send('index.html not found — copy public/ next to relay.js on the VPS');
    return;
  }
  let content = fs.readFileSync(html, 'utf8');
  content = content.replace('</head>', `<script>window.RELAY_TOKEN="${req.params.token}";</script>\n</head>`);
  res.setHeader('Content-Type', 'text/html');
  res.send(content);
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
const wss    = new WebSocket.Server({ server });

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
wss.on('connection', (ws) => {
  startKeepalive(ws);
  let role = null, token = null, clientId = null;

  ws.on('message', (data) => {
    let msg;
    try { msg = JSON.parse(data.toString()); } catch { return; }

    // ── First message must be a registration ──
    if (!role) {
      if (!msg.token) { ws.close(); return; }
      token = msg.token;
      const room = getRoom(token);

      if (msg.type === 'host-register') {
        // verify secret if one is configured on the relay
        if (RELAY_SECRET && msg.secret !== RELAY_SECRET) {
          ws.send(JSON.stringify({ type: 'error', reason: 'bad-secret' }));
          ws.close();
          log(`host rejected — bad secret  token=${token.slice(0,8)}…`);
          return;
        }
        // evict stale host (crashed/reconnecting desktop)
        if (room.host && room.host !== ws) {
          try { room.host.terminate(); } catch {}
        }
        role = 'host';
        room.host = ws;
        ws.send(JSON.stringify({ type: 'registered' }));
        log(`host registered   token=${token.slice(0,8)}…`);
        // re-announce any clients that were already in the room
        room.clients.forEach((_, cid) => {
          ws.send(JSON.stringify({ type: 'client-connect', clientId: cid }));
        });
        return;
      }

      if (msg.type === 'client-connect') {
        role     = 'client';
        clientId = crypto.randomBytes(6).toString('hex');
        room.clients.set(clientId, ws);
        if (room.host && room.host.readyState === WebSocket.OPEN) {
          ws.send(JSON.stringify({ type: 'connected', clientId }));
          room.host.send(JSON.stringify({ type: 'client-connect', clientId }));
        } else {
          // no host — tell phone to wait/retry
          ws.send(JSON.stringify({ type: 'error', reason: 'host-unavailable' }));
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
      if (room.host && room.host.readyState === WebSocket.OPEN)
        room.host.send(JSON.stringify({ type: 'client-message', clientId, data: data.toString() }));
      return;
    }

    // ── Host → Client forwarding ──
    if (role === 'host') {
      const room = getRoom(token);
      if (!msg.clientId) return;
      if (msg.type === 'host-message') {
        const client = room.clients.get(msg.clientId);
        if (client && client.readyState === WebSocket.OPEN) client.send(msg.data);
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
      if (room.host && room.host.readyState === WebSocket.OPEN)
        room.host.send(JSON.stringify({ type: 'client-disconnect', clientId }));
      log(`client disconnected  id=${clientId}`);
      cleanRoom(token);
    }
  });
});

function log(msg) {
  const t = new Date().toISOString().slice(11,19);
  console.log(`[${t}] ${msg}`);
}

server.listen(PORT, () => log(`relay listening on :${PORT}`));
