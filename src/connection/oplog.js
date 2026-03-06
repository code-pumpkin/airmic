'use strict';

const { escape } = require('../utils');

/**
 * OpLog — linked operation history for tracking typed text.
 * Each node represents a typed or deleted segment. Nodes form a chain.
 * On final, we diff against committed (known-done) text and fix only the damage.
 *
 * _screenLen tracks the total chars we believe are on-screen from our typing,
 * surviving across resets so AI replacement and next-phrase spacing work correctly.
 */
class OpLog {
  constructor() {
    this._nodes = [];
    this._nextId = 0;
    this._running = false;
    this._pendingReset = false;
    this._screenLen = 0;          // chars we own on-screen (persists across resets)
  }

  /** Replay nodes to reconstruct on-screen text. */
  _replay(includeStatuses) {
    let text = '';
    for (const n of this._nodes) {
      if (!includeStatuses.includes(n.status)) continue;
      if (n.type === 'type') text += n.text;
      else if (n.type === 'delete') text = text.slice(0, Math.max(0, text.length - n.charCount));
    }
    return text;
  }

  /** What we KNOW is on screen (only completed ops). */
  committedText() { return this._replay(['done']); }

  /** What SHOULD be on screen once everything drains. */
  projectedText() { return this._replay(['done', 'running', 'queued']); }

  /**
   * If a deferred reset is pending and new ops arrive, force the reset now.
   * Old running/queued ops keep executing (they're already spawned or will
   * drain next), but projected/committed text starts fresh for the new phrase.
   */
  _flushPendingReset() {
    if (!this._pendingReset) return;
    this._pendingReset = false;
    // Snapshot screen length from what's done so far
    this._screenLen = this._replay(['done']).length;
    // Keep only in-flight ops (running) — they'll finish on their own
    this._nodes = this._nodes.filter(n => n.status === 'running');
  }

  /** Add a type op. */
  addType(text, interim = false) {
    this._flushPendingReset();
    const node = { id: this._nextId++, type: 'type', text, charCount: text.length, status: 'queued', interim };
    this._nodes.push(node);
    return node;
  }

  /** Add a delete op. */
  addDelete(charCount, interim = false) {
    if (charCount <= 0) return null;
    this._flushPendingReset();
    const node = { id: this._nextId++, type: 'delete', text: '', charCount, status: 'queued', interim };
    this._nodes.push(node);
    return node;
  }

  /** Cancel all queued interim ops (not yet running). */
  cancelInterims() {
    this._nodes = this._nodes.filter(n => !(n.interim && n.status === 'queued'));
  }

  /** Cancel ALL queued ops. */
  cancelQueued() {
    this._nodes = this._nodes.filter(n => n.status !== 'queued');
  }

  /** Mark the next queued node as running, execute it, mark done on callback. */
  drain(execFn) {
    if (this._running) return;
    const next = this._nodes.find(n => n.status === 'queued');
    if (!next) {
      // Queue fully drained — apply deferred reset if requested
      if (this._pendingReset) {
        this._pendingReset = false;
        // Update _screenLen from the final projected state before clearing nodes
        this._screenLen = this.projectedText().length;
        this._nodes = [];
      }
      return;
    }
    this._running = true;
    next.status = 'running';

    const cmd = next.type === 'type'
      ? `xdotool type --clearmodifiers -- '${escape(next.text)}'`
      : `xdotool key --clearmodifiers --repeat ${Math.min(next.charCount, 500)} BackSpace`;

    execFn(cmd, () => {
      next.status = 'done';
      this._running = false;
      this._compact();
      this.drain(execFn);
    });
  }

  /** Merge consecutive done nodes of same type to keep list short. */
  _compact() {
    const merged = [];
    for (const n of this._nodes) {
      const prev = merged.length > 0 ? merged[merged.length - 1] : null;
      if (prev && prev.status === 'done' && n.status === 'done' && prev.type === 'type' && n.type === 'type') {
        prev.text += n.text;
        prev.charCount += n.charCount;
      } else {
        merged.push(n);
      }
    }
    this._nodes = merged;
  }

  /**
   * Schedule a reset after the current queue drains.
   * If nothing is queued/running, resets immediately.
   */
  resetAfterDrain() {
    const hasWork = this._running || this._nodes.some(n => n.status === 'queued');
    if (hasWork) {
      this._pendingReset = true;
    } else {
      this._screenLen = this.projectedText().length;
      this._nodes = [];
    }
  }

  /** Hard reset — on disconnect or voice-command clear. */
  reset() {
    this._nodes = [];
    this._running = false;
    this._pendingReset = false;
    this._screenLen = 0;
  }

  /** How many chars we believe are on-screen (survives resets). */
  screenLength() { return this._screenLen; }

  /** Manually set screen length (e.g. after AI replacement). */
  setScreenLength(n) { this._screenLen = n; }

  /** How many chars are projected on screen. */
  projectedLength() { return this.projectedText().length; }
}

module.exports = OpLog;
