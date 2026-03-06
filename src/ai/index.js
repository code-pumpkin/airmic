'use strict';

const { DEFAULT_CONFIG, getAiApiKey } = require('../config');

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

function resetSdkCache() {
  _openai = null; _anthropic = null; _google = null;
}

const AI_DEFAULTS = { openai: 'gpt-4o-mini', anthropic: 'claude-3-5-haiku-latest', google: 'gemini-1.5-flash' };

async function aiSummarize(text, config, logFn) {
  if (!config.aiEnabled || !getAiApiKey()) return text;
  const input = text.slice(0, 4000);
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
    if (logFn) logFn(`AI error: ${e.message}`, 'warn');
  }
  return text;
}

module.exports = { getOpenAI, getAnthropic, getGoogle, resetSdkCache, aiSummarize, getAiApiKey, AI_DEFAULTS };
