'use strict';

const https   = require('https');
const fs      = require('fs');
const path    = require('path');
const express = require('express');
const WebSocket = require('ws');

/**
 * Create the Express app with all middleware and routes.
 * Returns { app, server, wss }.
 */
function createServer(config, rootDir) {
  const app = express();
  app.disable('x-powered-by');

  // ─── HTTP rate limiting (per IP, 60 req/min) ──────────────────────────────
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
  setInterval(() => {
    const now = Date.now();
    httpRates.forEach((v, k) => { if (now > v.resetAt) httpRates.delete(k); });
  }, 300000);

  // ─── Security headers ─────────────────────────────────────────────────────
  app.use((req, res, next) => {
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('X-Frame-Options', 'DENY');
    res.setHeader('Referrer-Policy', 'no-referrer');
    res.setHeader('X-XSS-Protection', '1; mode=block');
    res.setHeader('Strict-Transport-Security', 'max-age=31536000; includeSubDomains');
    res.setHeader('Permissions-Policy', 'camera=(), geolocation=(), payment=()');
    res.setHeader('Content-Security-Policy', "default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; connect-src 'self' wss: https:; base-uri 'self'; form-action 'none'; frame-ancestors 'none'");
    res.setHeader('Cache-Control', 'no-store');
    next();
  });

  // Health endpoint
  app.get('/ping', (req, res) => {
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'GET');
    res.json({ ok: true, ts: Date.now() });
  });

  // Serve the phone UI if URL token matches
  app.get(`/${config.urlToken}`, (req, res) => {
    res.sendFile(path.join(rootDir, 'public/index.html'));
  });
  app.get('/{*path}', (req, res) => res.status(403).send('Forbidden'));

  // HTTPS server
  const server = https.createServer({
    key:  fs.readFileSync(path.join(rootDir, 'certs/key.pem')),
    cert: fs.readFileSync(path.join(rootDir, 'certs/cert.pem')),
  }, app);

  // WebSocket server
  const wss = new WebSocket.Server({ server, maxPayload: 64 * 1024 });

  return { app, server, wss };
}

module.exports = { createServer };
