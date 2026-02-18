const https    = require('https');
const fs       = require('fs');
const path     = require('path');
const { exec } = require('child_process');
const crypto   = require('crypto');
const { EventEmitter } = require('events');
const { networkInterfaces } = require('os');
const WebSocket = require('ws');
const express  = require('express');
const blessed  = require('blessed');
const QRCode   = require('qrcode');

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
  try { return JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf8')); }
  catch { return {}; }
}
function saveConfig(cfg) {
  const tmp = CONFIG_PATH + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(cfg, null, 2));
  fs.renameSync(tmp, CONFIG_PATH);
}
function saveSessions(s) {
  const tmp = SESSIONS_PATH + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(s, null, 2));
  fs.renameSync(tmp, SESSIONS_PATH);
}
function loadSessions() {
  try { return JSON.parse(fs.readFileSync(SESSIONS_PATH, 'utf8')); }
  catch { return {}; }
}

const DEFAULT_CONFIG = {
  port: 4000,
  language: 'en-US',
  clipboardMode: false,
  wordReplacements: {},
  voiceCommandsExtra: {},
  relayUrl: '',                  // e.g. "wss://yourrelay.example.com:4001"
  relaySecret: '',               // must match RELAY_SECRET env var on the relay server
  relayRejectUnauthorized: true, // false for self-signed certs (dev only)
};

let config   = { ...DEFAULT_CONFIG, ...loadConfig() };
let sessions = loadSessions(); // { deviceToken: { name, approved, lastSeen } }

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
// Sanitize object fields — discard if not plain objects
if (typeof config.wordReplacements !== 'object' || Array.isArray(config.wordReplacements) || !config.wordReplacements) config.wordReplacements = {};
if (typeof config.voiceCommandsExtra !== 'object' || Array.isArray(config.voiceCommandsExtra) || !config.voiceCommandsExtra) config.voiceCommandsExtra = {};

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
app.use(express.json());

// Only serve the app if URL token matches
app.get(`/${config.urlToken}`, (req, res) => {
  res.sendFile(path.join(__dirname, 'public/index.html'));
});
app.use('/static', express.static(path.join(__dirname, 'public/static')));
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

const screen = blessed.screen({ smartCSR: true, title: '🎤 Wireless Mic Input', fullUnicode: true });

const LEFT_W = 40;

const titleBar = blessed.box({
  top: 0, left: 0, width: '100%', height: 1, tags: true,
  content: '{bold}{white-fg}{blue-bg}  🎤  Wireless Mic Input  —  Voice to Keyboard{/blue-bg}{/white-fg}{/bold}',
  style: { fg: 'white', bg: 'blue' },
});

const leftPanel = blessed.box({
  top: 1, left: 0, width: LEFT_W, height: '100%-2',
  border: { type: 'line' },
  style: { border: { fg: '#005f87' }, bg: '#0a0a0a' },
  label: { text: ' ◉ Status ', side: 'left', style: { fg: 'cyan', bold: true } },
});

const infoBox   = blessed.box({ parent: leftPanel, top: 0,  left: 1, width: LEFT_W-4, height: 6,  tags: true, style: { bg: '#0a0a0a' } });
blessed.line({ parent: leftPanel, top: 6,  left: 0, width: LEFT_W-4, orientation: 'horizontal', style: { fg: '#222' } });
const phoneBox  = blessed.box({ parent: leftPanel, top: 7,  left: 1, width: LEFT_W-4, height: 6,  tags: true, style: { bg: '#0a0a0a' } });
blessed.line({ parent: leftPanel, top: 13, left: 0, width: LEFT_W-4, orientation: 'horizontal', style: { fg: '#222' } });
const statsBox  = blessed.box({ parent: leftPanel, top: 14, left: 1, width: LEFT_W-4, height: 4,  tags: true, style: { bg: '#0a0a0a' } });
blessed.line({ parent: leftPanel, top: 18, left: 0, width: LEFT_W-4, orientation: 'horizontal', style: { fg: '#222' } });
blessed.box({ parent: leftPanel, top: 19, left: 1, width: LEFT_W-4, height: 1, tags: true, style: { bg: '#0a0a0a' }, content: '{#555555-fg}WORD REPLACEMENTS{/#555555-fg}' });
const replBox   = blessed.box({ parent: leftPanel, top: 20, left: 1, width: LEFT_W-4, height: 5,  tags: true, scrollable: true, style: { bg: '#0a0a0a', fg: '#aaa' }, content: '{#444-fg}none{/#444-fg}' });
blessed.line({ parent: leftPanel, top: 25, left: 0, width: LEFT_W-4, orientation: 'horizontal', style: { fg: '#222' } });

// QR area — label + ascii art side by side
const qrLabel = blessed.box({ parent: leftPanel, top: 26, left: 1, width: LEFT_W-4, height: 1, tags: true, style: { bg: '#0a0a0a' }, content: '{#555555-fg}SCAN TO CONNECT{/#555555-fg}' });
const qrBox   = blessed.box({ parent: leftPanel, top: 27, left: 1, width: LEFT_W-4, height: '100%-29', tags: false, style: { fg: 'white', bg: '#0a0a0a' }, content: 'Generating...' });

// Right panel
const rightPanel = blessed.box({
  top: 1, left: LEFT_W, width: `100%-${LEFT_W}`, height: '100%-2',
  border: { type: 'line' },
  style: { border: { fg: '#005f87' }, bg: '#080808' },
  label: { text: ' ▸ Phrase Log ', side: 'left', style: { fg: 'cyan', bold: true } },
});

const logBox = blessed.log({
  parent: rightPanel, top: 0, left: 1, width: '100%-3', height: '100%-6',
  tags: true, scrollable: true, alwaysScroll: true, mouse: true,
  scrollbar: { ch: ' ', track: { bg: '#111' }, style: { bg: '#005f87' } },
  style: { fg: '#aaaaaa', bg: '#080808' },
});

const liveBox = blessed.box({
  parent: rightPanel, bottom: 0, left: 1, width: '100%-3', height: 5,
  border: { type: 'line' },
  style: { border: { fg: '#333' }, bg: '#080808' },
  label: { text: ' ◎ Live ', side: 'left', style: { fg: '#888' } },
  tags: true, padding: { left: 1 },
  content: '{#444444-fg}Waiting for speech...{/#444444-fg}',
});

const bottomBar = blessed.box({
  bottom: 0, left: 0, width: '100%', height: 1, tags: true,
  content: ' {black-fg}{cyan-bg}[^P]{/cyan-bg}{/black-fg} Pause  {black-fg}{cyan-bg}[^R]{/cyan-bg}{/black-fg} Add Replace  {black-fg}{cyan-bg}[^D]{/cyan-bg}{/black-fg} Del Replace  {black-fg}{cyan-bg}[^E]{/cyan-bg}{/black-fg} Relay URL  {black-fg}{cyan-bg}[^L]{/cyan-bg}{/black-fg} Clear Log  {black-fg}{cyan-bg}[^Q]{/cyan-bg}{/black-fg} Quit',
  style: { fg: '#aaaaaa', bg: '#111' },
});

screen.append(titleBar);
screen.append(leftPanel);
screen.append(rightPanel);
screen.append(bottomBar);

// ─── TUI helpers ──────────────────────────────────────────────────────────────

function fmtUptime() {
  const s = Math.floor((Date.now() - startTime) / 1000);
  const h = Math.floor(s/3600), m = Math.floor((s%3600)/60), ss = s%60;
  return `${String(h).padStart(2,'0')}:${String(m).padStart(2,'0')}:${String(ss).padStart(2,'0')}`;
}
function badge(label, value, color) {
  return `{#555555-fg}${label}{/#555555-fg} {${color}-fg}${value}{/${color}-fg}`;
}

function updateStatus() {
  infoBox.setContent(
    `{bold}{white-fg}🌐 https://${localIP}:${config.port}{/white-fg}{/bold}\n` +
    `{#444-fg}   /${config.urlToken}{/#444-fg}\n\n` +
    `${badge('Status  ', paused ? '⏸  PAUSED' : '▶  ACTIVE', paused ? 'red' : 'green')}\n` +
    `${badge('Uptime  ', fmtUptime(), '#888888')}\n` +
    `${badge('Clients ', connectedCount > 0 ? `${connectedCount} connected` : 'none', connectedCount > 0 ? 'cyan' : '#555555')}\n` +
    `${badge('Relay   ', relayStatus === 'connected' ? '⬤ connected' : relayStatus === 'connecting' ? '… connecting' : relayStatus === 'error' ? '✖ retrying' : '— disabled', relayStatus === 'connected' ? 'green' : relayStatus === 'connecting' ? 'yellow' : relayStatus === 'error' ? 'red' : '#555555')}`
  );

  const states = [...phoneStates.values()].filter(s => s.authed);
  if (states.length === 0) {
    phoneBox.setContent(
      `{#555555-fg}No phone connected\n\nScan the QR code below{/#555555-fg}`
    );
  } else {
    const s = states[0];
    phoneBox.setContent(
      `{#888888-fg}PHONE{/#888888-fg}\n` +
      `${badge('Language', s.language || config.language, 'cyan')}\n` +
      `${badge('Mode    ', s.pttMode ? 'Hold-to-talk' : 'Toggle', s.pttMode ? 'yellow' : '#888888')}\n` +
      `${badge('Output  ', s.clipboardMode ? 'Clipboard' : 'Direct type', s.clipboardMode ? 'blue' : '#888888')}\n` +
      `${badge('Session ', s.deviceToken ? 'saved' : 'temp', s.deviceToken ? 'green' : '#555555')}`
    );
  }

  statsBox.setContent(
    `{#888888-fg}SESSION{/#888888-fg}\n` +
    `${badge('Phrases ', totalPhrases, 'white')}\n` +
    `${badge('Words   ', totalWords, 'white')}\n` +
    `${badge('Avg len ', totalPhrases > 0 ? (totalWords/totalPhrases).toFixed(1)+' words' : '—', '#888888')}`
  );

  const repls = Object.entries(config.wordReplacements || {});
  replBox.setContent(repls.length === 0
    ? '{#444-fg}none{/#444-fg}'
    : repls.map(([k,v]) => {
        const ek = String(k).replace(/[{}]/g, c => c === '{' ? '\\{' : '\\}');
        const ev = String(v).replace(/[{}]/g, c => c === '{' ? '\\{' : '\\}');
        return `{cyan-fg}${ek}{/cyan-fg} {#555-fg}→{/#555-fg} {white-fg}${ev}{/white-fg}`;
      }).join('\n')
  );

  screen.render();
}

setInterval(updateStatus, 1000);

function logPhrase(text, type = 'info') {
  const time = new Date().toLocaleTimeString('en-GB', { hour:'2-digit', minute:'2-digit', second:'2-digit' });
  const t = `{#444444-fg}${time}{/#444444-fg}`;
  // escape blessed tag chars so speech text never corrupts the TUI
  const safe = String(text).replace(/[{}]/g, c => c === '{' ? '\\{' : '\\}');
  const lines = { phrase: `${t}  {white-fg}${safe}{/white-fg}`, command: `${t}  {yellow-fg}⌘  ${safe}{/yellow-fg}`, connect: `${t}  {green-fg}⬤  ${safe}{/green-fg}`, disconnect: `${t}  {red-fg}○  ${safe}{/red-fg}`, warn: `${t}  {red-fg}⚠  ${safe}{/red-fg}`, auth: `${t}  {magenta-fg}🔐 ${safe}{/magenta-fg}` };
  logBox.log(lines[type] || `${t}  {#666-fg}${safe}{/#666-fg}`);
  screen.render();
}

function setLive(text, isFinal = false) {
  const safe = String(text).replace(/[{}]/g, c => c === '{' ? '\\{' : '\\}');
  liveBox.setContent(isFinal ? `{white-fg}{bold}${safe}{/bold}{/white-fg}` : `{#888888-fg}${safe}{/#888888-fg}`);
  screen.render();
}

// ─── PIN approval popup ───────────────────────────────────────────────────────

const pinQueue = []; // { pin, ws } — queued when a prompt is already showing
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
    parent: screen, top: 'center', left: 'center', width: 44, height: 10,
    border: { type: 'line' },
    style: { border: { fg: 'magenta' }, bg: '#111' },
    label: ' 🔐 New Device Wants to Connect ',
    tags: true, padding: { left: 2, right: 2 },
  });
  blessed.text({
    parent: popup, top: 1, left: 2, tags: true,
    content: `Phone is showing PIN:\n\n  {bold}{magenta-fg}${pin}{/magenta-fg}{/bold}\n\n{#888-fg}Press {white-fg}Y{/white-fg} to approve, {white-fg}N{/white-fg} to reject{/#888-fg}`,
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

screen.key(['C-q', 'C-c'], () => shutdown());

screen.key('C-p', () => {
  paused = !paused;
  logPhrase(paused ? 'Paused from keyboard' : 'Resumed from keyboard', 'command');
  broadcast({ type: 'paused', value: paused });
  updateStatus();
});

screen.key('C-l', () => { logBox.setContent(''); logPhrase('Log cleared', 'info'); });

screen.key('C-e', () => {
  let rejectUnauth = config.relayRejectUnauthorized !== false;
  const form = blessed.form({ parent: screen, top: 'center', left: 'center', width: 60, height: 16, border: { type: 'line' }, style: { border: { fg: 'cyan' }, bg: '#111' }, label: ' ⇄  Set Relay ', keys: true });
  blessed.text({ parent: form, top: 1, left: 2, content: 'Relay WSS URL (blank to disable):', style: { fg: '#888' } });
  const urlInput = blessed.textbox({ parent: form, top: 2, left: 2, width: 54, height: 1, style: { fg: 'white', bg: '#222' }, inputOnFocus: true, value: config.relayUrl || '' });
  blessed.text({ parent: form, top: 4, left: 2, content: 'Relay secret (leave blank if none):', style: { fg: '#888' } });
  const secretInput = blessed.textbox({ parent: form, top: 5, left: 2, width: 54, height: 1, style: { fg: 'white', bg: '#222' }, inputOnFocus: true, value: config.relaySecret || '' });
  const tlsLabel = blessed.text({ parent: form, top: 7, left: 2, tags: true, style: { fg: '#888', bg: '#111' } });
  function updateTlsLabel() { tlsLabel.setContent(`{#888888-fg}TLS verify:{/#888888-fg} {${rejectUnauth ? 'green' : 'yellow'}-fg}${rejectUnauth ? 'on (prod/LE)' : 'off (self-signed)'}{/${rejectUnauth ? 'green' : 'yellow'}-fg}  {#555-fg}[Space to toggle]{/#555-fg}`); screen.render(); }
  updateTlsLabel();
  blessed.text({ parent: form, top: 9,  left: 2, content: 'e.g. wss://yourserver.com:4001', style: { fg: '#555' } });
  blessed.text({ parent: form, top: 10, left: 2, content: 'Tab to switch fields, Enter to save, Esc to cancel', style: { fg: '#555' } });
  urlInput.key('tab',   () => secretInput.focus());
  urlInput.key('enter', () => secretInput.focus()); // Enter on URL field moves to secret
  secretInput.key('tab', () => urlInput.focus());
  secretInput.key('space', () => { rejectUnauth = !rejectUnauth; updateTlsLabel(); });
  function onEscE() { form.destroy(); screen.unkey('escape', onEscE); screen.render(); }
  function save() {
    screen.unkey('escape', onEscE);
    const val    = urlInput.getValue().trim();
    const secret = secretInput.getValue().trim();
    config.relayUrl                = val;
    config.relaySecret             = secret;
    config.relayRejectUnauthorized = rejectUnauth;
    saveConfig(config);
    form.destroy();
    logPhrase(val ? `Relay URL set: ${val}` : 'Relay disabled', 'command');
    updateStatus();
    renderQR();
    relayStopped = true;
    if (relayWs) { try { relayWs.terminate(); } catch {} relayWs = null; }
    connectRelay();
  }
  secretInput.key('enter', save); // only secret field Enter saves
  screen.key('escape', onEscE);
  screen.render(); urlInput.focus();
});

screen.key('C-r', () => {
  const form = blessed.form({ parent: screen, top: 'center', left: 'center', width: 52, height: 11, border: { type: 'line' }, style: { border: { fg: 'yellow' }, bg: '#111' }, label: ' ✎  Add Word Replacement ', keys: true });
  blessed.text({ parent: form, top: 1, left: 2, content: 'Say this word/phrase:', style: { fg: '#888' } });
  const fromInput = blessed.textbox({ parent: form, top: 2, left: 2, width: 46, height: 1, style: { fg: 'white', bg: '#222' }, inputOnFocus: true });
  blessed.text({ parent: form, top: 4, left: 2, content: 'Type this instead:', style: { fg: '#888' } });
  const toInput = blessed.textbox({ parent: form, top: 5, left: 2, width: 46, height: 1, style: { fg: 'white', bg: '#222' }, inputOnFocus: true });
  blessed.text({ parent: form, top: 7, left: 2, content: 'Tab to switch, Enter to save, Esc to cancel', style: { fg: '#555' } });
  fromInput.focus();
  fromInput.key('tab', () => toInput.focus());
  fromInput.key('enter', () => toInput.focus());
  toInput.key('tab', () => fromInput.focus());
  function onEscR() { form.destroy(); screen.unkey('escape', onEscR); screen.render(); }
  toInput.key('enter', () => {
    screen.unkey('escape', onEscR);
    const from = fromInput.getValue().trim().toLowerCase().slice(0, 200);
    const to   = toInput.getValue().trim().slice(0, 500);
    if (from && to) { config.wordReplacements[from] = to; saveConfig(config); logPhrase(`Replacement: "${from}" → "${to}"`, 'command'); }
    form.destroy(); updateStatus();
  });
  screen.key('escape', onEscR);
  screen.render(); fromInput.focus();
});

screen.key('C-d', () => {
  const repls = Object.keys(config.wordReplacements || {});
  if (!repls.length) { logPhrase('No replacements to delete', 'warn'); return; }
  const list = blessed.list({ parent: screen, top: 'center', left: 'center', width: 54, height: Math.min(repls.length+4, 20), border: { type: 'line' }, style: { border: { fg: 'red' }, bg: '#111', item: { fg: '#aaa' }, selected: { bg: '#500', fg: 'white' } }, label: ' ✖  Delete — Enter to delete, Esc to cancel ', keys: true, vi: true, items: repls.map(k => `  ${k}  →  ${config.wordReplacements[k]}`) });
  list.focus();
  list.key('enter', () => { const key = repls[list.selected]; delete config.wordReplacements[key]; saveConfig(config); logPhrase(`Removed: "${key}"`, 'command'); list.destroy(); updateStatus(); });
  list.key('escape', () => { list.destroy(); screen.render(); });
  screen.render();
});

// ─── Helpers ──────────────────────────────────────────────────────────────────

function runCmd(cmd, cb) { exec(cmd, (err) => { if (err) logPhrase(`xdotool: ${err.message}`, 'warn'); cb && cb(); }); }
function escape(text) { return text.replace(/'/g, "'\\''"); }
function safeKey(key) { return String(key).replace(/[^a-zA-Z0-9_\- ]/g, ''); }
function safeSend(ws, data) { if (ws && ws.readyState === WebSocket.OPEN) { try { ws.send(typeof data === 'string' ? data : JSON.stringify(data)); } catch {} } }

function applyReplacements(text) {
  let out = text;
  for (const [from, to] of Object.entries(config.wordReplacements || {})) {
    // escape regex special chars in the key so literal strings always match
    const escaped = from.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    out = out.replace(new RegExp(`\\b${escaped}\\b`, 'gi'), to);
  }
  return out;
}

function wordDiff(onScreen, final) {
  const sw = onScreen.trim().split(/\s+/).filter(Boolean);
  const fw = final.trim().split(/\s+/).filter(Boolean);
  let common = 0;
  while (common < sw.length && common < fw.length && sw[common] === fw[common]) common++;
  const screenTail  = sw.slice(common).join(' ');
  const deleteCount = screenTail.length + (common > 0 && screenTail.length > 0 ? 1 : 0);
  const finalTail   = fw.slice(common).join(' ');
  const typeStr     = (common > 0 && finalTail.length > 0 ? ' ' : '') + finalTail;
  return { deleteCount, typeStr };
}

function toClipboard(text, cb) { const p = exec('xclip -selection clipboard', cb); p.stdin.write(text); p.stdin.end(); }

// ─── Shared connection handler (local WSS + relay VirtualWS) ─────────────────

function handleConnection(ws) {
  phoneStates.set(ws, { language: config.language, pttMode: false, clipboardMode: config.clipboardMode, authed: false, deviceToken: null });

  ws.on('message', (data) => {
    let msg;
    try { msg = JSON.parse(data.toString()); } catch { return; }
    const state = phoneStates.get(ws) || {};

    // ── Auth handshake ──
    if (msg.type === 'auth') {
      if (state.authed) return; // ignore re-auth from already-approved socket
      // returning device with saved token
      if (msg.deviceToken && typeof msg.deviceToken === 'string' && /^[a-f0-9]{32}$/.test(msg.deviceToken) && sessions[msg.deviceToken]) {
        sessions[msg.deviceToken].lastSeen = Date.now();
        saveSessions(sessions);
        state.authed = true;
        state.deviceToken = msg.deviceToken;
        phoneStates.set(ws, state);
        connectedCount++;
        safeSend(ws, { type: 'auth', status: 'approved', deviceToken: msg.deviceToken });
        safeSend(ws, { type: 'paused', value: paused });
        logPhrase(`Known device reconnected`, 'connect');
        updateStatus();
        return;
      }
      // new device — generate PIN, show popup
      const pin = String(Math.floor(100000 + Math.random() * 900000));
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
      phoneStates.set(ws, state);
      updateStatus();
      return;
    }

    if (paused || !msg.text) return;
    if (typeof msg.text !== 'string' || msg.text.length > 2000) return; // sanity cap

    const queue = ws._queue || (ws._queue = []);
    let running = ws._running || false;

    function enqueue(cmd, isFinal = false) {
      if (!isFinal) { for (let i = queue.length-1; i >= 0; i--) { if (!queue[i].isFinal) queue.splice(i,1); } }
      queue.push({ cmd, isFinal });
      drain();
    }
    function drain() {
      if (running || !queue.length) return;
      ws._running = running = true;
      const { cmd } = queue.shift();
      runCmd(cmd, () => { ws._running = running = false; drain(); });
    }
    function typeOrClip(text, isFinal = true) {
      if (state.clipboardMode) { toClipboard(text, (err) => { if (!err) exec('xdotool key --clearmodifiers ctrl+v'); }); }
      else { enqueue(`xdotool type --clearmodifiers -- '${escape(text)}'`, isFinal); }
    }

    if (!ws._phraseOnScreen) ws._phraseOnScreen = '';
    if (!ws._lastPhrase)     ws._lastPhrase = '';
    if (!ws._lastPhraseLen)  ws._lastPhraseLen = 0;

    if (msg.type === 'interim') {
      setLive(msg.text, false);
      if (msg.text.startsWith(ws._phraseOnScreen)) {
        const delta = msg.text.slice(ws._phraseOnScreen.length);
        if (delta) { ws._phraseOnScreen = msg.text; enqueue(`xdotool type --clearmodifiers -- '${escape(delta)}'`, false); }
      }
    } else if (msg.type === 'final') {
      setLive(msg.text, true);
      const onScreen = ws._phraseOnScreen;
      ws._phraseOnScreen = '';
      const vcmds = getVoiceCommands();
      const cmd = msg.text.trim().toLowerCase();
      if (vcmds[cmd]) {
        const vc = vcmds[cmd];
        const onScreenCap = Math.min(onScreen.length, 500);
        if (onScreenCap > 0) enqueue(`xdotool key --clearmodifiers --repeat ${onScreenCap} BackSpace`, true);
        if (vc.action === 'scratch') { if (ws._lastPhraseLen > 0) { const cap = Math.min(ws._lastPhraseLen, 500); enqueue(`xdotool key --clearmodifiers --repeat ${cap} BackSpace`, true); logPhrase(`Scratched: "${ws._lastPhrase}"`, 'command'); ws._lastPhrase = ''; ws._lastPhraseLen = 0; } }
        else if (vc.action === 'key'  && typeof vc.key  === 'string') { enqueue(`xdotool key --clearmodifiers ${safeKey(vc.key)}`, true); logPhrase(`⌘ ${cmd}`, 'command'); }
        else if (vc.action === 'type' && typeof vc.text === 'string') { typeOrClip(vc.text.slice(0, 2000)); logPhrase(`⌘ ${cmd} → "${vc.text}"`, 'command'); }
        return;
      }
      const finalText = applyReplacements(msg.text);
      const { deleteCount, typeStr } = wordDiff(onScreen, finalText);
      if (deleteCount > 0) enqueue(`xdotool key --clearmodifiers --repeat ${Math.min(deleteCount, 500)} BackSpace`, true);
      const toType = typeStr.trimStart() + ' ';
      typeOrClip(toType);
      ws._lastPhrase = toType; ws._lastPhraseLen = toType.length;
      totalPhrases++; totalWords += finalText.trim().split(/\s+/).filter(Boolean).length;
      logPhrase(finalText, 'phrase');
      updateStatus();
    }
  });

  ws.on('close', () => {
    const state = phoneStates.get(ws);
    if (state && state.authed) connectedCount--;
    phoneStates.delete(ws);
    // flush pending xdotool queue so stale commands don't fire after disconnect
    if (ws._queue) ws._queue.length = 0;
    ws._running = false;
    logPhrase('Phone disconnected', 'disconnect');
    updateStatus();
  });
}

// Local WSS connections
wss.on('connection', handleConnection);

// ─── Broadcast to all connected clients (local + relay virtual) ───────────────

function broadcast(msg) {
  const data = JSON.stringify(msg);
  wss.clients.forEach(c => { if (c.readyState === WebSocket.OPEN) { try { c.send(data); } catch {} } });
  virtualClients.forEach(c => { if (c.readyState === WebSocket.OPEN) { try { c.send(data); } catch {} } });
}

// ─── Relay client ─────────────────────────────────────────────────────────────

let relayStatus    = 'disabled'; // 'disabled' | 'connecting' | 'connected' | 'error'
let relayWs        = null;
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
  relayWs = new WebSocket(url, { rejectUnauthorized: config.relayRejectUnauthorized !== false });
  const ws = relayWs; // local capture — prevents stale-closure if relayWs is reassigned on reconnect

  ws.on('open', () => {
    relayStatus = 'connected';
    safeSend(ws, { type: 'host-register', token: config.urlToken, secret: config.relaySecret || '' });
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

    if (msg.type === 'registered') {
      logPhrase('Relay: host registered, waiting for phones', 'info');
      return;
    }

    if (msg.type === 'error') {
      if (msg.reason === 'bad-secret') {
        logPhrase('Relay: bad secret — check relaySecret in config.json', 'warn');
        relayStopped = true; // don't retry — wrong secret won't fix itself
        relayStatus = 'error';
        updateStatus();
      } else {
        logPhrase(`Relay error: ${msg.reason}`, 'warn');
      }
      return;
    }

    if (msg.type === 'client-connect') {
      const vws = new VirtualWS(msg.clientId, ws);
      virtualClients.set(msg.clientId, vws);
      handleConnection(vws);
      return;
    }

    if (msg.type === 'client-message') {
      const vws = virtualClients.get(msg.clientId);
      if (vws) vws._receive(msg.data);
      return;
    }

    if (msg.type === 'client-disconnect') {
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

  updateStatus();

  const localUrl = `https://${localIP}:${config.port}/${config.urlToken}`;

  renderQR = function() {
    const displayUrl = (config.relayUrl && relayStatus === 'connected')
      ? config.relayUrl.replace(/^wss:\/\//, 'https://').replace(/\/$/, '') + `/${config.urlToken}`
      : localUrl;
    qrLabel.setContent(`{#555555-fg}SCAN TO CONNECT${config.relayUrl ? ' (relay)' : ' (local)'}{/#555555-fg}`);
    QRCode.toString(displayUrl, { type: 'terminal', small: true }, (err, qrStr) => {
      if (!err) { qrBox.setContent(qrStr); screen.render(); }
    });
  };

  // Re-render QR whenever relay status changes
  let _lastRelayStatus = relayStatus;
  setInterval(() => {
    if (relayStatus !== _lastRelayStatus) { _lastRelayStatus = relayStatus; renderQR(); }
  }, 1000);

  renderQR();

  logPhrase(`Server started — ${localUrl}`, 'connect');
  logPhrase('Scan QR or open URL on your phone', 'info');
  if (config.relayUrl) logPhrase(`Relay URL set — connecting to ${config.relayUrl}`, 'info');
  else logPhrase('No relay configured — local only (set relayUrl in config.json)', 'info');
  screen.render();

  // Start relay connection after local server is up
  connectRelay();
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
process.on('uncaughtException',  (err) => logPhrase(`uncaughtException: ${err.message}`, 'warn'));
process.on('unhandledRejection', (err) => logPhrase(`unhandledRejection: ${err}`, 'warn'));
