#!/usr/bin/env node
const https    = require('https');
const fs       = require('fs');
const path     = require('path');
const { exec } = require('child_process');
const crypto   = require('crypto');
const { EventEmitter } = require('events');
const { networkInterfaces } = require('os');
const WebSocket = require('ws');
const express  = require('express');
const QRCode   = require('qrcode');

// ─── Headless mode ────────────────────────────────────────────────────────────
const HEADLESS = process.argv.includes('--headless');
const blessed  = HEADLESS ? null : require('blessed');

// ─── .env loader (no dotenv dependency) ──────────────────────────────────────
const ENV_PATH = path.join(__dirname, '.env');
try {
  const envContent = fs.readFileSync(ENV_PATH, 'utf8');
  for (const line of envContent.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    const eq = trimmed.indexOf('=');
    if (eq < 1) continue;
    const key = trimmed.slice(0, eq).trim();
    let val = trimmed.slice(eq + 1).trim();
    // strip surrounding quotes
    if ((val.startsWith('"') && val.endsWith('"')) || (val.startsWith("'") && val.endsWith("'"))) val = val.slice(1, -1);
    if (!process.env[key]) process.env[key] = val; // don't override existing env vars
  }
} catch {}

// ─── AI API key — from env only (.env file or environment variable) ──────────
function getAiApiKey() { return (process.env.VOICEBRIDGE_AI_KEY || '').slice(0, 200); }

// ─── AI SDKs (loaded lazily on first use) ────────────────────────────────────
let _openai = null, _anthropic = null, _google = null;
function getOpenAI() {
  if (!_openai) { const { OpenAI } = require('openai'); _openai = new OpenAI({ apiKey: getAiApiKey() }); }
  return _openai;
}
function getAnthropic() {
  if (!_anthropic) { const { Anthropic } = require('@anthropic-ai/sdk'); _anthropic = new Anthropic({ apiKey: getAiApiKey() }); }
  return _anthropic;
}
function getGoogle() {
  if (!_google) { const { GoogleGenerativeAI } = require('@google/generative-ai'); _google = new GoogleGenerativeAI(getAiApiKey()); }
  return _google;
}

// ─── VirtualWS ────────────────────────────────────────────────────────────────
// Wraps a relay-proxied client so it looks identical to a real ws to handleConnection()
class VirtualWS extends EventEmitter {
  constructor(clientId, relayWs) {
    super();
    this.clientId   = clientId;
    this._relayWs   = relayWs;
    this.readyState = WebSocket.OPEN;
    this._queue     = [];
    this._running   = false;
  }
  send(data) {
    if (this.readyState !== WebSocket.OPEN) return;
    if (this._relayWs.readyState !== WebSocket.OPEN) return;
    try { this._relayWs.send(JSON.stringify({ type: 'host-message', clientId: this.clientId, data })); } catch {}
  }
  close() {
    if (this.readyState === WebSocket.CLOSED) return;
    this.readyState = WebSocket.CLOSED;
    if (this._relayWs.readyState === WebSocket.OPEN) {
      try { this._relayWs.send(JSON.stringify({ type: 'host-close', clientId: this.clientId })); } catch {}
    }
    this.emit('close');
  }
  // called by relay client when a message arrives for this virtual socket
  _receive(data) {
    this.emit('message', data);
  }
}

// ─── Config ───────────────────────────────────────────────────────────────────

const CONFIG_PATH   = path.join(__dirname, 'config.json');
const SESSIONS_PATH = path.join(__dirname, 'sessions.json');

function loadConfig() {
  try {
    const data = JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf8'));
    if (data && typeof data === 'object' && !Array.isArray(data)) return data;
  } catch {}
  return {};
}
function saveConfig(cfg) {
  const tmp = CONFIG_PATH + '.tmp';
  try { fs.writeFileSync(tmp, JSON.stringify(cfg, null, 2)); fs.renameSync(tmp, CONFIG_PATH); } catch (e) { console.error('[config] save failed:', e.message); }
}
function saveSessions(s) {
  const tmp = SESSIONS_PATH + '.tmp';
  try { fs.writeFileSync(tmp, JSON.stringify(s, null, 2)); fs.renameSync(tmp, SESSIONS_PATH); } catch (e) { console.error('[sessions] save failed:', e.message); }
}
function loadSessions() {
  try {
    const data = JSON.parse(fs.readFileSync(SESSIONS_PATH, 'utf8'));
    if (data && typeof data === 'object' && !Array.isArray(data)) return data;
  } catch {}
  return {};
}

const DEFAULT_CONFIG = {
  port: 4000,
  language: 'en-US',
  clipboardMode: false,
  wordReplacements: {},
  voiceCommandsExtra: {},
  relayUrl: '',
  relaySecret: '',
  relayRejectUnauthorized: true,
  relayServers: [
    { name: 'VoiceBridge Cloud', url: 'wss://voicebridge.returnfeed.com:4001', secret: '' },
  ],
  aiEnabled:   false,
  aiProvider:  'openai',   // 'openai' | 'anthropic' | 'google'
  aiModel:     '',         // blank = use provider default
  aiPrompt:    'You are a transcription assistant. Clean up and summarize the following spoken text into clear, concise written prose. Preserve the meaning exactly. Output only the improved text, nothing else.',
};

let config   = { ...DEFAULT_CONFIG, ...loadConfig() };
let sessions = loadSessions(); // { deviceToken: { name, approved, lastSeen } }
// Strip any malformed session entries on load
for (const [token, s] of Object.entries(sessions)) {
  if (!token || !/^[a-f0-9]{32}$/.test(token) || typeof s !== 'object' || s === null || Array.isArray(s) || s.approved !== true) {
    delete sessions[token];
  }
}
const MAX_SESSIONS = 500;
// Trim to cap in case sessions.json was manually inflated
const _sessionKeys = Object.keys(sessions);
if (_sessionKeys.length > MAX_SESSIONS) {
  _sessionKeys.sort((a, b) => (sessions[a].lastSeen || 0) - (sessions[b].lastSeen || 0))
    .slice(0, _sessionKeys.length - MAX_SESSIONS)
    .forEach(k => delete sessions[k]);
}

// Sanitize port — must be a valid integer in range
if (!Number.isInteger(config.port) || config.port < 1 || config.port > 65535) {
  console.warn(`[config] invalid port ${config.port}, falling back to 4000`);
  config.port = 4000;
}

// Generate URL token once, persist it — regenerate if tampered/invalid
if (!config.urlToken || !/^[a-f0-9]{8,64}$/.test(config.urlToken)) {
  config.urlToken = crypto.randomBytes(8).toString('hex');
  saveConfig(config);
}

// Sanitize language — fall back to default if not a valid BCP 47 tag
if (typeof config.language !== 'string' || !/^[a-zA-Z]{2,8}(-[a-zA-Z0-9]{2,8})*$/.test(config.language)) {
  config.language = DEFAULT_CONFIG.language;
}
// Sanitize boolean fields
if (typeof config.clipboardMode !== 'boolean') config.clipboardMode = false;
if (typeof config.relayRejectUnauthorized !== 'boolean') config.relayRejectUnauthorized = true;
// Sanitize string fields
if (typeof config.relayUrl !== 'string') config.relayUrl = '';
if (typeof config.relaySecret !== 'string') config.relaySecret = '';
// Cap string lengths to prevent oversized values from config.json
config.relayUrl    = config.relayUrl.slice(0, 500);
config.relaySecret = config.relaySecret.slice(0, 200);
// Sanitize AI fields
if (typeof config.aiEnabled  !== 'boolean') config.aiEnabled = false;
if (!['openai','anthropic','google'].includes(config.aiProvider)) config.aiProvider = 'openai';
if (typeof config.aiModel    !== 'string')  config.aiModel   = '';
if (typeof config.aiPrompt   !== 'string')  config.aiPrompt  = DEFAULT_CONFIG.aiPrompt;
config.aiModel  = config.aiModel.slice(0, 100);
config.aiPrompt = config.aiPrompt.slice(0, 1000);
// Migrate: if aiApiKey exists in config.json, move it to .env and remove from config
if (config.aiApiKey && typeof config.aiApiKey === 'string' && config.aiApiKey.trim()) {
  const envLine = `VOICEBRIDGE_AI_KEY=${config.aiApiKey.trim()}\n`;
  try {
    const existing = fs.existsSync(ENV_PATH) ? fs.readFileSync(ENV_PATH, 'utf8') : '';
    if (!existing.includes('VOICEBRIDGE_AI_KEY')) fs.writeFileSync(ENV_PATH, existing + envLine);
  } catch {}
  if (!process.env.VOICEBRIDGE_AI_KEY) process.env.VOICEBRIDGE_AI_KEY = config.aiApiKey.trim();
  delete config.aiApiKey;
  saveConfig(config);
}
// Sanitize object fields — discard if not plain objects
if (typeof config.wordReplacements !== 'object' || Array.isArray(config.wordReplacements) || !config.wordReplacements) config.wordReplacements = {};
if (typeof config.voiceCommandsExtra !== 'object' || Array.isArray(config.voiceCommandsExtra) || !config.voiceCommandsExtra) config.voiceCommandsExtra = {};
// Cap entry counts to prevent DoS from huge config files
const MAX_REPLACEMENTS = 200;
const MAX_VOICE_CMDS   = 100;
for (const key of Object.keys(config.wordReplacements).slice(MAX_REPLACEMENTS)) delete config.wordReplacements[key];
for (const key of Object.keys(config.voiceCommandsExtra).slice(MAX_VOICE_CMDS)) delete config.voiceCommandsExtra[key];
// Strip malformed voiceCommandsExtra entries — must be plain objects with a valid action
for (const [k, v] of Object.entries(config.voiceCommandsExtra)) {
  const valid = v && typeof v === 'object' && !Array.isArray(v) &&
    typeof v.action === 'string' &&
    (v.action === 'scratch' ||
     (v.action === 'key'  && typeof v.key  === 'string') ||
     (v.action === 'type' && typeof v.text === 'string'));
  if (!valid) delete config.voiceCommandsExtra[k];
}
// Strip malformed wordReplacements entries — both key and value must be strings
for (const [k, v] of Object.entries(config.wordReplacements)) {
  if (typeof k !== 'string' || typeof v !== 'string') delete config.wordReplacements[k];
}

// Prune sessions older than 90 days
const SESSION_TTL = 90 * 24 * 60 * 60 * 1000;
function pruneSessions() {
  const cutoff = Date.now() - SESSION_TTL;
  let pruned = 0;
  for (const [token, s] of Object.entries(sessions)) {
    if ((s.lastSeen || 0) < cutoff) { delete sessions[token]; pruned++; }
  }
  if (pruned > 0) { saveSessions(sessions); }
}
pruneSessions();
setInterval(pruneSessions, 24 * 60 * 60 * 1000); // daily

// ─── Built-in voice commands ──────────────────────────────────────────────────

const BUILTIN_VOICE_COMMANDS = {
  'scratch that':      { action: 'scratch' },
  'new line':          { action: 'key',  key: 'Return' },
  'new paragraph':     { action: 'key',  key: 'Return Return' },
  'period':            { action: 'type', text: '.' },
  'full stop':         { action: 'type', text: '.' },
  'comma':             { action: 'type', text: ',' },
  'question mark':     { action: 'type', text: '?' },
  'exclamation mark':  { action: 'type', text: '!' },
  'exclamation point': { action: 'type', text: '!' },
  'open bracket':      { action: 'type', text: '(' },
  'close bracket':     { action: 'type', text: ')' },
  'colon':             { action: 'type', text: ':' },
  'semicolon':         { action: 'type', text: ';' },
  'dash':              { action: 'type', text: ' - ' },
  'open quote':        { action: 'type', text: '"' },
  'close quote':       { action: 'type', text: '"' },
};

function getVoiceCommands() {
  return { ...BUILTIN_VOICE_COMMANDS, ...(config.voiceCommandsExtra || {}) };
}

// ─── Server setup ─────────────────────────────────────────────────────────────

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
  res.setHeader('Cache-Control', 'no-store');
  next();
});

// Health/connectivity test — phone hits this to confirm HTTPS works before WSS
// CORS allowed so phone served from relay domain can reach local server
app.get('/ping', (req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET');
  res.json({ ok: true, ts: Date.now() });
});

// Serve the app if URL token matches
app.get(`/${config.urlToken}`, (req, res) => {
  res.sendFile(path.join(__dirname, 'public/index.html'));
});
app.get('/{*path}', (req, res) => res.status(403).send('Forbidden'));

const server = https.createServer({
  key:  fs.readFileSync(path.join(__dirname, 'certs/key.pem')),
  cert: fs.readFileSync(path.join(__dirname, 'certs/cert.pem')),
}, app);

const wss = new WebSocket.Server({ server, maxPayload: 64 * 1024 }); // 64KB max frame

// ─── State ────────────────────────────────────────────────────────────────────

let paused         = false;
let connectedCount = 0;
let totalPhrases   = 0;
let totalWords     = 0;
let localIP        = 'localhost';
let startTime      = Date.now();
let renderQR       = () => {}; // assigned after server starts

const phoneStates  = new Map(); // ws -> { language, pttMode, clipboardMode, authed, deviceToken, pin }

// ─── TUI ──────────────────────────────────────────────────────────────────────

// Theme tokens (OpenCode-inspired)
const T = {
  bg:        '#0a0a0a',   // base background
  bgPanel:   '#141414',   // panel background
  bgElement: '#1e1e1e',   // nested element background
  primary:   '#e8a838',   // warm orange accent
  text:      '#eeeeee',   // main text
  textMuted: '#808080',   // dimmed text
  textDim:   '#555555',   // very dimmed
  border:    '#333333',   // subtle border
  green:     '#7fd88f',   // success / connected
  red:       '#e06c75',   // error / disconnect
  purple:    '#9d7cd8',   // auth / accent
  blue:      '#5c9cf5',   // secondary
  yellow:    '#e5c07b',   // warning
  cyan:      '#56b6c2',   // info
};

// ── Headless stubs — console-only logging, no TUI ──
let screen, titleBar, mainPanel, logBox, liveBox, liveAccent, qrOverlay, qrTitle, qrInfo, qrBox, bottomBar;

if (HEADLESS) {
  // Minimal stubs so the rest of the code doesn't crash
  screen = { render() {}, append() {}, key() {}, unkey() {}, destroy() {}, width: 80, height: 24, emit() {} };
} else {
  screen = blessed.screen({ smartCSR: true, title: 'VoiceBridge', fullUnicode: true });

  // ── Header bar — clean, minimal ──
  titleBar = blessed.box({
    top: 0, left: 0, width: '100%', height: 1, tags: true,
    style: { fg: T.text, bg: T.bgPanel },
  });

  // ── Main area — no border, just background ──
  mainPanel = blessed.box({
    top: 1, left: 0, width: '100%', height: '100%-2',
    style: { bg: T.bg },
  });

  logBox = blessed.log({
    parent: mainPanel, top: 0, left: 2, width: '100%-4', height: '100%-4',
    tags: true, scrollable: true, alwaysScroll: true, mouse: true,
    scrollbar: { ch: '│', track: { bg: T.bg }, style: { fg: T.border } },
    style: { fg: T.text, bg: T.bg },
  });

  // ── Live preview — subtle elevated background, left accent ──
  liveBox = blessed.box({
    parent: mainPanel, bottom: 0, left: 0, width: '100%', height: 4,
    style: { bg: T.bgPanel },
    tags: true, padding: { left: 3, top: 1 },
    content: `{${T.textDim}-fg}Waiting for speech...{/${T.textDim}-fg}`,
  });
  liveAccent = blessed.box({
    parent: mainPanel, bottom: 1, left: 1, width: 1, height: 2,
    style: { bg: T.bg },
    tags: true,
    content: `{${T.primary}-fg}┃{/${T.primary}-fg}\n{${T.primary}-fg}┃{/${T.primary}-fg}`,
  });

  // ── QR overlay — dynamically sized based on terminal ──
  qrOverlay = blessed.box({
    top: 'center', left: 'center',
    width: 50, height: 24,
    border: { type: 'line' },
    style: { border: { fg: T.border }, bg: '#1c1c1e' },
    tags: true,
    hidden: false,
  });

  qrTitle = blessed.box({
    parent: qrOverlay, top: 0, left: 2, width: '100%-6', height: 1,
    tags: true, style: { bg: '#1c1c1e' },
    content: `{bold}{${T.primary}-fg}Scan to Connect{/${T.primary}-fg}{/bold}`,
  });

  qrInfo = blessed.box({
    parent: qrOverlay, top: 2, left: 2, width: '100%-6', height: 3,
    tags: true, style: { bg: '#1c1c1e' },
  });

  qrBox = blessed.box({
    parent: qrOverlay, top: 5, left: 2, width: '100%-6', height: '100%-7',
    tags: true, style: { fg: '#e8dcc8', bg: '#1c1c1e' },
    content: '',
  });

  // ── Bottom bar — minimal, muted ──
  bottomBar = blessed.box({
    bottom: 0, left: 0, width: '100%', height: 1, tags: true,
    style: { fg: T.textMuted, bg: T.bgPanel },
  });

  screen.append(titleBar);
  screen.append(mainPanel);
  screen.append(bottomBar);
  // QR overlay must be appended last so it renders on top
  screen.append(qrOverlay);
}

// ─── TUI helpers ──────────────────────────────────────────────────────────────

function fmtUptime() {
  const s = Math.floor((Date.now() - startTime) / 1000);
  const h = Math.floor(s/3600), m = Math.floor((s%3600)/60), ss = s%60;
  return `${String(h).padStart(2,'0')}:${String(m).padStart(2,'0')}:${String(ss).padStart(2,'0')}`;
}

// Show/hide QR overlay based on connection state
let qrVisible = true;
function updateQRVisibility() {
  if (HEADLESS) return;
  const hasClient = connectedCount > 0;
  if (hasClient && qrVisible) {
    qrOverlay.hide();
    qrVisible = false;
    screen.render();
  } else if (!hasClient && !qrVisible) {
    qrOverlay.show();
    qrVisible = true;
    screen.render();
  }
}

function updateTitleBar() {
  if (HEADLESS) return;
  // Left side: brand + status dots
  const clientDot = connectedCount > 0
    ? `{${T.green}-fg}●{/${T.green}-fg} ${connectedCount} device${connectedCount > 1 ? 's' : ''}`
    : `{${T.textDim}-fg}○ waiting{/${T.textDim}-fg}`;
  const relayDot = relayStatus === 'connected' ? `{${T.green}-fg}●{/${T.green}-fg} relay`
    : relayStatus === 'connecting' ? `{${T.yellow}-fg}◐{/${T.yellow}-fg} relay`
    : relayStatus === 'error' ? `{${T.red}-fg}●{/${T.red}-fg} relay`
    : '';
  const aiDot = config.aiEnabled && getAiApiKey()
    ? `{${T.green}-fg}●{/${T.green}-fg} AI` : '';
  const pauseDot = paused ? `{${T.red}-fg}● PAUSED{/${T.red}-fg}` : '';

  // Right side: uptime + phrase count
  const stats = [];
  if (totalPhrases > 0) stats.push(`${totalPhrases} phrases`);
  stats.push(fmtUptime());
  const right = `{${T.textMuted}-fg}${stats.join('  ')}{/${T.textMuted}-fg}`;

  // Build left
  const parts = [`  {bold}{${T.primary}-fg}VoiceBridge{/${T.primary}-fg}{/bold}`, clientDot];
  if (relayDot) parts.push(relayDot);
  if (aiDot) parts.push(aiDot);
  if (pauseDot) parts.push(pauseDot);
  const left = parts.join(`  {${T.border}-fg}·{/${T.border}-fg}  `);

  // Pad right side to right-align (blessed doesn't have flexbox, so we just append)
  titleBar.setContent(`${left}    ${right}`);
}

function badge(label, value, color) {
  const safe = String(value).replace(/[{}]/g, c => c === '{' ? '\\{' : '\\}');
  return `{${T.textDim}-fg}${label}{/${T.textDim}-fg} {${color}-fg}${safe}{/${color}-fg}`;
}

function updateStatus() {
  if (HEADLESS) return;
  updateTitleBar();
  updateQRVisibility();

  // bottom bar — left: directory/mode info, right: shortcuts
  const states = [...phoneStates.values()].filter(s => s.authed);
  let modeInfo = '';
  if (states.length > 0) {
    const s = states[0];
    modeInfo = `{${T.textDim}-fg}${s.language || config.language} · ${s.pttMode ? 'Hold' : 'Toggle'} · ${s.clipboardMode ? 'Clipboard' : 'Direct'}{/${T.textDim}-fg}`;
  }

  const left = modeInfo ? `  ${modeInfo}` : `  {${T.textDim}-fg}VoiceBridge{/${T.textDim}-fg}`;
  const right = `{${T.textDim}-fg}Ctrl+K{/${T.textDim}-fg} {${T.textMuted}-fg}commands{/${T.textMuted}-fg}  `;

  bottomBar.setContent(`${left}${' '.repeat(Math.max(0, (screen.width || 80) - 40))}${right}`);
  screen.render();
}

setInterval(updateStatus, 1000);

function logPhrase(text, type = 'info') {
  const time = new Date().toLocaleTimeString('en-GB', { hour:'2-digit', minute:'2-digit', second:'2-digit' });
  if (HEADLESS) {
    const prefix = { phrase: '📝', command: '⚙', connect: '✓', disconnect: '✗', warn: '⚠', auth: '🔑', info: 'ℹ' };
    console.log(`[${time}] ${prefix[type] || 'ℹ'}  ${text}`);
    return;
  }
  const ts = `{${T.textDim}-fg}${time}{/${T.textDim}-fg}`;
  const safe = String(text).replace(/[{}]/g, c => c === '{' ? '\\{' : '\\}');
  // Left accent marker + colored text (OpenCode style)
  const markers = {
    phrase:     { mark: T.text,    color: T.text },
    command:    { mark: T.primary, color: T.primary },
    connect:    { mark: T.green,   color: T.green },
    disconnect: { mark: T.red,     color: T.red },
    warn:       { mark: T.red,     color: T.red },
    auth:       { mark: T.purple,  color: T.purple },
    info:       { mark: T.textMuted, color: T.textMuted },
  };
  const m = markers[type] || markers.info;
  logBox.log(`  {${m.mark}-fg}┃{/${m.mark}-fg} ${ts}  {${m.color}-fg}${safe}{/${m.color}-fg}`);
  screen.render();
}

function setLive(text, isFinal = false) {
  if (HEADLESS) return;
  const safe = String(text).replace(/[{}]/g, c => c === '{' ? '\\{' : '\\}');
  liveBox.setContent(isFinal
    ? `{${T.text}-fg}{bold}${safe}{/bold}{/${T.text}-fg}`
    : `{${T.textMuted}-fg}${safe}{/${T.textMuted}-fg}`);
  // Update accent color based on state
  const col = isFinal ? T.green : T.primary;
  liveAccent.setContent(`{${col}-fg}┃{/${col}-fg}\n{${col}-fg}┃{/${col}-fg}`);
  screen.render();
}

// ─── PIN approval popup ───────────────────────────────────────────────────────

const pinQueue = []; // { pin, ws } — queued when a prompt is already showing
const PIN_QUEUE_MAX = 10; // max pending PIN approvals
let pinPromptActive = false;

function processPinQueue() {
  if (pinPromptActive || !pinQueue.length) return;
  const { pin, ws } = pinQueue.shift();
  // skip if phone already disconnected while waiting in queue
  if (ws.readyState !== WebSocket.OPEN) { processPinQueue(); return; }
  pinPromptActive = true;
  _showPinPopup(pin, ws);
}

function showPinPrompt(pin, ws) {
  // reject if queue is full — prevents unbounded memory growth from many new devices
  if (pinQueue.length >= PIN_QUEUE_MAX) {
    safeSend(ws, { type: 'auth', status: 'rejected' });
    ws.close();
    return;
  }
  // remove from queue if phone disconnects while waiting
  ws.once('close', () => {
    const idx = pinQueue.findIndex(e => e.ws === ws);
    if (idx !== -1) pinQueue.splice(idx, 1);
  });
  pinQueue.push({ pin, ws });
  processPinQueue();
}

function _showPinPopup(pin, ws) {
  const popup = blessed.box({
    parent: screen, top: 'center', left: 'center', width: 44, height: 9,
    border: { type: 'line' },
    style: { border: { fg: T.purple }, bg: T.bgPanel },
    tags: true, padding: { left: 2, right: 2 },
  });
  blessed.text({
    parent: popup, top: 1, left: 2, tags: true,
    content:
      `{bold}{${T.purple}-fg}New Device{/${T.purple}-fg}{/bold}\n\n` +
      `  PIN:  {bold}{${T.purple}-fg}${pin}{/${T.purple}-fg}{/bold}\n\n` +
      `{${T.textDim}-fg}Y{/${T.textDim}-fg} {${T.textMuted}-fg}approve{/${T.textMuted}-fg}    {${T.textDim}-fg}N{/${T.textDim}-fg} {${T.textMuted}-fg}reject{/${T.textMuted}-fg}`,
  });

  let done = false;
  function cleanup() {
    if (done) return;
    done = true;
    screen.unkey('y', onY);
    screen.unkey('n', onN);
    popup.destroy();
    pinPromptActive = false;
    screen.render();
    processPinQueue();
  }

  function onY() {
    cleanup();
    // cap sessions to prevent unbounded growth of sessions.json
    if (Object.keys(sessions).length >= MAX_SESSIONS) {
      // evict the oldest session to make room
      const oldest = Object.entries(sessions).sort((a, b) => (a[1].lastSeen || 0) - (b[1].lastSeen || 0))[0];
      if (oldest) delete sessions[oldest[0]];
    }
    const deviceToken = crypto.randomBytes(16).toString('hex');
    sessions[deviceToken] = { approved: true, lastSeen: Date.now() };
    saveSessions(sessions);
    const state = phoneStates.get(ws);
    if (state) { state.authed = true; state.deviceToken = deviceToken; }
    connectedCount++;
    safeSend(ws, { type: 'auth', status: 'approved', deviceToken });
    logPhrase(`Device approved — token saved`, 'auth');
    updateStatus();
  }

  function onN() {
    cleanup();
    safeSend(ws, { type: 'auth', status: 'rejected' });
    ws.close();
    logPhrase(`Device rejected`, 'warn');
  }

  // Auto-dismiss if phone disconnects before approval
  ws.once('close', () => cleanup());

  screen.key('y', onY);
  screen.key('n', onN);
  screen.render();
}

// ─── Key bindings ─────────────────────────────────────────────────────────────

if (!HEADLESS) {

screen.key(['C-q', 'C-c'], () => shutdown());

screen.key('C-p', () => {
  paused = !paused;
  logPhrase(paused ? 'Paused from keyboard' : 'Resumed from keyboard', 'command');
  broadcast({ type: 'paused', value: paused });
  updateStatus();
});

screen.key('C-l', () => { logBox.setContent(''); logPhrase('Log cleared', 'info'); });

// ─── Command Palette (Ctrl+K) ────────────────────────────────────────────────

screen.key('C-k', showCommandPalette);

function showCommandPalette() {
  const items = [
    { label: 'Toggle Pause',       action: 'pause' },
    { label: 'Relay Servers',      action: 'relay' },
    { label: 'AI Settings',        action: 'ai' },
    { label: 'Add Word Replace',   action: 'replace' },
    { label: 'Delete Word Replace', action: 'delreplace' },
    { label: 'Clear Log',          action: 'clear' },
    { label: 'Quit',               action: 'quit' },
  ];

  const palette = blessed.list({
    parent: screen, top: 'center', left: 'center',
    width: 34, height: items.length + 2,
    border: { type: 'line' },
    style: {
      border: { fg: T.border }, bg: T.bgPanel,
      item: { fg: T.textMuted, bg: T.bgPanel },
      selected: { fg: T.bg, bg: T.primary, bold: true },
    },
    keys: true, vi: true, mouse: true,
    items: items.map(i => `  ${i.label}`),
  });

  palette.focus();
  screen.render();

  function close() { screen.unkey('escape', close); palette.destroy(); screen.render(); }
  screen.key('escape', close);

  palette.on('select', (el, idx) => {
    close();
    const act = items[idx].action;
    if (act === 'pause')      { paused = !paused; logPhrase(paused ? 'Paused' : 'Resumed', 'command'); broadcast({ type: 'paused', value: paused }); updateStatus(); }
    else if (act === 'relay') { showRelayServers(); }
    else if (act === 'ai')    { showAiSettings(); }
    else if (act === 'replace') { showAddReplace(); }
    else if (act === 'delreplace') { showDelReplace(); }
    else if (act === 'clear') { logBox.setContent(''); logPhrase('Log cleared', 'info'); }
    else if (act === 'quit')  { shutdown(); }
  });
}

screen.key('C-e', showRelayServers);
function showRelayServers() {
  if (!Array.isArray(config.relayServers)) config.relayServers = [...DEFAULT_CONFIG.relayServers];
  if (config.relayServers.length === 0) config.relayServers = [...DEFAULT_CONFIG.relayServers];

  const form = blessed.box({
    parent: screen, top: 'center', left: 'center',
    width: 60, height: 20,
    border: { type: 'line' },
    style: { border: { fg: T.border }, bg: T.bgPanel },
    tags: true, padding: { left: 2, right: 2 },
  });

  blessed.box({
    parent: form, top: 0, left: 0, width: '100%-4', height: 2,
    tags: true, style: { bg: T.bgPanel },
    content:
      `{bold}{${T.purple}-fg}Relay Servers{/${T.purple}-fg}{/bold}\n` +
      `{${T.textDim}-fg}Select, add, or remove relay servers{/${T.textDim}-fg}`,
  });

  function buildItems() {
    const items = config.relayServers.map(s => {
      const active = s.url === config.relayUrl ? ` {${T.green}-fg}●{/${T.green}-fg}` : '';
      return `  ${s.name || s.url.slice(0, 40)}${active}`;
    });
    items.push(`  {${T.cyan}-fg}+ Add custom server{/${T.cyan}-fg}`);
    items.push(`  {${T.red}-fg}- Remove a server{/${T.red}-fg}`);
    items.push(`  {${T.yellow}-fg}× Disable relay{/${T.yellow}-fg}`);
    return items;
  }

  const sList = blessed.list({
    parent: form, top: 3, left: 0, width: '100%-4',
    height: Math.min(config.relayServers.length + 5, 12),
    keys: true, vi: true, mouse: true, tags: true,
    style: {
      bg: T.bgPanel,
      item: { fg: T.textMuted, bg: T.bgPanel },
      selected: { fg: T.text, bg: T.bgElement, bold: true },
    },
    items: buildItems(),
  });

  blessed.box({
    parent: form, bottom: 0, left: 0, width: '100%-4', height: 1,
    tags: true, style: { bg: T.bgPanel },
    content: `{${T.textDim}-fg}Enter to select · Esc to cancel{/${T.textDim}-fg}`,
  });

  sList.focus();
  screen.render();

  function onEscE() {
    screen.unkey('escape', onEscE);
    form.destroy();
    screen.render();
  }
  screen.key('escape', onEscE);

  sList.on('select', (item, idx) => {
    screen.unkey('escape', onEscE);
    form.destroy();
    screen.render();

    if (idx < config.relayServers.length) {
      // Selected existing server — activate it
      const srv = config.relayServers[idx];
      config.relayUrl = srv.url;
      config.relaySecret = srv.secret || '';
      config.relayRejectUnauthorized = true;
      saveConfig(config);
      logPhrase(`Relay set: ${srv.name || srv.url}`, 'command');
      relayStopped = true;
      relayRoomToken = null;
      if (relayWs) { try { relayWs.terminate(); } catch {} relayWs = null; }
      updateStatus();
      renderQR();
      connectRelay();
    } else if (idx === config.relayServers.length) {
      // Add custom
      showCtrlEAddCustom();
    } else if (idx === config.relayServers.length + 1) {
      // Remove
      showCtrlERemove();
    } else if (idx === config.relayServers.length + 2) {
      // Disable relay
      config.relayUrl = '';
      config.relaySecret = '';
      saveConfig(config);
      relayStopped = true;
      relayRoomToken = null;
      if (relayWs) { try { relayWs.terminate(); } catch {} relayWs = null; }
      logPhrase('Relay disabled', 'command');
      updateStatus();
      renderQR();
    }
  });

  function showCtrlEAddCustom() {
    // Step 1: Name
    promptInput('Server name:', '', (name) => {
      if (name === null) return;
      // Step 2: URL
      promptInput('Relay URL:', 'wss://', (url) => {
        if (url === null || !url || url === 'wss://' || !/^wss?:\/\/.+/.test(url)) return;
        // Step 3: Secret
        promptInput('Secret (blank if none):', '', (secret) => {
          if (secret === null) secret = '';
          const entry = { name: name || url.replace(/^wss?:\/\//, '').slice(0, 40), url, secret };
          if (!config.relayServers.some(s => s.url === url)) config.relayServers.push(entry);
          config.relayUrl = url;
          config.relaySecret = secret;
          config.relayRejectUnauthorized = true;
          saveConfig(config);
          logPhrase(`Relay added: ${entry.name}`, 'command');
          relayStopped = true;
          relayRoomToken = null;
          if (relayWs) { try { relayWs.terminate(); } catch {} relayWs = null; }
          updateStatus(); renderQR();
          connectRelay();
        });
      });
    });
  }

  function showCtrlERemove() {
    if (!config.relayServers || config.relayServers.length === 0) return;

    const rmList = blessed.list({
      parent: screen, top: 'center', left: 'center',
      width: 56, height: Math.min(config.relayServers.length + 4, 18),
      border: { type: 'line' },
      style: { border: { fg: T.red }, bg: T.bgPanel, item: { fg: T.textMuted, bg: T.bgPanel }, selected: { bg: '#3a1a1a', fg: T.text } },
      label: { text: ` Remove `, side: 'left', style: { fg: T.red } },
      keys: true, vi: true, mouse: true, tags: true,
      items: config.relayServers.map(s => `  ${s.name || s.url.slice(0, 45)}`),
    });

    rmList.focus();
    screen.render();

    function onRmEsc() { screen.unkey('escape', onRmEsc); rmList.destroy(); screen.render(); }
    screen.key('escape', onRmEsc);

    rmList.on('select', (item, idx) => {
      screen.unkey('escape', onRmEsc);
      const removed = config.relayServers.splice(idx, 1)[0];
      if (removed && removed.url === config.relayUrl) {
        config.relayUrl = '';
        config.relaySecret = '';
        relayStopped = true;
        relayRoomToken = null;
        if (relayWs) { try { relayWs.terminate(); } catch {} relayWs = null; }
      }
      saveConfig(config);
      logPhrase(`Removed relay: ${removed ? removed.name || removed.url : '?'}`, 'command');
      updateStatus();
      renderQR();
      rmList.destroy();
      screen.render();
    });
  }
}

screen.key('C-a', showAiSettings);
function showAiSettings() {
  const providers = ['openai', 'anthropic', 'google'];
  let selProvider   = config.aiProvider || 'openai';
  let pendingEnabled = config.aiEnabled;
  const form = blessed.form({ parent: screen, top: 'center', left: 'center', width: 60, height: 18, border: { type: 'line' }, style: { border: { fg: T.border }, bg: T.bgPanel }, keys: true });
  blessed.text({ parent: form, top: 0, left: 2, tags: true, content: `{bold}{${T.green}-fg}AI Settings{/${T.green}-fg}{/bold}`, style: { bg: T.bgPanel } });
  blessed.text({ parent: form, top: 2, left: 2, content: 'Provider:', style: { fg: T.textMuted, bg: T.bgPanel } });
  const provLabel = blessed.text({ parent: form, top: 2, left: 12, tags: true, style: { bg: T.bgPanel } });
  function updateProvLabel() { provLabel.setContent(`{${T.green}-fg}${selProvider}{/${T.green}-fg}  {${T.textDim}-fg}[←/→ or Ctrl+N]{/${T.textDim}-fg}`); screen.render(); }
  updateProvLabel();
  blessed.text({ parent: form, top: 4, left: 2, content: 'API Key (saved to .env):', style: { fg: T.textMuted, bg: T.bgPanel } });
  const currentKey = getAiApiKey();
  const maskedKey = currentKey ? currentKey.slice(0, 6) + '...' + currentKey.slice(-4) : '';
  const keyInput = blessed.textbox({ parent: form, top: 5, left: 2, width: 54, height: 1, style: { fg: T.text, bg: T.bgElement }, inputOnFocus: true, value: maskedKey });
  blessed.text({ parent: form, top: 7, left: 2, content: 'Model (blank = default):', style: { fg: T.textMuted, bg: T.bgPanel } });
  const modelInput = blessed.textbox({ parent: form, top: 8, left: 2, width: 54, height: 1, style: { fg: T.text, bg: T.bgElement }, inputOnFocus: true, value: config.aiModel || '' });
  blessed.text({ parent: form, top: 10, left: 2, content: 'Prompt:', style: { fg: T.textMuted, bg: T.bgPanel } });
  const promptInput = blessed.textbox({ parent: form, top: 11, left: 2, width: 54, height: 1, style: { fg: T.text, bg: T.bgElement }, inputOnFocus: true, value: config.aiPrompt || DEFAULT_CONFIG.aiPrompt });
  const enabledLabel = blessed.text({ parent: form, top: 13, left: 2, tags: true, style: { bg: T.bgPanel } });
  function updateEnabledLabel() { enabledLabel.setContent(`{${T.textMuted}-fg}AI:{/${T.textMuted}-fg} {${pendingEnabled ? T.green : T.red}-fg}${pendingEnabled ? 'enabled' : 'disabled'}{/${pendingEnabled ? T.green : T.red}-fg}  {${T.textDim}-fg}[Ctrl+T]{/${T.textDim}-fg}`); screen.render(); }
  updateEnabledLabel();
  blessed.text({ parent: form, top: 15, left: 2, content: 'Tab fields · Enter save · Esc cancel', style: { fg: T.textDim, bg: T.bgPanel } });

  // provider cycling — arrow keys work when form is focused, Ctrl+N works from any field
  form.key('right', () => { const idx = providers.indexOf(selProvider); selProvider = providers[(idx + 1) % providers.length]; updateProvLabel(); });
  form.key('left',  () => { const idx = providers.indexOf(selProvider); selProvider = providers[(idx - 1 + providers.length) % providers.length]; updateProvLabel(); });
  const cycleProvider = () => { const idx = providers.indexOf(selProvider); selProvider = providers[(idx + 1) % providers.length]; updateProvLabel(); };
  keyInput.key('C-n',    cycleProvider);
  modelInput.key('C-n',  cycleProvider);
  promptInput.key('C-n', cycleProvider);
  const toggleEnabled = () => { pendingEnabled = !pendingEnabled; updateEnabledLabel(); };
  form.key('C-t',       toggleEnabled);
  keyInput.key('C-t',   toggleEnabled);
  modelInput.key('C-t', toggleEnabled);
  promptInput.key('C-t',toggleEnabled);

  keyInput.key('tab',    () => modelInput.focus());
  keyInput.key('enter',  () => modelInput.focus());
  modelInput.key('tab',  () => promptInput.focus());
  modelInput.key('enter',() => promptInput.focus());
  promptInput.key('tab', () => keyInput.focus());

  function onEscA() { form.destroy(); screen.unkey('escape', onEscA); screen.render(); }
  function save() {
    screen.unkey('escape', onEscA);
    config.aiEnabled  = pendingEnabled;
    config.aiProvider = selProvider;
    config.aiModel    = modelInput.getValue().trim().slice(0, 100);
    config.aiPrompt   = promptInput.getValue().trim().slice(0, 1000) || DEFAULT_CONFIG.aiPrompt;
    // Save API key to .env file (not config.json)
    const newKey = keyInput.getValue().trim().slice(0, 200);
    // Only update if user typed a real new key (not the masked version)
    if (newKey && !newKey.includes('...')) {
      process.env.VOICEBRIDGE_AI_KEY = newKey;
      try {
        let envContent = fs.existsSync(ENV_PATH) ? fs.readFileSync(ENV_PATH, 'utf8') : '';
        if (envContent.includes('VOICEBRIDGE_AI_KEY')) {
          envContent = envContent.replace(/^VOICEBRIDGE_AI_KEY=.*$/m, `VOICEBRIDGE_AI_KEY=${newKey}`);
        } else {
          envContent += `${envContent && !envContent.endsWith('\n') ? '\n' : ''}VOICEBRIDGE_AI_KEY=${newKey}\n`;
        }
        fs.writeFileSync(ENV_PATH, envContent);
      } catch (e) { logPhrase(`Failed to save .env: ${e.message}`, 'warn'); }
    }
    // reset cached SDK instances so they pick up the new key/provider
    _openai = null; _anthropic = null; _google = null;
    saveConfig(config);
    form.destroy();
    logPhrase(`AI: ${config.aiEnabled ? 'enabled' : 'disabled'} — provider: ${config.aiProvider}`, 'command');
    updateStatus();
  }
  promptInput.key('enter', save);
  screen.key('escape', onEscA);
  screen.render(); keyInput.focus();
}

screen.key('C-r', showAddReplace);
function showAddReplace() {  const form = blessed.form({ parent: screen, top: 'center', left: 'center', width: 50, height: 10, border: { type: 'line' }, style: { border: { fg: T.border }, bg: T.bgPanel }, keys: true });
  blessed.text({ parent: form, top: 0, left: 2, tags: true, content: `{bold}{${T.yellow}-fg}Add Replacement{/${T.yellow}-fg}{/bold}`, style: { bg: T.bgPanel } });
  blessed.text({ parent: form, top: 2, left: 2, content: 'Say this:', style: { fg: T.textMuted, bg: T.bgPanel } });
  const fromInput = blessed.textbox({ parent: form, top: 3, left: 2, width: 44, height: 1, style: { fg: T.text, bg: T.bgElement }, inputOnFocus: true });
  blessed.text({ parent: form, top: 5, left: 2, content: 'Type this:', style: { fg: T.textMuted, bg: T.bgPanel } });
  const toInput = blessed.textbox({ parent: form, top: 6, left: 2, width: 44, height: 1, style: { fg: T.text, bg: T.bgElement }, inputOnFocus: true });
  blessed.text({ parent: form, top: 8, left: 2, content: 'Tab switch · Enter save · Esc cancel', style: { fg: T.textDim, bg: T.bgPanel } });
  fromInput.focus();
  fromInput.key('tab', () => toInput.focus());
  fromInput.key('enter', () => toInput.focus());
  toInput.key('tab', () => fromInput.focus());
  function onEscR() { form.destroy(); screen.unkey('escape', onEscR); screen.render(); }
  toInput.key('enter', () => {
    screen.unkey('escape', onEscR);
    const from = fromInput.getValue().trim().toLowerCase().slice(0, 200);
    const to   = toInput.getValue().trim().slice(0, 500);
    const FORBIDDEN = ['__proto__', 'constructor', 'prototype'];
    if (from && to && !FORBIDDEN.includes(from)) {
      config.wordReplacements[from] = to; saveConfig(config); logPhrase(`Replacement: "${from}" → "${to}"`, 'command');
    }
    form.destroy(); updateStatus();
  });
  screen.key('escape', onEscR);
  screen.render(); fromInput.focus();
}

screen.key('C-d', showDelReplace);
function showDelReplace() {
  const repls = Object.keys(config.wordReplacements || {});
  if (!repls.length) { logPhrase('No replacements to delete', 'warn'); return; }
  const list = blessed.list({ parent: screen, top: 'center', left: 'center', width: 50, height: Math.min(repls.length+4, 20), border: { type: 'line' }, style: { border: { fg: T.red }, bg: T.bgPanel, item: { fg: T.textMuted, bg: T.bgPanel }, selected: { bg: '#3a1a1a', fg: T.text } }, label: { text: ` Remove `, side: 'left', style: { fg: T.red } }, keys: true, vi: true, items: repls.map(k => `  ${k}  →  ${config.wordReplacements[k]}`) });
  list.focus();
  list.key('enter', () => { const key = repls[list.selected]; delete config.wordReplacements[key]; saveConfig(config); logPhrase(`Removed: "${key}"`, 'command'); list.destroy(); updateStatus(); });
  list.key('escape', () => { list.destroy(); screen.render(); });
  screen.render();
}

} // end if (!HEADLESS)

// ─── Helpers ──────────────────────────────────────────────────────────────────

// Small single-field prompt dialog — cb(value) or cb(null) on Esc
function promptInput(label, defaultVal, cb) {
  const box = blessed.box({
    parent: screen, top: 'center', left: 'center',
    width: 48, height: 5,
    border: { type: 'line' },
    style: { border: { fg: T.border }, bg: T.bgPanel },
    label: { text: ` ${label} `, side: 'left', style: { fg: T.primary } },
    tags: true, padding: { left: 1, right: 1 },
  });
  const input = blessed.textbox({
    parent: box, top: 1, left: 0, width: '100%-2', height: 1,
    style: { fg: T.text, bg: T.bgElement },
    inputOnFocus: true, value: defaultVal || '',
  });
  input.focus();
  screen.render();

  function close(val) {
    screen.unkey('escape', onEsc);
    box.destroy();
    screen.render();
    cb(val);
  }
  function onEsc() { close(null); }
  screen.key('escape', onEsc);
  input.key('enter', () => { close(input.getValue().trim().slice(0, 500)); });
}

function runCmd(cmd, cb) { exec(cmd, (err) => { if (err) logPhrase(`xdotool: ${err.message}`, 'warn'); cb && cb(); }); }
function escape(text) {
  // Strip control characters (null bytes, escape sequences, etc.) then escape single quotes for shell
  return text.replace(/[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/g, '').replace(/'/g, "'\\''");
}
function safeKey(key) { return String(key).replace(/[^a-zA-Z0-9_\- ]/g, ''); }
function safeSend(ws, data) { if (ws && ws.readyState === WebSocket.OPEN) { try { ws.send(typeof data === 'string' ? data : JSON.stringify(data)); } catch {} } }

// ─── OpLog — linked operation history for tracking typed text ─────────────────
// Each node represents a typed or deleted segment. Nodes form a chain.
// On final, we diff against committed (known-done) text and fix only the damage.

class OpLog {
  constructor() {
    this._nodes = [];   // { id, type:'type'|'delete', text, charCount, status:'queued'|'running'|'done', interim:bool }
    this._nextId = 0;
    this._running = false;
    this._runCb = null;  // callback for current running op
  }

  // Replay nodes up to a given status filter to reconstruct on-screen text
  _replay(includeStatuses) {
    let text = '';
    for (const n of this._nodes) {
      if (!includeStatuses.includes(n.status)) continue;
      if (n.type === 'type') text += n.text;
      else if (n.type === 'delete') text = text.slice(0, Math.max(0, text.length - n.charCount));
    }
    return text;
  }

  // What we KNOW is on screen (only completed ops)
  committedText() { return this._replay(['done']); }

  // What SHOULD be on screen once everything drains
  projectedText() { return this._replay(['done', 'running', 'queued']); }

  // Add a type op
  addType(text, interim = false) {
    const node = { id: this._nextId++, type: 'type', text, charCount: text.length, status: 'queued', interim };
    this._nodes.push(node);
    return node;
  }

  // Add a delete op
  addDelete(charCount, interim = false) {
    if (charCount <= 0) return null;
    const node = { id: this._nextId++, type: 'delete', text: '', charCount, status: 'queued', interim };
    this._nodes.push(node);
    return node;
  }

  // Cancel all queued interim ops (not yet running)
  cancelInterims() {
    this._nodes = this._nodes.filter(n => !(n.interim && n.status === 'queued'));
  }

  // Cancel ALL queued ops
  cancelQueued() {
    this._nodes = this._nodes.filter(n => n.status !== 'queued');
  }

  // Mark the next queued node as running, execute it, mark done on callback
  drain(execFn) {
    if (this._running) return;
    const next = this._nodes.find(n => n.status === 'queued');
    if (!next) return;
    this._running = true;
    next.status = 'running';

    const cmd = next.type === 'type'
      ? `xdotool type --clearmodifiers -- '${escape(next.text)}'`
      : `xdotool key --clearmodifiers --repeat ${Math.min(next.charCount, 500)} BackSpace`;

    execFn(cmd, () => {
      next.status = 'done';
      this._running = false;
      // Compact: merge consecutive done type nodes to save memory
      this._compact();
      this.drain(execFn);
    });
  }

  // Merge consecutive done nodes of same type to keep list short
  _compact() {
    const merged = [];
    for (const n of this._nodes) {
      const prev = merged.length > 0 ? merged[merged.length - 1] : null;
      if (prev && prev.status === 'done' && n.status === 'done' && prev.type === 'type' && n.type === 'type') {
        prev.text += n.text;
        prev.charCount += n.charCount;
      } else {
        merged.push(n);
      }
    }
    this._nodes = merged;
  }

  // Reset everything (on disconnect, new phrase boundary)
  reset() {
    this._nodes = [];
    this._running = false;
  }

  // How many chars are projected on screen
  projectedLength() { return this.projectedText().length; }
}

function applyReplacements(text) {
  let out = text;
  for (const [from, to] of Object.entries(config.wordReplacements || {})) {
    if (typeof from !== 'string' || typeof to !== 'string') continue;
    if (from.length > 200 || to.length > 500) continue; // skip oversized entries from config.json
    // escape regex special chars in the key so literal strings always match
    const escaped = from.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    out = out.replace(new RegExp(`\\b${escaped}\\b`, 'gi'), () => to);
  }
  return out;
}

function toClipboard(text, cb) { const p = exec('xclip -selection clipboard', cb); p.stdin.write(text); p.stdin.end(); }

// ─── AI summarize ─────────────────────────────────────────────────────────────

const AI_DEFAULTS = { openai: 'gpt-4o-mini', anthropic: 'claude-3-5-haiku-latest', google: 'gemini-1.5-flash' };

async function aiSummarize(text) {
  if (!config.aiEnabled || !getAiApiKey()) return text;
  const input = text.slice(0, 4000); // cap to ~1000 tokens before sending
  const model = config.aiModel || AI_DEFAULTS[config.aiProvider] || AI_DEFAULTS.openai;
  const prompt = config.aiPrompt || DEFAULT_CONFIG.aiPrompt;
  try {
    if (config.aiProvider === 'openai') {
      const res = await getOpenAI().chat.completions.create({
        model,
        messages: [{ role: 'user', content: `${prompt}\n\n${input}` }],
        max_tokens: 1024,
      });
      return res.choices[0]?.message?.content?.trim() || text;
    }
    if (config.aiProvider === 'anthropic') {
      const res = await getAnthropic().messages.create({
        model,
        max_tokens: 1024,
        messages: [{ role: 'user', content: `${prompt}\n\n${input}` }],
      });
      return res.content[0]?.text?.trim() || text;
    }
    if (config.aiProvider === 'google') {
      const genModel = getGoogle().getGenerativeModel({ model });
      const res = await genModel.generateContent(`${prompt}\n\n${input}`);
      return res.response.text()?.trim() || text;
    }
  } catch (e) {
    logPhrase(`AI error: ${e.message}`, 'warn');
  }
  return text;
}

// ─── Shared connection handler (local WSS + relay VirtualWS) ─────────────────

const LOCAL_MAX_CLIENTS = 5;   // max simultaneous local WS connections
const LOCAL_REG_TIMEOUT = 8000; // drop unauthenticated sockets after 8s
const VIRTUAL_MAX_CLIENTS = 10; // max simultaneous relay virtual connections
const MSG_RATE_WINDOW = 1000;   // 1 second
const MSG_RATE_MAX    = 30;     // max messages per socket per second

function handleConnection(ws) {
  const isVirtual = ws instanceof VirtualWS;

  // cap local (non-relay) connections to prevent DoS
  if (!isVirtual && wss.clients.size > LOCAL_MAX_CLIENTS) {
    safeSend(ws, { type: 'error', reason: 'room-full' });
    ws.terminate();
    return;
  }

  phoneStates.set(ws, { language: config.language, pttMode: false, clipboardMode: config.clipboardMode, authed: false, deviceToken: null });

  // drop connections that never authenticate
  let regTimer;
  const regTimeout = isVirtual ? LOCAL_REG_TIMEOUT * 2 : LOCAL_REG_TIMEOUT; // virtual gets 16s, local 8s
  regTimer = setTimeout(() => {
    const state = phoneStates.get(ws);
    if (state && !state.authed) { ws.terminate(); }
  }, regTimeout);
  ws.once('close', () => clearTimeout(regTimer));

  if (!isVirtual) {  // keepalive — ping phone every 25s, terminate if no pong within 10s
    ws.isAlive = true;
    ws.on('pong', () => { ws.isAlive = true; clearTimeout(ws._pongTimeout); });
    ws._pingTimer = setInterval(() => {
      if (!ws.isAlive) { clearInterval(ws._pingTimer); ws.terminate(); return; }
      ws.isAlive = false;
      ws.ping();
      ws._pongTimeout = setTimeout(() => { if (!ws.isAlive) ws.terminate(); }, 10000);
    }, 25000);
    ws.on('close', () => { clearInterval(ws._pingTimer); clearTimeout(ws._pongTimeout); });
  }

  ws.on('message', (data) => {
    // ── Per-socket message rate limiting ──
    const now = Date.now();
    if (!ws._msgCount) { ws._msgCount = 0; ws._msgWindowStart = now; }
    if (now - ws._msgWindowStart > MSG_RATE_WINDOW) { ws._msgCount = 0; ws._msgWindowStart = now; }
    ws._msgCount++;
    if (ws._msgCount > MSG_RATE_MAX) {
      safeSend(ws, { type: 'error', reason: 'rate-limited' });
      ws.terminate();
      return;
    }

    let msg;
    try { msg = JSON.parse(data.toString()); } catch { return; }
    if (!msg || typeof msg !== 'object' || Array.isArray(msg)) return;
    const state = phoneStates.get(ws) || {};

    // ── Auth handshake ──
    if (msg.type === 'auth') {
      if (state.authed) return; // ignore re-auth from already-approved socket
      // returning device with saved token
      if (msg.deviceToken && typeof msg.deviceToken === 'string' && /^[a-f0-9]{32}$/.test(msg.deviceToken) && sessions[msg.deviceToken]?.approved === true) {
        sessions[msg.deviceToken].lastSeen = Date.now();
        saveSessions(sessions);
        state.authed = true;
        state.deviceToken = msg.deviceToken;
        phoneStates.set(ws, state);
        connectedCount++;
        safeSend(ws, { type: 'auth', status: 'approved', deviceToken: msg.deviceToken });
        safeSend(ws, { type: 'paused', value: paused });
        safeSend(ws, { type: 'aiEnabled', value: config.aiEnabled });
        logPhrase(`Known device reconnected`, 'connect');
        updateStatus();
        return;
      }
      // new device — generate PIN, show popup
      const pin = String(crypto.randomInt(100000, 1000000));
      safeSend(ws, { type: 'auth', status: 'pin', pin });
      logPhrase(`New device — PIN: ${pin}`, 'auth');
      showPinPrompt(pin, ws);
      return;
    }

    if (!state.authed) { safeSend(ws, { type: 'auth', status: 'required' }); return; }

    // ── Config updates ──
    if (msg.type === 'config') {
      if (typeof msg.clipboardMode === 'boolean') { state.clipboardMode = msg.clipboardMode; config.clipboardMode = msg.clipboardMode; saveConfig(config); logPhrase(`Clipboard: ${msg.clipboardMode ? 'on' : 'off'}`, 'command'); }
      if (typeof msg.pttMode === 'boolean')       { state.pttMode = msg.pttMode; logPhrase(`PTT: ${msg.pttMode ? 'on' : 'off'}`, 'command'); }
      if (typeof msg.language === 'string' && /^[a-zA-Z]{2,8}(-[a-zA-Z0-9]{2,8})*$/.test(msg.language)) { state.language = msg.language; logPhrase(`Language: ${msg.language}`, 'command'); }
      if (typeof msg.paused === 'boolean')        { paused = msg.paused; broadcast({ type: 'paused', value: paused }); logPhrase(paused ? 'Paused from phone' : 'Resumed from phone', 'command'); }
      if (typeof msg.aiEnabled === 'boolean')     { config.aiEnabled = msg.aiEnabled; saveConfig(config); logPhrase(`AI: ${msg.aiEnabled ? 'enabled' : 'disabled'}`, 'command'); updateStatus(); }
      phoneStates.set(ws, state);
      updateStatus();
      return;
    }

    if (paused || !msg.text) return;
    if (typeof msg.text !== 'string' || msg.text.length > 2000) return; // sanity cap

    // Initialize OpLog per socket
    if (!ws._oplog) ws._oplog = new OpLog();
    const oplog = ws._oplog;
    if (!ws._lastPhrase)    ws._lastPhrase = '';
    if (!ws._lastPhraseLen) ws._lastPhraseLen = 0;

    function execOp(cmd, cb) { runCmd(cmd, cb); }
    function drainOps() { oplog.drain(execOp); }

    function typeOrClip(text, interim = false) {
      if (state.clipboardMode) {
        toClipboard(text, (err) => { if (!err) exec('xdotool key --clearmodifiers ctrl+v'); });
      } else {
        oplog.addType(text, interim);
        drainOps();
      }
    }

    function deleteChars(count, interim = false) {
      if (count <= 0) return;
      oplog.addDelete(count, interim);
      drainOps();
    }

    // ── Find longest common prefix between two strings ──
    function commonPrefix(a, b) {
      let i = 0;
      while (i < a.length && i < b.length && a[i] === b[i]) i++;
      return i;
    }

    if (msg.type === 'interim') {
      setLive(msg.text, false);
      const projected = oplog.projectedText();

      if (msg.text.startsWith(projected)) {
        // New text extends what we've already typed — just append the delta
        const delta = msg.text.slice(projected.length);
        if (delta) typeOrClip(delta, true);
      } else {
        // Divergence — cancel pending interims, diff from committed text
        oplog.cancelInterims();
        const committed = oplog.committedText();
        const cp = commonPrefix(committed, msg.text);
        const toDelete = committed.length - cp;
        const toType = msg.text.slice(cp);
        if (toDelete > 0) deleteChars(toDelete, true);
        if (toType) typeOrClip(toType, true);
      }
      drainOps();

    } else if (msg.type === 'final') {
      setLive(msg.text, true);

      // Voice commands — check before processing
      const vcmds = getVoiceCommands();
      const cmd = msg.text.trim().toLowerCase();
      if (Object.hasOwn(vcmds, cmd)) {
        const vc = vcmds[cmd];
        if (!vc || typeof vc !== 'object') return;
        // Undo everything we typed for this phrase
        oplog.cancelQueued();
        const onScreen = oplog.projectedText();
        if (onScreen.length > 0) deleteChars(onScreen.length);
        if (vc.action === 'scratch') {
          if (ws._lastPhraseLen > 0) {
            deleteChars(ws._lastPhraseLen);
            logPhrase(`Scratched: "${ws._lastPhrase}"`, 'command');
            ws._lastPhrase = ''; ws._lastPhraseLen = 0;
          }
        }
        else if (vc.action === 'key'  && typeof vc.key  === 'string') {
          oplog.addType('', false); // placeholder
          runCmd(`xdotool key --clearmodifiers ${safeKey(vc.key)}`, () => {});
          logPhrase(`⌘ ${cmd}`, 'command');
        }
        else if (vc.action === 'type' && typeof vc.text === 'string') {
          typeOrClip(vc.text.slice(0, 2000));
          logPhrase(`⌘ ${cmd} → "${vc.text}"`, 'command');
        }
        oplog.reset();
        drainOps();
        return;
      }

      const finalText = applyReplacements(msg.text);

      // Cancel pending interims, diff from committed (known-on-screen) text
      oplog.cancelInterims();
      const committed = oplog.committedText();
      const cp = commonPrefix(committed, finalText);
      const toDelete = committed.length - cp;
      const toType = finalText.slice(cp) + ' ';

      if (toDelete > 0) deleteChars(toDelete);
      if (toType.trim()) typeOrClip(toType);
      else if (toDelete > 0) typeOrClip(' '); // deletion-only: still add trailing space

      // AI summarize — type raw text, replace once AI responds
      if (config.aiEnabled && getAiApiKey()) {
        const fullTyped = finalText + ' ';
        ws._lastPhrase = fullTyped; ws._lastPhraseLen = fullTyped.length;
        totalPhrases++; totalWords += finalText.trim().split(/\s+/).filter(Boolean).length;
        logPhrase(finalText, 'phrase');
        updateStatus();
        ws._aiSeq = (ws._aiSeq || 0) + 1;
        const seq = ws._aiSeq;
        const typedLen = fullTyped.length;
        aiSummarize(finalText).then(improved => {
          if (improved === finalText) return;
          if (ws.readyState !== WebSocket.OPEN) return;
          if (ws._aiSeq !== seq) return;
          const safeImproved = improved.trimStart().slice(0, 4000) + ' ';
          deleteChars(typedLen);
          typeOrClip(safeImproved);
          ws._lastPhrase = safeImproved;
          ws._lastPhraseLen = safeImproved.length;
          logPhrase(`AI (${config.aiProvider}): ${improved}`, 'command');
        }).catch(() => {});
      } else {
        const fullTyped = finalText + ' ';
        ws._lastPhrase = fullTyped; ws._lastPhraseLen = fullTyped.length;
        totalPhrases++; totalWords += finalText.trim().split(/\s+/).filter(Boolean).length;
        logPhrase(finalText, 'phrase');
        updateStatus();
      }

      // Reset oplog for next phrase
      // (keep running — drain will finish, but projected state resets)
      oplog.reset();
      drainOps();
    }
  });

  ws.on('close', () => {
    const state = phoneStates.get(ws);
    if (state && state.authed) connectedCount = Math.max(0, connectedCount - 1);
    phoneStates.delete(ws);
    // flush OpLog so stale commands don't fire after disconnect
    if (ws._oplog) ws._oplog.reset();
    logPhrase('Phone disconnected', 'disconnect');
    updateStatus();
  });
}

// Local WSS connections
wss.on('connection', (ws, req) => {
  const ip = req.socket.remoteAddress || 'unknown';
  logPhrase(`WSS connection from ${ip}`, 'connect');
  handleConnection(ws);
});

// ─── Broadcast to all connected clients (local + relay virtual) ───────────────

function broadcast(msg) {
  const data = JSON.stringify(msg);
  wss.clients.forEach(c => { if (c.readyState === WebSocket.OPEN) { try { c.send(data); } catch {} } });
  virtualClients.forEach(c => { if (c.readyState === WebSocket.OPEN) { try { c.send(data); } catch {} } });
}

// ─── Relay client ─────────────────────────────────────────────────────────────

let relayStatus    = 'disabled'; // 'disabled' | 'connecting' | 'connected' | 'error'
let relayWs        = null;
let relayRoomToken = null;     // assigned by relay server on successful registration
let relayStopped   = false; // true when we intentionally terminate (prevents auto-reconnect)
const virtualClients = new Map(); // clientId → VirtualWS

function connectRelay() {
  if (!config.relayUrl) { relayStatus = 'disabled'; updateStatus(); return; }
  if (!/^wss?:\/\/.+/.test(config.relayUrl)) {
    logPhrase('Relay URL must start with wss:// — skipping', 'warn');
    relayStatus = 'error';
    updateStatus();
    return;
  }

  relayStopped = false;
  relayStatus  = 'connecting';
  updateStatus();

  const url = config.relayUrl.replace(/\/$/, '');
  relayWs = new WebSocket(url, { rejectUnauthorized: config.relayRejectUnauthorized !== false, maxPayload: 64 * 1024 });
  const ws = relayWs; // local capture — prevents stale-closure if relayWs is reassigned on reconnect

  ws.on('open', () => {
    relayStatus = 'connected';
    safeSend(ws, { type: 'host-register', token: config.urlToken, secret: config.relaySecret || '', localUrl: `https://${localIP}:${config.port}/${config.urlToken}` });
    logPhrase(`Relay connected — ${url}`, 'connect');
    updateStatus();
    renderQR();

    // keepalive — ping relay every 25s, terminate if no pong within 10s
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
      // Relay assigned us a unique room token — use it for QR URL
      if (typeof msg.roomToken === 'string' && /^[a-f0-9]{16,64}$/.test(msg.roomToken)) {
        relayRoomToken = msg.roomToken;
      }
      logPhrase('Relay: registered, waiting for phones', 'info');
      renderQR();
      return;
    }

    if (msg.type === 'error') {
      if (msg.reason === 'bad-secret') {
        logPhrase('Relay: bad secret — check relaySecret in config.json', 'warn');
        relayStopped = true; // don't retry — wrong secret won't fix itself
        relayRoomToken = null;
        relayStatus = 'error';
        updateStatus();
      } else {
        const reason = typeof msg.reason === 'string' ? msg.reason.slice(0, 100) : 'unknown';
        logPhrase(`Relay error: ${reason}`, 'warn');
      }
      return;
    }

    if (msg.type === 'client-connect') {
      if (typeof msg.clientId !== 'string' || !/^[a-f0-9]{12}$/.test(msg.clientId)) return;
      if (virtualClients.size >= VIRTUAL_MAX_CLIENTS) {
        safeSend(ws, JSON.stringify({ type: 'host-to-client', clientId: msg.clientId, data: JSON.stringify({ type: 'error', reason: 'room-full' }) }));
        return;
      }
      const vws = new VirtualWS(msg.clientId, ws);
      virtualClients.set(msg.clientId, vws);
      handleConnection(vws);
      return;
    }

    if (msg.type === 'client-message') {
      if (typeof msg.clientId !== 'string' || !/^[a-f0-9]{12}$/.test(msg.clientId)) return;
      const vws = virtualClients.get(msg.clientId);
      if (vws && typeof msg.data === 'string') vws._receive(msg.data);
      return;
    }

    if (msg.type === 'client-disconnect') {
      if (typeof msg.clientId !== 'string' || !/^[a-f0-9]{12}$/.test(msg.clientId)) return;
      const vws = virtualClients.get(msg.clientId);
      if (vws) { vws.readyState = WebSocket.CLOSED; vws.emit('close'); }
      virtualClients.delete(msg.clientId);
      return;
    }
  });

  ws.on('close', () => {
    clearInterval(ws._pingTimer);
    clearTimeout(ws._pongTimeout);
    relayStatus = 'error';
    relayRoomToken = null; // clear — no longer registered
    virtualClients.forEach(vws => { vws.readyState = WebSocket.CLOSED; vws.emit('close'); });
    virtualClients.clear();
    renderQR();
    if (relayStopped) return;
    logPhrase('Relay disconnected — retrying in 5s', 'warn');
    updateStatus();
    setTimeout(connectRelay, 5000);
  });

  ws.on('error', (err) => {
    relayStatus = 'error';
    logPhrase(`Relay error: ${err.message}`, 'warn');
    updateStatus();
  });
}

// ─── Start ────────────────────────────────────────────────────────────────────

server.listen(config.port, '0.0.0.0', () => {
  const nets = networkInterfaces();
  for (const iface of Object.values(nets))
    for (const net of iface)
      if (net.family === 'IPv4' && !net.internal) { localIP = net.address; break; }

  const localUrl = `https://${localIP}:${config.port}/${config.urlToken}`;

  renderQR = function() {
    // Only show relay URL when we have a confirmed roomToken from the relay server
    const useRelay = config.relayUrl && relayRoomToken;
    const displayUrl = useRelay
      ? config.relayUrl.replace(/^wss:\/\//, 'https://').replace(/\/$/, '') + `/${relayRoomToken}`
      : localUrl;
    const mode = useRelay ? 'relay' : 'local';

    if (HEADLESS) {
      logPhrase(`QR URL (${mode}): ${displayUrl}`, 'info');
      return;
    }

    qrInfo.setContent(
      `{${T.textDim}-fg}URL{/${T.textDim}-fg}  {${T.text}-fg}${displayUrl}{/${T.text}-fg}\n` +
      `{${T.textDim}-fg}Mode{/${T.textDim}-fg} {${mode === 'relay' ? T.green : T.primary}-fg}${mode}{/${mode === 'relay' ? T.green : T.primary}-fg}`
    );

    // Use utf8 mode — clean Unicode blocks, no ANSI escape codes
    // blessed handles these much better than ANSI-colored terminal output
    const termH = screen.height || 24;
    const termW = screen.width || 80;
    const ecl = (termH < 30 || termW < 50) ? 'L' : 'M'; // lower error correction = smaller QR

    QRCode.toString(displayUrl, { type: 'utf8', errorCorrectionLevel: ecl }, (err, qrStr) => {
      if (err) return;
      const lines = qrStr.split('\n').filter(l => l.length > 0);
      const qrH = lines.length;
      const qrW = Math.max(...lines.map(l => l.length));

      // Resize overlay to fit: border(2) + title(1) + gap(1) + info(2) + gap(1) + qr + padding(2)
      const overlayH = Math.min(qrH + 9, termH - 2);
      const overlayW = Math.min(qrW + 8, termW - 4);
      qrOverlay.width = overlayW;
      qrOverlay.height = overlayH;

      // Color the QR blocks with our accent — ▀▄█ chars from utf8 output
      const colored = lines.map(line => {
        return `{${T.primary}-fg}${line}{/${T.primary}-fg}`;
      }).join('\n');
      qrBox.setContent(colored);
      screen.render();
    });
  };

  // ── Setup wizard ──────────────────────────────────────────────────────────
  function startApp(skipRelay) {
    if (!HEADLESS) {
      qrOverlay.show();
      qrVisible = true;
    }
    renderQR();
    updateStatus();
    logPhrase(`Server started — ${localUrl}`, 'connect');
    logPhrase('Scan QR or open URL on your phone', 'info');
    if (config.relayUrl && !skipRelay) {
      logPhrase(`Relay: connecting to ${config.relayUrl}`, 'info');
      connectRelay();
    } else if (!config.relayUrl) {
      logPhrase('Local only — press ^E to add a relay later', 'info');
    }
    if (!getAiApiKey()) logPhrase('Tip: ^A to configure AI summarize', 'info');
    screen.render();
  }

  // Skip wizard if config already has relay or has been saved before, or headless
  const configExists = fs.existsSync(CONFIG_PATH);
  const hasRelay = !!config.relayUrl;
  const skipWizard = HEADLESS || (configExists && (hasRelay || loadConfig().relayUrl !== undefined));

  if (skipWizard) {
    startApp(false);
  } else {
    // Show setup wizard on first launch
    qrOverlay.hide();
    qrVisible = false;

  const wizard = blessed.box({
    parent: screen, top: 'center', left: 'center',
    width: 52, height: 18,
    border: { type: 'line' },
    style: { border: { fg: T.border }, bg: T.bgPanel },
    tags: true, padding: { left: 2, right: 2 },
  });

  const wizTitle = blessed.box({
    parent: wizard, top: 0, left: 0, width: '100%-4', height: 3,
    tags: true, style: { bg: T.bgPanel },
    content:
      `{bold}{${T.primary}-fg}VoiceBridge{/${T.primary}-fg}{/bold}\n` +
      `{${T.textDim}-fg}How should phones connect?{/${T.textDim}-fg}`,
  });

  const wizList = blessed.list({
    parent: wizard, top: 4, left: 0, width: '100%-4', height: 6,
    keys: true, vi: true, mouse: true,
    style: {
      bg: T.bgPanel,
      item: { fg: T.textMuted, bg: T.bgPanel },
      selected: { fg: T.text, bg: T.bgElement, bold: true },
    },
    items: [
      '  Local network only (same WiFi)',
      '  Relay server (connect from anywhere)',
      '  Both (local + relay fallback)',
    ],
  });

  const wizHint = blessed.box({
    parent: wizard, top: 11, left: 0, width: '100%-4', height: 4,
    tags: true, style: { bg: T.bgPanel },
    content:
      `{${T.textDim}-fg}Local  phone must be on same network{/${T.textDim}-fg}\n` +
      `{${T.textDim}-fg}Relay  works over internet via relay server{/${T.textDim}-fg}\n` +
      `{${T.textDim}-fg}Both   local first, falls back to relay{/${T.textDim}-fg}\n\n` +
      `{${T.textDim}-fg}Enter to select · Esc to skip{/${T.textDim}-fg}`,
  });

  wizList.focus();
  screen.render();

  function destroyWizard() {
    wizard.destroy();
    screen.render();
  }

  // Esc — skip wizard, use existing config
  function onWizEsc() {
    screen.unkey('escape', onWizEsc);
    destroyWizard();
    startApp(false);
  }
  screen.key('escape', onWizEsc);

  wizList.on('select', (item, idx) => {
    screen.unkey('escape', onWizEsc);

    if (idx === 0) {
      // Local only
      destroyWizard();
      config.relayUrl = '';
      showSavePrompt(() => startApp(true));
    } else if (idx === 1 || idx === 2) {
      // Relay or Both — ask for relay URL
      destroyWizard();
      showRelaySetup(idx === 2, () => startApp(false));
    }
  });

  function showRelaySetup(keepLocal, onDone) {
    // Ensure relayServers exists
    if (!Array.isArray(config.relayServers)) config.relayServers = [...DEFAULT_CONFIG.relayServers];
    if (config.relayServers.length === 0) config.relayServers = [...DEFAULT_CONFIG.relayServers];

    const rForm = blessed.box({
      parent: screen, top: 'center', left: 'center',
      width: 58, height: 20,
      border: { type: 'line' },
      style: { border: { fg: T.border }, bg: T.bgPanel },
      tags: true, padding: { left: 2, right: 2 },
    });

    blessed.box({
      parent: rForm, top: 0, left: 0, width: '100%-4', height: 2,
      tags: true, style: { bg: T.bgPanel },
      content:
        `{bold}{${T.purple}-fg}Select Relay Server{/${T.purple}-fg}{/bold}\n` +
        `{${T.textDim}-fg}Choose a server or add your own${keepLocal ? ' (local + relay)' : ''}{/${T.textDim}-fg}`,
    });

    function buildItems() {
      const items = config.relayServers.map((s, i) => {
        const active = s.url === config.relayUrl ? ` {${T.green}-fg}●{/${T.green}-fg}` : '';
        return `  ${s.name || s.url.slice(0, 40)}${active}`;
      });
      items.push(`  {${T.cyan}-fg}+ Add custom server{/${T.cyan}-fg}`);
      items.push(`  {${T.red}-fg}- Remove a server{/${T.red}-fg}`);
      return items;
    }

    const serverList = blessed.list({
      parent: rForm, top: 3, left: 0, width: '100%-4',
      height: Math.min(config.relayServers.length + 4, 12),
      keys: true, vi: true, mouse: true, tags: true,
      style: {
        bg: T.bgPanel,
        item: { fg: T.textMuted, bg: T.bgPanel },
        selected: { fg: T.text, bg: T.bgElement, bold: true },
      },
      items: buildItems(),
    });

    const hintTop = Math.min(config.relayServers.length + 4, 12) + 4;
    const rHint = blessed.box({
      parent: rForm, top: hintTop, left: 0, width: '100%-4', height: 2,
      tags: true, style: { bg: T.bgPanel },
      content: `{${T.textDim}-fg}Enter to select · Esc to go back{/${T.textDim}-fg}`,
    });

    serverList.focus();
    screen.render();

    function onRelayEsc() {
      screen.unkey('escape', onRelayEsc);
      rForm.destroy();
      screen.render();
      config.relayUrl = '';
      config.relaySecret = '';
      showSavePrompt(() => startApp(true));
    }
    screen.key('escape', onRelayEsc);

    serverList.on('select', (item, idx) => {
      if (idx < config.relayServers.length) {
        // Selected an existing server
        screen.unkey('escape', onRelayEsc);
        const srv = config.relayServers[idx];
        config.relayUrl = srv.url;
        config.relaySecret = srv.secret || '';
        config.relayRejectUnauthorized = true;
        rForm.destroy();
        screen.render();
        showSavePrompt(onDone);
      } else if (idx === config.relayServers.length) {
        // Add custom server
        screen.unkey('escape', onRelayEsc);
        rForm.destroy();
        screen.render();
        showAddCustomRelay(keepLocal, onDone);
      } else if (idx === config.relayServers.length + 1) {
        // Remove a server
        screen.unkey('escape', onRelayEsc);
        rForm.destroy();
        screen.render();
        showRemoveRelay(keepLocal, onDone);
      }
    });
  }

  function showAddCustomRelay(keepLocal, onDone) {
    // Step 1: Name
    promptInput('Server name:', '', (name) => {
      if (name === null) { showRelaySetup(keepLocal, onDone); return; }
      // Step 2: URL
      promptInput('Relay URL:', 'wss://', (url) => {
        if (url === null || !url || url === 'wss://' || !/^wss?:\/\/.+/.test(url)) { showRelaySetup(keepLocal, onDone); return; }
        // Step 3: Secret
        promptInput('Secret (blank if none):', '', (secret) => {
          if (secret === null) secret = '';
          const entry = { name: name || url.replace(/^wss?:\/\//, '').slice(0, 40), url, secret };
          if (!Array.isArray(config.relayServers)) config.relayServers = [];
          if (!config.relayServers.some(s => s.url === url)) config.relayServers.push(entry);
          config.relayUrl = url;
          config.relaySecret = secret;
          config.relayRejectUnauthorized = true;
          showSavePrompt(onDone);
        });
      });
    });
  }

  function showRemoveRelay(keepLocal, onDone) {
    if (!config.relayServers || config.relayServers.length === 0) {
      showRelaySetup(keepLocal, onDone);
      return;
    }

    const rmForm = blessed.box({
      parent: screen, top: 'center', left: 'center',
      width: 56, height: Math.min(config.relayServers.length + 6, 18),
      border: { type: 'line' },
      style: { border: { fg: T.red }, bg: T.bgPanel },
      tags: true, padding: { left: 2, right: 2 },
    });

    blessed.box({
      parent: rmForm, top: 0, left: 0, width: '100%-4', height: 2,
      tags: true, style: { bg: T.bgPanel },
      content:
        `{bold}{${T.red}-fg}Remove Relay Server{/${T.red}-fg}{/bold}\n` +
        `{${T.textDim}-fg}Select a server to remove{/${T.textDim}-fg}`,
    });

    const rmList = blessed.list({
      parent: rmForm, top: 3, left: 0, width: '100%-4',
      height: Math.min(config.relayServers.length + 1, 10),
      keys: true, vi: true, mouse: true, tags: true,
      style: {
        bg: T.bgPanel,
        item: { fg: T.textMuted, bg: T.bgPanel },
        selected: { fg: T.text, bg: '#3a1a1a', bold: true },
      },
      items: config.relayServers.map(s => `  ${s.name || s.url.slice(0, 45)}`),
    });

    rmList.focus();
    screen.render();

    function onRmEsc() {
      screen.unkey('escape', onRmEsc);
      rmForm.destroy();
      screen.render();
      showRelaySetup(keepLocal, onDone);
    }
    screen.key('escape', onRmEsc);

    rmList.on('select', (item, idx) => {
      screen.unkey('escape', onRmEsc);
      const removed = config.relayServers.splice(idx, 1)[0];
      if (removed && removed.url === config.relayUrl) {
        config.relayUrl = '';
        config.relaySecret = '';
      }
      logPhrase(`Removed relay: ${removed ? removed.name || removed.url : '?'}`, 'command');
      rmForm.destroy();
      screen.render();
      showRelaySetup(keepLocal, onDone);
    });
  }

  function showSavePrompt(onDone) {
    const saveBox = blessed.box({
      parent: screen, top: 'center', left: 'center',
      width: 48, height: 9,
      border: { type: 'line' },
      style: { border: { fg: T.border }, bg: T.bgPanel },
      tags: true, padding: { left: 2, right: 2 },
    });

    const modeDesc = config.relayUrl
      ? `Local + Relay (${config.relayUrl.slice(0, 30)}${config.relayUrl.length > 30 ? '...' : ''})`
      : 'Local only';

    blessed.box({
      parent: saveBox, top: 0, left: 0, width: '100%-4', height: 6,
      tags: true, style: { bg: T.bgPanel },
      content:
        `{bold}{${T.primary}-fg}Save Settings?{/${T.primary}-fg}{/bold}\n\n` +
        `{${T.textMuted}-fg}Mode:{/${T.textMuted}-fg} {${T.text}-fg}${modeDesc}{/${T.text}-fg}\n\n` +
        `{${T.green}-fg}Y{/${T.green}-fg} {${T.textMuted}-fg}save to config.json{/${T.textMuted}-fg}\n` +
        `{${T.yellow}-fg}N{/${T.yellow}-fg} {${T.textMuted}-fg}this session only{/${T.textMuted}-fg}`,
    });

    function onSaveY() {
      screen.unkey('y', onSaveY);
      screen.unkey('n', onSaveN);
      saveConfig(config);
      saveBox.destroy();
      screen.render();
      onDone();
    }
    function onSaveN() {
      screen.unkey('y', onSaveY);
      screen.unkey('n', onSaveN);
      saveBox.destroy();
      screen.render();
      onDone();
    }

    screen.key('y', onSaveY);
    screen.key('n', onSaveN);
    screen.render();
  }
  } // end else (wizard)
});

process.on('exit', () => { try { screen.destroy(); } catch {} });

function shutdown() {
  relayStopped = true;
  if (relayWs) { try { relayWs.terminate(); } catch {} }
  try { screen.destroy(); } catch {}
  process.exit(0);
}
process.on('SIGTERM', shutdown);
process.on('SIGINT',  shutdown);
process.on('uncaughtException',  (err) => { try { logPhrase(`uncaughtException: ${err && err.message ? err.message : err}`, 'warn'); } catch { console.error('uncaughtException:', err); } });
process.on('unhandledRejection', (err) => { try { logPhrase(`unhandledRejection: ${err && err.message ? err.message : err}`, 'warn'); } catch { console.error('unhandledRejection:', err); } });
