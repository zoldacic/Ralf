'use strict';

const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');
const { createAudioResource, StreamType } = require('@discordjs/voice');

const config = require('../config');
const log = require('../util/logger');

/**
 * Split into sentences so we can synthesize and start playing the first one
 * while the rest is still generating.
 */
function splitSentences(text) {
  return text
    .split(/(?<=[.!?])\s+/)
    .map((s) => s.trim())
    .filter(Boolean);
}

/**
 * Run one sentence through Piper into a specific WAV path.
 *
 * Piper is spawned with cwd set to its own directory — it resolves espeak-ng
 * data relative to the working directory and fails confusingly otherwise.
 *
 * @param {string} sentence
 * @param {string} out  destination WAV path
 * @returns {Promise<string>} path to the generated WAV
 */
function runPiper(sentence, out) {
  return new Promise((resolve, reject) => {
    const proc = spawn(
      config.piper.bin,
      ['--model', config.piper.voice, '--output_file', out],
      { cwd: path.dirname(config.piper.bin) }
    );

    let stderr = '';
    proc.stderr.on('data', (d) => {
      stderr += d.toString();
    });

    proc.on('error', (err) =>
      reject(new Error(`Failed to spawn Piper at ${config.piper.bin}: ${err.message}`))
    );

    proc.on('close', (code) => {
      if (code !== 0) return reject(new Error(`Piper exited ${code}: ${stderr.slice(-400)}`));
      if (!fs.existsSync(out)) return reject(new Error('Piper produced no output file'));
      resolve(out);
    });

    proc.stdin.write(sentence);
    proc.stdin.end();
  });
}

/**
 * Run one sentence through Piper, producing a WAV file with a unique name.
 *
 * @param {string} sentence
 * @returns {Promise<string>} path to the generated WAV
 */
function synthesize(sentence) {
  fs.mkdirSync(config.paths.tmp, { recursive: true });
  const out = path.join(
    config.paths.tmp,
    `tts-${Date.now()}-${Math.random().toString(36).slice(2, 8)}.wav`
  );
  return runPiper(sentence, out);
}

// Cached acknowledgement WAV, synthesized once at startup. Null when the ack
// is disabled or pre-synthesis failed — the pipeline degrades to no ack.
let ackWav = null;

/**
 * Pre-synthesize the instant-ack phrase once, so playing it later is just a
 * file read (no Piper spawn on the hot path). Call at startup.
 *
 * @param {string} phrase  empty/falsy disables the ack
 * @returns {Promise<string|null>} cached WAV path, or null if disabled
 */
async function prepareAck(phrase) {
  if (!phrase || !phrase.trim()) {
    ackWav = null;
    return null;
  }
  fs.mkdirSync(config.paths.tmp, { recursive: true });
  const out = path.join(config.paths.tmp, 'ack.wav');
  await runPiper(phrase.trim(), out);
  ackWav = out;
  return out;
}

/**
 * Play the pre-synthesized ack immediately (fire-and-forget). Returns false if
 * no ack is prepared, so callers can proceed regardless.
 *
 * @param {import('@discordjs/voice').AudioPlayer} player
 * @returns {boolean} whether an ack was queued
 */
function playAck(player) {
  if (!ackWav) return false;
  try {
    const resource = createAudioResource(fs.createReadStream(ackWav), {
      inputType: StreamType.Arbitrary,
    });
    player.play(resource);
    return true;
  } catch (err) {
    log.error(`Ack playback failed: ${err.message}`);
    return false;
  }
}

/**
 * Speak an answer into a voice channel, sentence by sentence.
 *
 * @param {import('@discordjs/voice').AudioPlayer} player
 * @param {string} text
 */
async function speak(player, text) {
  const sentences = splitSentences(text);
  if (!sentences.length) return;

  const temps = [];
  try {
    for (const sentence of sentences) {
      const started = Date.now();
      const wav = await synthesize(sentence);
      temps.push(wav);
      log.debug(`Piper ${Date.now() - started}ms for ${sentence.length} chars`);

      await playAndWait(player, wav);
    }
  } finally {
    for (const f of temps) fs.unlink(f, () => {});
  }
}

function playAndWait(player, file) {
  return new Promise((resolve, reject) => {
    const resource = createAudioResource(fs.createReadStream(file), {
      inputType: StreamType.Arbitrary,
    });

    const onIdle = () => {
      cleanup();
      resolve();
    };
    const onError = (err) => {
      cleanup();
      reject(err);
    };
    const cleanup = () => {
      player.off('idle', onIdle);
      player.off('error', onError);
    };

    player.on('idle', onIdle);
    player.on('error', onError);
    player.play(resource);
  });
}

module.exports = { speak, synthesize, splitSentences, prepareAck, playAck };
