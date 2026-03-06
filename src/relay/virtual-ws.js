'use strict';

const { EventEmitter } = require('events');
const WebSocket = require('ws');

/**
 * VirtualWS — wraps a relay-proxied client so it looks identical
 * to a real ws WebSocket for handleConnection().
 */
class VirtualWS extends EventEmitter {
  constructor(clientId, relayWs) {
    super();
    this.clientId   = clientId;
    this._relayWs   = relayWs;
    this.readyState = WebSocket.OPEN;
    this._queue     = [];
    this._running   = false;
  }

  send(data) {
    if (this.readyState !== WebSocket.OPEN) return;
    if (this._relayWs.readyState !== WebSocket.OPEN) return;
    try {
      this._relayWs.send(JSON.stringify({
        type: 'host-message', clientId: this.clientId, data,
      }));
    } catch {}
  }

  close() {
    if (this.readyState === WebSocket.CLOSED) return;
    this.readyState = WebSocket.CLOSED;
    if (this._relayWs.readyState === WebSocket.OPEN) {
      try {
        this._relayWs.send(JSON.stringify({
          type: 'host-close', clientId: this.clientId,
        }));
      } catch {}
    }
    this.emit('close');
  }

  /** Called by relay client when a message arrives for this virtual socket. */
  _receive(data) {
    this.emit('message', data);
  }
}

module.exports = VirtualWS;
