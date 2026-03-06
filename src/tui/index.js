'use strict';

const QRCode = require('qrcode');
const { BUILT_IN_THEMES, createTheme } = require('./themes');
const { saveConfig } = require('../config');
const { getAiApiKey } = require('../ai');
const dialogs = require('./dialogs');

/**
 * Create the full TUI. Returns an object with all TUI methods and widgets.
 * If headless, returns stubs.
 */
function createTUI(config, opts = {}) {
  const headless = opts.headless || false;
  const T = createTheme(config.theme);

  // ── Headless mode — console-only, no blessed ──
  if (headless) {
    return {
      T, headless: true,
      screen: { render() {}, append() {}, key() {}, unkey() {}, destroy() {}, width: 80, height: 24, emit() {} },
      logPhrase: _headlessLog,
      setLive() {},
      updateStatus() {},
      renderQR: _headlessQR,
      showQR() {},
      hideQR() {},
      destroy() {},
      bindKeys() {},
      applyTheme() { return false; },
      clearLog() {},
      setupInputBar() {},
      setAppState() {},
      widgets: {},
    };
  }

  // ── Full TUI ──
  // blessed doesn't recognize some modern terminals (kitty, alacritty, etc.)
  // which causes raw escape sequences to leak as visible garbage characters
  const knownTerms = ['xterm', 'xterm-256color', 'screen', 'screen-256color', 'tmux', 'tmux-256color', 'rxvt', 'linux', 'vt100'];
  if (process.env.TERM && !knownTerms.some(t => process.env.TERM.startsWith(t))) {
    process.env.TERM = 'xterm-256color';
  }

  const blessed = require('blessed');
  const screen = blessed.screen({ smartCSR: true, title: 'AirMic', fullUnicode: true, mouse: false });

  // ── Header bar ──
  const titleBar = blessed.box({
    top: 0, left: 0, width: '100%', height: 1, tags: true,
    style: { fg: T.text, bg: T.bgPanel },
  });

  // ── Main area ──
  const mainPanel = blessed.box({
    top: 1, left: 0, width: '100%', height: '100%-3',
    style: { bg: T.bg },
  });

  const logBox = blessed.log({
    parent: mainPanel, top: 0, left: 2, width: '100%-4', height: '100%-4',
    tags: true, scrollable: true, alwaysScroll: true, mouse: false,
    scrollbar: { ch: '│', track: { bg: T.bg }, style: { fg: T.border } },
    style: { fg: T.text, bg: T.bg },
  });

  // ── Live preview ──
  const liveBox = blessed.box({
    parent: mainPanel, bottom: 0, left: 0, width: '100%', height: 4,
    style: { bg: T.bgPanel },
    tags: true, padding: { left: 3, top: 1 },
    content: `{${T.textDim}-fg}Waiting for speech...{/${T.textDim}-fg}`,
  });
  const liveAccent = blessed.box({
    parent: mainPanel, bottom: 1, left: 1, width: 1, height: 2,
    style: { bg: T.bg },
    tags: true,
    content: `{${T.primary}-fg}┃{/${T.primary}-fg}\n{${T.primary}-fg}┃{/${T.primary}-fg}`,
  });

  // ── QR overlay ──
  const qrOverlay = blessed.box({
    top: 'center', left: 'center', width: 50, height: 24,
    border: { type: 'line' },
    style: { border: { fg: T.border }, bg: '#1c1c1e' },
    tags: true, hidden: false,
  });
  const qrTitle = blessed.box({
    parent: qrOverlay, top: 0, left: 2, width: '100%-6', height: 1,
    tags: true, style: { bg: '#1c1c1e' },
    content: `{bold}{${T.primary}-fg}Scan to Connect{/${T.primary}-fg}{/bold}`,
  });
  const qrInfo = blessed.box({
    parent: qrOverlay, top: 2, left: 2, width: '100%-6', height: 3,
    tags: true, style: { bg: '#1c1c1e' },
  });
  const qrBox = blessed.box({
    parent: qrOverlay, top: 5, left: 2, width: '100%-6', height: '100%-7',
    tags: true, style: { fg: '#e8dcc8', bg: '#1c1c1e' },
    content: '',
  });

  // ── Bottom section ──
  const bottomBar = blessed.box({
    bottom: 1, left: 0, width: '100%', height: 1, tags: true,
    style: { fg: T.textMuted, bg: T.bgPanel },
  });
  const inputBar = blessed.textbox({
    bottom: 0, left: 0, width: '100%', height: 1,
    style: { fg: T.text, bg: T.bgElement },
    inputOnFocus: false, tags: false,
  });
  const inputHint = blessed.box({
    bottom: 0, left: 0, width: '100%', height: 1, tags: true,
    style: { fg: T.textDim, bg: T.bgElement },
    content: `  /  commands   Ctrl+K  palette   Ctrl+Q  quit`,
  });

  // Append to screen
  screen.append(titleBar);
  screen.append(mainPanel);
  screen.append(bottomBar);
  screen.append(inputHint);
  screen.append(inputBar);
  screen.append(qrOverlay);

  // Initially hide input bar
  inputBar.hide();

  const widgets = { titleBar, mainPanel, logBox, liveBox, liveAccent, qrOverlay, qrTitle, qrInfo, qrBox, bottomBar, inputBar, inputHint };

  // ── State ──
  let qrVisible = true;
  let startTime = Date.now();
  let inputActive = false;
  let completionBox = null;

  // These are set by the caller via setAppState
  let appState = { paused: false, connectedCount: 0, totalPhrases: 0, totalWords: 0, relayStatus: 'disabled', config };

  function setAppState(s) { Object.assign(appState, s); }

  // ── Helpers ──
  function fmtUptime() {
    const s = Math.floor((Date.now() - startTime) / 1000);
    const h = Math.floor(s/3600), m = Math.floor((s%3600)/60), ss = s%60;
    return `${String(h).padStart(2,'0')}:${String(m).padStart(2,'0')}:${String(ss).padStart(2,'0')}`;
  }

  function updateQRVisibility() {
    const hasClient = appState.connectedCount > 0;
    if (hasClient && qrVisible) { qrOverlay.hide(); qrVisible = false; screen.render(); }
    else if (!hasClient && !qrVisible) { qrOverlay.show(); qrVisible = true; screen.render(); }
  }

  function updateTitleBar() {
    const clientDot = appState.connectedCount > 0
      ? `{${T.green}-fg}●{/${T.green}-fg} ${appState.connectedCount} device${appState.connectedCount > 1 ? 's' : ''}`
      : `{${T.textDim}-fg}○ waiting{/${T.textDim}-fg}`;
    const relayDot = appState.relayStatus === 'connected' ? `{${T.green}-fg}▲{/${T.green}-fg} relay`
      : appState.relayStatus === 'connecting' ? `{${T.yellow}-fg}◐{/${T.yellow}-fg} relay`
      : appState.relayStatus === 'error' ? `{${T.red}-fg}▼{/${T.red}-fg} relay`
      : '';
    const aiDot = config.aiEnabled && getAiApiKey()
      ? `{${T.cyan}-fg}●{/${T.cyan}-fg} AI:${config.aiProvider}` : '';
    const pauseDot = appState.paused ? `{${T.red}-fg}■ PAUSED{/${T.red}-fg}` : '';

    const stats = [];
    if (appState.totalPhrases > 0) stats.push(`{${T.textMuted}-fg}${appState.totalPhrases} phrases{/${T.textMuted}-fg}`);
    if (appState.totalWords > 0) stats.push(`{${T.textMuted}-fg}${appState.totalWords} words{/${T.textMuted}-fg}`);
    stats.push(`{${T.textDim}-fg}${fmtUptime()}{/${T.textDim}-fg}`);
    const right = stats.join(`  {${T.border}-fg}·{/${T.border}-fg}  `) + '  ';

    const parts = [`  {bold}{${T.primary}-fg}AirMic{/${T.primary}-fg}{/bold}`, clientDot];
    if (relayDot) parts.push(relayDot);
    if (aiDot) parts.push(aiDot);
    if (pauseDot) parts.push(pauseDot);
    const sep = `  {${T.border}-fg}·{/${T.border}-fg}  `;
    titleBar.setContent(`${parts.join(sep)}${' '.repeat(Math.max(2, (screen.width || 80) - 60))}${right}`);
  }

  function updateStatus() {
    updateTitleBar();
    updateQRVisibility();

    const states = appState.phoneStates ? [...appState.phoneStates.values()].filter(s => s.authed) : [];
    let modeInfo = '';
    if (states.length > 0) {
      const s = states[0];
      modeInfo = `{${T.textDim}-fg}${s.language || config.language} · ${s.pttMode ? 'Hold' : 'Toggle'} · ${s.clipboardMode ? 'Clipboard' : 'Direct'}{/${T.textDim}-fg}`;
    }
    const left = modeInfo ? `  ${modeInfo}` : `  {${T.textDim}-fg}AirMic{/${T.textDim}-fg}`;
    const wordsInfo = appState.totalWords > 0 ? `${appState.totalWords} words  ` : '';
    const right = `{${T.textDim}-fg}${wordsInfo}${fmtUptime()}{/${T.textDim}-fg}  `;
    bottomBar.setContent(`${left}${' '.repeat(Math.max(0, (screen.width || 80) - 50))}${right}`);
    screen.render();
  }

  function logPhrase(text, type = 'info') {
    const time = new Date().toLocaleTimeString('en-GB', { hour:'2-digit', minute:'2-digit', second:'2-digit' });
    const ts = `{${T.textDim}-fg}${time}{/${T.textDim}-fg}`;
    const safe = String(text).replace(/[{}]/g, c => c === '{' ? '\\{' : '\\}');

    if (type === 'connect' || type === 'disconnect') {
      const lineColor = type === 'connect' ? T.green : T.red;
      logBox.log(`  {${T.border}-fg}${'─'.repeat(Math.max(20, (screen.width || 80) - 10))}{/${T.border}-fg}`);
    }

    const markers = {
      phrase:     { mark: T.text,    icon: '  ', color: T.text },
      command:    { mark: T.primary, icon: '› ', color: T.primary },
      connect:    { mark: T.green,   icon: '+ ', color: T.green },
      disconnect: { mark: T.red,     icon: '- ', color: T.red },
      warn:       { mark: T.red,     icon: '! ', color: T.red },
      auth:       { mark: T.purple,  icon: '# ', color: T.purple },
      info:       { mark: T.textMuted, icon: '  ', color: T.textMuted },
    };
    const m = markers[type] || markers.info;
    logBox.log(`  {${m.mark}-fg}┃{/${m.mark}-fg} ${ts}  {${m.color}-fg}${m.icon}${safe}{/${m.color}-fg}`);
    screen.render();
  }

  function setLive(text, isFinal = false) {
    const safe = String(text).replace(/[{}]/g, c => c === '{' ? '\\{' : '\\}');
    liveBox.setContent(isFinal
      ? `{${T.text}-fg}{bold}${safe}{/bold}{/${T.text}-fg}`
      : `{${T.textMuted}-fg}${safe}{/${T.textMuted}-fg}`);
    const col = isFinal ? T.green : T.primary;
    liveAccent.setContent(`{${col}-fg}┃{/${col}-fg}\n{${col}-fg}┃{/${col}-fg}`);
    screen.render();
  }

  function renderQR(displayUrl, mode, localUrl) {
    if (mode === 'relay-pending') {
      qrInfo.setContent(
        `{${T.yellow}-fg}Waiting for relay connection...{/${T.yellow}-fg}\n` +
        `{${T.textDim}-fg}QR code will appear once relay is ready{/${T.textDim}-fg}`
      );
      qrBox.setContent('');
      screen.render();
      return;
    }

    qrInfo.setContent(
      `{${T.textDim}-fg}URL{/${T.textDim}-fg}  {${T.text}-fg}${displayUrl}{/${T.text}-fg}\n` +
      `{${T.textDim}-fg}Mode{/${T.textDim}-fg} {${mode === 'relay' ? T.green : T.primary}-fg}${mode}{/${mode === 'relay' ? T.green : T.primary}-fg}`
    );

    const termH = screen.height || 24;
    const termW = screen.width || 80;
    const ecl = (termH < 30 || termW < 50) ? 'L' : 'M';

    QRCode.toString(displayUrl, { type: 'utf8', errorCorrectionLevel: ecl }, (err, qrStr) => {
      if (err) return;
      const lines = qrStr.split('\n').filter(l => l.length > 0);
      const qrH = lines.length;
      const qrW = Math.max(...lines.map(l => l.length));
      const overlayH = Math.min(qrH + 9, termH - 2);
      const overlayW = Math.min(qrW + 8, termW - 4);
      qrOverlay.width = overlayW;
      qrOverlay.height = overlayH;
      const colored = lines.map(line => `{${T.primary}-fg}${line}{/${T.primary}-fg}`).join('\n');
      qrBox.setContent(colored);
      screen.render();
    });
  }

  function showQR() { qrOverlay.show(); qrVisible = true; screen.render(); }
  function hideQR() { qrOverlay.hide(); qrVisible = false; screen.render(); }

  function applyTheme(name) {
    const theme = BUILT_IN_THEMES[name];
    if (!theme) return false;
    Object.assign(T, theme);
    config.theme = name;
    saveConfig(config);
    titleBar.style.bg = T.bgPanel; titleBar.style.fg = T.text;
    mainPanel.style.bg = T.bg;
    logBox.style.bg = T.bg; logBox.style.fg = T.text;
    liveBox.style.bg = T.bgPanel;
    bottomBar.style.bg = T.bgPanel; bottomBar.style.fg = T.textMuted;
    inputHint.style.bg = T.bgElement; inputHint.style.fg = T.textDim;
    inputBar.style.bg = T.bgElement; inputBar.style.fg = T.text;
    qrOverlay.style.border.fg = T.border;
    screen.render();
    return true;
  }

  function clearLog() { logBox.setContent(''); logPhrase('Log cleared', 'info'); }

  function destroy() { try { screen.destroy(); } catch {} }

  // ── Input bar + slash commands ──
  function setupInputBar(slashCommands) {
    function activateInput() {
      if (inputActive) return;
      inputActive = true;
      inputHint.hide();
      inputBar.show();
      inputBar.setValue('');
      inputBar.readInput();
      screen.render();
    }

    function deactivateInput() {
      inputActive = false;
      inputBar.cancel();
      inputBar.setValue('');
      inputBar.hide();
      if (completionBox) { completionBox.destroy(); completionBox = null; }
      inputHint.show();
      screen.render();
    }

    screen.key('/', () => {
      if (inputActive) return;
      activateInput();
      inputBar.setValue('/');
      screen.render();
    });

    inputBar.key('escape', () => deactivateInput());

    inputBar.key('tab', () => {
      const val = inputBar.getValue();
      if (!val.startsWith('/')) return;
      const partial = val.slice(1).toLowerCase();
      const matches = slashCommands.filter(c => c.name.startsWith(partial));
      if (matches.length === 1) {
        inputBar.setValue('/' + matches[0].name);
        screen.render();
      } else if (matches.length > 1) {
        if (completionBox) { completionBox.destroy(); completionBox = null; }
        completionBox = blessed.list({
          parent: screen, bottom: 2, left: 1,
          width: 36, height: Math.min(matches.length + 2, 12),
          border: { type: 'line' },
          style: { border: { fg: T.border }, bg: T.bgPanel, item: { fg: T.textMuted, bg: T.bgPanel }, selected: { fg: T.text, bg: T.bgElement, bold: true } },
          keys: true, vi: true, mouse: false, tags: true,
          items: matches.map(c => `  /${c.name}  {${T.textDim}-fg}${c.desc}{/${T.textDim}-fg}`),
        });
        completionBox.focus();
        screen.render();
        completionBox.on('select', (el, idx) => {
          completionBox.destroy(); completionBox = null;
          inputBar.setValue('/' + matches[idx].name);
          inputBar.readInput();
          screen.render();
        });
        completionBox.key('escape', () => {
          completionBox.destroy(); completionBox = null;
          inputBar.readInput();
          screen.render();
        });
      }
    });

    inputBar.on('submit', (val) => {
      deactivateInput();
      if (!val || !val.startsWith('/')) return;
      const cmdName = val.slice(1).trim().toLowerCase();
      const cmd = slashCommands.find(c => c.name === cmdName);
      if (cmd) cmd.fn();
      else if (cmdName) logPhrase(`Unknown command: /${cmdName}`, 'warn');
    });
  }

  // ── Key bindings ──
  function bindKeys(handlers) {
    screen.key(['C-q', 'C-c'], () => handlers.shutdown());
    screen.key('C-p', () => handlers.togglePause());
    screen.key('C-l', () => clearLog());
    screen.key('C-k', () => handlers.showCommandPalette());
    screen.key('C-e', () => handlers.showRelayServers());
    screen.key('C-a', () => handlers.showAiSettings());
    screen.key('C-r', () => handlers.showAddReplace());
    screen.key('C-d', () => handlers.showDelReplace());
  }

  // Start status refresh interval
  const statusInterval = setInterval(updateStatus, 1000);

  return {
    T, headless: false, blessed, screen, widgets,
    logPhrase, setLive, updateStatus, renderQR,
    showQR, hideQR, applyTheme, clearLog, destroy,
    setupInputBar, bindKeys, setAppState,
    _statusInterval: statusInterval,
  };
}

// ── Headless helpers ──
function _headlessLog(text, type = 'info') {
  const time = new Date().toLocaleTimeString('en-GB', { hour:'2-digit', minute:'2-digit', second:'2-digit' });
  const prefix = { phrase: '>', command: '*', connect: '+', disconnect: '-', warn: '!', auth: '#', info: '~' };
  console.log(`[${time}] ${prefix[type] || '~'}  ${text}`);
}

function _headlessQR(displayUrl, mode, localUrl) {
  if (mode === 'relay-pending') {
    console.log(`\n╔══════════════════════════════════════════════════╗`);
    console.log(`║  AirMic — Waiting for relay connection...`);
    console.log(`║  QR code will appear once relay is ready`);
    console.log(`╚══════════════════════════════════════════════════╝\n`);
    return;
  }
  console.log(`\n╔══════════════════════════════════════════════════╗`);
  console.log(`║  AirMic — ${mode === 'relay' ? 'RELAY' : 'LOCAL'} mode`);
  console.log(`║  Phone URL: ${displayUrl}`);
  if (mode === 'relay') console.log(`║  Local:     ${localUrl}`);
  console.log(`╚══════════════════════════════════════════════════╝\n`);
}

module.exports = { createTUI };
