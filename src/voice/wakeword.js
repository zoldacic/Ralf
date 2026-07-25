'use strict';

const { spawn } = require('child_process');
const fs = require('fs');
const { EventEmitter } = require('events');

const config = require('../config');
const log = require('../util/logger');

// openWakeWord runs 16 kHz mono int16 audio in 80 ms (1280-sample) frames.
const FRAME_LENGTH = 1280;
const READY_TIMEOUT_MS = 20000;

const OP_OPEN = 1;
const OP_AUDIO = 2;
const OP_CLOSE = 3;

/**
 * Manages the local openWakeWord sidecar (see src/voice/oww_sidecar.py).
 *
 * We replaced Picovoice Porcupine with openWakeWord so the wake word stays
 * fully local with no account. The sidecar is a Python child process; we pipe
 * per-speaker PCM to it and it emits detections back. Everything degrades
 * gracefully: if Python, the model, or the sidecar is unavailable, `available`
 * stays false and the bot runs /ralf-only.
 *
 * Emits: 'detection' ({ userId, model, score })
 */
class WakeWord extends EventEmitter {
  constructor() {
    super();
    this.available = false;
    this.frameLength = FRAME_LENGTH;
    this.proc = null;
    this._stdoutBuf = '';
    this._streams = new Map(); // userId -> streamId
    this._nextId = 1;
    this._settled = false;
    this._resolveInit = null;
  }

  /** Resolve the model arg: path-like -> absolute file; otherwise a builtin name. */
  _resolveModel() {
    const m = config.wakeword.model;
    if (/[\\/]/.test(m) || /\.(onnx|tflite)$/i.test(m)) return config.abs(m);
    return m;
  }

  /**
   * Spawn the sidecar. Resolves true once it reports ready, false on any
   * failure. Safe to await from startup.
   */
  init() {
    if (this._settled) return Promise.resolve(this.available);

    return new Promise((resolve) => {
      this._resolveInit = resolve;

      if (!config.wakeword.enabled) return this._settle(false, 'wake word disabled by config');

      const { python, sidecar } = config.wakeword;
      if (!fs.existsSync(python)) {
        return this._settle(false, `Python not found at ${python} — wake word disabled`);
      }
      if (!fs.existsSync(sidecar)) {
        return this._settle(false, `Sidecar not found at ${sidecar} — wake word disabled`);
      }

      const model = this._resolveModel();
      const args = [sidecar, '--model', model, '--threshold', String(config.wakeword.threshold)];

      let proc;
      try {
        proc = spawn(python, args, { cwd: config.ROOT });
      } catch (err) {
        return this._settle(false, `Failed to spawn sidecar: ${err.message}`);
      }
      this.proc = proc;

      proc.stdout.on('data', (d) => this._onStdout(d));
      proc.stderr.on('data', (d) => log.debug(`[oww] ${d.toString().trim()}`));
      proc.on('error', (err) => this._settle(false, `Sidecar error: ${err.message}`));
      proc.on('exit', (code) => {
        if (!this._settled) return this._settle(false, `Sidecar exited (${code}) before ready`);
        // Crashed after coming up: disable and keep the bot alive.
        this.available = false;
        this.proc = null;
        log.warn(`Wake word sidecar exited (${code}) — wake word now disabled`);
      });

      setTimeout(() => {
        if (!this._settled) this._settle(false, 'Sidecar did not report ready in time');
      }, READY_TIMEOUT_MS);
    });
  }

  _settle(ok, message) {
    if (this._settled) return;
    this._settled = true;
    this.available = ok;
    if (ok) log.info(message);
    else {
      log.warn(message);
      if (this.proc) {
        try { this.proc.kill(); } catch (_) { /* ignore */ }
        this.proc = null;
      }
    }
    if (this._resolveInit) this._resolveInit(ok);
  }

  _onStdout(data) {
    this._stdoutBuf += data.toString();
    let nl;
    while ((nl = this._stdoutBuf.indexOf('\n')) >= 0) {
      const line = this._stdoutBuf.slice(0, nl).trim();
      this._stdoutBuf = this._stdoutBuf.slice(nl + 1);
      if (!line) continue;
      let msg;
      try {
        msg = JSON.parse(line);
      } catch (_) {
        log.debug(`[oww] non-JSON: ${line}`);
        continue;
      }
      this._handle(msg);
    }
  }

  _handle(msg) {
    switch (msg.type) {
      case 'ready':
        this._settle(true, `Wake word ready (openWakeWord model="${msg.model}", threshold=${msg.threshold})`);
        break;
      case 'detect': {
        const userId = this._userForStream(msg.stream);
        if (userId) this.emit('detection', { userId, model: msg.model, score: msg.score });
        break;
      }
      case 'error':
        log.warn(`[oww] ${msg.msg}`);
        break;
      default:
        log.debug(`[oww] ${JSON.stringify(msg)}`);
    }
  }

  _userForStream(sid) {
    for (const [userId, id] of this._streams) if (id === sid) return userId;
    return null;
  }

  /** Begin detecting for a speaker. */
  openStream(userId) {
    if (!this.available || this._streams.has(userId)) return;
    const sid = this._nextId++ & 0xffff || 1;
    this._streams.set(userId, sid);
    this._send(OP_OPEN, sid);
  }

  /** Feed one 1280-sample Int16Array frame for a speaker. */
  feed(userId, frame) {
    if (!this.available) return;
    const sid = this._streams.get(userId);
    if (sid === undefined) return;
    const body = Buffer.alloc(3 + frame.length * 2);
    body[0] = OP_AUDIO;
    body.writeUInt16LE(sid, 1);
    for (let i = 0; i < frame.length; i++) body.writeInt16LE(frame[i], 3 + i * 2);
    this._write(body);
  }

  /** Stop detecting for a speaker. */
  closeStream(userId) {
    const sid = this._streams.get(userId);
    if (sid === undefined) return;
    this._streams.delete(userId);
    this._send(OP_CLOSE, sid);
  }

  // Back-compat alias used by the receiver teardown.
  release(userId) {
    this.closeStream(userId);
  }

  _send(op, sid) {
    const body = Buffer.alloc(3);
    body[0] = op;
    body.writeUInt16LE(sid, 1);
    this._write(body);
  }

  _write(body) {
    if (!this.proc || !this.proc.stdin.writable) return;
    const header = Buffer.alloc(4);
    header.writeUInt32LE(body.length, 0);
    this.proc.stdin.write(Buffer.concat([header, body]));
  }

  releaseAll() {
    for (const userId of [...this._streams.keys()]) this.closeStream(userId);
    if (this.proc) {
      try { this.proc.stdin.end(); } catch (_) { /* ignore */ }
      try { this.proc.kill(); } catch (_) { /* ignore */ }
      this.proc = null;
    }
    this.available = false;
  }
}

module.exports = new WakeWord();
