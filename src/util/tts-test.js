'use strict';

/**
 * Voice audition helper. Synthesizes a few representative D&D sentences so you
 * can compare Piper voices before committing to one.
 *
 * Usage:
 *   node src/util/tts-test.js
 *   node src/util/tts-test.js models/en_US-ryan-high.onnx
 *
 * Output lands in tmp/tts-test/. Listen, then set PIPER_VOICE in .env.
 */

const fs = require('fs');
const path = require('path');
const config = require('../config');
const { synthesize } = require('../pipeline/speak');

const OUT = path.join(config.paths.tmp, 'tts-test');

const SAMPLES = [
  'You get Advantage on the next attack roll against that creature.',
  'Weapon Mastery lets you use the Topple property, forcing a Constitution saving throw.',
  'No, an Opportunity Attack only triggers when a creature leaves your reach willingly.',
  'Roll two d six and add your Proficiency Bonus.',
  "I'm not certain about that one — check the Player's Handbook, chapter two.",
];

async function main() {
  const override = process.argv[2];
  if (override) process.env.PIPER_VOICE = override;

  fs.mkdirSync(OUT, { recursive: true });
  const label = path.basename(config.piper.voice, '.onnx');
  console.log(`Voice: ${label}\nWriting to ${OUT}\n`);

  for (let i = 0; i < SAMPLES.length; i++) {
    try {
      const wav = await synthesize(SAMPLES[i]);
      const dest = path.join(OUT, `${label}--${String(i + 1).padStart(2, '0')}.wav`);
      fs.renameSync(wav, dest);
      console.log(`  ok  ${SAMPLES[i].slice(0, 60)}...`);
    } catch (err) {
      console.error(`  FAIL ${err.message}`);
      break;
    }
  }

  console.log('\nRun again with a different .onnx path to compare voices.');
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
