const https    = require('https');
const fs       = require('fs');
const path     = require('path');
const { exec } = require('child_process');
const crypto   = require('crypto');
const { EventEmitter } = require('events');
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
    this._relayWs.send(JSON.stringify({ type: 'host-message', clientId: this.clientId, data }));
  }
  close() {
    if (this.readyState === WebSocket.CLOSED) return;
    this.readyState = WebSocket.CLOSED;
    this._relayWs.send(JSON.stringify({ type: 'host-close', clientId: this.clientId }));
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
  fs.writeFileSync(CONFIG_PATH, JSON.stringify(cfg, null, 2));
}
function loadSessions() {
  try { return JSON.parse(fs.readFileSync(SESSIONS_PATH, 'utf8')); }
  catch { return {}; }
}
function saveSessions(s) {
  fs.writeFileSync(SESSIONS_PATH, JSON.stringify(s, null, 2));
}

const DEFAULT_CONFIG = {
  port: 4000,
  language: 'en-US',
  clipboardMode: false,
  wordReplacements: {},
  voiceCommandsExtra: {},
  relayUrl: '',   // e.g. "wss://yourrelay.example.com:4001"
};

let config   = { ...DEFAULT_CONFIG, ...loadConfig() };
let sessions = loadSessions(); // { deviceToken: { name, approved, lastSeen } }

// Generate URL token once, persist it
if (!config.urlToken) {
  config.urlToken = crypto.randomBytes(8).toString('hex');
  saveConfig(config);
}

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

const wss = new WebSocket.Server({ server });

// ─── State ────────────────────────────────────────────────────────────────────

let paused         = false;
let connectedCount = 0;
let totalPhrases   = 0;
let totalWords     = 0;
let localIP        = 'localhost';
let startTime      = Date.now();

const phoneStates  = new Map(); // ws -> { language, pttMode, clipboardMode, authed, deviceToken, pin }
const pendingPins  = new Map(); // pin -> ws  (waiting for TUI approval)

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
  content: ' {black-fg}{cyan-bg}[^P]{/cyan-bg}{/black-fg} Pause  {black-fg}{cyan-bg}[^R]{/cyan-bg}{/black-fg} Add Replace  {black-fg}{cyan-bg}[^D]{/cyan-bg}{/black-fg} Del Replace  {black-fg}{cyan-bg}[^L]{/cyan-bg}{/black-fg} Clear Log  {black-fg}{cyan-bg}[^Q]{/cyan-bg}{/black-fg} Quit',
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
    : repls.map(([k,v]) => `{cyan-fg}${k}{/cyan-fg} {#555-fg}→{/#555-fg} {white-fg}${v}{/white-fg}`).join('\n')
  );

  screen.render();
}

setInterval(updateStatus, 1000);

function logPhrase(text, type = 'info') {
  const time = new Date().toLocaleTimeString('en-GB', { hour:'2-digit', minute:'2-digit', second:'2-digit' });
  const t = `{#444444-fg}${time}{/#444444-fg}`;
  const lines = { phrase: `${t}  {white-fg}${text}{/white-fg}`, command: `${t}  {yellow-fg}⌘  ${text}{/yellow-fg}`, connect: `${t}  {green-fg}⬤  ${text}{/green-fg}`, disconnect: `${t}  {red-fg}○  ${text}{/red-fg}`, warn: `${t}  {red-fg}⚠  ${text}{/red-fg}`, auth: `${t}  {magenta-fg}🔐 ${text}{/magenta-fg}` };
  logBox.log(lines[type] || `${t}  {#666-fg}${text}{/#666-fg}`);
  screen.render();
}

function setLive(text, isFinal = false) {
  liveBox.setContent(isFinal ? `{white-fg}{bold}${text}{/bold}{/white-fg}` : `{#888888-fg}${text}{/#888888-fg}`);
  screen.render();
}

// ─── PIN approval popup ───────────────────────────────────────────────────────

function showPinPrompt(pin, ws) {
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
    pendingPins.delete(pin);
    screen.render();
  }

  function onY() {
    cleanup();
    const deviceToken = crypto.randomBytes(16).toString('hex');
    sessions[deviceToken] = { approved: true, lastSeen: Date.now() };
    saveSessions(sessions);
    const state = phoneStates.get(ws);
    if (state) { state.authed = true; state.deviceToken = deviceToken; }
    if (ws.readyState === WebSocket.OPEN)
      ws.send(JSON.stringify({ type: 'auth', status: 'approved', deviceToken }));
    logPhrase(`Device approved — token saved`, 'auth');
    updateStatus();
  }

  function onN() {
    cleanup();
    if (ws.readyState === WebSocket.OPEN)
      ws.send(JSON.stringify({ type: 'auth', status: 'rejected' }));
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

screen.key(['C-q', 'C-c'], () => process.exit());

screen.key('C-p', () => {
  paused = !paused;
  logPhrase(paused ? 'Paused from keyboard' : 'Resumed from keyboard', 'command');
  wss.clients.forEach(c => { if (c.readyState === WebSocket.OPEN) c.send(JSON.stringify({ type: 'paused', value: paused })); });
  updateStatus();
});

screen.key('C-l', () => { logBox.setContent(''); logPhrase('Log cleared', 'info'); });

screen.key('C-r', () => {
  const form = blessed.form({ parent: screen, top: 'center', left: 'center', width: 52, height: 11, border: { type: 'line' }, style: { border: { fg: 'yellow' }, bg: '#111' }, label: ' ✎  Add Word Replacement ', keys: true });
  blessed.text({ parent: form, top: 1, left: 2, content: 'Say this word/phrase:', style: { fg: '#888' } });
  const fromInput = blessed.textbox({ parent: form, top: 2, left: 2, width: 46, height: 1, style: { fg: 'white', bg: '#222' }, inputOnFocus: true });
  blessed.text({ parent: form, top: 4, left: 2, content: 'Type this instead:', style: { fg: '#888' } });
  const toInput = blessed.textbox({ parent: form, top: 5, left: 2, width: 46, height: 1, style: { fg: 'white', bg: '#222' }, inputOnFocus: true });
  blessed.text({ parent: form, top: 7, left: 2, content: 'Tab to switch, Enter to save, Esc to cancel', style: { fg: '#555' } });
  fromInput.focus();
  fromInput.key('tab', () => toInput.focus());
  toInput.key('tab', () => fromInput.focus());
  toInput.key('enter', () => {
    const from = fromInput.getValue().trim().toLowerCase(), to = toInput.getValue().trim();
    if (from && to) { config.wordReplacements[from] = to; saveConfig(config); logPhrase(`Replacement: "${from}" → "${to}"`, 'command'); }
    form.destroy(); updateStatus();
  });
  screen.key('escape', () => { form.destroy(); screen.render(); });
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

function applyReplacements(text) {
  let out = text;
  for (const [from, to] of Object.entries(config.wordReplacements || {})) {
    out = out.replace(new RegExp(`\\b${from}\\b`, 'gi'), to);
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
      // returning device with saved token
      if (msg.deviceToken && sessions[msg.deviceToken]) {
        sessions[msg.deviceToken].lastSeen = Date.now();
        saveSessions(sessions);
        state.authed = true;
        state.deviceToken = msg.deviceToken;
        phoneStates.set(ws, state);
        connectedCount++;
        ws.send(JSON.stringify({ type: 'auth', status: 'approved', deviceToken: msg.deviceToken }));
        ws.send(JSON.stringify({ type: 'paused', value: paused }));
        logPhrase(`Known device reconnected`, 'connect');
        updateStatus();
        return;
      }
      // new device — generate PIN, show popup
      const pin = String(Math.floor(100000 + Math.random() * 900000));
      pendingPins.set(pin, ws);
      ws.send(JSON.stringify({ type: 'auth', status: 'pin', pin }));
      logPhrase(`New device — PIN: ${pin}`, 'auth');
      showPinPrompt(pin, ws);
      return;
    }

    if (!state.authed) { ws.send(JSON.stringify({ type: 'auth', status: 'required' })); return; }

    // ── Config updates ──
    if (msg.type === 'config') {
      if (typeof msg.clipboardMode === 'boolean') { state.clipboardMode = msg.clipboardMode; config.clipboardMode = msg.clipboardMode; saveConfig(config); logPhrase(`Clipboard: ${msg.clipboardMode ? 'on' : 'off'}`, 'command'); }
      if (typeof msg.pttMode === 'boolean')       { state.pttMode = msg.pttMode; logPhrase(`PTT: ${msg.pttMode ? 'on' : 'off'}`, 'command'); }
      if (typeof msg.language === 'string')       { state.language = msg.language; logPhrase(`Language: ${msg.language}`, 'command'); }
      if (typeof msg.paused === 'boolean')        { paused = msg.paused; wss.clients.forEach(c => { if (c.readyState === WebSocket.OPEN) c.send(JSON.stringify({ type: 'paused', value: paused })); }); logPhrase(paused ? 'Paused from phone' : 'Resumed from phone', 'command'); }
      phoneStates.set(ws, state);
      updateStatus();
      return;
    }

    if (paused || !msg.text) return;

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
        if (onScreen.length > 0) enqueue(`xdotool key --clearmodifiers --repeat ${onScreen.length} BackSpace`, true);
        if (vc.action === 'scratch') { if (ws._lastPhraseLen > 0) { enqueue(`xdotool key --clearmodifiers --repeat ${ws._lastPhraseLen} BackSpace`, true); logPhrase(`Scratched: "${ws._lastPhrase}"`, 'command'); ws._lastPhrase = ''; ws._lastPhraseLen = 0; } }
        else if (vc.action === 'key')  { enqueue(`xdotool key --clearmodifiers ${vc.key}`, true); logPhrase(`⌘ ${cmd}`, 'command'); }
        else if (vc.action === 'type') { typeOrClip(vc.text); logPhrase(`⌘ ${cmd} → "${vc.text}"`, 'command'); }
        return;
      }
      const finalText = applyReplacements(msg.text);
      const { deleteCount, typeStr } = wordDiff(onScreen, finalText);
      if (deleteCount > 0) enqueue(`xdotool key --clearmodifiers --repeat ${deleteCount} BackSpace`, true);
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
    logPhrase('Phone disconnected', 'disconnect');
    updateStatus();
  });
}

// Local WSS connections
wss.on('connection', handleConnection);

// ─── Relay client ─────────────────────────────────────────────────────────────

let relayStatus = 'disabled'; // 'disabled' | 'connecting' | 'connected' | 'error'
let relayWs     = null;
const virtualClients = new Map(); // clientId → VirtualWS

function connectRelay() {
  if (!config.relayUrl) { relayStatus = 'disabled'; updateStatus(); return; }

  relayStatus = 'connecting';
  updateStatus();

  const url = config.relayUrl.replace(/\/$/, '');
  relayWs = new WebSocket(url, { rejectUnauthorized: false });

  relayWs.on('open', () => {
    relayStatus = 'connected';
    relayWs.send(JSON.stringify({ type: 'host-register', token: config.urlToken }));
    logPhrase(`Relay connected — ${url}`, 'connect');
    updateStatus();
  });

  relayWs.on('message', (data) => {
    let msg;
    try { msg = JSON.parse(data.toString()); } catch { return; }

    if (msg.type === 'registered') {
      logPhrase('Relay: host registered, waiting for phones', 'info');
      return;
    }

    if (msg.type === 'error') {
      logPhrase(`Relay error: ${msg.reason}`, 'warn');
      return;
    }

    if (msg.type === 'client-connect') {
      const vws = new VirtualWS(msg.clientId, relayWs);
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

  relayWs.on('close', () => {
    relayStatus = 'error';
    // close all virtual clients cleanly
    virtualClients.forEach(vws => { vws.readyState = WebSocket.CLOSED; vws.emit('close'); });
    virtualClients.clear();
    logPhrase('Relay disconnected — retrying in 5s', 'warn');
    updateStatus();
    setTimeout(connectRelay, 5000);
  });

  relayWs.on('error', (err) => {
    relayStatus = 'error';
    logPhrase(`Relay error: ${err.message}`, 'warn');
    updateStatus();
  });
}

// ─── Start ────────────────────────────────────────────────────────────────────

server.listen(config.port, '0.0.0.0', () => {
  const { networkInterfaces } = require('os');
  const nets = networkInterfaces();
  for (const iface of Object.values(nets))
    for (const net of iface)
      if (net.family === 'IPv4' && !net.internal) { localIP = net.address; break; }

  updateStatus();

  const url = `https://${localIP}:${config.port}/${config.urlToken}`;

  // Render QR using block characters for crisp display
  QRCode.toString(url, { type: 'terminal', small: true }, (err, qrStr) => {
    if (!err) { qrBox.setContent(qrStr); screen.render(); }
  });

  logPhrase(`Server started — ${url}`, 'connect');
  logPhrase('Scan QR or open URL on your phone', 'info');
  if (config.relayUrl) logPhrase(`Relay URL set — connecting to ${config.relayUrl}`, 'info');
  else logPhrase('No relay configured — local only (set relayUrl in config.json)', 'info');
  screen.render();

  // Start relay connection after local server is up
  connectRelay();
});

process.on('exit', () => { try { screen.destroy(); } catch {} });
