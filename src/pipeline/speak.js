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
 * Run one sentence through Piper, producing a WAV file.
 *
 * Piper is spawned with cwd set to its own directory — it resolves espeak-ng
 * data relative to the working directory and fails confusingly otherwise.
 *
 * @param {string} sentence
 * @returns {Promise<string>} path to the generated WAV
 */
function synthesize(sentence) {
  return new Promise((resolve, reject) => {
    fs.mkdirSync(config.paths.tmp, { recursive: true });
    const out = path.join(
      config.paths.tmp,
      `tts-${Date.now()}-${Math.random().toString(36).slice(2, 8)}.wav`
    );

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

module.exports = { speak, synthesize, splitSentences };
