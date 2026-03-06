'use strict';

const crypto = require('crypto');
const WebSocket = require('ws');
const OpLog = require('./oplog');
const { getVoiceCommands } = require('./voice-commands');
const { safeSend, runCmd, safeKey, toClipboard, applyReplacements, escape } = require('../utils');
const { aiSummarize } = require('../ai');
const VirtualWS = require('../relay/virtual-ws');

const LOCAL_MAX_CLIENTS = 5;
const LOCAL_REG_TIMEOUT = 8000;
const VIRTUAL_MAX_CLIENTS = 10;
const MSG_RATE_WINDOW = 1000;
const MSG_RATE_MAX    = 30;

/**
 * Create a connection handler bound to the app's shared state.
 * Returns { handleConnection, broadcast, phoneStates }.
 */
function createConnectionHandler(ctx) {
  // ctx: { config, sessions, saveSessions, wss, logFn, setLive, updateStatus,
  //        getPaused, setPaused, getConnectedCount, setConnectedCount,
  //        showPinPrompt, relayClient }

  const phoneStates = new Map();
  let connectedCount = 0;

  function getConnectedCount() { return connectedCount; }
  function setConnectedCount(n) { connectedCount = n; if (ctx.onCountChange) ctx.onCountChange(n); }

  function broadcast(msg) {
    const data = JSON.stringify(msg);
    ctx.wss.clients.forEach(c => {
      if (c.readyState === WebSocket.OPEN) { try { c.send(data); } catch {} }
    });
    if (ctx.relayClient) ctx.relayClient.broadcast(msg);
  }

  function handleConnection(ws) {
    const isVirtual = ws instanceof VirtualWS;

    if (!isVirtual && ctx.wss.clients.size > LOCAL_MAX_CLIENTS) {
      safeSend(ws, { type: 'error', reason: 'room-full' });
      ws.terminate();
      return;
    }

    phoneStates.set(ws, {
      language: ctx.config.language,
      pttMode: false,
      clipboardMode: ctx.config.clipboardMode,
      authed: false,
      deviceToken: null,
    });

    // Drop connections that never authenticate
    const regTimeout = isVirtual ? LOCAL_REG_TIMEOUT * 2 : LOCAL_REG_TIMEOUT;
    const regTimer = setTimeout(() => {
      const state = phoneStates.get(ws);
      if (state && !state.authed) ws.terminate();
    }, regTimeout);
    ws.once('close', () => clearTimeout(regTimer));

    // Keepalive for local sockets
    if (!isVirtual) {
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
      // Per-socket rate limiting
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
        if (state.authed) return;
        if (msg.deviceToken && typeof msg.deviceToken === 'string' && /^[a-f0-9]{32}$/.test(msg.deviceToken) && ctx.sessions[msg.deviceToken]?.approved === true) {
          ctx.sessions[msg.deviceToken].lastSeen = Date.now();
          ctx.saveSessions(ctx.sessions);
          state.authed = true;
          state.deviceToken = msg.deviceToken;
          phoneStates.set(ws, state);
          connectedCount++;
          if (ctx.onCountChange) ctx.onCountChange(connectedCount);
          safeSend(ws, { type: 'auth', status: 'approved', deviceToken: msg.deviceToken });
          safeSend(ws, { type: 'paused', value: ctx.getPaused() });
          safeSend(ws, { type: 'aiEnabled', value: ctx.config.aiEnabled });
          ctx.logFn('Known device reconnected', 'connect');
          ctx.updateStatus();
          return;
        }
        const pin = String(crypto.randomInt(100000, 1000000));
        safeSend(ws, { type: 'auth', status: 'pin', pin });
        ctx.logFn(`New device — PIN: ${pin}`, 'auth');
        ctx.showPinPrompt(pin, ws);
        return;
      }

      if (!state.authed) { safeSend(ws, { type: 'auth', status: 'required' }); return; }

      // ── Config updates ──
      if (msg.type === 'config') {
        if (typeof msg.clipboardMode === 'boolean') { state.clipboardMode = msg.clipboardMode; ctx.config.clipboardMode = msg.clipboardMode; ctx.saveConfig(ctx.config); ctx.logFn(`Clipboard: ${msg.clipboardMode ? 'on' : 'off'}`, 'command'); }
        if (typeof msg.pttMode === 'boolean')       { state.pttMode = msg.pttMode; ctx.logFn(`PTT: ${msg.pttMode ? 'on' : 'off'}`, 'command'); }
        if (typeof msg.language === 'string' && /^[a-zA-Z]{2,8}(-[a-zA-Z0-9]{2,8})*$/.test(msg.language)) { state.language = msg.language; ctx.logFn(`Language: ${msg.language}`, 'command'); }
        if (typeof msg.paused === 'boolean')        { ctx.setPaused(msg.paused); broadcast({ type: 'paused', value: msg.paused }); ctx.logFn(msg.paused ? 'Paused from phone' : 'Resumed from phone', 'command'); }
        if (typeof msg.aiEnabled === 'boolean')     { ctx.config.aiEnabled = msg.aiEnabled; ctx.saveConfig(ctx.config); ctx.logFn(`AI: ${msg.aiEnabled ? 'enabled' : 'disabled'}`, 'command'); ctx.updateStatus(); }
        phoneStates.set(ws, state);
        ctx.updateStatus();
        return;
      }

      if (ctx.getPaused() || !msg.text) return;
      if (typeof msg.text !== 'string' || msg.text.length > 2000) return;

      // Initialize OpLog per socket
      if (!ws._oplog) ws._oplog = new OpLog();
      const oplog = ws._oplog;
      if (!ws._lastPhrase) ws._lastPhrase = '';

      function execOp(cmd, cb) { runCmd(cmd, cb, ctx.logFn); }
      function drainOps() { oplog.drain(execOp); }

      function typeOrClip(text, interim = false) {
        if (state.clipboardMode) {
          toClipboard(text, (err) => { if (!err) require('child_process').exec('xdotool key --clearmodifiers ctrl+v'); });
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

      function commonPrefix(a, b) {
        let i = 0;
        while (i < a.length && i < b.length && a[i] === b[i]) i++;
        return i;
      }

      if (msg.type === 'interim') {
        ctx.setLive(msg.text, false);
        const projected = oplog.projectedText();

        if (msg.text.startsWith(projected)) {
          const delta = msg.text.slice(projected.length);
          if (delta) typeOrClip(delta, true);
        } else {
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
        ctx.setLive(msg.text, true);

        const vcmds = getVoiceCommands(ctx.config);
        const cmd = msg.text.trim().toLowerCase();
        if (Object.hasOwn(vcmds, cmd)) {
          const vc = vcmds[cmd];
          if (!vc || typeof vc !== 'object') return;
          oplog.cancelQueued();
          const onScreen = oplog.projectedText();
          if (onScreen.length > 0) deleteChars(onScreen.length);
          if (vc.action === 'scratch') {
            const scratchLen = oplog.screenLength();
            if (scratchLen > 0) {
              deleteChars(scratchLen);
              ctx.logFn(`Scratched: "${ws._lastPhrase}"`, 'command');
              ws._lastPhrase = '';
              oplog.setScreenLength(0);
            }
          }
          else if (vc.action === 'key' && typeof vc.key === 'string') {
            oplog.addType('', false);
            runCmd(`xdotool key --clearmodifiers ${safeKey(vc.key)}`, () => {}, ctx.logFn);
            ctx.logFn(`\u2318 ${cmd}`, 'command');
          }
          else if (vc.action === 'type' && typeof vc.text === 'string') {
            typeOrClip(vc.text.slice(0, 2000));
            ctx.logFn(`\u2318 ${cmd} \u2192 "${vc.text}"`, 'command');
          }
          oplog.reset();
          drainOps();
          return;
        }

        const finalText = applyReplacements(msg.text, ctx.config.wordReplacements);

        oplog.cancelInterims();
        const committed = oplog.committedText();
        const cp = commonPrefix(committed, finalText);
        const toDelete = committed.length - cp;
        const toType = finalText.slice(cp) + ' ';

        if (toDelete > 0) deleteChars(toDelete);
        if (toType.trim()) typeOrClip(toType);
        else if (toDelete > 0) typeOrClip(' ');

        const fullTyped = finalText + ' ';
        ctx.totalPhrases++; ctx.totalWords += finalText.trim().split(/\s+/).filter(Boolean).length;
        ctx.logFn(finalText, 'phrase');
        ctx.updateStatus();

        // AI summarize
        if (ctx.config.aiEnabled && require('../ai').getAiApiKey()) {
          ws._lastPhrase = fullTyped;
          ws._aiSeq = (ws._aiSeq || 0) + 1;
          const seq = ws._aiSeq;
          aiSummarize(finalText, ctx.config, ctx.logFn).then(improved => {
            if (improved === finalText) return;
            if (ws.readyState !== WebSocket.OPEN) return;
            if (ws._aiSeq !== seq) return;
            const safeImproved = improved.trimStart().slice(0, 4000) + ' ';
            // Use screenLength — it tracks what's actually on-screen across resets
            const onScreenLen = oplog.screenLength();
            if (onScreenLen > 0) deleteChars(onScreenLen);
            typeOrClip(safeImproved);
            ws._lastPhrase = safeImproved;
            oplog.setScreenLength(safeImproved.length);
            ctx.logFn(`AI (${ctx.config.aiProvider}): ${improved}`, 'command');
          }).catch(() => {});
        } else {
          ws._lastPhrase = fullTyped;
        }

        // Defer reset until queued ops finish — keeps nodes alive for drain
        oplog.resetAfterDrain();
        drainOps();
      }
    });

    ws.on('close', () => {
      const state = phoneStates.get(ws);
      if (state && state.authed) { connectedCount = Math.max(0, connectedCount - 1); if (ctx.onCountChange) ctx.onCountChange(connectedCount); }
      phoneStates.delete(ws);
      if (ws._oplog) ws._oplog.reset();
      ctx.logFn('Phone disconnected', 'disconnect');
      ctx.updateStatus();
    });
  }

  return { handleConnection, broadcast, phoneStates, getConnectedCount, setConnectedCount };
}

module.exports = { createConnectionHandler, LOCAL_MAX_CLIENTS, VIRTUAL_MAX_CLIENTS };
