'use strict';

const fs = require('fs');
const path = require('path');

const LEVELS = { debug: 10, info: 20, warn: 30, error: 40 };
const threshold = LEVELS[process.env.LOG_LEVEL || 'info'] || LEVELS.info;

function stamp() {
  return new Date().toISOString().slice(11, 23);
}

function emit(level, msg) {
  if (LEVELS[level] < threshold) return;
  const line = `${stamp()} ${level.toUpperCase().padEnd(5)} ${msg}`;
  if (level === 'error') console.error(line);
  else console.log(line);
}

const log = {
  debug: (m) => emit('debug', m),
  info: (m) => emit('info', m),
  warn: (m) => emit('warn', m),
  error: (m) => emit('error', m),
};

/**
 * Append a Q&A pair to logs/qa.jsonl. This becomes your eval set — when Ralf
 * gets a ruling wrong, the record is already there.
 */
log.qa = (entry) => {
  try {
    const config = require('../config');
    fs.mkdirSync(path.dirname(config.paths.qaLog), { recursive: true });
    fs.appendFileSync(
      config.paths.qaLog,
      JSON.stringify({ ts: new Date().toISOString(), ...entry }) + '\n'
    );
  } catch (err) {
    emit('error', `Failed to write qa log: ${err.message}`);
  }
};

module.exports = log;
