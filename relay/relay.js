// relay.js — runs on a VPS, brokers WSS between desktop host and phone clients
// Desktop connects outbound as 'host', phones connect as 'client'
// All traffic is end-to-end encrypted via WSS (TLS)

const https   = require('https');
const fs      = require('fs');
const path    = require('path');
const crypto  = require('crypto');
const WebSocket = require('ws');
const express = require('express');

const PORT     = process.env.PORT || 4001;
const CERT_DIR = path.join(__dirname, 'certs');
const PUBLIC   = path.join(__dirname, 'public');

// ─── Rooms ────────────────────────────────────────────────────────────────────
// token → { host: ws|null, clients: Map<clientId, ws> }
const rooms = new Map();

function getRoom(token) {
  if (!rooms.has(token)) rooms.set(token, { host: null, clients: new Map() });
  return rooms.get(token);
}

// ─── HTTP ─────────────────────────────────────────────────────────────────────
const app = express();

// Serve index.html with injected RELAY_TOKEN so phone knows it's in relay mode
app.get('/:token', (req, res) => {
  const html = path.join(PUBLIC, 'index.html');
  if (!fs.existsSync(html)) {
    res.status(503).send('index.html not found — copy public/ next to relay.js on the VPS');
    return;
  }
  let content = fs.readFileSync(html, 'utf8');
  // inject token before </head> so index.html can detect relay mode
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

// ─── WebSocket broker ─────────────────────────────────────────────────────────
wss.on('connection', (ws) => {
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
        if (room.host && room.host.readyState === WebSocket.OPEN) {
          ws.send(JSON.stringify({ type: 'error', reason: 'host-already-connected' }));
          ws.close(); return;
        }
        role = 'host';
        room.host = ws;
        ws.send(JSON.stringify({ type: 'registered' }));
        log(`host registered   token=${token.slice(0,8)}…`);
        return;
      }

      if (msg.type === 'client-connect') {
        role     = 'client';
        clientId = crypto.randomBytes(6).toString('hex');
        room.clients.set(clientId, ws);
        ws.send(JSON.stringify({ type: 'connected', clientId }));
        // notify host
        if (room.host && room.host.readyState === WebSocket.OPEN)
          room.host.send(JSON.stringify({ type: 'client-connect', clientId }));
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
      room.host = null;
      // drop all relay clients when host disappears
      room.clients.forEach(c => { try { c.close(); } catch {} });
      room.clients.clear();
      log(`host disconnected  token=${token.slice(0,8)}…`);
    }

    if (role === 'client' && clientId) {
      room.clients.delete(clientId);
      if (room.host && room.host.readyState === WebSocket.OPEN)
        room.host.send(JSON.stringify({ type: 'client-disconnect', clientId }));
      log(`client disconnected  id=${clientId}`);
    }
  });
});

function log(msg) {
  const t = new Date().toISOString().slice(11,19);
  console.log(`[${t}] ${msg}`);
}

server.listen(PORT, () => log(`relay listening on :${PORT}`));
