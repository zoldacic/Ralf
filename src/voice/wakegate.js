'use strict';

const config = require('../config');
const log = require('../util/logger');
const { WhisperClient } = require('../pipeline/transcribe');
const { wavRms, pcmToWav } = require('./resample');

/**
 * Wake word by transcription.
 *
 * openWakeWord's trained ralf.onnx turned out to recognise Piper's synthetic
 * speech and nothing else — 0.99 on TTS saying "Hey Ralf", 0.002 on this table
 * saying the same words into a real microphone. Rather than retrain it, every
 * finished speech segment now goes through a tiny local Whisper and a leading
 * "Ralf" opens the question. Slower to fire, because a transcript only exists
 * once someone stops talking, but it hears actual humans.
 *
 * Runs in its own sidecar so the live path keeps its warm, larger model: the
 * gate answers "was that the name?" in a few hundred milliseconds, and only
 * then does the real transcription start.
 */

// Whisper renders the name however it likes; a false open costs one ignored
// segment, a miss costs the whole feature, so match generously. Keep in step
// with stripWakeWord() in pipeline/transcribe.js.
const NAME = /^(ralff?|ralph|rolf|rolph|ralv|rafe|alf)$/i;

class WakeGate {
  constructor() {
    this.available = false;
    this.queued = 0;
    this.client = null;
  }

  enabled() {
    return config.gate.enabled;
  }

  /**
   * Spawn and warm the gate's Whisper. Resolves to whether it is usable —
   * a failure here disables the gate and leaves /ralf working, like every
   * other optional subsystem.
   */
  async init() {
    if (!config.gate.enabled) return false;
    this.client = new WhisperClient({
      model: config.gate.model,
      language: 'en',
      prompt: config.gate.prompt,
      beamSize: config.gate.beamSize,
    });
    try {
      await this.client.transcribe(silentWav(300)); // forces the model to load
      this.available = true;
      log.info(`Wake gate ready (whisper "${config.gate.model}", listening for "Ralf")`);
    } catch (err) {
      this.available = false;
      log.warn(`Wake gate unavailable (${err.message}) — /ralf only.`);
    }
    return this.available;
  }

  /**
   * Does this speech segment start with the wake word?
   *
   * Cheap rejections first: nothing here is worth a Whisper call unless the
   * clip is short enough to be an address and loud enough to hold speech.
   *
   * @param {Buffer} wav 16 kHz mono WAV
   * @param {number} durationMs
   * @returns {Promise<{hit: boolean, text: string}>}
   */
  async check(wav, durationMs) {
    const miss = { hit: false, text: '' };
    if (!this.available) return miss;
    if (durationMs > config.gate.maxMs) return miss;
    if (wavRms(wav) < config.gate.minRms) return miss;
    if (this.queued >= config.gate.maxQueued) {
      log.debug('Wake gate backed up — dropping a segment');
      return miss;
    }

    this.queued++;
    const started = Date.now();
    let text;
    try {
      text = await this.client.transcribe(wav);
    } catch (err) {
      log.warn(`Wake gate transcription failed: ${err.message}`);
      return miss;
    } finally {
      this.queued--;
    }

    const hit = match(text);
    log.debug(`Gate ${Date.now() - started}ms ${hit ? 'HIT' : '   '} "${text.trim()}"`);
    return { hit, text: text.trim() };
  }

  shutdown() {
    if (this.client) this.client.shutdown();
    this.available = false;
  }
}

/**
 * True when the name appears near the front of the transcript. Position is what
 * separates "Ralf, how does grappling work" from a player telling another player
 * to go ask Ralf about it later.
 */
function match(text) {
  const words = String(text)
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\s]/gu, ' ')
    .split(/\s+/)
    .filter(Boolean);
  return words.slice(0, config.gate.leadingWords).some((w) => NAME.test(w));
}

/** A short silent WAV, used only to force the model to load on startup. */
function silentWav(ms) {
  return pcmToWav(Buffer.alloc(Math.round((16000 * ms) / 1000) * 2), 16000);
}

const gate = new WakeGate();
gate.match = match; // exported for tests; the gate itself calls the closure
gate.NAME = NAME;

module.exports = gate;
