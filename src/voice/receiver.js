'use strict';

const { EndBehaviorType } = require('@discordjs/voice');
const prism = require('prism-media');
const { EventEmitter } = require('events');

const config = require('../config');
const log = require('../util/logger');
const wakeword = require('./wakeword');
const { Downsampler, toFrames, pcmToWav } = require('./resample');

const IDLE = 'idle';
const CAPTURING = 'capturing';

// Keep this much recent audio so the onset of a question spoken right as the
// wake word fires isn't clipped. 16 kHz mono 16-bit => 32000 bytes/sec.
const PREROLL_BYTES = Math.round((16000 * 2 * 600) / 1000); // ~600 ms

/**
 * Subscribes to every speaker in a voice connection, runs wake word detection
 * locally, and emits a WAV buffer once a post-wake utterance completes.
 *
 * Emits: 'utterance' ({ userId, wav, durationMs })
 */
class VoiceListener extends EventEmitter {
  constructor(connection, { captureTest = false } = {}) {
    super();
    this.connection = connection;
    this.sessions = new Map(); // userId -> session
    this.stopped = false;
    // Phase 2 debug: capture on any voice activity instead of waiting for the
    // wake word, and save the WAV rather than transcribing it.
    this.captureTest = captureTest;

    this.receiver = connection.receiver;
    this._onSpeakingStart = (userId) => this._subscribe(userId);
    this.receiver.speaking.on('start', this._onSpeakingStart);

    // Detections arrive asynchronously from the openWakeWord sidecar.
    this._onDetection = ({ userId }) => this._onWakeDetection(userId);
    wakeword.on('detection', this._onDetection);
  }

  _onWakeDetection(userId) {
    if (this.stopped) return;
    const s = this.sessions.get(userId);
    if (!s || s.state === CAPTURING) return;
    if (Date.now() < s.cooldownUntil) return;
    this._beginCapture(s);
  }

  _session(userId) {
    let s = this.sessions.get(userId);
    if (!s) {
      s = {
        userId,
        state: IDLE,
        pending: Buffer.alloc(0), // frames not yet fed to Porcupine
        captured: [], // PCM chunks since the wake word
        capturedBytes: 0,
        preroll: Buffer.alloc(0), // rolling recent audio, prepended on capture
        silenceTimer: null,
        maxTimer: null,
        cooldownUntil: 0,
        stream: null,
      };
      this.sessions.set(userId, s);
    }
    return s;
  }

  _subscribe(userId) {
    if (this.stopped) return;
    const s = this._session(userId);
    if (s.stream) return; // already listening to this user

    // Manual end behaviour: we manage the lifecycle ourselves, so the stream
    // stays open across natural pauses instead of tearing down every gap.
    const opus = this.receiver.subscribe(userId, {
      end: { behavior: EndBehaviorType.Manual },
    });

    const decoder = new prism.opus.Decoder({
      rate: config.audio.discordRate,
      channels: config.audio.discordChannels,
      frameSize: 960,
    });

    const down = new Downsampler();
    const pipeline = opus.pipe(decoder).pipe(down);

    s.stream = { opus, decoder, down };

    if (wakeword.available && !this.captureTest) wakeword.openStream(userId);

    pipeline.on('data', (pcm) => this._onPcm(s, pcm));
    pipeline.on('error', (err) => {
      log.error(`Stream error for ${userId}: ${err.message}`);
      this._teardown(userId);
    });
    opus.on('end', () => this._teardown(userId));

    log.debug(`Listening to ${userId}`);
  }

  _onPcm(s, pcm) {
    if (this.stopped) return;

    if (s.state === CAPTURING) {
      s.captured.push(pcm);
      s.capturedBytes += pcm.length;
      this._resetSilence(s);
      return;
    }

    if (Date.now() < s.cooldownUntil) return;

    // Phase 2: with no wake word, treat the onset of speech as the trigger and
    // capture the whole utterance, including this first chunk.
    if (this.captureTest) {
      this._beginCapture(s);
      s.captured.push(pcm);
      s.capturedBytes += pcm.length;
      this._resetSilence(s);
      return;
    }

    if (!wakeword.available) return;

    // Feed fixed-length frames to the sidecar; detections come back as events
    // and are handled in _onWakeDetection.
    s.pending = s.pending.length ? Buffer.concat([s.pending, pcm]) : pcm;
    const { frames, remainder } = toFrames(s.pending, wakeword.frameLength);
    s.pending = remainder;

    for (const frame of frames) wakeword.feed(s.userId, frame);

    // Roll a short pre-roll window so _beginCapture can prepend the audio just
    // before detection — otherwise the first word of the question is clipped.
    s.preroll = s.preroll.length ? Buffer.concat([s.preroll, pcm]) : pcm;
    if (s.preroll.length > PREROLL_BYTES) {
      s.preroll = s.preroll.subarray(s.preroll.length - PREROLL_BYTES);
    }
  }

  _beginCapture(s) {
    log.info(
      this.captureTest
        ? `Capturing speech from ${s.userId} (capture-test)`
        : `Wake word detected from ${s.userId}`
    );
    s.state = CAPTURING;
    s.captured = [];
    s.capturedBytes = 0;
    // Prepend the pre-roll so the onset of speech isn't clipped.
    if (s.preroll.length) {
      s.captured.push(s.preroll);
      s.capturedBytes += s.preroll.length;
    }
    s.preroll = Buffer.alloc(0);
    s.pending = Buffer.alloc(0);
    this.emit('wake', { userId: s.userId });

    this._resetSilence(s);
    s.maxTimer = setTimeout(() => this._finishCapture(s, 'max-duration'), config.capture.maxMs);
  }

  _resetSilence(s) {
    if (s.silenceTimer) clearTimeout(s.silenceTimer);
    s.silenceTimer = setTimeout(
      () => this._finishCapture(s, 'silence'),
      config.capture.silenceMs
    );
  }

  _finishCapture(s, reason) {
    if (s.state !== CAPTURING) return;

    if (s.silenceTimer) clearTimeout(s.silenceTimer);
    if (s.maxTimer) clearTimeout(s.maxTimer);
    s.silenceTimer = s.maxTimer = null;
    s.state = IDLE;
    s.cooldownUntil = Date.now() + config.wakeword.cooldownMs;

    const pcm = Buffer.concat(s.captured);
    s.captured = [];
    s.capturedBytes = 0;

    // 16 kHz mono 16-bit => 32000 bytes per second.
    const durationMs = Math.round((pcm.length / 32000) * 1000);
    if (durationMs < config.capture.minMs) {
      log.debug(`Discarding ${durationMs}ms capture from ${s.userId} (too short)`);
      return;
    }

    log.info(`Captured ${durationMs}ms from ${s.userId} (${reason})`);
    this.emit('utterance', {
      userId: s.userId,
      wav: pcmToWav(pcm, config.audio.targetRate),
      durationMs,
    });
  }

  _teardown(userId) {
    const s = this.sessions.get(userId);
    if (!s) return;
    if (s.silenceTimer) clearTimeout(s.silenceTimer);
    if (s.maxTimer) clearTimeout(s.maxTimer);
    if (s.stream) {
      try {
        s.stream.opus.destroy();
        s.stream.decoder.destroy();
        s.stream.down.destroy();
      } catch (_) {
        /* already gone */
      }
    }
    wakeword.release(userId);
    this.sessions.delete(userId);
    log.debug(`Stopped listening to ${userId}`);
  }

  stop() {
    this.stopped = true;
    this.receiver.speaking.off('start', this._onSpeakingStart);
    wakeword.off('detection', this._onDetection);
    for (const userId of [...this.sessions.keys()]) this._teardown(userId);
  }
}

module.exports = { VoiceListener };
