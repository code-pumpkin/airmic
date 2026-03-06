'use strict';

const fs = require('fs');
const { BUILT_IN_THEMES } = require('./themes');
const { DEFAULT_CONFIG, ENV_PATH, saveConfig } = require('../config');
const { resetSdkCache, getAiApiKey } = require('../ai');
const RelayClient = require('../relay/client');

/**
 * All TUI dialog/popup functions.
 * Each takes a ctx object with blessed, screen, T, config, etc.
 */

function showCommandPalette(ctx) {
  const { blessed, screen, T } = ctx;
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
    if (act === 'pause')      { ctx.togglePause(); }
    else if (act === 'relay') { showRelayServers(ctx); }
    else if (act === 'ai')    { showAiSettings(ctx); }
    else if (act === 'replace') { showAddReplace(ctx); }
    else if (act === 'delreplace') { showDelReplace(ctx); }
    else if (act === 'clear') { ctx.clearLog(); }
    else if (act === 'quit')  { ctx.shutdown(); }
  });
}

function promptInput(ctx, label, defaultVal, cb) {
  const { blessed, screen, T } = ctx;
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

function showRelayServers(ctx) {
  const { blessed, screen, T, config } = ctx;
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

  const healthCache = {};

  function buildItems() {
    const items = config.relayServers.map(s => {
      const active = s.url === config.relayUrl ? ` {${T.green}-fg}●{/${T.green}-fg}` : '';
      let status = '';
      const h = healthCache[s.url];
      if (h === 'checking') status = ` {${T.textDim}-fg}…{/${T.textDim}-fg}`;
      else if (h && h.up) status = ` {${T.green}-fg}▲{/${T.green}-fg}`;
      else if (h && !h.up) status = ` {${T.red}-fg}▼{/${T.red}-fg}`;
      return `  ${s.name || s.url.slice(0, 35)}${active}${status}`;
    });
    items.push(`  {${T.cyan}-fg}+ Add custom server{/${T.cyan}-fg}`);
    items.push(`  {${T.red}-fg}- Remove a server{/${T.red}-fg}`);
    items.push(`  {${T.yellow}-fg}× Disable relay{/${T.yellow}-fg}`);
    return items;
  }

  config.relayServers.forEach(s => {
    healthCache[s.url] = 'checking';
    RelayClient.checkHealth(s.url, s.secret).then(result => {
      healthCache[s.url] = result;
      try { sList.setItems(buildItems()); screen.render(); } catch {}
    });
  });

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

  function onEsc() { screen.unkey('escape', onEsc); form.destroy(); screen.render(); }
  screen.key('escape', onEsc);

  sList.on('select', (item, idx) => {
    screen.unkey('escape', onEsc);
    form.destroy();
    screen.render();

    if (idx < config.relayServers.length) {
      const srv = config.relayServers[idx];
      config.relayUrl = srv.url;
      config.relaySecret = srv.secret || '';
      config.relayRejectUnauthorized = true;
      saveConfig(config);
      ctx.logFn(`Relay set: ${srv.name || srv.url}`, 'command');
      ctx.reconnectRelay();
    } else if (idx === config.relayServers.length) {
      _addCustomRelay(ctx);
    } else if (idx === config.relayServers.length + 1) {
      _removeRelay(ctx);
    } else if (idx === config.relayServers.length + 2) {
      config.relayUrl = '';
      config.relaySecret = '';
      saveConfig(config);
      ctx.disconnectRelay();
      ctx.logFn('Relay disabled', 'command');
    }
  });
}

function _addCustomRelay(ctx) {
  promptInput(ctx, 'Server name:', '', (name) => {
    if (name === null) return;
    promptInput(ctx, 'Relay URL:', 'wss://', (url) => {
      if (url === null || !url || url === 'wss://' || !/^wss:\/\/.+/.test(url)) return;
      promptInput(ctx, 'Secret (blank if none):', '', (secret) => {
        if (secret === null) secret = '';
        const entry = { name: name || url.replace(/^wss:\/\//, '').slice(0, 40), url, secret };
        if (!ctx.config.relayServers.some(s => s.url === url)) ctx.config.relayServers.push(entry);
        ctx.config.relayUrl = url;
        ctx.config.relaySecret = secret;
        ctx.config.relayRejectUnauthorized = true;
        saveConfig(ctx.config);
        ctx.logFn(`Relay added: ${entry.name}`, 'command');
        ctx.reconnectRelay();
      });
    });
  });
}

function _removeRelay(ctx) {
  const { blessed, screen, T, config } = ctx;
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

  function onEsc() { screen.unkey('escape', onEsc); rmList.destroy(); screen.render(); }
  screen.key('escape', onEsc);

  rmList.on('select', (item, idx) => {
    screen.unkey('escape', onEsc);
    const removed = config.relayServers.splice(idx, 1)[0];
    if (removed && removed.url === config.relayUrl) {
      config.relayUrl = '';
      config.relaySecret = '';
      ctx.disconnectRelay();
    }
    saveConfig(config);
    ctx.logFn(`Removed relay: ${removed ? removed.name || removed.url : '?'}`, 'command');
    rmList.destroy();
    screen.render();
  });
}

function showAiSettings(ctx) {
  const { blessed, screen, T, config } = ctx;
  const providers = ['openai', 'anthropic', 'google'];
  let selProvider = config.aiProvider || 'openai';
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
  const promptBox = blessed.textbox({ parent: form, top: 11, left: 2, width: 54, height: 1, style: { fg: T.text, bg: T.bgElement }, inputOnFocus: true, value: config.aiPrompt || DEFAULT_CONFIG.aiPrompt });
  const enabledLabel = blessed.text({ parent: form, top: 13, left: 2, tags: true, style: { bg: T.bgPanel } });
  function updateEnabledLabel() { enabledLabel.setContent(`{${T.textMuted}-fg}AI:{/${T.textMuted}-fg} {${pendingEnabled ? T.green : T.red}-fg}${pendingEnabled ? 'enabled' : 'disabled'}{/${pendingEnabled ? T.green : T.red}-fg}  {${T.textDim}-fg}[Ctrl+T]{/${T.textDim}-fg}`); screen.render(); }
  updateEnabledLabel();
  blessed.text({ parent: form, top: 15, left: 2, content: 'Tab fields · Enter save · Esc cancel', style: { fg: T.textDim, bg: T.bgPanel } });

  form.key('right', () => { const idx = providers.indexOf(selProvider); selProvider = providers[(idx + 1) % providers.length]; updateProvLabel(); });
  form.key('left',  () => { const idx = providers.indexOf(selProvider); selProvider = providers[(idx - 1 + providers.length) % providers.length]; updateProvLabel(); });
  const cycleProvider = () => { const idx = providers.indexOf(selProvider); selProvider = providers[(idx + 1) % providers.length]; updateProvLabel(); };
  keyInput.key('C-n', cycleProvider); modelInput.key('C-n', cycleProvider); promptBox.key('C-n', cycleProvider);
  const toggleEnabled = () => { pendingEnabled = !pendingEnabled; updateEnabledLabel(); };
  form.key('C-t', toggleEnabled); keyInput.key('C-t', toggleEnabled); modelInput.key('C-t', toggleEnabled); promptBox.key('C-t', toggleEnabled);

  keyInput.key('tab', () => modelInput.focus()); keyInput.key('enter', () => modelInput.focus());
  modelInput.key('tab', () => promptBox.focus()); modelInput.key('enter', () => promptBox.focus());
  promptBox.key('tab', () => keyInput.focus());

  function onEsc() { form.destroy(); screen.unkey('escape', onEsc); screen.render(); }
  function save() {
    screen.unkey('escape', onEsc);
    config.aiEnabled = pendingEnabled;
    config.aiProvider = selProvider;
    config.aiModel = modelInput.getValue().trim().slice(0, 100);
    config.aiPrompt = promptBox.getValue().trim().slice(0, 1000) || DEFAULT_CONFIG.aiPrompt;
    const newKey = keyInput.getValue().trim().slice(0, 200);
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
      } catch (e) { ctx.logFn(`Failed to save .env: ${e.message}`, 'warn'); }
    }
    resetSdkCache();
    saveConfig(config);
    form.destroy();
    ctx.logFn(`AI: ${config.aiEnabled ? 'enabled' : 'disabled'} — provider: ${config.aiProvider}`, 'command');
    ctx.updateStatus();
  }
  promptBox.key('enter', save);
  screen.key('escape', onEsc);
  screen.render(); keyInput.focus();
}

function showAddReplace(ctx) {
  const { blessed, screen, T, config } = ctx;
  const form = blessed.form({ parent: screen, top: 'center', left: 'center', width: 50, height: 10, border: { type: 'line' }, style: { border: { fg: T.border }, bg: T.bgPanel }, keys: true });
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
  function onEsc() { form.destroy(); screen.unkey('escape', onEsc); screen.render(); }
  toInput.key('enter', () => {
    screen.unkey('escape', onEsc);
    const from = fromInput.getValue().trim().toLowerCase().slice(0, 200);
    const to   = toInput.getValue().trim().slice(0, 500);
    const FORBIDDEN = ['__proto__', 'constructor', 'prototype'];
    if (from && to && !FORBIDDEN.includes(from)) {
      config.wordReplacements[from] = to; saveConfig(config); ctx.logFn(`Replacement: "${from}" → "${to}"`, 'command');
    }
    form.destroy(); ctx.updateStatus();
  });
  screen.key('escape', onEsc);
  screen.render(); fromInput.focus();
}

function showDelReplace(ctx) {
  const { blessed, screen, T, config } = ctx;
  const repls = Object.keys(config.wordReplacements || {});
  if (!repls.length) { ctx.logFn('No replacements to delete', 'warn'); return; }
  const list = blessed.list({ parent: screen, top: 'center', left: 'center', width: 50, height: Math.min(repls.length+4, 20), border: { type: 'line' }, style: { border: { fg: T.red }, bg: T.bgPanel, item: { fg: T.textMuted, bg: T.bgPanel }, selected: { bg: '#3a1a1a', fg: T.text } }, label: { text: ` Remove `, side: 'left', style: { fg: T.red } }, keys: true, vi: true, items: repls.map(k => `  ${k}  →  ${config.wordReplacements[k]}`) });
  list.focus();
  list.key('enter', () => { const key = repls[list.selected]; delete config.wordReplacements[key]; saveConfig(config); ctx.logFn(`Removed: "${key}"`, 'command'); list.destroy(); ctx.updateStatus(); });
  list.key('escape', () => { list.destroy(); screen.render(); });
  screen.render();
}

function showSessionManager(ctx) {
  const { blessed, screen, T, sessions, saveSessions } = ctx;
  const tokens = Object.keys(sessions);
  if (!tokens.length) { ctx.logFn('No saved sessions', 'info'); return; }

  const form = blessed.box({
    parent: screen, top: 'center', left: 'center',
    width: 58, height: Math.min(tokens.length + 6, 20),
    border: { type: 'line' },
    style: { border: { fg: T.border }, bg: T.bgPanel },
    tags: true, padding: { left: 2, right: 2 },
  });

  blessed.box({
    parent: form, top: 0, left: 0, width: '100%-4', height: 2,
    tags: true, style: { bg: T.bgPanel },
    content:
      `{bold}{${T.purple}-fg}Device Sessions{/${T.purple}-fg}{/bold}\n` +
      `{${T.textDim}-fg}${tokens.length} saved device${tokens.length > 1 ? 's' : ''} — Enter to revoke{/${T.textDim}-fg}`,
  });

  const items = tokens.map(t => {
    const s = sessions[t];
    const ago = s.lastSeen ? Math.floor((Date.now() - s.lastSeen) / 86400000) : '?';
    return `  ${t.slice(0, 12)}...  {${T.textDim}-fg}${ago}d ago{/${T.textDim}-fg}`;
  });

  const sList = blessed.list({
    parent: form, top: 3, left: 0, width: '100%-4',
    height: Math.min(tokens.length + 1, 12),
    keys: true, vi: true, mouse: true, tags: true,
    style: { bg: T.bgPanel, item: { fg: T.textMuted, bg: T.bgPanel }, selected: { fg: T.text, bg: T.bgElement, bold: true } },
    items,
  });

  sList.focus();
  screen.render();

  function onEsc() { screen.unkey('escape', onEsc); form.destroy(); screen.render(); }
  screen.key('escape', onEsc);

  sList.on('select', (el, idx) => {
    screen.unkey('escape', onEsc);
    const token = tokens[idx];
    delete sessions[token];
    saveSessions(sessions);
    ctx.logFn(`Session revoked: ${token.slice(0, 12)}...`, 'command');
    form.destroy();
    screen.render();
  });
}

function showThemePicker(ctx) {
  const { blessed, screen, T, config } = ctx;
  const names = Object.keys(BUILT_IN_THEMES);
  const list = blessed.list({
    parent: screen, top: 'center', left: 'center',
    width: 34, height: names.length + 2,
    border: { type: 'line' },
    style: { border: { fg: T.border }, bg: T.bgPanel, item: { fg: T.textMuted, bg: T.bgPanel }, selected: { fg: T.bg, bg: T.primary, bold: true } },
    label: { text: ' Theme ', side: 'left', style: { fg: T.primary } },
    keys: true, vi: true, mouse: true, tags: true,
    items: names.map(n => {
      const active = n === (config.theme || 'opencode') ? ` {${T.green}-fg}●{/${T.green}-fg}` : '';
      return `  ${n}${active}`;
    }),
  });

  list.focus();
  screen.render();

  function onEsc() { screen.unkey('escape', onEsc); list.destroy(); screen.render(); }
  screen.key('escape', onEsc);

  list.on('select', (el, idx) => {
    screen.unkey('escape', onEsc);
    list.destroy();
    const name = names[idx];
    if (ctx.applyTheme(name)) {
      ctx.logFn(`Theme: ${name}`, 'command');
    }
  });
}

function showHelp(ctx) {
  const { blessed, screen, T } = ctx;
  const helpContent = [
    `{bold}{${T.primary}-fg}VoiceBridge — Keybinds & Commands{/${T.primary}-fg}{/bold}`,
    ``,
    `{${T.cyan}-fg}Keybinds{/${T.cyan}-fg}`,
    `  {${T.textMuted}-fg}Ctrl+K{/${T.textMuted}-fg}    Command palette`,
    `  {${T.textMuted}-fg}Ctrl+P{/${T.textMuted}-fg}    Toggle pause`,
    `  {${T.textMuted}-fg}Ctrl+E{/${T.textMuted}-fg}    Relay servers`,
    `  {${T.textMuted}-fg}Ctrl+A{/${T.textMuted}-fg}    AI settings`,
    `  {${T.textMuted}-fg}Ctrl+R{/${T.textMuted}-fg}    Add word replacement`,
    `  {${T.textMuted}-fg}Ctrl+D{/${T.textMuted}-fg}    Delete word replacement`,
    `  {${T.textMuted}-fg}Ctrl+L{/${T.textMuted}-fg}    Clear log`,
    `  {${T.textMuted}-fg}Ctrl+Q{/${T.textMuted}-fg}    Quit`,
    `  {${T.textMuted}-fg}/{/${T.textMuted}-fg}         Open command input`,
    ``,
    `{${T.cyan}-fg}Slash Commands{/${T.cyan}-fg}`,
    `  {${T.textMuted}-fg}/pause{/${T.textMuted}-fg}       Toggle pause`,
    `  {${T.textMuted}-fg}/relay{/${T.textMuted}-fg}       Relay server settings`,
    `  {${T.textMuted}-fg}/ai{/${T.textMuted}-fg}          AI settings`,
    `  {${T.textMuted}-fg}/replace{/${T.textMuted}-fg}     Add word replacement`,
    `  {${T.textMuted}-fg}/delreplace{/${T.textMuted}-fg}  Delete word replacement`,
    `  {${T.textMuted}-fg}/sessions{/${T.textMuted}-fg}    Manage device sessions`,
    `  {${T.textMuted}-fg}/theme{/${T.textMuted}-fg}       Switch theme`,
    `  {${T.textMuted}-fg}/clear{/${T.textMuted}-fg}       Clear log`,
    `  {${T.textMuted}-fg}/help{/${T.textMuted}-fg}        This help`,
    `  {${T.textMuted}-fg}/quit{/${T.textMuted}-fg}        Exit VoiceBridge`,
    ``,
    `{${T.textDim}-fg}Press Esc to close{/${T.textDim}-fg}`,
  ];

  const popup = blessed.box({
    parent: screen, top: 'center', left: 'center',
    width: 50, height: helpContent.length + 2,
    border: { type: 'line' },
    style: { border: { fg: T.border }, bg: T.bgPanel },
    tags: true, padding: { left: 2, right: 2 },
    content: helpContent.join('\n'),
    scrollable: true, keys: true, mouse: true,
  });

  popup.focus();
  screen.render();

  function onEsc() { screen.unkey('escape', onEsc); popup.destroy(); screen.render(); }
  screen.key('escape', onEsc);
}

module.exports = {
  showCommandPalette, promptInput,
  showRelayServers, showAiSettings,
  showAddReplace, showDelReplace,
  showSessionManager, showThemePicker, showHelp,
};
