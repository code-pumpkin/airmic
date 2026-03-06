'use strict';

const crypto = require('crypto');
const WebSocket = require('ws');
const { safeSend } = require('../utils');
const { MAX_SESSIONS } = require('../config');

const PIN_QUEUE_MAX = 10;

/**
 * Create PIN approval system. Returns { showPinPrompt }.
 * Works in both TUI (blessed) and headless (readline) modes.
 */
function createPinSystem(ctx) {
  // ctx: { headless, blessed, screen, sessions, saveSessions, phoneStates,
  //        connectedCount, setConnectedCount, logFn, updateStatus, T }

  const pinQueue = [];
  let pinPromptActive = false;

  function processPinQueue() {
    if (pinPromptActive || !pinQueue.length) return;
    const { pin, ws } = pinQueue.shift();
    if (ws.readyState !== WebSocket.OPEN) { processPinQueue(); return; }
    pinPromptActive = true;
    if (ctx.headless) _headlessPrompt(pin, ws);
    else _tuiPrompt(pin, ws);
  }

  function showPinPrompt(pin, ws) {
    if (pinQueue.length >= PIN_QUEUE_MAX) {
      safeSend(ws, { type: 'auth', status: 'rejected' });
      ws.close();
      return;
    }
    ws.once('close', () => {
      const idx = pinQueue.findIndex(e => e.ws === ws);
      if (idx !== -1) pinQueue.splice(idx, 1);
    });
    pinQueue.push({ pin, ws });
    processPinQueue();
  }

  function approveDevice(ws, pin) {
    if (Object.keys(ctx.sessions).length >= MAX_SESSIONS) {
      const oldest = Object.entries(ctx.sessions).sort((a, b) => (a[1].lastSeen || 0) - (b[1].lastSeen || 0))[0];
      if (oldest) delete ctx.sessions[oldest[0]];
    }
    const deviceToken = crypto.randomBytes(16).toString('hex');
    ctx.sessions[deviceToken] = { approved: true, lastSeen: Date.now() };
    ctx.saveSessions(ctx.sessions);
    const state = ctx.phoneStates.get(ws);
    if (state) { state.authed = true; state.deviceToken = deviceToken; }
    ctx.setConnectedCount(ctx.getConnectedCount() + 1);
    safeSend(ws, { type: 'auth', status: 'approved', deviceToken });
    // Send initial state so phone UI is in sync immediately
    if (typeof ctx.getPaused === 'function') safeSend(ws, { type: 'paused', value: ctx.getPaused() });
    if (ctx.config) safeSend(ws, { type: 'aiEnabled', value: !!ctx.config.aiEnabled });
    ctx.logFn('Device approved — token saved', 'auth');
    ctx.updateStatus();
  }

  function rejectDevice(ws) {
    safeSend(ws, { type: 'auth', status: 'rejected' });
    ws.close();
    ctx.logFn('Device rejected', 'warn');
  }

  // ── Headless PIN approval — just queue and wait for IPC `airmic approve` ──
  function _headlessPrompt(pin, ws) {
    // In daemon mode stdin is /dev/null — don't try readline.
    // Just log the PIN and leave it in the queue for IPC approval.
    // The registration timeout in handler.js gives the user time to approve.
    ctx.logFn(`New device — PIN: ${pin}  (run: airmic approve ${pin})`, 'auth');

    // If stdin is readable (interactive headless), offer Y/N prompt
    if (process.stdin.readable && !process.stdin.destroyed) {
      let done = false;
      function cleanup() {
        if (done) return;
        done = true;
        pinPromptActive = false;
        processPinQueue();
      }

      console.log(`\n──────────────────────────────────`);
      console.log(`  New device — PIN: ${pin}`);
      console.log(`  Type Y to approve, N to reject`);
      console.log(`──────────────────────────────────`);

      ws.once('close', () => cleanup());

      try {
        const rl = require('readline').createInterface({ input: process.stdin, output: process.stdout });
        rl.question('> ', (answer) => {
          rl.close();
          if (done) return;
          const a = (answer || '').trim().toLowerCase();
          if (a === 'y' || a === 'yes') {
            approveDevice(ws, pin);
          } else {
            rejectDevice(ws);
          }
          cleanup();
        });
        rl.on('close', () => {
          // stdin closed (daemon mode) — don't reject, just leave in queue
          if (!done) {
            done = true;
            pinPromptActive = false;
            processPinQueue();
          }
        });
      } catch {
        // readline failed — leave in queue for IPC
        pinPromptActive = false;
        processPinQueue();
      }
    } else {
      // Daemon mode — PIN stays in queue, waiting for IPC approve
      pinPromptActive = false;
      processPinQueue();
    }
  }

  // ── TUI PIN approval popup ──
  function _tuiPrompt(pin, ws) {
    const { blessed, screen, T } = ctx;

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

    function onY() { cleanup(); approveDevice(ws, pin); }
    function onN() { cleanup(); rejectDevice(ws); }

    ws.once('close', () => cleanup());
    screen.key('y', onY);
    screen.key('n', onN);
    screen.render();
  }

  /** Approve a pending PIN from CLI (for daemon mode). Returns true if found. */
  function approveByPin(pin) {
    const idx = pinQueue.findIndex(e => e.pin === pin);
    if (idx === -1) return false;
    const { ws } = pinQueue.splice(idx, 1)[0];
    if (ws.readyState !== WebSocket.OPEN) return false;
    approveDevice(ws, pin);
    return true;
  }

  /** Get list of pending PINs. */
  function getPendingPins() {
    return pinQueue.filter(e => e.ws.readyState === WebSocket.OPEN).map(e => e.pin);
  }

  return { showPinPrompt, approveByPin, getPendingPins };
}

module.exports = { createPinSystem };
