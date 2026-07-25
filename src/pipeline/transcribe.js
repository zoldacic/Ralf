'use strict';

const fs = require('fs');
const path = require('path');
const OpenAI = require('openai');

const config = require('../config');
const log = require('../util/logger');

let client = null;
function getClient() {
  if (!client) client = new OpenAI({ apiKey: config.stt.apiKey() });
  return client;
}

/**
 * Transcribe a 16 kHz mono WAV buffer as English.
 * Writes to tmp/ first because the SDK wants a file stream.
 * @param {Buffer} wav
 * @returns {Promise<string>} transcript, trimmed. Empty string if nothing heard.
 */
async function transcribe(wav) {
  fs.mkdirSync(config.paths.tmp, { recursive: true });
  const file = path.join(config.paths.tmp, `utt-${Date.now()}.wav`);
  fs.writeFileSync(file, wav);

  const started = Date.now();
  try {
    const res = await getClient().audio.transcriptions.create({
      file: fs.createReadStream(file),
      model: config.stt.model,
      language: config.stt.language,
      prompt: config.stt.prompt,
    });
    const text = (res.text || '').trim();
    log.info(`STT ${Date.now() - started}ms: "${text}"`);
    return text;
  } finally {
    fs.unlink(file, () => {});
  }
}

/**
 * Strip a leading wake word from the transcript. Whisper still renders the
 * name inconsistently, so match loosely.
 */
function stripWakeWord(text) {
  // The wake phrase is "hey ralf" (openWakeWord). Strip an optional leading
  // "hey" and the name — Whisper still renders the name loosely, so match wide.
  return text
    .replace(/^\s*(hey|hi|okay|ok)?\s*(ralff|ralph|ralf|rolf|ralv|rafe)\s*[,.!?:-]*\s*/i, '')
    .trim();
}

module.exports = { transcribe, stripWakeWord };
