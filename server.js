#!/usr/bin/env node
'use strict';

const path = require('path');
const fs   = require('fs');
const net  = require('net');
const { networkInterfaces } = require('os');

const { initConfig, initSessions, saveConfig, saveSessions, pruneSessions, ROOT } = require('./src/config');
const { createServer } = require('./src/connection/http');
const { createConnectionHandler } = require('./src/connection/handler');
const { createTUI } = require('./src/tui');
const { createPinSystem } = require('./src/tui/pin-prompt');
const RelayClient = require('./src/relay/client');
const dialogs = require('./src/tui/dialogs');
const { getAiApiKey } = require('./src/ai');

// ─── CLI argument parsing ────────────────────────────────────────────────────

const args = process.argv.slice(2);
const command = args[0] || '';

// IPC socket path for daemon communication
const IPC_PATH = path.join(ROOT, '.voicebridge.sock');
const PID_PATH = path.join(ROOT, '.voicebridge.pid');
const LOG_PATH = path.join(ROOT, 'voicebridge.log');

// ─── Subcommand routing ──────────────────────────────────────────────────────

if (command === 'headless') {
  const action = args[1];
  if (action === 'on')  return startDaemon();
  if (action === 'off') return stopDaemon();
  console.log('Usage: voicebridge headless on|off');
  process.exit(1);
}

if (command === 'status') return showStatus();
if (command === 'approve') {
  const pin = args[1];
  if (!pin) { console.log('Usage: voicebridge approve <PIN>'); process.exit(1); }
  return approvePin(pin);
}

if (command === 'help' || command === '--help' || command === '-h') {
  console.log(`
  VoiceBridge — Turn your phone into a wireless mic

  Usage:
    voicebridge                  Launch TUI (interactive)
    voicebridge headless on      Start as background daemon
    voicebridge headless off     Stop the daemon
    voicebridge status           Show daemon status
    voicebridge approve <PIN>    Approve a new device by PIN

  Options:
    --help, -h                   Show this help
`);
  process.exit(0);
}

// Default: launch TUI (unless internal daemon mode)
if (command === '--headless-daemon') {
  startApp(true);
} else {
  startApp(false);
}

// ─── Start app (TUI or headless inline) ──────────────────────────────────────

function startApp(headless) {
  const config   = initConfig();
  const sessions = initSessions();

  // Prune sessions daily
  setInterval(() => pruneSessions(sessions), 24 * 60 * 60 * 1000);

  // Create TUI (or headless stubs)
  const tui = createTUI(config, { headless });

  // Create HTTP/WSS server
  const { app, server, wss } = createServer(config, ROOT);

  // Shared mutable state
  let paused = false;
  let totalPhrases = 0;
  let totalWords = 0;
  let localIP = 'localhost';
  let localUrl = '';

  // Relay client
  const relay = new RelayClient(config, {
    logFn: tui.logPhrase,
    onStatus: (status) => {
      tui.setAppState({ relayStatus: status });
      tui.updateStatus();
    },
    onQR: () => doRenderQR(),
  });

  // PIN system
  const pinSystem = createPinSystem({
    headless,
    blessed: tui.blessed,
    screen: tui.screen,
    sessions, saveSessions,
    phoneStates: null, // set after connection handler
    logFn: tui.logPhrase,
    updateStatus: () => tui.updateStatus(),
    T: tui.T,
    getConnectedCount: () => connHandler.getConnectedCount(),
    setConnectedCount: (n) => {
      connHandler.setConnectedCount(n);
      tui.setAppState({ connectedCount: n });
    },
  });

  // Connection handler
  const connHandler = createConnectionHandler({
    config, sessions, saveSessions: (s) => saveSessions(s),
    saveConfig: (c) => saveConfig(c),
    wss,
    logFn: tui.logPhrase,
    setLive: tui.setLive,
    updateStatus: () => {
      tui.setAppState({
        connectedCount: connHandler.getConnectedCount(),
        paused, totalPhrases, totalWords,
        phoneStates: connHandler.phoneStates,
      });
      tui.updateStatus();
    },
    getPaused: () => paused,
    setPaused: (v) => { paused = v; },
    showPinPrompt: pinSystem.showPinPrompt,
    relayClient: relay,
    onCountChange: (n) => tui.setAppState({ connectedCount: n }),
    get totalPhrases() { return totalPhrases; },
    set totalPhrases(v) { totalPhrases = v; },
    get totalWords() { return totalWords; },
    set totalWords(v) { totalWords = v; },
  });

  // Wire PIN system's phoneStates reference
  pinSystem._ctx = pinSystem._ctx || {};
  // The pin system needs phoneStates from connHandler
  Object.defineProperty(pinSystem, '_phoneStates', { get: () => connHandler.phoneStates });

  // Set relay's handleConnection
  relay.handleConnection = connHandler.handleConnection;

  // Local WSS connections
  wss.on('connection', (ws, req) => {
    const ip = req.socket.remoteAddress || 'unknown';
    tui.logPhrase(`WSS connection from ${ip}`, 'connect');
    connHandler.handleConnection(ws);
  });

  // QR rendering
  function doRenderQR() {
    const useRelay = config.relayUrl && relay.roomToken;
    const displayUrl = useRelay
      ? config.relayUrl.replace(/^wss:\/\//, 'https://').replace(/\/$/, '') + `/${relay.roomToken}`
      : localUrl;
    const mode = useRelay ? 'relay' : 'local';
    tui.renderQR(displayUrl, mode, localUrl);
  }

  // Helper functions for TUI context
  function togglePause() {
    paused = !paused;
    tui.logPhrase(paused ? 'Paused' : 'Resumed', 'command');
    connHandler.broadcast({ type: 'paused', value: paused });
    tui.setAppState({ paused });
    tui.updateStatus();
  }

  function reconnectRelay() {
    relay.disconnect();
    config._localUrl = localUrl;
    tui.setAppState({ relayStatus: 'disabled' });
    tui.updateStatus();
    doRenderQR();
    relay.connect();
  }

  function disconnectRelay() {
    relay.disconnect();
    tui.setAppState({ relayStatus: 'disabled' });
    tui.updateStatus();
    doRenderQR();
  }

  // Dialog context
  const dialogCtx = {
    blessed: tui.blessed, screen: tui.screen, T: tui.T,
    config, sessions, saveSessions,
    logFn: tui.logPhrase,
    updateStatus: () => tui.updateStatus(),
    togglePause,
    clearLog: () => tui.clearLog(),
    shutdown,
    reconnectRelay,
    disconnectRelay,
    applyTheme: (name) => tui.applyTheme(name),
  };

  // Setup TUI key bindings and slash commands
  if (!headless) {
    const slashCommands = [
      { name: 'pause',      desc: 'Toggle pause',           fn: () => togglePause() },
      { name: 'relay',      desc: 'Relay server settings',  fn: () => dialogs.showRelayServers(dialogCtx) },
      { name: 'ai',         desc: 'AI settings',            fn: () => dialogs.showAiSettings(dialogCtx) },
      { name: 'replace',    desc: 'Add word replacement',   fn: () => dialogs.showAddReplace(dialogCtx) },
      { name: 'delreplace', desc: 'Delete word replacement', fn: () => dialogs.showDelReplace(dialogCtx) },
      { name: 'clear',      desc: 'Clear log',              fn: () => tui.clearLog() },
      { name: 'sessions',   desc: 'Manage device sessions', fn: () => dialogs.showSessionManager(dialogCtx) },
      { name: 'theme',      desc: 'Switch theme',           fn: () => dialogs.showThemePicker(dialogCtx) },
      { name: 'help',       desc: 'Show keybinds & commands', fn: () => dialogs.showHelp(dialogCtx) },
      { name: 'quit',       desc: 'Exit VoiceBridge',       fn: () => shutdown() },
    ];

    tui.setupInputBar(slashCommands);
    tui.bindKeys({
      shutdown,
      togglePause,
      showCommandPalette: () => dialogs.showCommandPalette(dialogCtx),
      showRelayServers:   () => dialogs.showRelayServers(dialogCtx),
      showAiSettings:     () => dialogs.showAiSettings(dialogCtx),
      showAddReplace:     () => dialogs.showAddReplace(dialogCtx),
      showDelReplace:     () => dialogs.showDelReplace(dialogCtx),
    });
  }

  // ─── Start server ──────────────────────────────────────────────────────────

  server.listen(config.port, '0.0.0.0', () => {
    const nets = networkInterfaces();
    for (const iface of Object.values(nets))
      for (const n of iface)
        if (n.family === 'IPv4' && !n.internal) { localIP = n.address; break; }

    localUrl = `https://${localIP}:${config.port}/${config.urlToken}`;
    config._localUrl = localUrl;

    if (!headless) tui.showQR();
    doRenderQR();
    tui.logPhrase(`Server started — ${localUrl}`, 'connect');

    if (headless) {
      tui.logPhrase('Open the Phone URL above on your phone to connect', 'info');
    } else {
      tui.logPhrase('Scan QR or open URL on your phone', 'info');
    }

    if (config.relayUrl) {
      tui.logPhrase(`Relay: connecting to ${config.relayUrl}`, 'info');
      relay.connect();
    } else {
      if (headless) tui.logPhrase('Local only — set relayUrl in config.json to enable relay', 'info');
      else tui.logPhrase('Local only — press Ctrl+E to add a relay', 'info');
    }

    if (!getAiApiKey()) {
      if (headless) tui.logPhrase('Tip: set VOICEBRIDGE_AI_KEY in .env to enable AI summarize', 'info');
      else tui.logPhrase('Tip: Ctrl+A to configure AI summarize', 'info');
    }

    if (!headless) tui.screen.render();

    // Start IPC server for CLI commands
    startIPC({ pinSystem, config, relay, paused: () => paused, connectedCount: () => connHandler.getConnectedCount(), totalPhrases: () => totalPhrases, totalWords: () => totalWords });
  });

  // ─── Shutdown ──────────────────────────────────────────────────────────────

  function shutdown() {
    relay.disconnect();
    tui.destroy();
    cleanupIPC();
    process.exit(0);
  }

  process.on('SIGTERM', shutdown);
  process.on('SIGINT',  shutdown);
  process.on('exit', () => tui.destroy());
  process.on('uncaughtException',  (err) => { try { tui.logPhrase(`uncaughtException: ${err?.message || err}`, 'warn'); } catch { console.error('uncaughtException:', err); } });
  process.on('unhandledRejection', (err) => { try { tui.logPhrase(`unhandledRejection: ${err?.message || err}`, 'warn'); } catch { console.error('unhandledRejection:', err); } });
}

// ─── IPC server (Unix socket) ────────────────────────────────────────────────

let ipcServer = null;

function startIPC(ctx) {
  // Clean up stale socket
  try { fs.unlinkSync(IPC_PATH); } catch {}

  ipcServer = net.createServer((conn) => {
    let buf = '';
    conn.on('data', (data) => {
      buf += data.toString();
      if (!buf.includes('\n')) return;
      const lines = buf.split('\n');
      buf = lines.pop();
      for (const line of lines) {
        try {
          const msg = JSON.parse(line);
          const resp = handleIPC(msg, ctx);
          conn.write(JSON.stringify(resp) + '\n');
        } catch { conn.write(JSON.stringify({ error: 'invalid request' }) + '\n'); }
      }
    });
  });

  ipcServer.listen(IPC_PATH);

  // Write PID file
  fs.writeFileSync(PID_PATH, String(process.pid));
}

function handleIPC(msg, ctx) {
  if (msg.cmd === 'status') {
    return {
      ok: true,
      pid: process.pid,
      paused: ctx.paused(),
      connectedCount: ctx.connectedCount(),
      totalPhrases: ctx.totalPhrases(),
      totalWords: ctx.totalWords(),
      relayStatus: ctx.relay.status,
      relayUrl: ctx.config.relayUrl || null,
      pendingPins: ctx.pinSystem.getPendingPins(),
    };
  }
  if (msg.cmd === 'approve' && msg.pin) {
    const ok = ctx.pinSystem.approveByPin(String(msg.pin));
    return { ok, message: ok ? 'Device approved' : 'PIN not found or device disconnected' };
  }
  return { error: 'unknown command' };
}

function cleanupIPC() {
  if (ipcServer) { try { ipcServer.close(); } catch {} }
  try { fs.unlinkSync(IPC_PATH); } catch {}
  try { fs.unlinkSync(PID_PATH); } catch {}
}

// ─── CLI subcommands ─────────────────────────────────────────────────────────

function startDaemon() {
  // Check if already running
  if (fs.existsSync(PID_PATH)) {
    const pid = parseInt(fs.readFileSync(PID_PATH, 'utf8'));
    try { process.kill(pid, 0); console.log(`VoiceBridge is already running (PID ${pid})`); process.exit(1); }
    catch {} // process not running, stale PID file
  }

  const { spawn } = require('child_process');
  const logFd = fs.openSync(LOG_PATH, 'a');

  const child = spawn(process.execPath, [__filename, '--headless-daemon'], {
    detached: true,
    stdio: ['ignore', logFd, logFd],
    env: { ...process.env },
  });

  child.unref();
  console.log(`VoiceBridge daemon started (PID ${child.pid})`);
  console.log(`  Log: ${LOG_PATH}`);
  console.log(`  Stop: voicebridge headless off`);
  console.log(`  Status: voicebridge status`);
  process.exit(0);
}

function stopDaemon() {
  if (!fs.existsSync(PID_PATH)) {
    console.log('VoiceBridge is not running');
    process.exit(1);
  }
  const pid = parseInt(fs.readFileSync(PID_PATH, 'utf8'));
  try {
    process.kill(pid, 'SIGTERM');
    console.log(`VoiceBridge stopped (PID ${pid})`);
    try { fs.unlinkSync(PID_PATH); } catch {}
    try { fs.unlinkSync(IPC_PATH); } catch {}
  } catch {
    console.log(`Process ${pid} not found — cleaning up stale PID file`);
    try { fs.unlinkSync(PID_PATH); } catch {}
    try { fs.unlinkSync(IPC_PATH); } catch {}
  }
  process.exit(0);
}

function showStatus() {
  if (!fs.existsSync(IPC_PATH)) {
    console.log('VoiceBridge is not running');
    process.exit(1);
  }

  const conn = net.createConnection(IPC_PATH);
  conn.on('connect', () => {
    conn.write(JSON.stringify({ cmd: 'status' }) + '\n');
  });

  let buf = '';
  conn.on('data', (data) => {
    buf += data.toString();
    if (!buf.includes('\n')) return;
    const resp = JSON.parse(buf.split('\n')[0]);
    conn.destroy();

    console.log(`VoiceBridge — running (PID ${resp.pid})`);
    console.log(`  Devices:  ${resp.connectedCount}`);
    console.log(`  Paused:   ${resp.paused ? 'yes' : 'no'}`);
    console.log(`  Phrases:  ${resp.totalPhrases}`);
    console.log(`  Words:    ${resp.totalWords}`);
    console.log(`  Relay:    ${resp.relayUrl || 'disabled'} (${resp.relayStatus})`);
    if (resp.pendingPins.length > 0) {
      console.log(`  Pending PINs: ${resp.pendingPins.join(', ')}`);
      console.log(`  Run: voicebridge approve <PIN>`);
    }
    process.exit(0);
  });

  conn.on('error', () => {
    console.log('VoiceBridge is not running (stale socket)');
    process.exit(1);
  });
}

function approvePin(pin) {
  if (!fs.existsSync(IPC_PATH)) {
    console.log('VoiceBridge is not running');
    process.exit(1);
  }

  const conn = net.createConnection(IPC_PATH);
  conn.on('connect', () => {
    conn.write(JSON.stringify({ cmd: 'approve', pin }) + '\n');
  });

  let buf = '';
  conn.on('data', (data) => {
    buf += data.toString();
    if (!buf.includes('\n')) return;
    const resp = JSON.parse(buf.split('\n')[0]);
    conn.destroy();
    console.log(resp.ok ? resp.message : `Failed: ${resp.message || resp.error}`);
    process.exit(resp.ok ? 0 : 1);
  });

  conn.on('error', () => {
    console.log('VoiceBridge is not running');
    process.exit(1);
  });
}
