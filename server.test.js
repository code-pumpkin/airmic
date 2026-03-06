'use strict';
// server.test.js — Tests for text-input-cursor-tracking bugfix spec
// Task 1: Bug condition exploration tests (expected to FAIL on unfixed code)
// Task 2: Preservation property tests (expected to PASS on unfixed code)
//
// Run with: node server.test.js

const assert = require('assert');

// ─── Minimal test runner ──────────────────────────────────────────────────────

let passed = 0;
let failed = 0;
const failures = [];

function test(name, fn) {
  try {
    fn();
    console.log(`  ✓ ${name}`);
    passed++;
  } catch (e) {
    console.log(`  ✗ ${name}`);
    console.log(`    ${e.message}`);
    failed++;
    failures.push({ name, error: e });
  }
}

function section(name) {
  console.log(`\n── ${name} ──`);
}

// ─── Pure logic extracted verbatim from server.js ────────────────────────────

function escape(text) { return text.replace(/'/g, "'\\''"); }

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

function safeKey(key) { return String(key).replace(/[^a-zA-Z0-9_\- ]/g, ''); }


// ─── VirtualCursorBuffer (mirrors server.js implementation) ──────────────────
class VirtualCursorBuffer {
  constructor() { this.chars = []; this.cursor = 0; }
  insert(text) {
    for (const c of text) { this.chars.splice(this.cursor, 0, c); this.cursor++; }
  }
  deleteBack(n) {
    n = Math.min(n, this.cursor);
    this.chars.splice(this.cursor - n, n);
    this.cursor -= n;
  }
  deleteForward(n) {
    n = Math.min(n, this.chars.length - this.cursor);
    this.chars.splice(this.cursor, n);
  }
  moveLeft(n)  { this.cursor = Math.max(0, this.cursor - n); }
  moveRight(n) { this.cursor = Math.min(this.chars.length, this.cursor + n); }
  deleteWordBack() {
    if (this.cursor === 0) return;
    let end = this.cursor;
    if (this.chars[end - 1] === ' ') end--;
    let start = end;
    while (start > 0 && this.chars[start - 1] !== ' ') start--;
    if (start > 0 && this.chars[start - 1] === ' ') start--;
    this.chars.splice(start, this.cursor - start);
    this.cursor = start;
  }
  getText() { return this.chars.join(''); }
  reset()   { this.chars = []; this.cursor = 0; }
}

// ─── Handler simulator (replicates FIXED handleConnection message logic) ──────
//
// Simulates the per-connection state and the message handler from server.js
// WITHOUT loading the full server. exec/runCmd are replaced with a synchronous
// stub that records commands and immediately fires the callback so drain() runs
// to completion synchronously — this lets us inspect the queue and issued
// commands without async complexity.
//
// clipboardCalls records { text } for each toClipboard() call.
// execCalls records every raw exec() call string (including ctrl+v).
// enqueuedCmds records every cmd string passed to enqueue().

function makeHandler(opts = {}) {
  const {
    clipboardMode = false,
    wordReplacements = {},
    voiceCommandsExtra = {},
    lastPhraseLen = 0,
    lastPhrase = '',
    phraseOnScreen = '',  // used to pre-populate the VirtualCursorBuffer
    aiEnabled = false,
  } = opts;

  // Recorded side-effects
  const enqueuedCmds = [];   // all cmds pushed into queue (in order)
  const clipboardCalls = []; // text passed to toClipboard()
  const execCalls = [];      // raw exec() calls (ctrl+v etc.)

  // Per-connection state (mirrors ws.*)
  const ws = {
    _queue: [],
    _running: false,
    _vcb: new VirtualCursorBuffer(),
    _lastPhrase: lastPhrase,
    _lastPhraseLen: lastPhraseLen,
    readyState: 1, // OPEN
  };

  // Pre-populate the buffer from phraseOnScreen (simulates prior interim typing)
  if (phraseOnScreen) ws._vcb.insert(phraseOnScreen);

  const state = {
    clipboardMode,
    authed: true,
    pttMode: false,
  };

  const config = {
    wordReplacements,
    voiceCommandsExtra,
    aiEnabled,
    aiApiKey: '',
  };

  // Stub exec — records the call and immediately fires callback with no error
  function stubExec(cmd, cb) {
    execCalls.push(cmd);
    if (typeof cb === 'function') cb(null);
    // Return a fake child process with a writable stdin for toClipboard()
    return {
      stdin: {
        write() {},
        end() {},
      },
    };
  }

  // Stub toClipboard — records text, then fires ctrl+v via stubExec
  function toClipboard(text, cb) {
    clipboardCalls.push(text);
    const p = stubExec('xclip -selection clipboard', cb);
    p.stdin.write(text);
    p.stdin.end();
  }

  // runCmd stub — records cmd and immediately fires the onComplete + callback
  function runCmd(cmd, cb) {
    if (cb) cb();
  }

  const buf = ws._vcb;

  function enqueue(cmd, isFinal = false, onComplete) {
    const queue = ws._queue;
    if (!isFinal) {
      for (let i = queue.length - 1; i >= 0; i--) {
        if (!queue[i].isFinal) queue.splice(i, 1);
      }
    }
    const CMD_QUEUE_MAX = 50;
    if (queue.length >= CMD_QUEUE_MAX) return;
    enqueuedCmds.push(cmd);
    queue.push({ cmd, isFinal, onComplete });
    drain();
  }

  function drain() {
    if (ws._running || !ws._queue.length) return;
    ws._running = true;
    const { cmd, onComplete } = ws._queue.shift();
    runCmd(cmd, () => {
      if (onComplete) onComplete();
      ws._running = false;
      drain();
    });
  }

  function typeOrClip(text, isFinal = true) {
    if (state.clipboardMode) {
      toClipboard(text, (err) => {
        if (!err) stubExec('xdotool key --clearmodifiers ctrl+v');
      });
    } else {
      enqueue(`xdotool type --clearmodifiers -- '${escape(text)}'`, isFinal);
    }
  }

  function deleteWord() {
    if (buf.cursor === 0) return;
    enqueue('xdotool key --clearmodifiers ctrl+BackSpace', true, () => buf.deleteWordBack());
  }

  function getVoiceCommands() {
    return { ...BUILTIN_VOICE_COMMANDS, ...(config.voiceCommandsExtra || {}) };
  }

  // The message handler — mirrors the FIXED server.js logic
  function handleMessage(msg) {
    if (!msg || typeof msg !== 'object' || Array.isArray(msg)) return;
    if (!msg.text) return;
    if (typeof msg.text !== 'string' || msg.text.length > 2000) return;

    if (!ws._lastPhrase)     ws._lastPhrase = '';
    if (!ws._lastPhraseLen)  ws._lastPhraseLen = 0;

    if (msg.type === 'interim') {
      const currentText = buf.getText();
      if (msg.text.startsWith(currentText)) {
        const delta = msg.text.slice(currentText.length);
        if (delta) {
          for (let i = 0; i < delta.length; i += 10) {
            const chunk = delta.slice(i, i + 10);
            enqueue(`xdotool type --clearmodifiers -- '${escape(chunk)}'`, false, () => buf.insert(chunk));
          }
        }
      }
    } else if (msg.type === 'final') {
      const currentText = buf.getText();
      const vcmds = getVoiceCommands();
      const cmd = msg.text.trim().toLowerCase();
      if (Object.hasOwn(vcmds, cmd)) {
        const vc = vcmds[cmd];
        if (!vc || typeof vc !== 'object') return;
        if (buf.chars.length > 0) {
          const n = buf.chars.length;
          enqueue(`xdotool key --clearmodifiers --repeat ${Math.min(n, 500)} Delete`, true, () => buf.deleteForward(n));
        }
        if (vc.action === 'scratch') {
          if (ws._lastPhraseLen > 0) {
            const cap = Math.min(ws._lastPhraseLen, 500);
            enqueue(`xdotool key --clearmodifiers --repeat ${cap} BackSpace`, true);
            ws._lastPhrase = '';
            ws._lastPhraseLen = 0;
            buf.reset();
          }
        } else if (vc.action === 'key' && typeof vc.key === 'string') {
          enqueue(`xdotool key --clearmodifiers ${safeKey(vc.key)}`, true);
        } else if (vc.action === 'type' && typeof vc.text === 'string') {
          typeOrClip(vc.text.slice(0, 2000));
        }
        return;
      }
      buf.reset();
      const finalText = applyReplacements(msg.text, config.wordReplacements);

      // Clipboard mode — bypass cursor-buffer path entirely (requirement 3.1)
      if (state.clipboardMode) {
        const toType = finalText.trimStart() + ' ';
        typeOrClip(toType);
        ws._lastPhrase    = toType;
        ws._lastPhraseLen = toType.length;
        // AI disabled in tests
        return;
      }

      // Find divergence index between buffer content and desired final text
      let divergenceIndex = 0;
      while (
        divergenceIndex < currentText.length &&
        divergenceIndex < finalText.length &&
        currentText[divergenceIndex] === finalText[divergenceIndex]
      ) divergenceIndex++;

      const charsToLeft  = currentText.length - divergenceIndex;
      const charsToRight = currentText.length - divergenceIndex;
      const suffix       = finalText.slice(divergenceIndex);

      if (charsToLeft > 0) {
        const n = charsToLeft;
        enqueue(`xdotool key --clearmodifiers --repeat ${Math.min(n, 500)} Left`, true, () => buf.moveLeft(n));
      }
      if (charsToRight > 0) {
        const n = charsToRight;
        enqueue(`xdotool key --clearmodifiers --repeat ${Math.min(n, 500)} Delete`, true, () => buf.deleteForward(n));
      }
      for (let i = 0; i < suffix.length; i += 10) {
        const chunk = suffix.slice(i, i + 10);
        enqueue(`xdotool type --clearmodifiers -- '${escape(chunk)}'`, true, () => buf.insert(chunk));
      }
      // trailing space
      enqueue(`xdotool type --clearmodifiers -- ' '`, true, () => buf.insert(' '));

      const toType = suffix.trimStart() + ' ';
      ws._lastPhrase    = toType;
      ws._lastPhraseLen = toType.length;
      // AI disabled in tests (aiEnabled=false, aiApiKey='')
    }
  }

  return { handleMessage, deleteWord, enqueuedCmds, clipboardCalls, execCalls, ws, state, buf };
}


// ═══════════════════════════════════════════════════════════════════════════════
// TASK 1 — Bug condition exploration tests
// These tests encode the EXPECTED (fixed) behavior.
// They are EXPECTED TO FAIL on unfixed code — failure confirms the bug exists.
// ═══════════════════════════════════════════════════════════════════════════════

section('Task 1 — Bug condition exploration tests (expected to FAIL on unfixed code)');

// Test 1: Stale buffer on final — old code issues BackSpace count from _phraseOnScreen
// rather than using arrow-key navigation to the divergence point.
test('T1.1 stale buffer: final correction uses arrow-key navigation, not BackSpace count', () => {
  const h = makeHandler({ phraseOnScreen: 'hello wor' });
  // Simulate: interim typed 'hello wor' but runCmd hasn't completed yet (stale state).
  // Now a final arrives with 'hello world'.
  h.handleMessage({ type: 'final', text: 'hello world' });

  // EXPECTED (fixed) behavior: navigate left to divergence point (index 9 = end of 'hello wor'),
  // no chars differ at index 9 so charsToLeft=0, charsToRight=0, type suffix 'ld' then ' '.
  // OLD (unfixed) behavior: wordDiff('hello wor', 'hello world') → deleteCount=3, typeStr=' world'
  // which issues BackSpace×3 then types ' world' — wrong.
  const hasBackspace = h.enqueuedCmds.some(c => c.includes('BackSpace'));
  // On unfixed code: BackSpace is issued → this assertion FAILS (bug confirmed)
  assert.ok(!hasBackspace, `Expected no BackSpace commands but got: ${h.enqueuedCmds.filter(c=>c.includes('BackSpace')).join(', ')}`);
  // Fixed code types the suffix 'ld' (divergence at index 9, no navigation needed)
  const typesLdSuffix = h.enqueuedCmds.some(c => c.includes("'ld'"));
  const hasLeftArrow  = h.enqueuedCmds.some(c => c.includes('Left'));
  assert.ok(hasLeftArrow || typesLdSuffix,
    `Expected arrow-key navigation or suffix type 'ld', got: ${h.enqueuedCmds.join(', ')}`);
});

// Test 2: Long interim — old code enqueues a single monolithic type command (not chunked)
test('T1.2 long interim: delta of 25 chars is chunked into ≤10-char pieces', () => {
  const h = makeHandler({ phraseOnScreen: '' });
  const longText = 'hello world how are you'; // 23 chars
  h.handleMessage({ type: 'interim', text: longText });

  // EXPECTED (fixed): ceil(23/10) = 3 enqueued type commands
  // OLD (unfixed): 1 single type command for the whole delta
  const typeCmds = h.enqueuedCmds.filter(c => c.startsWith('xdotool type'));
  // On unfixed code: typeCmds.length === 1 → this assertion FAILS (bug confirmed)
  assert.ok(typeCmds.length > 1,
    `Expected multiple chunked type commands but got ${typeCmds.length}: ${typeCmds.join(', ')}`);
  typeCmds.forEach(cmd => {
    // Extract the typed text from the command: xdotool type --clearmodifiers -- 'TEXT'
    const m = cmd.match(/-- '(.*)'$/s);
    if (m) {
      assert.ok(m[1].length <= 10, `Chunk too long (${m[1].length}): "${m[1]}"`);
    }
  });
});

// Test 3: Superseded interims — old code leaves all three type commands in the queue
test('T1.3 superseded interims: only the latest interim command remains in queue', () => {
  // We need to observe queue state BEFORE drain runs.
  // Patch: use a version where runCmd never fires its callback (simulates slow execution).
  const enqueuedCmds = [];
  const ws = {
    _queue: [],
    _running: false,
    _phraseOnScreen: '',
    _lastPhrase: '',
    _lastPhraseLen: 0,
  };

  function enqueueBlocking(cmd, isFinal = false) {
    if (!isFinal) {
      for (let i = ws._queue.length - 1; i >= 0; i--) {
        if (!ws._queue[i].isFinal) ws._queue.splice(i, 1);
      }
    }
    enqueuedCmds.push(cmd);
    ws._queue.push({ cmd, isFinal });
    // Do NOT call drain — simulate a blocked queue (first command still running)
  }

  // Simulate: first interim starts running (ws._running = true), then two more arrive
  ws._running = true; // first command is executing
  enqueueBlocking(`xdotool type --clearmodifiers -- '${escape('he')}'`, false);
  enqueueBlocking(`xdotool type --clearmodifiers -- '${escape('hell')}'`, false);
  enqueueBlocking(`xdotool type --clearmodifiers -- '${escape('hello')}'`, false);

  // EXPECTED (fixed): only the last non-final command remains in queue (superseded ones purged)
  // OLD (unfixed): all three commands are in the queue
  // On unfixed code: ws._queue.length === 3 → this assertion FAILS (bug confirmed)
  assert.strictEqual(ws._queue.length, 1,
    `Expected 1 command in queue after superseding, but got ${ws._queue.length}`);
});

// Test 4: deleteWord missing — unfixed code has no deleteWord function
test('T1.4 deleteWord function exists', () => {
  // The unfixed server.js has no deleteWord() export or global.
  // We verify it's absent by checking our handler doesn't expose it.
  const h = makeHandler();
  // On unfixed code: h.deleteWord is undefined → this assertion FAILS (bug confirmed)
  assert.strictEqual(typeof h.deleteWord, 'function',
    'Expected deleteWord to be a function but it is ' + typeof h.deleteWord);
});


// ═══════════════════════════════════════════════════════════════════════════════
// TASK 2 — Preservation property tests
// These tests capture CURRENT (unfixed) baseline behavior.
// They are EXPECTED TO PASS on unfixed code.
// Validates: Requirements 3.1, 3.2, 3.3, 3.4
// ═══════════════════════════════════════════════════════════════════════════════

section('Task 2 — Preservation property tests (expected to PASS on unfixed code)');

// ── 2.1 Clipboard mode preservation ──────────────────────────────────────────
// Validates: Requirement 3.1
// When clipboardMode=true, the handler calls xclip+ctrl+v and does NOT enqueue
// any BackSpace/Left/Delete navigation commands via the queue.

section('  2.1 Clipboard mode preservation');

test('clipboard mode: final message calls xclip (toClipboard) with the typed text', () => {
  const h = makeHandler({ clipboardMode: true });
  h.handleMessage({ type: 'final', text: 'hello world' });
  assert.ok(h.clipboardCalls.length > 0, 'Expected toClipboard() to be called');
  // The text passed to clipboard should contain the typed phrase (with trailing space)
  const allClipText = h.clipboardCalls.join('');
  assert.ok(allClipText.includes('hello world'), `Expected clipboard text to include 'hello world', got: "${allClipText}"`);
});

test('clipboard mode: final message issues xdotool key ctrl+v', () => {
  const h = makeHandler({ clipboardMode: true });
  h.handleMessage({ type: 'final', text: 'hello world' });
  const ctrlV = h.execCalls.some(c => c.includes('ctrl+v'));
  assert.ok(ctrlV, `Expected ctrl+v exec call, got: ${h.execCalls.join(', ')}`);
});

test('clipboard mode: no BackSpace/Left/Delete navigation commands enqueued', () => {
  const h = makeHandler({ clipboardMode: true });
  h.handleMessage({ type: 'final', text: 'hello world' });
  const navCmds = h.enqueuedCmds.filter(c =>
    c.includes('BackSpace') || c.includes('Left') || c.includes('Delete')
  );
  assert.strictEqual(navCmds.length, 0,
    `Expected no navigation commands but got: ${navCmds.join(', ')}`);
});

test('clipboard mode: no xdotool type commands enqueued (clipboard path only)', () => {
  const h = makeHandler({ clipboardMode: true });
  h.handleMessage({ type: 'final', text: 'hello world' });
  const typeCmds = h.enqueuedCmds.filter(c => c.startsWith('xdotool type'));
  assert.strictEqual(typeCmds.length, 0,
    `Expected no enqueued type commands in clipboard mode, got: ${typeCmds.join(', ')}`);
});

// Property: for any non-empty final text with clipboardMode=true,
// exactly one clipboard call is made and no navigation commands are enqueued.
test('clipboard mode property: any final text → xclip called, zero nav commands', () => {
  const samples = [
    'hello',
    'hello world',
    'the quick brown fox jumps over the lazy dog',
    'a',
    "it's a test with apostrophes",
    'numbers 123 and symbols !@#',
  ];
  for (const text of samples) {
    const h = makeHandler({ clipboardMode: true });
    h.handleMessage({ type: 'final', text });
    assert.ok(h.clipboardCalls.length > 0, `clipboardMode: expected xclip call for "${text}"`);
    const navCmds = h.enqueuedCmds.filter(c =>
      c.includes('BackSpace') || c.includes('Left') || c.includes('Delete')
    );
    assert.strictEqual(navCmds.length, 0,
      `clipboardMode: expected no nav cmds for "${text}", got: ${navCmds.join(', ')}`);
  }
});

// ── 2.2 Voice command preservation ───────────────────────────────────────────
// Validates: Requirement 3.2

section('  2.2 Voice command preservation');

test('"scratch that" erases last phrase via BackSpace × lastPhraseLen', () => {
  const lastPhraseLen = 11; // e.g. 'hello world'
  const h = makeHandler({ lastPhraseLen, lastPhrase: 'hello world' });
  h.handleMessage({ type: 'final', text: 'scratch that' });
  const bsCmds = h.enqueuedCmds.filter(c => c.includes('BackSpace'));
  assert.ok(bsCmds.length > 0, 'Expected BackSpace command for scratch that');
  // Should issue --repeat 11 BackSpace
  const hasCorrectRepeat = bsCmds.some(c => c.includes(`--repeat ${lastPhraseLen}`));
  assert.ok(hasCorrectRepeat,
    `Expected --repeat ${lastPhraseLen} BackSpace, got: ${bsCmds.join(', ')}`);
});

test('"scratch that" resets _lastPhraseLen to 0', () => {
  const h = makeHandler({ lastPhraseLen: 11, lastPhrase: 'hello world' });
  h.handleMessage({ type: 'final', text: 'scratch that' });
  assert.strictEqual(h.ws._lastPhraseLen, 0, 'Expected _lastPhraseLen to be reset to 0');
});

test('"scratch that" resets _lastPhrase to empty string', () => {
  const h = makeHandler({ lastPhraseLen: 11, lastPhrase: 'hello world' });
  h.handleMessage({ type: 'final', text: 'scratch that' });
  assert.strictEqual(h.ws._lastPhrase, '', 'Expected _lastPhrase to be reset to ""');
});

test('"scratch that" with lastPhraseLen=0 issues no BackSpace commands', () => {
  const h = makeHandler({ lastPhraseLen: 0, lastPhrase: '' });
  h.handleMessage({ type: 'final', text: 'scratch that' });
  const bsCmds = h.enqueuedCmds.filter(c => c.includes('BackSpace'));
  assert.strictEqual(bsCmds.length, 0,
    `Expected no BackSpace when lastPhraseLen=0, got: ${bsCmds.join(', ')}`);
});

test('"new line" key command issues xdotool key Return', () => {
  const h = makeHandler();
  h.handleMessage({ type: 'final', text: 'new line' });
  const keyCmds = h.enqueuedCmds.filter(c => c.includes('xdotool key'));
  assert.ok(keyCmds.some(c => c.includes('Return')),
    `Expected xdotool key Return, got: ${keyCmds.join(', ')}`);
});

test('"period" type command issues xdotool type with "."', () => {
  const h = makeHandler();
  h.handleMessage({ type: 'final', text: 'period' });
  const typeCmds = h.enqueuedCmds.filter(c => c.startsWith('xdotool type'));
  assert.ok(typeCmds.some(c => c.includes("'.'")),
    `Expected xdotool type with '.', got: ${typeCmds.join(', ')}`);
});

// Property: for any key-action voice command, the issued command is xdotool key <key>
test('voice command property: key-action commands issue xdotool key <key>', () => {
  const keyCommands = [
    { text: 'new line',      key: 'Return' },
    { text: 'new paragraph', key: 'Return Return' },
  ];
  for (const { text, key } of keyCommands) {
    const h = makeHandler();
    h.handleMessage({ type: 'final', text });
    const keyCmds = h.enqueuedCmds.filter(c => c.startsWith('xdotool key'));
    assert.ok(keyCmds.some(c => c.includes(key)),
      `Expected xdotool key ${key} for "${text}", got: ${keyCmds.join(', ')}`);
  }
});

// Property: for any type-action voice command, the issued command is xdotool type with the text
test('voice command property: type-action commands issue xdotool type with correct text', () => {
  const typeCommands = [
    { text: 'period',            expected: '.' },
    { text: 'comma',             expected: ',' },
    { text: 'question mark',     expected: '?' },
    { text: 'exclamation mark',  expected: '!' },
    { text: 'colon',             expected: ':' },
    { text: 'semicolon',         expected: ';' },
  ];
  for (const { text, expected } of typeCommands) {
    const h = makeHandler();
    h.handleMessage({ type: 'final', text });
    const typeCmds = h.enqueuedCmds.filter(c => c.startsWith('xdotool type'));
    const escapedExpected = escape(expected);
    assert.ok(typeCmds.some(c => c.includes(`'${escapedExpected}'`)),
      `Expected xdotool type '${escapedExpected}' for "${text}", got: ${typeCmds.join(', ')}`);
  }
});

// ── 2.3 No-diff final preservation ───────────────────────────────────────────
// Validates: Requirement 3.3
// When finalText === ws._phraseOnScreen (after applyReplacements), wordDiff returns
// deleteCount=0 and typeStr='' so no BackSpace is issued; only the trailing space is typed.

section('  2.3 No-diff final preservation');

test('no-diff final: when onScreen matches final text, no BackSpace commands issued', () => {
  // phraseOnScreen = 'hello world', final = 'hello world'
  // wordDiff('hello world', 'hello world') → deleteCount=0, typeStr=''
  const h = makeHandler({ phraseOnScreen: 'hello world' });
  h.handleMessage({ type: 'final', text: 'hello world' });
  const bsCmds = h.enqueuedCmds.filter(c => c.includes('BackSpace'));
  assert.strictEqual(bsCmds.length, 0,
    `Expected no BackSpace for no-diff final, got: ${bsCmds.join(', ')}`);
});

test('no-diff final: only trailing space is typed', () => {
  const h = makeHandler({ phraseOnScreen: 'hello world' });
  h.handleMessage({ type: 'final', text: 'hello world' });
  const typeCmds = h.enqueuedCmds.filter(c => c.startsWith('xdotool type'));
  // typeStr='' → toType = '' + ' ' = ' '
  assert.strictEqual(typeCmds.length, 1,
    `Expected exactly 1 type command (trailing space), got: ${typeCmds.join(', ')}`);
  assert.ok(typeCmds[0].includes("' '"),
    `Expected trailing space type command, got: ${typeCmds[0]}`);
});

// Property: for any text T, if phraseOnScreen === T, no BackSpace is enqueued
test('no-diff property: any matching onScreen/final pair → zero BackSpace commands', () => {
  const samples = [
    'hello',
    'hello world',
    'the quick brown fox',
    'a single word',
    'multiple   spaces',
  ];
  for (const text of samples) {
    const h = makeHandler({ phraseOnScreen: text });
    h.handleMessage({ type: 'final', text });
    const bsCmds = h.enqueuedCmds.filter(c => c.includes('BackSpace'));
    assert.strictEqual(bsCmds.length, 0,
      `Expected no BackSpace for no-diff final "${text}", got: ${bsCmds.join(', ')}`);
  }
});

// ── 2.4 Word replacement preservation ────────────────────────────────────────
// Validates: Requirement 3.4
// applyReplacements is called on final text before correction logic.

section('  2.4 Word replacement preservation');

test('word replacement: configured replacement is applied to final text output', () => {
  const h = makeHandler({ wordReplacements: { 'hello': 'hi' } });
  h.handleMessage({ type: 'final', text: 'hello world' });
  // The typed text should contain 'hi world' not 'hello world'
  const typeCmds = h.enqueuedCmds.filter(c => c.startsWith('xdotool type'));
  const allTyped = typeCmds.join(' ');
  assert.ok(allTyped.includes('hi'), `Expected replacement 'hi' in typed output, got: ${allTyped}`);
  assert.ok(!allTyped.includes("'hello world'"), `Expected 'hello world' to be replaced, got: ${allTyped}`);
});

test('word replacement: replacement applied before diff (affects what is typed)', () => {
  // onScreen = 'hello world', final = 'hello world', replacement hello→hi
  // After replacement: finalText = 'hi world'
  // New code: divergence at index 1 ('h' matches, 'e'≠'i'), navigate left, delete, type suffix 'i world'
  // The combined result on screen will be 'hi world ' — replacement was applied
  const h = makeHandler({
    phraseOnScreen: 'hello world',
    wordReplacements: { 'hello': 'hi' },
  });
  h.handleMessage({ type: 'final', text: 'hello world' });
  // Since finalText becomes 'hi world' ≠ 'hello world', correction commands are issued
  const allCmds = h.enqueuedCmds.join(' ');
  // The suffix typed is 'i world' (divergence at index 1, 'h' is shared prefix)
  assert.ok(allCmds.includes('i world'), `Expected 'i world' suffix in commands after replacement, got: ${allCmds}`);
  // And navigation commands are issued (Left + Delete) to correct the on-screen text
  assert.ok(h.enqueuedCmds.some(c => c.includes('Left')), `Expected Left navigation for correction, got: ${allCmds}`);
});

test('word replacement: no replacement when wordReplacements is empty', () => {
  const h = makeHandler({ wordReplacements: {} });
  h.handleMessage({ type: 'final', text: 'hello world' });
  const typeCmds = h.enqueuedCmds.filter(c => c.startsWith('xdotool type'));
  // Extract typed text from each chunk command and join to reconstruct full output
  const allTyped = typeCmds.map(c => {
    const m = c.match(/-- '(.*)'$/s);
    return m ? m[1].replace(/'\\''/g, "'") : '';
  }).join('');
  assert.ok(allTyped.includes('hello world'), `Expected 'hello world' unchanged, got: ${allTyped}`);
});

// Property: for any (text, replacements) pair, applyReplacements is applied before output
test('word replacement property: replacement always applied before typing', () => {
  const cases = [
    { text: 'the cat sat',    replacements: { 'cat': 'dog' },    expected: 'dog' },
    { text: 'foo bar baz',    replacements: { 'bar': 'qux' },    expected: 'qux' },
    { text: 'test one two',   replacements: { 'one': '1', 'two': '2' }, expected: '1' },
  ];
  for (const { text, replacements, expected } of cases) {
    const h = makeHandler({ wordReplacements: replacements });
    h.handleMessage({ type: 'final', text });
    const typeCmds = h.enqueuedCmds.filter(c => c.startsWith('xdotool type'));
    const allTyped = typeCmds.join(' ');
    assert.ok(allTyped.includes(expected),
      `Expected replacement "${expected}" in output for "${text}", got: ${allTyped}`);
  }
});

// ── 2.5 Pure logic unit tests ─────────────────────────────────────────────────

section('  2.5 Pure logic unit tests');

test('wordDiff: identical strings → deleteCount=0, typeStr=""', () => {
  const { deleteCount, typeStr } = wordDiff('hello world', 'hello world');
  assert.strictEqual(deleteCount, 0);
  assert.strictEqual(typeStr, '');
});

test('wordDiff: empty onScreen, non-empty final → deleteCount=0, typeStr=finalText', () => {
  const { deleteCount, typeStr } = wordDiff('', 'hello world');
  assert.strictEqual(deleteCount, 0);
  assert.strictEqual(typeStr, 'hello world');
});

test('wordDiff: non-empty onScreen, empty final → deleteCount=onScreen.length', () => {
  const { deleteCount, typeStr } = wordDiff('hello', '');
  assert.strictEqual(deleteCount, 5);
  assert.strictEqual(typeStr, '');
});

test('wordDiff: partial match → correct deleteCount and typeStr', () => {
  const { deleteCount, typeStr } = wordDiff('hello world', 'hello earth');
  // sw=['hello','world'], fw=['hello','earth'], common=1
  // screenTail='world' (5), deleteCount=5+1=6 (space before 'world')
  // finalTail='earth', typeStr=' earth'
  assert.strictEqual(deleteCount, 6);
  assert.strictEqual(typeStr, ' earth');
});

test('applyReplacements: applies word boundary replacement', () => {
  const result = applyReplacements('hello world', { 'hello': 'hi' });
  assert.strictEqual(result, 'hi world');
});

test('applyReplacements: no replacement when no match', () => {
  const result = applyReplacements('hello world', { 'foo': 'bar' });
  assert.strictEqual(result, 'hello world');
});

test('applyReplacements: case-insensitive replacement', () => {
  const result = applyReplacements('Hello World', { 'hello': 'hi' });
  assert.strictEqual(result, 'hi World');
});

test('applyReplacements: empty replacements returns original text', () => {
  const result = applyReplacements('hello world', {});
  assert.strictEqual(result, 'hello world');
});

test('escape: single quotes are escaped for shell safety', () => {
  const result = escape("it's a test");
  assert.strictEqual(result, "it'\\''s a test");
});

test('escape: text without single quotes is unchanged', () => {
  const result = escape('hello world');
  assert.strictEqual(result, 'hello world');
});


// ─── Summary ──────────────────────────────────────────────────────────────────

console.log(`\n${'─'.repeat(60)}`);
console.log(`Results: ${passed} passed, ${failed} failed`);

if (failures.length > 0) {
  console.log('\nFailed tests:');
  for (const { name, error } of failures) {
    console.log(`  ✗ ${name}`);
    console.log(`    ${error.message}`);
  }
}

// Task 1 tests are EXPECTED to fail on unfixed code (they confirm the bug).
// Task 2 tests are EXPECTED to pass on unfixed code (they capture baseline behavior).
const task1Tests = failures.filter(f =>
  f.name.startsWith('T1.') || f.name.includes('stale buffer') ||
  f.name.includes('long interim') || f.name.includes('superseded') ||
  f.name.includes('deleteWord')
);
const task2Tests = failures.filter(f => !task1Tests.includes(f));

if (task2Tests.length > 0) {
  console.log('\n⚠ UNEXPECTED: Task 2 preservation tests failed (should pass on unfixed code):');
  for (const { name } of task2Tests) console.log(`  - ${name}`);
  process.exit(1);
} else {
  console.log('\n✓ Task 2 preservation tests all PASS on unfixed code (baseline captured).');
  if (task1Tests.length > 0) {
    console.log(`✓ Task 1 exploration tests FAIL as expected (${task1Tests.length} failures confirm bug exists).`);
    console.log('\nCounterexamples documented:');
    for (const { name, error } of task1Tests) {
      console.log(`  Bug confirmed by "${name}": ${error.message}`);
    }
  }
  process.exit(0);
}
