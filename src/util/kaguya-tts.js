'use strict';

/**
 * Swedish narration for the Kaguya animation. Synthesizes the ten narration
 * lines, in order, as n0.wav … n9.wav with the given Piper voice.
 *
 * Usage:
 *   node src/util/kaguya-tts.js models/sv_SE-nst-medium.onnx
 *
 * Output lands in tmp/kaguya/<voice name>/. Run once per voice to compare.
 */

const fs = require('fs');
const path = require('path');

// Same trick as tts-test.js: pick the voice before ../config is required,
// because config resolves PIPER_VOICE eagerly.
if (process.argv[2]) process.env.PIPER_VOICE = process.argv[2];

const config = require('../config');
const { synthesize } = require('../pipeline/speak');

const LINES = [
  'Det är år 2030. Iroha är på väg hem, sent en kväll. Då ser hon något konstigt. En stolpe som lyser! Och där inne ligger en liten bebis.',
  'Sen går allt väldigt fort. Bara några dagar senare är bebisen lika gammal som Iroha. Hon säger att hon kommer från månen. Så hon får heta Kaguya.',
  'Iroha visar henne Tsukuyomi, en virtuell värld. Där ställer de upp i Yachiyo Cup, en tävling för streamare. Kaguya blir en stjärna direkt. Och då vill toppgruppen Black Onyx utmana dem.',
  'De vinner! Och de får uppträda tillsammans med Yachiyo. Men sen händer något läskigt. Varelser från månen anfaller. De vill ta hem Kaguya. Och de lovar att komma tillbaka, vid nästa fullmåne.',
  'Och fullmånen kommer. Kaguya håller en sista konsert. Iroha och vännerna kämpar allt de kan. Men det räcker inte. Kaguya förs bort.',
  'Men Iroha ger inte upp. Hon gör klart låten som hon och pappa aldrig hann skriva färdigt. Och hon sjunger den. Sen loggar hon in igen. Då berättar Yachiyo sanningen. Hon är Kaguya. Fast från framtiden.',
  'Nu backar vi lite. Det här är tillbakablicken. Kaguya hör Irohas låt, och hon bestämmer sig. Hon ska resa tillbaka i tiden och hitta henne igen.',
  'Men då, pang! Skeppet krockar med en asteroid. Kaguya kastas åtta tusen år bakåt i tiden, och skeppet går sönder. Bara hennes husdjur Inudoge finns kvar hos henne. Och med tiden blir Inudoge till Fushi.',
  'Tusentals år senare skapas Tsukuyomi. Då laddas Kaguya upp i en avatar. Och det är så hon blir Yachiyo. Hon har alltså funnits där, hela tiden.',
  'Tio år senare har Iroha byggt en robotkropp åt Yachiyo. Och äntligen kan Kaguya leva i den riktiga världen, tillsammans med Iroha. Ett lyckligt slut. Precis som hon ville.',
];

async function main() {
  const label = path.basename(config.piper.voice, '.onnx');
  const out = path.join(config.paths.tmp, 'kaguya', label);
  fs.mkdirSync(out, { recursive: true });
  console.log(`Voice: ${label}\nWriting to ${out}\n`);

  let failed = 0;
  for (let i = 0; i < LINES.length; i++) {
    try {
      const wav = await synthesize(LINES[i]);
      fs.renameSync(wav, path.join(out, `n${i}.wav`));
      console.log(`  ok  n${i}  ${LINES[i].slice(0, 50)}...`);
    } catch (err) {
      failed++;
      console.error(`  FAIL n${i}  ${err.message}`);
    }
  }

  if (failed) process.exitCode = 1;
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
