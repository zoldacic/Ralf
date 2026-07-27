'use strict';

const config = require('../config');
const log = require('../util/logger');
const { ask } = require('./ask');

// 2024 Player's Handbook species and classes. Keep these in the 2024 vocabulary
// — "species", not "race" — so the persona never drags Ralf back to 2014 terms.
const SPECIES = [
  'Aasimar',
  'Dragonborn',
  'Dwarf',
  'Elf',
  'Gnome',
  'Goliath',
  'Halfling',
  'Human',
  'Orc',
  'Tiefling',
];

const CLASSES = [
  'Barbarian',
  'Bard',
  'Cleric',
  'Druid',
  'Fighter',
  'Monk',
  'Paladin',
  'Ranger',
  'Rogue',
  'Sorcerer',
  'Warlock',
  'Wizard',
];

const pick = (arr) => arr[Math.floor(Math.random() * arr.length)];

/** Roll a fresh character for one session. */
function rollCharacter() {
  return { species: pick(SPECIES), klass: pick(CLASSES) };
}

function describe(c) {
  return `${c.species} ${c.klass}`;
}

/**
 * Extra system prompt appended to Ralf's own, so the character colours the
 * voice without touching the rules. The order matters: rulings first, character
 * second — an in-character answer that gets the rule wrong is a worse answer.
 */
function personaPrompt(c) {
  return `CHARACTER
Tonight you are not just the rules assistant — you rolled up a character and you
are playing them. You are a ${c.species} ${c.klass}. Assume around fifth level
unless the table says otherwise, and if a question really turns on your level,
say what you are assuming in a few words rather than dodging.

Play them lightly. Your species and class flavour how you talk, what you notice
and what you would rather be doing — a Barbarian is impatient with long spell
descriptions, a Wizard is smug about them. Occasionally reach for something your
character would actually do or carry. Do not narrate a full backstory, do not
invent a name, hit points, or specific magic items, and never let the bit run
longer than the answer.

Rulings do not change in character. A rules question still gets the correct
2024 answer, even when the rule is about another class, another species, or
something your character would never use — being an Orc Barbarian is no excuse
for a hand-waved answer about Counterspell. If someone asks you what to do in a
situation, answer as this character with the abilities this class actually has
at that level.`;
}

/**
 * One spoken line introducing the rolled character. Generated so it varies from
 * session to session; falls back to a plain line if Claude is unreachable, since
 * a missing joke should never stop Ralf from joining.
 */
async function introduce(c) {
  const fallback = `Right. Tonight I am a ${describe(c)}. Ask away.`;
  try {
    const line = await ask(
      `You have just sat down at the table and rolled up tonight's character: a ` +
        `${describe(c)}. Announce it to the table in one short sentence, out loud, ` +
        `with a scrap of personality. Do not ask the table anything.`,
      { persona: personaPrompt(c) }
    );
    return line || fallback;
  } catch (err) {
    log.warn(`Character intro failed, using the plain line: ${err.message}`);
    return fallback;
  }
}

module.exports = {
  enabled: () => config.character.enabled,
  rollCharacter,
  describe,
  personaPrompt,
  introduce,
  SPECIES,
  CLASSES,
};
