'use strict';

const { exec } = require('child_process');
const WebSocket = require('ws');

/**
 * Strip control characters and escape single quotes for shell safety.
 */
function escape(text) {
  return text.replace(/[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/g, '').replace(/'/g, "'\\''");
}

/**
 * Whitelist filter for xdotool key names.
 */
function safeKey(key) {
  return String(key).replace(/[^a-zA-Z0-9_\- ]/g, '');
}

/**
 * Safe WebSocket send — checks readyState before sending.
 */
function safeSend(ws, data) {
  if (ws && ws.readyState === WebSocket.OPEN) {
    try { ws.send(typeof data === 'string' ? data : JSON.stringify(data)); } catch {}
  }
}

/**
 * Run a shell command, log errors via provided logger.
 */
function runCmd(cmd, cb, logFn) {
  exec(cmd, (err) => {
    if (err && logFn) logFn(`xdotool: ${err.message}`, 'warn');
    cb && cb();
  });
}

/**
 * Copy text to clipboard via xclip.
 */
function toClipboard(text, cb) {
  const p = exec('xclip -selection clipboard', cb);
  p.stdin.write(text);
  p.stdin.end();
}

/**
 * Apply word replacements from config to text.
 */
function applyReplacements(text, wordReplacements) {
  let out = text;
  for (const [from, to] of Object.entries(wordReplacements || {})) {
    if (typeof from !== 'string' || typeof to !== 'string') continue;
    if (from.length > 200 || to.length > 500) continue;
    const escaped = from.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    out = out.replace(new RegExp(`\\b${escaped}\\b`, 'gi'), () => to);
  }
  return out;
}

module.exports = { escape, safeKey, safeSend, runCmd, toClipboard, applyReplacements };
