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
    // Covers thinking tokens as well as the answer, so this is much larger than
    // a forty-word ruling needs. See the note in pipeline/ask.js.
    maxTokens: 1200,
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

  gate: {
    // The wake word, by transcription rather than by acoustic model.
    //
    // Every finished speech segment goes through a small local Whisper, and a
    // leading "Ralf" opens the question. This replaced openWakeWord: the trained
    // models/ralf.onnx scored 0.99 on Piper TTS and 0.002 on this table's actual
    // voices saying the same words, and no threshold rescues 0.002.
    //
    // The trade is latency — a transcript only exists once the utterance ends,
    // so the trigger lands about a second later than an acoustic model's would,
    // and the spoken ack lands with it. Worth it for something that hears real
    // people. Set WAKE_GATE=false to fall back to /ralf only.
    enabled: process.env.WAKE_GATE !== 'false',
    // Screening for one name, so the smallest model is plenty and it stays far
    // under realtime. Bump to base.en or small.en if it mishears the name.
    model: process.env.GATE_WHISPER_MODEL || 'tiny.en',
    // Greedy decoding: this transcript is only ever pattern-matched, never read
    // aloud, so beam search buys nothing but latency.
    beamSize: 1,
    // Load-bearing, and fragile in both directions — measured over 26 recorded
    // segments containing six real wake words:
    //   no prompt      1/6 caught. Whisper has no reason to think "Ralf" is a
    //                  word, so it reaches for Ron, Raul, "you're out".
    //   this sentence  6/6 caught, zero false positives.
    //   bare "Ralf"    6/6 caught but three false positives — over-primed, it
    //                  hallucinates the name into near-silence ("Grandma Ralf").
    //   "Hey Ralf. Yo Ralf."  a repetition loop: 55 copies of the phrase out of
    //                  a 2.5 s clip, 14 s to decode. Never prime with the wake
    //                  phrase itself, and never repeat it.
    // One natural sentence mentioning the name once is the shape that works.
    prompt: 'Ralf is the rules assistant at this Dungeons and Dragons table.',
    // The name must land this early in the transcript to count, so saying
    // "…ask Ralf about it" mid-sentence to another player doesn't fire.
    leadingWords: 3,
    // A wake word starts a short utterance; it is not buried in a monologue.
    // Every recorded wake word ran under five seconds, while the long segments
    // are the ones that cost the gate 13 s, so this cap is mostly about keeping
    // the queue moving.
    maxMs: Number(process.env.GATE_MAX_MS || 10000),
    // Below this RMS there is no speech to find — same measurement as the
    // session summariser (silence peaked at 944, quietest real speech was 957).
    minRms: Number(process.env.GATE_MIN_RMS || 500),
    // Discord hands every speaker their own stream, so a lively table can queue
    // clips faster than the sidecar drains them. Past this many waiting, drop
    // the segment: a stale trigger is worse than a missed one.
    maxQueued: 3,
  },

  wakeword: {
    // Off by default now — the transcript gate above does the job, and running
    // the sidecar as well costs a Python process and per-frame inference for
    // nothing. Set WAKEWORD_ENABLED=true to run an acoustic model alongside it
    // (worth doing again if models/ralf.onnx is ever retrained on real speech).
    enabled: process.env.WAKEWORD_ENABLED === 'true',
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

  session: {
    // Record every speech segment to disk during a game so the session can be
    // summarized afterwards. Writing WAVs is cheap; transcription deliberately
    // happens later in batch (/ralf-summary) because medium.en runs ~3x slower
    // than realtime on this CPU — transcribing live would fall behind and
    // starve the wake-word path.
    record: process.env.SESSION_RECORD !== 'false',
    dir: abs(process.env.SESSION_DIR || 'recordings'),
    // Cut a segment after this long so memory stays bounded on a monologue.
    maxSegmentMs: 30000,
    prompt: abs('src/data/summary-prompt.txt'),
    // Thinking shares this budget too, and a recap is long — leave real room or
    // a summary can truncate mid-sentence.
    maxTokens: 4000,
    // The table talks Swedish; only questions aimed at Ralf are English. So the
    // bulk transcription MUST use a multilingual model — the ".en" models used
    // on the live path cannot transcribe Swedish at all. Runs in its own
    // sidecar, so the live wake-word path keeps its warm English model.
    // 'small' is ~3x faster than 'medium' if a long session is too slow.
    model: process.env.SUMMARY_WHISPER_MODEL || 'medium',
    language: process.env.SUMMARY_LANGUAGE || 'sv',
    // Skip segments quieter than this RMS instead of transcribing them. On real
    // data, silence peaked at 944 RMS and the quietest real speech was 957, so
    // 500 leaves a wide margin. Silent clips were ~75% of a test session, and
    // transcription is the slow part. The WAVs are kept, so lowering this and
    // re-running recovers anything wrongly skipped.
    minRms: Number(process.env.SUMMARY_MIN_RMS || 500),
    // Whisper pads each call to a 30 s window, so short clips cost nearly what
    // long ones do. Batch one speaker's clips up to this much audio per call.
    batchMs: Number(process.env.SUMMARY_BATCH_MS || 25000),
    // ...but never span more than this much wall-clock time, so the recap keeps
    // the order the conversation actually happened in. Five minutes is plenty
    // of resolution for a recap; tightening it costs speed, widening it blurs
    // the chronology.
    batchSpanMs: Number(process.env.SUMMARY_BATCH_SPAN_MS || 300000),
    // Discord rejects attachments over its per-server limit outright; 10 MB is
    // the floor (an unboosted server). Raise it if this guild is boosted.
    maxUploadBytes: Number(process.env.MAX_UPLOAD_BYTES || 10 * 1024 * 1024),
    // Rules terms stay English at Swedish tables, so bias toward both.
    sttPrompt:
      'Ett samtal på svenska under en Dungeons and Dragons-session. ' +
      'Regeltermer sägs ofta på engelska: advantage, disadvantage, saving throw, ' +
      'initiative, opportunity attack, weapon mastery, concentration, armor class.',
  },

  illustrate: {
    // Draw the session recap and ship it as a PDF when /ralf-summary finishes.
    // Local Stable Diffusion, so this stays account-free like the rest of the
    // stack — the cost is a one-time multi-gigabyte model download and a GPU.
    // Set ILLUSTRATE=false for a text-only recap.
    enabled: process.env.ILLUSTRATE !== 'false',
    // Its own virtualenv: torch is a ~3 GB tree and has no business sharing an
    // environment with the wake word and Whisper, which have to keep working.
    python: abs(process.env.SD_PYTHON || '.venv-sd/Scripts/python.exe'),
    sidecar: abs('src/pipeline/image_sidecar.py'),
    scenePrompt: abs('src/data/scene-prompt.txt'),
    // sd-turbo is distilled for one to four steps and 512x512, which is what
    // fits a 4 GB card. SDXL does not fit; plain SD 1.5 needs ~25 steps for the
    // same quality and takes an order of magnitude longer.
    model: process.env.SD_MODEL || 'stabilityai/sd-turbo',
    // Keep the weights in the project's gitignored models/ rather than spraying
    // them through the user profile.
    hfHome: abs('models/hf'),
    count: Number(process.env.SD_IMAGES || 5),
    steps: Number(process.env.SD_STEPS || 4),
    width: 512,
    height: 512,
    // sd-turbo is trained for guidance 0. Raising it burns the image rather
    // than sharpening it.
    guidance: 0,
    // Inert at guidance 0 — a negative prompt only acts through classifier-free
    // guidance, which guidance 0 switches off. Left here for anyone who swaps in
    // a non-distilled model. The watermark strip this would otherwise target is
    // cropped in the sidecar instead.
    negative: 'text, letters, watermark, signature, blurry, deformed hands, extra limbs',
    // Fixed so a recap redrawn from the same scenes looks the same. Set
    // SD_SEED='' for a different roll every time.
    seed: process.env.SD_SEED === '' ? null : Number(process.env.SD_SEED || 1337),
    // Scene planning is a small structured job, but thinking shares the budget.
    maxTokens: 2000,
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

  character: {
    // Roll a random species + class when Ralf joins a channel, announce it, and
    // answer the rest of the session in character. Rulings stay correct either
    // way — the character only colours the voice. Set CHARACTER_ENABLED=false
    // for a plain rules assistant.
    enabled: process.env.CHARACTER_ENABLED !== 'false',
  },

  ack: {
    // Short spoken acknowledgement played the instant a spoken question is
    // captured — before STT/LLM run — so the user knows they were heard while
    // the ~13 s transcription happens. Pre-synthesized once at startup.
    // Set ACK_PHRASE='' to disable. Only used on the wake-word path.
    phrase: process.env.ACK_PHRASE ?? 'Right...',
  },

  paths: {
    tmp: abs('tmp'),
    logs: abs('logs'),
    prompt: abs('src/data/prompt.txt'),
    qaLog: abs('logs/qa.jsonl'),
  },
};
