# CLAUDE.md

Context for Claude Code working in this repo.

## What this is

**Ralf** — a Discord voice bot that answers D&D 5e (2024 ruleset) rules questions
by voice, in English. Runs on Windows at `C:\Code\Ralf`.

Two trigger paths, both funnelling into the same `handleQuestion()` in
`src/index.js` so they can't drift apart:

1. Spoken wake word "Ralf" → local Porcupine detection → capture → OpenAI STT → Claude → Piper TTS
2. `/ralf <question>` slash command → Claude → Piper TTS (skips STT entirely)

**Hosted:** speech-to-text (OpenAI), the LLM (Anthropic).
**Local:** the bot process, wake word detection (Porcupine), text-to-speech (Piper).

## Critical status

**This scaffold has never been executed.** No package has been installed, nothing
has been run against it. Only pure logic has been unit-tested: the resampler,
WAV header construction, and the phonetic respell matcher. Everything touching
Discord, Porcupine, OpenAI, Anthropic, or Piper is unverified.

Expect first-boot fixes, most likely in:

- Opus decoding (`@discordjs/opus` native build on Windows)
- Piper's exact CLI flags and working-directory behaviour
- `@discordjs/voice` receiver lifecycle under `EndBehaviorType.Manual`

Treat the code as a well-formed starting point, not as working software.

## Build order

Each phase has a test that must pass before moving on. Do not skip ahead —
later phases are hard to debug if an earlier one is subtly broken.

| Phase | Goal | Done when |
|---|---|---|
| 1 | `npm install`, Discord app, `/ralf` works | `/ralf vad är weapon mastery` returns a text answer |
| 2 | Voice receive | A WAV of the user's speech lands in `tmp/` and plays back clearly |
| 3 | Wake word (**riskiest**) | Saying "Ralf" logs a detection; 10 min of chatter logs zero |
| 4 | Transcription | D&D questions transcribe accurately, including proper nouns |
| 5 | Claude | Correct 2024 rules, two to three sentences, no markdown |
| 6 | Piper TTS | Spoken answer plays in the voice channel |
| 7 | Hardening | pm2/NSSM, error paths, cooldowns |
| 8 | Later | Retrieval over the 2024 SRD; optional VPS deploy |

**Phase 1 needs neither Picovoice nor Piper.** Get `/ralf` working end to end
before touching audio — it isolates every later failure to one subsystem.

## What Claude Code cannot do here

These need a browser, an account, or a human decision. Ask the user; don't try
to work around them:

- Creating the Discord application and copying the bot token
- Obtaining Anthropic / OpenAI / Picovoice API keys
- Training the "Ralf" keyword in the Picovoice Console and downloading the
  `.ppn` (must be the **Windows** build; English is the default model)
- Downloading the Piper Windows binary and an English voice model
- Choosing which Piper voice sounds right

## Conventions

- CommonJS, Node 20+. Not ESM.
- All paths go through `src/config.js` and `path.join` — never hardcode
  separators. The bot may move to a Linux VPS later.
- Config lives in `src/config.js`; secrets in `.env` (gitignored, never commit).
- Failures degrade rather than crash. If the wake word can't initialise, log a
  warning and run `/ralf`-only. Apply that pattern to anything new.

## Domain rules that matter

- **The ruleset is D&D 5e 2024, not 2014.** The system prompt in
  `src/data/prompt.txt` enforces this. Don't loosen it.
- **Answers stay 2–3 sentences, in plain prose.** They're read aloud, so no
  markdown, no bullet points, no parentheses. Dice are written as spoken
  ("two d six", not "2d6").
- The pipeline is English end to end. An earlier revision was Swedish with
  English rules terms and a phonetic respell table; that has been removed.

## Gotchas

- `selfDeaf: false` is required in `joinVoiceChannel` or no audio is received.
- Porcupine instances are stateful and single-stream — one per speaker, released
  on disconnect. `src/voice/wakeword.js` pools them; don't share one instance.
- Spawn Piper with `cwd` set to its own directory. It resolves espeak-ng data
  relative to the working directory and fails confusingly otherwise.
- Discord sends 48 kHz stereo; Porcupine and Whisper both want 16 kHz mono.
  `src/voice/resample.js` handles this. Frame length comes from
  `porcupine.frameLength` — don't hardcode 512.
- `config.wakeword.modelPath` is null for English — Porcupine uses its built-in
  model and the constructor takes three arguments, not four.
- If `@discordjs/opus` won't build, swap to `opusscript`. `prism-media` picks up
  whichever is installed.

## Useful commands

```powershell
npm install
npm run register          # register slash commands (set DISCORD_GUILD_ID for instant updates)
npm start
node src/util/tts-test.js # audition Piper voices on sample D&D sentences
```

Set `LOG_LEVEL=debug` in `.env` while working on Phase 3.

## Logs

Every Q&A pair is appended to `logs/qa.jsonl` with the trigger source. That's the
eval set — when Ralf gets a ruling wrong, the record is already there. Keep this
working; don't remove it while refactoring.
