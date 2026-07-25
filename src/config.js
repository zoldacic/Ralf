'use strict';

const path = require('path');
require('dotenv').config();

const ROOT = path.resolve(__dirname, '..');
const abs = (p) => (path.isAbsolute(p) ? p : path.join(ROOT, p));

function required(name) {
  const v = process.env[name];
  if (!v) throw new Error(`Missing required env var: ${name} (see .env.example)`);
  return v;
}

module.exports = {
  ROOT,
  abs,
  required,

  discord: {
    token: () => required('DISCORD_TOKEN'),
    clientId: () => required('DISCORD_CLIENT_ID'),
    guildId: process.env.DISCORD_GUILD_ID || null,
  },

  anthropic: {
    apiKey: () => required('ANTHROPIC_API_KEY'),
    // Public API model strings: claude-opus-4-8, claude-sonnet-5, claude-haiku-4-5-20251001
    model: process.env.ANTHROPIC_MODEL || 'claude-sonnet-5',
    maxTokens: 400,
  },

  stt: {
    // Local Whisper via a faster-whisper sidecar — no account, offline.
    // (Replaced OpenAI hosted transcription.) See src/pipeline/whisper_sidecar.py.
    python: abs(process.env.WHISPER_PYTHON || '.venv/Scripts/python.exe'),
    sidecar: abs('src/pipeline/whisper_sidecar.py'),
    // tiny | base | small | medium | large-v3. 'small' balances accuracy and
    // speed on CPU; bump to 'medium' for better proper-noun accuracy if you can
    // spare the latency.
    model: process.env.WHISPER_MODEL || 'small',
    language: 'en',
    beamSize: Number(process.env.WHISPER_BEAM || 5),
    // Biases the transcript toward D&D vocabulary — classes, spells, and terms
    // Whisper otherwise mangles at 16 kHz.
    prompt:
      'Dungeons and Dragons fifth edition rules. Classes: wizard, warlock, sorcerer, ' +
      'cleric, paladin, rogue, fighter, barbarian, bard, druid, monk, ranger. ' +
      'Spells: Fireball, Eldritch Blast, Bardic Inspiration, Cure Wounds, Counterspell. ' +
      'Terms: Advantage, Disadvantage, Opportunity Attack, Weapon Mastery, Saving Throw, ' +
      'Concentration, Grapple, Proficiency Bonus, Armor Class.',
  },

  wakeword: {
    enabled: process.env.WAKEWORD_ENABLED !== 'false',
    // openWakeWord runs as a local Python sidecar — no account, no cloud.
    // See src/voice/oww_sidecar.py and the wakeword-openwakeword-decision note.
    python: abs(process.env.WAKEWORD_PYTHON || '.venv/Scripts/python.exe'),
    sidecar: abs('src/voice/oww_sidecar.py'),
    // A builtin name (alexa, hey_jarvis, hey_mycroft, ...) for validation, or a
    // path to a trained custom model such as models/ralf.onnx once you have one.
    model: process.env.WAKEWORD_MODEL || 'alexa',
    // Detection score threshold, 0..1. Lower = more sensitive / more false fires.
    threshold: Number(process.env.WAKE_THRESHOLD || 0.5),
    // Ignore further detections from the same user for this long.
    cooldownMs: 8000,
  },

  capture: {
    // Stop capturing after this much continuous silence.
    silenceMs: 1500,
    // Hard cap so nobody can leave the mic open (also bounds STT latency on CPU).
    maxMs: 12000,
    // Discard captures shorter than this — almost always a false trigger.
    minMs: 700,
    // Phase 2 debug: capture speech to a WAV on any voice activity (no wake
    // word) and save it instead of transcribing. Set CAPTURE_TEST_MODE=true.
    testMode: process.env.CAPTURE_TEST_MODE === 'true',
  },

  audio: {
    discordRate: 48000,
    discordChannels: 2,
    targetRate: 16000,
  },

  piper: {
    bin: abs(process.env.PIPER_BIN || 'bin/piper/piper.exe'),
    voice: abs(process.env.PIPER_VOICE || 'models/en_GB-alba-medium.onnx'),
  },

  paths: {
    tmp: abs('tmp'),
    logs: abs('logs'),
    prompt: abs('src/data/prompt.txt'),
    qaLog: abs('logs/qa.jsonl'),
  },
};
