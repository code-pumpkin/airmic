'use strict';

const fs   = require('fs');
const path = require('path');
const crypto = require('crypto');

const ROOT = path.join(__dirname, '..', '..');
const CONFIG_PATH   = path.join(ROOT, 'config.json');
const SESSIONS_PATH = path.join(ROOT, 'sessions.json');
const ENV_PATH      = path.join(ROOT, '.env');

// ─── .env loader (no dotenv dependency) ──────────────────────────────────────
function loadEnv() {
  try {
    const envContent = fs.readFileSync(ENV_PATH, 'utf8');
    for (const line of envContent.split('\n')) {
      const trimmed = line.trim();
      if (!trimmed || trimmed.startsWith('#')) continue;
      const eq = trimmed.indexOf('=');
      if (eq < 1) continue;
      const key = trimmed.slice(0, eq).trim();
      let val = trimmed.slice(eq + 1).trim();
      if ((val.startsWith('"') && val.endsWith('"')) || (val.startsWith("'") && val.endsWith("'"))) val = val.slice(1, -1);
      if (!process.env[key]) process.env[key] = val;
    }
  } catch {}
}

function getAiApiKey() { return (process.env.AIRMIC_AI_KEY || process.env.VOICEBRIDGE_AI_KEY || '').slice(0, 200); }

// ─── Config persistence ──────────────────────────────────────────────────────

function loadConfig() {
  try {
    const data = JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf8'));
    if (data && typeof data === 'object' && !Array.isArray(data)) return data;
  } catch {}
  return {};
}

function saveConfig(cfg) {
  const tmp = CONFIG_PATH + '.tmp';
  try { fs.writeFileSync(tmp, JSON.stringify(cfg, null, 2)); fs.renameSync(tmp, CONFIG_PATH); }
  catch (e) { console.error('[config] save failed:', e.message); }
}

// ─── Session persistence ─────────────────────────────────────────────────────

function loadSessions() {
  try {
    const data = JSON.parse(fs.readFileSync(SESSIONS_PATH, 'utf8'));
    if (data && typeof data === 'object' && !Array.isArray(data)) return data;
  } catch {}
  return {};
}

function saveSessions(s) {
  const tmp = SESSIONS_PATH + '.tmp';
  try { fs.writeFileSync(tmp, JSON.stringify(s, null, 2)); fs.renameSync(tmp, SESSIONS_PATH); }
  catch (e) { console.error('[sessions] save failed:', e.message); }
}

// ─── Defaults ────────────────────────────────────────────────────────────────

const DEFAULT_CONFIG = {
  port: 4000,
  bindAddress: '',
  language: 'en-US',
  clipboardMode: false,
  wordReplacements: {},
  voiceCommandsExtra: {},
  relayUrl: '',
  relaySecret: '',
  relayRejectUnauthorized: true,
  relayServers: [
    { name: 'AirMic Cloud', url: 'wss://amrelay1.returnfeed.com:4001', secret: '' },
  ],
  aiEnabled:   false,
  aiProvider:  'openai',
  aiModel:     '',
  aiPrompt:    'You are a transcription assistant. Clean up and summarize the following spoken text into clear, concise written prose. Preserve the meaning exactly. Output only the improved text, nothing else.',
};

// ─── Sanitize & initialize ───────────────────────────────────────────────────

const MAX_SESSIONS     = 500;
const MAX_REPLACEMENTS = 200;
const MAX_VOICE_CMDS   = 100;
const SESSION_TTL      = 90 * 24 * 60 * 60 * 1000; // 90 days

function initConfig() {
  loadEnv();

  const config = { ...DEFAULT_CONFIG, ...loadConfig() };

  // Sanitize port
  if (!Number.isInteger(config.port) || config.port < 1 || config.port > 65535) {
    console.warn(`[config] invalid port ${config.port}, falling back to 4000`);
    config.port = 4000;
  }

  // Generate URL token once, persist it
  if (!config.urlToken || !/^[a-f0-9]{8,64}$/.test(config.urlToken)) {
    config.urlToken = crypto.randomBytes(8).toString('hex');
    saveConfig(config);
  }

  // Sanitize language
  if (typeof config.language !== 'string' || !/^[a-zA-Z]{2,8}(-[a-zA-Z0-9]{2,8})*$/.test(config.language)) {
    config.language = DEFAULT_CONFIG.language;
  }

  // Sanitize booleans
  if (typeof config.clipboardMode !== 'boolean') config.clipboardMode = false;
  if (typeof config.relayRejectUnauthorized !== 'boolean') config.relayRejectUnauthorized = true;

  // Sanitize strings
  if (typeof config.bindAddress !== 'string') config.bindAddress = '';
  config.bindAddress = config.bindAddress.slice(0, 100);
  if (typeof config.relayUrl !== 'string') config.relayUrl = '';
  if (typeof config.relaySecret !== 'string') config.relaySecret = '';
  config.relayUrl    = config.relayUrl.slice(0, 500);
  config.relaySecret = config.relaySecret.slice(0, 200);

  // Sanitize AI fields
  if (typeof config.aiEnabled  !== 'boolean') config.aiEnabled = false;
  if (!['openai','anthropic','google'].includes(config.aiProvider)) config.aiProvider = 'openai';
  if (typeof config.aiModel    !== 'string')  config.aiModel   = '';
  if (typeof config.aiPrompt   !== 'string')  config.aiPrompt  = DEFAULT_CONFIG.aiPrompt;
  config.aiModel  = config.aiModel.slice(0, 100);
  config.aiPrompt = config.aiPrompt.slice(0, 1000);

  // Migrate: if aiApiKey exists in config.json, move it to .env
  if (config.aiApiKey && typeof config.aiApiKey === 'string' && config.aiApiKey.trim()) {
    const envLine = `AIRMIC_AI_KEY=${config.aiApiKey.trim()}\n`;
    try {
      const existing = fs.existsSync(ENV_PATH) ? fs.readFileSync(ENV_PATH, 'utf8') : '';
      if (!existing.includes('AIRMIC_AI_KEY')) fs.writeFileSync(ENV_PATH, existing + envLine);
    } catch {}
    if (!process.env.AIRMIC_AI_KEY) process.env.AIRMIC_AI_KEY = config.aiApiKey.trim();
    delete config.aiApiKey;
    saveConfig(config);
  }

  // Sanitize object fields
  if (typeof config.wordReplacements !== 'object' || Array.isArray(config.wordReplacements) || !config.wordReplacements) config.wordReplacements = {};
  if (typeof config.voiceCommandsExtra !== 'object' || Array.isArray(config.voiceCommandsExtra) || !config.voiceCommandsExtra) config.voiceCommandsExtra = {};

  // Cap entry counts
  for (const key of Object.keys(config.wordReplacements).slice(MAX_REPLACEMENTS)) delete config.wordReplacements[key];
  for (const key of Object.keys(config.voiceCommandsExtra).slice(MAX_VOICE_CMDS)) delete config.voiceCommandsExtra[key];

  // Strip malformed voiceCommandsExtra
  for (const [k, v] of Object.entries(config.voiceCommandsExtra)) {
    const valid = v && typeof v === 'object' && !Array.isArray(v) &&
      typeof v.action === 'string' &&
      (v.action === 'scratch' ||
       (v.action === 'key'  && typeof v.key  === 'string') ||
       (v.action === 'type' && typeof v.text === 'string'));
    if (!valid) delete config.voiceCommandsExtra[k];
  }

  // Strip malformed wordReplacements
  for (const [k, v] of Object.entries(config.wordReplacements)) {
    if (typeof k !== 'string' || typeof v !== 'string') delete config.wordReplacements[k];
  }

  return config;
}

function initSessions() {
  const sessions = loadSessions();

  // Strip malformed entries
  for (const [token, s] of Object.entries(sessions)) {
    if (!token || !/^[a-f0-9]{32}$/.test(token) || typeof s !== 'object' || s === null || Array.isArray(s) || s.approved !== true) {
      delete sessions[token];
    }
  }

  // Trim to cap
  const keys = Object.keys(sessions);
  if (keys.length > MAX_SESSIONS) {
    keys.sort((a, b) => (sessions[a].lastSeen || 0) - (sessions[b].lastSeen || 0))
      .slice(0, keys.length - MAX_SESSIONS)
      .forEach(k => delete sessions[k]);
  }

  // Prune old sessions
  pruneSessions(sessions);

  return sessions;
}

function pruneSessions(sessions) {
  const cutoff = Date.now() - SESSION_TTL;
  let pruned = 0;
  for (const [token, s] of Object.entries(sessions)) {
    if ((s.lastSeen || 0) < cutoff) { delete sessions[token]; pruned++; }
  }
  if (pruned > 0) saveSessions(sessions);
  return pruned;
}

module.exports = {
  CONFIG_PATH, SESSIONS_PATH, ENV_PATH, ROOT,
  DEFAULT_CONFIG, MAX_SESSIONS, SESSION_TTL,
  loadEnv, getAiApiKey,
  loadConfig, saveConfig,
  loadSessions, saveSessions,
  initConfig, initSessions, pruneSessions,
};
