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
 * @returns {Promise<string>} answer, 2-3 sentences of plain prose
 */
async function ask(question) {
  const started = Date.now();
  const res = await getClient().messages.create({
    model: config.anthropic.model,
    max_tokens: config.anthropic.maxTokens,
    system: getSystemPrompt(),
    messages: [{ role: 'user', content: question }],
  });

  const answer = res.content
    .filter((b) => b.type === 'text')
    .map((b) => b.text)
    .join('\n')
    .trim();

  log.info(`Claude ${Date.now() - started}ms: "${answer}"`);
  return answer;
}

module.exports = { ask };
