'use strict';

const fs = require('fs');
const Anthropic = require('@anthropic-ai/sdk');

const config = require('../config');
const log = require('../util/logger');

let client = null;
let systemPrompt = null;

function getClient() {
  if (!client) client = new Anthropic({ apiKey: config.anthropic.apiKey() });
  return client;
}

function getSystemPrompt() {
  if (!systemPrompt) systemPrompt = fs.readFileSync(config.paths.prompt, 'utf8');
  return systemPrompt;
}

/**
 * Ask Ralf a D&D rules question.
 * @param {string} question  the rules question
 * @param {{persona?: string|null}} [opts]  extra system prompt appended after
 *        Ralf's own — used for the per-session character. Appended rather than
 *        substituted so the rules and brevity instructions always win.
 * @returns {Promise<string>} answer, 2-3 sentences of plain prose
 */
async function ask(question, { persona = null } = {}) {
  const started = Date.now();
  const system = persona ? `${getSystemPrompt()}\n\n${persona}` : getSystemPrompt();
  const res = await getClient().messages.create({
    model: config.anthropic.model,
    max_tokens: config.anthropic.maxTokens,
    // Sonnet 5 runs adaptive thinking whenever `thinking` is unset, and
    // max_tokens caps thinking plus text together. At 400 tokens the thinking
    // sometimes ate the entire budget and the answer came back empty, with
    // stop_reason "max_tokens" and no text block at all — Ralf simply went
    // quiet. Low effort fits a two-sentence spoken ruling and keeps latency
    // down; the bigger budget is headroom for thinking, not licence to ramble,
    // since the prompt still caps the answer at about forty words.
    output_config: { effort: 'low' },
    system,
    messages: [{ role: 'user', content: question }],
  });

  const answer = res.content
    .filter((b) => b.type === 'text')
    .map((b) => b.text)
    .join('\n')
    .trim();

  if (!answer) {
    // Better to fail loudly into the existing error path than to hand back an
    // empty string, which Discord rejects and Piper renders as silence.
    throw new Error(`Claude returned no text (stop_reason=${res.stop_reason})`);
  }

  log.info(`Claude ${Date.now() - started}ms: "${answer}"`);
  return answer;
}

module.exports = { ask };
