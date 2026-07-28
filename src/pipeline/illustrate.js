'use strict';

const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');
const Anthropic = require('@anthropic-ai/sdk');

const config = require('../config');
const log = require('../util/logger');

// The model download on first run is several GB; warm starts load from cache.
const READY_TIMEOUT_MS = 900000;

let client = null;
let scenePrompt = null;

function getClient() {
  if (!client) client = new Anthropic({ apiKey: config.anthropic.apiKey() });
  return client;
}

function getScenePrompt() {
  if (!scenePrompt) scenePrompt = fs.readFileSync(config.illustrate.scenePrompt, 'utf8');
  return scenePrompt;
}

/**
 * Turn a session recap into a handful of scenes to draw.
 *
 * The recap is Swedish and the image model only understands English, so Claude
 * does both jobs at once: pick the moments worth a picture, and write each one
 * as a Stable Diffusion prompt.
 *
 * @param {string} summary  the recap, as posted to Discord
 * @param {number} count    how many scenes to ask for
 * @returns {Promise<Array<{caption: string, prompt: string}>>} possibly fewer
 *   than `count`, and empty if the recap was too thin to illustrate.
 */
async function planScenes(summary, count) {
  const res = await getClient().messages.create({
    model: config.anthropic.model,
    max_tokens: config.illustrate.maxTokens,
    system: getScenePrompt(),
    messages: [
      {
        role: 'user',
        content: `Choose up to ${count} scenes from this session recap.\n\n${summary}`,
      },
    ],
  });

  const text = res.content
    .filter((b) => b.type === 'text')
    .map((b) => b.text)
    .join('\n')
    .trim();

  // Claude is asked for a bare JSON array, but a stray fence or sentence around
  // it should cost us a picture, not the whole PDF.
  const start = text.indexOf('[');
  const end = text.lastIndexOf(']');
  if (start < 0 || end <= start) {
    log.warn(`Scene planning returned no JSON array: "${text.slice(0, 120)}"`);
    return [];
  }

  let scenes;
  try {
    scenes = JSON.parse(text.slice(start, end + 1));
  } catch (err) {
    log.warn(`Scene planning JSON did not parse: ${err.message}`);
    return [];
  }

  return scenes
    .filter((s) => s && typeof s.prompt === 'string' && s.prompt.trim())
    .slice(0, count)
    .map((s) => ({
      caption: String(s.caption || '').trim(),
      prompt: s.prompt.trim(),
    }));
}

/**
 * Renders scenes through the local Stable Diffusion sidecar.
 *
 * Spawned per summary rather than kept warm: the model holds most of a 4 GB
 * card and the bot spends the rest of its life doing audio.
 */
class ImageSidecar {
  constructor(outDir) {
    this.outDir = outDir;
    this.proc = null;
    this._stdoutBuf = '';
    this._pending = new Map();
    this._nextId = 1;
    this.device = null;
  }

  start() {
    return new Promise((resolve, reject) => {
      const { python, sidecar, model, steps, width, height, guidance, negative } =
        config.illustrate;
      if (!fs.existsSync(python)) {
        return reject(new Error(`Stable Diffusion Python not found at ${python}`));
      }
      if (!fs.existsSync(sidecar)) {
        return reject(new Error(`Image sidecar not found at ${sidecar}`));
      }

      const args = [
        sidecar,
        '--model', model,
        '--out', this.outDir,
        '--steps', String(steps),
        '--width', String(width),
        '--height', String(height),
        '--guidance', String(guidance),
      ];
      if (negative) args.push('--negative', negative);

      let proc;
      try {
        // Keep the multi-gigabyte weights inside the project's gitignored
        // models/ directory rather than scattered through the user profile.
        proc = spawn(python, args, {
          cwd: config.ROOT,
          env: { ...process.env, HF_HOME: config.illustrate.hfHome },
        });
      } catch (err) {
        return reject(new Error(`Failed to spawn image sidecar: ${err.message}`));
      }
      this.proc = proc;

      let settled = false;
      const timer = setTimeout(() => {
        if (!settled) {
          settled = true;
          reject(new Error('Image sidecar did not report ready in time'));
        }
      }, READY_TIMEOUT_MS);

      proc.stdout.on('data', (d) =>
        this._onStdout(d, (msg) => {
          if (settled) return;
          settled = true;
          clearTimeout(timer);
          this.device = `${msg.device}${msg.gpu ? ` (${msg.gpu})` : ''}`;
          log.info(`Stable Diffusion ready on ${this.device}, model "${msg.model}"`);
          resolve();
        })
      );
      proc.stderr.on('data', (d) => log.debug(`[sd] ${d.toString().trim()}`));
      proc.on('error', (err) => {
        if (!settled) {
          settled = true;
          clearTimeout(timer);
          reject(err);
        }
        this._fail(err);
      });
      proc.on('exit', (code) => {
        const err = new Error(`image sidecar exited (${code})`);
        if (!settled) {
          settled = true;
          clearTimeout(timer);
          reject(err);
        }
        this._fail(err);
      });
    });
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
        log.debug(`[sd] non-JSON: ${line}`);
        continue;
      }
      if (msg.type === 'ready') onReady(msg);
      else if (msg.type === 'result') this._settle(msg.id, null, msg);
      else if (msg.type === 'error') this._settle(msg.id, new Error(msg.msg || 'render failed'));
    }
  }

  _settle(id, err, msg) {
    const p = this._pending.get(id);
    if (!p) return;
    this._pending.delete(id);
    if (err) p.reject(err);
    else p.resolve(msg);
  }

  _fail(err) {
    for (const [, p] of this._pending) p.reject(err);
    this._pending.clear();
    this.proc = null;
  }

  /** Render one prompt. Resolves to { file, ms }. */
  render(prompt, seed) {
    const id = this._nextId++;
    const body = Buffer.from(JSON.stringify({ prompt, seed }), 'utf8');
    const payload = Buffer.alloc(4 + body.length);
    payload.writeUInt32LE(id, 0);
    body.copy(payload, 4);
    const header = Buffer.alloc(4);
    header.writeUInt32LE(payload.length, 0);

    return new Promise((resolve, reject) => {
      this._pending.set(id, { resolve, reject });
      if (!this.proc || !this.proc.stdin.writable) {
        this._pending.delete(id);
        return reject(new Error('image sidecar not available'));
      }
      this.proc.stdin.write(Buffer.concat([header, payload]));
    });
  }

  stop() {
    if (this.proc) {
      try {
        this.proc.stdin.end();
      } catch (_) {
        /* ignore */
      }
      try {
        this.proc.kill();
      } catch (_) {
        /* ignore */
      }
    }
    this.proc = null;
  }
}

/**
 * Plan and render illustrations for a recap.
 *
 * Every failure here is survivable: the recap is already posted by the time this
 * runs, so a missing picture costs a picture. Returns whatever was drawn.
 *
 * @param {string} summary
 * @param {string} dir  session directory; images land in <dir>/images
 * @param {(done:number,total:number)=>void} [onProgress]
 * @returns {Promise<Array<{caption: string, prompt: string, file: string}>>}
 */
async function illustrate(summary, dir, onProgress) {
  if (!config.illustrate.enabled) return [];

  const scenes = await planScenes(summary, config.illustrate.count);
  if (!scenes.length) {
    log.info('No scenes worth illustrating in this recap');
    return [];
  }
  log.info(`Illustrating ${scenes.length} scenes`);

  const outDir = path.join(dir, 'images');
  const sidecar = new ImageSidecar(outDir);
  await sidecar.start();

  const done = [];
  try {
    for (let i = 0; i < scenes.length; i++) {
      try {
        const { file, ms } = await sidecar.render(scenes[i].prompt, config.illustrate.seed);
        log.debug(`Scene ${i + 1}/${scenes.length} rendered in ${ms}ms`);
        done.push({ ...scenes[i], file });
      } catch (err) {
        log.warn(`Scene ${i + 1} failed to render: ${err.message}`);
      }
      if (onProgress) onProgress(i + 1, scenes.length);
    }
  } finally {
    sidecar.stop();
  }

  return done;
}

module.exports = { illustrate, planScenes, ImageSidecar };
