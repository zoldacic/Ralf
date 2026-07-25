'use strict';

const { spawn } = require('child_process');
const fs = require('fs');

const config = require('../config');
const log = require('../util/logger');

// Model download on first run can be slow; warm starts load from cache.
const READY_TIMEOUT_MS = 300000;

/**
 * Local speech-to-text via a faster-whisper sidecar (see whisper_sidecar.py).
 *
 * We replaced OpenAI's hosted transcription with local Whisper so the whole
 * voice path stays account-free and offline. The sidecar is a Python child
 * process that keeps the model warm; we send it a WAV and get back text.
 * Degrades gracefully: if Python or the model is unavailable, transcribe()
 * rejects and the caller logs it (the wake-word path just drops that utterance).
 */
class WhisperClient {
  constructor() {
    this.proc = null;
    this.ready = null; // Promise<void> once spawning
    this._stdoutBuf = '';
    this._pending = new Map(); // id -> { resolve, reject }
    this._nextId = 1;
  }

  _ensure() {
    if (this.ready) return this.ready;

    this.ready = new Promise((resolve, reject) => {
      const { python, sidecar, model, language, prompt, beamSize } = config.stt;
      if (!fs.existsSync(python)) return reject(new Error(`Python not found at ${python}`));
      if (!fs.existsSync(sidecar)) return reject(new Error(`Whisper sidecar not found at ${sidecar}`));

      const args = [
        sidecar,
        '--model', model,
        '--language', language,
        '--beam-size', String(beamSize),
      ];
      if (prompt) args.push('--initial-prompt', prompt);

      let proc;
      try {
        proc = spawn(python, args, { cwd: config.ROOT });
      } catch (err) {
        return reject(new Error(`Failed to spawn whisper sidecar: ${err.message}`));
      }
      this.proc = proc;

      let settled = false;
      const timer = setTimeout(() => {
        if (!settled) {
          settled = true;
          reject(new Error('Whisper sidecar did not report ready in time'));
        }
      }, READY_TIMEOUT_MS);

      proc.stdout.on('data', (d) => this._onStdout(d, () => {
        if (!settled) { settled = true; clearTimeout(timer); resolve(); }
      }));
      proc.stderr.on('data', (d) => log.debug(`[whisper] ${d.toString().trim()}`));
      proc.on('error', (err) => {
        if (!settled) { settled = true; clearTimeout(timer); reject(err); }
        this._fail(err);
      });
      proc.on('exit', (code) => {
        this._fail(new Error(`whisper sidecar exited (${code})`));
        if (!settled) { settled = true; clearTimeout(timer); reject(new Error(`whisper sidecar exited (${code})`)); }
      });
    }).catch((err) => {
      // Allow a later call to retry a fresh spawn.
      this.ready = null;
      this.proc = null;
      throw err;
    });

    return this.ready;
  }

  _onStdout(data, onReady) {
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
        log.debug(`[whisper] non-JSON: ${line}`);
        continue;
      }
      if (msg.type === 'ready') {
        log.info(`Whisper ready (local model="${msg.model}")`);
        onReady();
      } else if (msg.type === 'result') {
        this._resolve(msg.id, msg.text || '');
      } else if (msg.type === 'error') {
        this._rejectId(msg.id, new Error(msg.msg || 'transcription failed'));
      }
    }
  }

  _resolve(id, text) {
    const p = this._pending.get(id);
    if (p) { this._pending.delete(id); p.resolve(text); }
  }

  _rejectId(id, err) {
    const p = this._pending.get(id);
    if (p) { this._pending.delete(id); p.reject(err); }
  }

  _fail(err) {
    for (const [, p] of this._pending) p.reject(err);
    this._pending.clear();
    this.proc = null;
    this.ready = null;
  }

  /** Transcribe a 16 kHz mono WAV buffer. Resolves to the transcript. */
  async transcribe(wav) {
    await this._ensure();
    const id = this._nextId++ & 0xffffffff || 1;
    const body = Buffer.alloc(4 + wav.length);
    body.writeUInt32LE(id, 0);
    wav.copy(body, 4);
    const header = Buffer.alloc(4);
    header.writeUInt32LE(body.length, 0);

    return new Promise((resolve, reject) => {
      this._pending.set(id, { resolve, reject });
      if (!this.proc || !this.proc.stdin.writable) {
        this._pending.delete(id);
        return reject(new Error('whisper sidecar not available'));
      }
      this.proc.stdin.write(Buffer.concat([header, body]));
    });
  }

  /** Pre-load the model so the first real transcription isn't slow. */
  warm() {
    this._ensure().catch((err) => log.warn(`Whisper warm-up failed: ${err.message}`));
  }

  shutdown() {
    if (this.proc) {
      try { this.proc.stdin.end(); } catch (_) { /* ignore */ }
      try { this.proc.kill(); } catch (_) { /* ignore */ }
    }
    this.proc = null;
    this.ready = null;
  }
}

const client = new WhisperClient();

/**
 * Transcribe a 16 kHz mono WAV buffer as English.
 * @param {Buffer} wav
 * @returns {Promise<string>} transcript, trimmed. Empty string if nothing heard.
 */
async function transcribe(wav) {
  const started = Date.now();
  const text = await client.transcribe(wav);
  log.info(`STT ${Date.now() - started}ms: "${text}"`);
  return text;
}

/**
 * Strip a leading wake word from the transcript. The wake phrase is "hey ralf"
 * (openWakeWord). Whisper still renders the name loosely, so match wide.
 */
function stripWakeWord(text) {
  return text
    .replace(/^\s*(hey|hi|okay|ok)?\s*(ralff|ralph|ralf|rolf|ralv|rafe)\s*[,.!?:-]*\s*/i, '')
    .trim();
}

module.exports = { transcribe, stripWakeWord, _client: client };
