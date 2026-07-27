# CLAUDE.md

Context for Claude Code working in this repo.

## What this is

**Ralf** — a Discord voice bot that answers D&D 5e (2024 ruleset) rules questions
by voice, in English. Runs on Windows at `C:\Code\Ralf`.

Two trigger paths, both funnelling into the same `handleQuestion()` in
`src/index.js` so they can't drift apart:

1. Spoken wake word "Ralf" → segment → tiny Whisper gate → Whisper STT → Claude → Piper TTS
2. `/ralf <question>` slash command → Claude → Piper TTS (skips STT entirely)

**Hosted:** the LLM (Anthropic). Nothing else.
**Local:** the bot process, wake word, speech-to-text (faster-whisper), text-to-speech (Piper).

## Critical status

Running software, not a scaffold — everything through Phase 6 has been exercised
against real Discord audio. The build-order table below is kept for the test each
phase had to pass, not as a to-do list.

Two subsystems drifted from the original plan and the sections below are written
against the current code, not the plan:

- **Wake word is transcription, not acoustics.** openWakeWord replaced Porcupine
  (no account), and then a *trained* `models/ralf.onnx` turned out to score 0.99
  on Piper's synthetic speech and 0.002 on this table's real voices saying the
  same words. So `src/voice/wakegate.js` now runs every finished speech segment
  through a `tiny.en` Whisper and fires on a leading "Ralf". The openWakeWord
  path still exists behind `WAKEWORD_ENABLED=true`, for if the model is ever
  retrained on real speech.
- **STT is local.** faster-whisper via `src/pipeline/whisper_sidecar.py`, not
  OpenAI. Two sidecars run: `medium.en` for questions, `tiny.en` for the gate,
  plus a third multilingual one on demand for Swedish session summaries.

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

## What Claude Code cannot do here

These need a browser, an account, or a human decision. Ask the user; don't try
to work around them:

- Creating the Discord application and copying the bot token
- Obtaining the Anthropic API key
- Downloading the Piper Windows binary and an English voice model
- Choosing which Piper voice sounds right
- Speaking into a microphone. Recall of the wake word can only be measured live;
  every offline check needs a clip of a real person saying it, and the only
  source of those is `recordings/`.

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
- Spawn Piper with `cwd` set to its own directory. It resolves espeak-ng data
  relative to the working directory and fails confusingly otherwise.
- Discord sends 48 kHz stereo; Whisper wants 16 kHz mono. `src/voice/resample.js`
  handles this, and the receiver emits segments already in that format — which is
  why `recordings/*.wav` can be replayed through the gate offline byte for byte.
- **The gate's `initial_prompt` is load-bearing and fragile in both directions.**
  Without one, `tiny.en` caught 1 of 6 real wake words — it has no reason to
  think "Ralf" is a word and reaches for Ron, Raul, "you're out". With one
  natural sentence naming Ralf once, 6 of 6 and no false positives. But priming
  with the bare word hallucinates it into silence, and priming with the wake
  phrase repeated ("Hey Ralf. Yo Ralf.") sends it into a repetition loop — 55
  copies out of a 2.5 s clip, 14 s to decode. Re-measure before changing it;
  `recordings/` has the clips.
- `stripWakeWord()` in `pipeline/transcribe.js` and `NAME` in `voice/wakegate.js`
  must stay in step: anything that can open the gate has to be strippable, or the
  wake word ends up inside the question sent to Claude.
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
