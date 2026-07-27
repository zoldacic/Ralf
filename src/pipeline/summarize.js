'use strict';

const fs = require('fs');
const path = require('path');
const Anthropic = require('@anthropic-ai/sdk');

const config = require('../config');
const log = require('../util/logger');
const { _client: whisper, WhisperClient } = require('./transcribe');
const { pcmToWav, wavRms } = require('../voice/resample');

const MANIFEST = 'manifest.jsonl';

let client = null;
let systemPrompt = null;

function getClient() {
  if (!client) client = new Anthropic({ apiKey: config.anthropic.apiKey() });
  return client;
}

function getSystemPrompt() {
  if (!systemPrompt) systemPrompt = fs.readFileSync(config.session.prompt, 'utf8');
  return systemPrompt;
}

/** Root directory for one guild's recordings. */
function guildDir(guildId) {
  return path.join(config.session.dir, String(guildId));
}

/** Create a fresh session directory, e.g. recordings/<guild>/2026-07-26T08-30-00. */
function startSession(guildId) {
  const stamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
  const dir = path.join(guildDir(guildId), stamp);
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

/** The most recent session directory for a guild, or null. */
function latestSession(guildId) {
  const root = guildDir(guildId);
  if (!fs.existsSync(root)) return null;
  const dirs = fs
    .readdirSync(root, { withFileTypes: true })
    .filter((d) => d.isDirectory())
    .map((d) => d.name)
    .sort();
  return dirs.length ? path.join(root, dirs[dirs.length - 1]) : null;
}

/**
 * Persist one speech segment and record it in the manifest.
 * Cheap by design — no transcription here, just a file write.
 */
function saveSegment(dir, { userId, speaker, wav, durationMs, startedAt }) {
  const file = `seg-${startedAt}-${userId}.wav`;
  fs.writeFileSync(path.join(dir, file), wav);
  fs.appendFileSync(
    path.join(dir, MANIFEST),
    JSON.stringify({ file, userId, speaker, startedAt, durationMs }) + '\n'
  );
}

function readManifest(dir) {
  const p = path.join(dir, MANIFEST);
  if (!fs.existsSync(p)) return [];
  return fs
    .readFileSync(p, 'utf8')
    .split('\n')
    .filter(Boolean)
    .map((line) => {
      try {
        return JSON.parse(line);
      } catch (_) {
        return null;
      }
    })
    .filter(Boolean)
    .sort((a, b) => a.startedAt - b.startedAt);
}

/**
 * Pack a speaker's segments into batches of roughly batchMs of audio.
 *
 * Whisper pads every call out to a 30 second window, so transcribing a 2 second
 * clip costs about what 30 seconds costs. Table talk arrives in exactly those
 * short bursts, so batching one speaker's clips together is a large speedup for
 * the same audio. Batches never mix speakers, which keeps attribution intact;
 * the batch is timestamped at its first clip.
 *
 * A batch is also capped to spanMs of wall-clock time. Without that, one
 * speaker's clips from across the entire session collapse into a single blob
 * stamped at its earliest moment, and the recap loses the order things happened
 * in — which is most of what a recap is for.
 */
function batchSegments(segments, batchMs, spanMs) {
  const bySpeaker = new Map();
  for (const seg of segments) {
    if (!bySpeaker.has(seg.userId)) bySpeaker.set(seg.userId, []);
    bySpeaker.get(seg.userId).push(seg);
  }

  const batches = [];
  for (const [, segs] of bySpeaker) {
    let cur = null;
    for (const seg of segs) {
      const tooLong = cur && cur.durationMs + seg.durationMs > batchMs;
      const tooFar = cur && seg.startedAt + seg.durationMs - cur.startedAt > spanMs;
      if (tooLong || tooFar) {
        batches.push(cur);
        cur = null;
      }
      if (!cur) cur = { ...seg, files: [], durationMs: 0 };
      cur.files.push(seg.file);
      cur.durationMs += seg.durationMs;
    }
    if (cur) batches.push(cur);
  }
  return batches.sort((a, b) => a.startedAt - b.startedAt);
}

/** Concatenate segment WAVs into one, with a short gap so words don't run together. */
function joinWavs(dir, files, minRms) {
  const gap = Buffer.alloc(Math.round(0.25 * 16000) * 2); // 250 ms of silence
  const parts = [];
  for (const f of files) {
    const wav = fs.readFileSync(path.join(dir, f));
    if (wavRms(wav) < minRms) continue; // drop silent clips before they cost anything
    if (parts.length) parts.push(gap);
    parts.push(wav.subarray(44));
  }
  if (!parts.length) return null;
  return pcmToWav(Buffer.concat(parts), 16000);
}

function clock(ms) {
  const total = Math.max(0, Math.round(ms / 1000));
  const m = String(Math.floor(total / 60)).padStart(2, '0');
  const s = String(total % 60).padStart(2, '0');
  return `${m}:${s}`;
}

/**
 * Transcribe every recorded segment in order and write transcript.txt.
 * This is the slow part — roughly 3x the wall-clock length of the speech on a
 * CPU-only box — so it runs after the game, not during it.
 *
 * @param {string} dir           session directory
 * @param {(done:number,total:number)=>void} [onProgress]
 */
async function buildTranscript(dir, onProgress) {
  const segments = readManifest(dir);
  if (!segments.length) return { transcript: '', segments: 0, spoken: 0 };

  // The table speaks Swedish, so bulk transcription needs its own multilingual
  // sidecar — the live path's ".en" model cannot do Swedish at all.
  const { model: bulk, language } = config.session;
  const useOwn = bulk !== config.stt.model || language !== config.stt.language;
  const stt = useOwn
    ? new WhisperClient({ model: bulk, language, prompt: config.session.sttPrompt })
    : whisper;
  if (useOwn) log.info(`Summary transcription using model="${bulk}" language="${language}"`);

  const t0 = segments[0].startedAt;
  const batches = batchSegments(segments, config.session.batchMs, config.session.batchSpanMs);
  log.info(`Transcribing ${segments.length} clips as ${batches.length} batches`);

  const lines = [];
  let spoken = 0;
  let skipped = 0;

  try {
    for (let i = 0; i < batches.length; i++) {
      const b = batches[i];
      try {
        const wav = joinWavs(dir, b.files, config.session.minRms);
        if (!wav) {
          skipped += b.files.length; // whole batch was silence
        } else {
          const text = (await stt.transcribe(wav)).trim();
          if (text) {
            lines.push(`[${clock(b.startedAt - t0)}] ${b.speaker || b.userId}: ${text}`);
            spoken++;
          }
        }
      } catch (err) {
        log.warn(`Transcribe failed for batch at ${clock(b.startedAt - t0)}: ${err.message}`);
      }
      if (onProgress) onProgress(i + 1, batches.length);
    }
  } finally {
    if (useOwn) stt.shutdown();
  }

  const transcript = lines.join('\n');
  fs.writeFileSync(path.join(dir, 'transcript.txt'), transcript);
  if (skipped) log.info(`Skipped ${skipped} silent clips`);
  return { transcript, segments: segments.length, batches: batches.length, spoken, skipped };
}

/** Ask Claude for the session recap. Separate prompt from Ralf's spoken persona. */
async function summarizeTranscript(transcript) {
  const res = await getClient().messages.create({
    model: config.anthropic.model,
    max_tokens: config.session.maxTokens,
    system: getSystemPrompt(),
    messages: [{ role: 'user', content: `Session transcript:\n\n${transcript}` }],
  });
  return res.content
    .filter((b) => b.type === 'text')
    .map((b) => b.text)
    .join('\n')
    .trim();
}

/**
 * Full pipeline: transcribe the session's audio, then summarize it.
 * @returns {Promise<{summary:string, segments:number, spoken:number, dir:string}|null>}
 */
async function summarizeSession(dir, onProgress) {
  const started = Date.now();
  const { transcript, segments, spoken } = await buildTranscript(dir, onProgress);
  if (!transcript) return { summary: null, segments, spoken: 0, dir };

  const summary = await summarizeTranscript(transcript);
  fs.writeFileSync(path.join(dir, 'summary.md'), summary);
  log.info(`Session summary built in ${Date.now() - started}ms (${spoken}/${segments} segments)`);
  return { summary, segments, spoken, dir };
}

module.exports = {
  startSession,
  latestSession,
  saveSegment,
  readManifest,
  buildTranscript,
  summarizeSession,
};
