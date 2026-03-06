'use strict';

const https   = require('https');
const WebSocket = require('ws');
const VirtualWS = require('./virtual-ws');
const { safeSend } = require('../utils');

const VIRTUAL_MAX_CLIENTS = 10;

/**
 * Relay client — connects to a relay server and manages virtual clients.
 * Emits events: 'status', 'log', 'roomToken', 'qr'
 */
class RelayClient {
  constructor(config, opts = {}) {
    this.config = config;
    this.handleConnection = opts.handleConnection; // fn(ws)
    this.logFn = opts.logFn || (() => {});
    this.onStatus = opts.onStatus || (() => {});
    this.onQR = opts.onQR || (() => {});

    this.status = 'disabled';
    this.ws = null;
    this.roomToken = null;
    this.stopped = false;
    this.virtualClients = new Map();
  }

  connect() {
    if (!this.config.relayUrl) { this.status = 'disabled'; this.onStatus(this.status); return; }
    if (!/^wss:\/\/.+/.test(this.config.relayUrl)) {
      this.logFn('Relay URL must start with wss:// — skipping', 'warn');
      this.status = 'error'; this.onStatus(this.status);
      return;
    }

    this.stopped = false;
    this.status = 'connecting';
    this.onStatus(this.status);

    const url = this.config.relayUrl.replace(/\/$/, '');
    this.ws = new WebSocket(url, {
      rejectUnauthorized: this.config.relayRejectUnauthorized !== false,
      maxPayload: 64 * 1024,
    });
    const ws = this.ws;

    ws.on('open', () => {
      this.status = 'connected';
      this.onStatus(this.status);
      safeSend(ws, {
        type: 'host-register',
        token: this.config.urlToken,
        secret: this.config.relaySecret || '',
        localUrl: this.config._localUrl || '',
      });
      this.logFn(`Relay connected — ${url}`, 'connect');
      this.onQR();

      // Keepalive
      ws.isAlive = true;
      ws.on('pong', () => { ws.isAlive = true; clearTimeout(ws._pongTimeout); });
      ws._pingTimer = setInterval(() => {
        if (!ws.isAlive) { ws.terminate(); return; }
        ws.isAlive = false;
        ws.ping();
        ws._pongTimeout = setTimeout(() => { if (!ws.isAlive) ws.terminate(); }, 10000);
      }, 25000);
    });

    ws.on('message', (data) => {
      let msg;
      try { msg = JSON.parse(data.toString()); } catch { return; }
      if (!msg || typeof msg !== 'object' || Array.isArray(msg)) return;

      if (msg.type === 'registered') {
        if (typeof msg.roomToken === 'string' && /^[a-f0-9]{16,64}$/.test(msg.roomToken)) {
          this.roomToken = msg.roomToken;
        }
        this.logFn('Relay: registered, waiting for phones', 'info');
        this.onQR();
        return;
      }

      if (msg.type === 'error') {
        if (msg.reason === 'bad-secret') {
          this.logFn('Relay: bad secret — check relaySecret in config.json', 'warn');
          this.stopped = true;
          this.roomToken = null;
          this.status = 'error'; this.onStatus(this.status);
        } else {
          const reason = typeof msg.reason === 'string' ? msg.reason.slice(0, 100) : 'unknown';
          this.logFn(`Relay error: ${reason}`, 'warn');
        }
        return;
      }

      if (msg.type === 'client-connect') {
        if (typeof msg.clientId !== 'string' || !/^[a-f0-9]{12}$/.test(msg.clientId)) return;
        if (this.virtualClients.size >= VIRTUAL_MAX_CLIENTS) {
          safeSend(ws, JSON.stringify({ type: 'host-to-client', clientId: msg.clientId, data: JSON.stringify({ type: 'error', reason: 'room-full' }) }));
          return;
        }
        const vws = new VirtualWS(msg.clientId, ws);
        this.virtualClients.set(msg.clientId, vws);
        if (this.handleConnection) this.handleConnection(vws);
        return;
      }

      if (msg.type === 'client-message') {
        if (typeof msg.clientId !== 'string' || !/^[a-f0-9]{12}$/.test(msg.clientId)) return;
        const vws = this.virtualClients.get(msg.clientId);
        if (vws && typeof msg.data === 'string') vws._receive(msg.data);
        return;
      }

      if (msg.type === 'client-disconnect') {
        if (typeof msg.clientId !== 'string' || !/^[a-f0-9]{12}$/.test(msg.clientId)) return;
        const vws = this.virtualClients.get(msg.clientId);
        if (vws) { vws.readyState = WebSocket.CLOSED; vws.emit('close'); }
        this.virtualClients.delete(msg.clientId);
        return;
      }
    });

    ws.on('close', () => {
      clearInterval(ws._pingTimer);
      clearTimeout(ws._pongTimeout);
      this.status = 'error';
      this.roomToken = null;
      this.virtualClients.forEach(vws => { vws.readyState = WebSocket.CLOSED; vws.emit('close'); });
      this.virtualClients.clear();
      this.onQR();
      if (this.stopped) return;
      this.logFn('Relay disconnected — retrying in 5s', 'warn');
      this.onStatus(this.status);
      setTimeout(() => this.connect(), 5000);
    });

    ws.on('error', (err) => {
      this.status = 'error';
      this.logFn(`Relay error: ${err.message}`, 'warn');
      this.onStatus(this.status);
    });
  }

  disconnect() {
    this.stopped = true;
    this.roomToken = null;
    if (this.ws) { try { this.ws.terminate(); } catch {} this.ws = null; }
  }

  /** Broadcast to all virtual clients. */
  broadcast(msg) {
    const data = JSON.stringify(msg);
    this.virtualClients.forEach(c => {
      if (c.readyState === WebSocket.OPEN) { try { c.send(data); } catch {} }
    });
  }

  /** Check relay health via HTTPS /health endpoint. */
  static checkHealth(relayUrl, secret, timeout = 3000) {
    return new Promise((resolve) => {
      try {
        const healthUrl = relayUrl.replace(/^wss:\/\//, 'https://').replace(/\/$/, '') + '/health';
        const url = new URL(healthUrl);
        const opts = {
          hostname: url.hostname, port: url.port || 443, path: url.pathname,
          method: 'GET', rejectUnauthorized: true, timeout,
          headers: secret ? { Authorization: `Bearer ${secret}` } : {},
        };
        const req = https.request(opts, (res) => {
          let body = '';
          res.on('data', (d) => { body += d; });
          res.on('end', () => {
            if (res.statusCode === 200) {
              try { const j = JSON.parse(body); resolve({ up: true, rooms: j.rooms ? j.rooms.length : 0 }); }
              catch { resolve({ up: true, rooms: 0 }); }
            } else resolve({ up: false });
          });
        });
        req.on('error', () => resolve({ up: false }));
        req.on('timeout', () => { req.destroy(); resolve({ up: false }); });
        req.end();
      } catch { resolve({ up: false }); }
    });
  }
}

module.exports = RelayClient;
