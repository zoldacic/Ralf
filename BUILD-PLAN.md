# Ralf — Discord D&D Voice Bot

A Discord bot that listens in a voice channel, wakes on the word **"Ralf"**, and answers
D&D 5e (2024) rules questions by voice, in English.

---

## 1. Architecture

```
Discord voice channel
  │
  ├─ @discordjs/voice receiver  ──► per-user Opus stream
  │
  ├─ prism-media decode          ──► 48 kHz stereo PCM
  ├─ downmix + resample          ──► 16 kHz mono Int16
  │
  ├─ Porcupine (LOCAL)           ──► wake word "Ralf" detected?
  │        │
  │        └─ no ──► discard frame, continue
  │        └─ yes ─┐
  │                ▼
  ├─ capture until 1.5 s silence (20 s cap) ──► WAV
  │
  ├─ OpenAI transcription API (HOSTED)  language: "en"  ──► text
  │                                                          │
  │   /ralf <question> slash command ──────────────────────► ┤  (skips STT)
  │                                                          ▼
  ├─ Anthropic API (HOSTED)  5e 2024 system prompt     ──► answer
  │
  ├─ Piper (LOCAL)  English voice                      ──► WAV
  │
  └─ createAudioResource ──► played back into the channel
                          └─ original answer text ──► posted to text channel
```

**Hosted:** speech-to-text, Claude.
**Local:** bot process, wake word, text-to-speech.

---

## 2. Stack

| Layer | Choice | Notes |
|---|---|---|
| Runtime | Node 20+ | `@discordjs/voice` has the best-documented voice receive |
| Discord | `discord.js`, `@discordjs/voice`, `@discordjs/opus` | |
| Audio | `prism-media`, `ffmpeg-static` | Opus decode + resample |
| Wake word | Picovoice Porcupine (`@picovoice/porcupine-node`) | Train "Ralf" on the **English** model — natively supported |
| STT | OpenAI transcription API | `language: "en"`, D&D vocabulary in `prompt` |
| LLM | Anthropic API | 5e 2024 system prompt |
| TTS | Piper, `en_GB-alba-medium` | CPU-only, no VRAM, wide voice choice |
| Process mgmt | `pm2` or `systemd` | auto-restart |

**Secrets (`.env`):** `DISCORD_TOKEN`, `DISCORD_CLIENT_ID`, `ANTHROPIC_API_KEY`,
`OPENAI_API_KEY`, `PICOVOICE_ACCESS_KEY`

---

## 3. Cost

Only post-wake audio ever leaves the machine, so STT volume is tiny.

- **STT:** ~15 s per question. 200 questions ≈ 50 min ≈ **$0.30**.
- **Claude:** pennies, if answers stay at 2–3 sentences.
- **TTS:** **$0** (local).
- **Hosting:** $0 on your own machine; ~€5/mo if you move it to a VPS later.

New OpenAI accounts get $5 free credit, which covers this for a very long time.

---

## 4. Build phases

Each phase has a **done when** test. Don't move on until it passes.

### Phase 0 — Two trigger paths

Ralf gets **two ways in**, and they share everything downstream of the trigger:

| Trigger | Path | Use |
|---|---|---|
| Spoken "Ralf" | wake word → capture → STT → Claude | hands-free, mid-combat |
| `/ralf <question>` | text straight to Claude, skips STT entirely | noisy table, long or precise questions, DM lookups |

The slash command is the **guaranteed** path — it has no language, accent, or
false-trigger risk, and it costs nothing to run. Build it first so you always have a
working bot, then treat the wake word as the upgrade.

**Validate the wake word (no code):** sign in to the Picovoice Console, select the
**English** model (the default), type `Ralf`, and test with the in-browser mic. Say it
inside real sentences; say similar words (*Rolf, Ralph, half*) to check false triggers.

English is Porcupine's natively supported case, so this should just work — no separate
language model file needed. If it doesn't, ship `/ralf` alone. It's a real product.

**Done when:** you have a `.ppn` file that reliably fires on your own voice and doesn't
fire on ordinary table talk. The Console test works from a phone browser.

Design note: `/ralf` should still **speak** its answer into the voice channel, not just
reply in text — otherwise you've got two bots with different behaviour. Same output
path, different input.

### Phase 1 — Bot skeleton + `/ralf`

Register the bot, invite it with voice permissions, add three slash commands:

- `/ralf-join` / `/ralf-leave` — voice channel management
- `/ralf <question>` — one required string option, the question

Wire `/ralf` to a stub that echoes the question back. It becomes the real thing once
Phase 5 lands.

**Done when:** the bot joins and leaves on command, and `/ralf what is advantage` echoes
your question back in the channel.

### Phase 2 — Voice receive

Subscribe to per-user streams via `connection.receiver`. Decode Opus, write a WAV to
`/tmp`.

**Done when:** you can play back a file of yourself talking and hear it clearly.

### Phase 3 — Wake word wiring  ← riskiest step

Insert the resample stage (48 kHz stereo → 16 kHz mono Int16), chunk into frames of
`porcupine.frameLength`, feed `porcupine.process()`. Log `"detected"` to console.

Details that matter:

- **One detector instance per speaker.** Create lazily on `speaking.start`, release on
  disconnect, or you leak handles across a 4-hour session.
- **Ring buffer** the last ~1 s so a fast "Ralf, vad händer om…" doesn't lose its head.
- **Cooldown** 5–10 s after each trigger so one utterance doesn't fire twice.

**Done when:** saying "Ralf" logs a detection; a normal 10-minute conversation logs zero.

### Phase 4 — Transcription

On detection, capture until 1.5 s of silence (hard cap 20 s), POST the WAV with
`language: "en"` and a `prompt` seeded with D&D vocabulary. Log the transcript.

**Done when:** D&D questions with real table vocabulary transcribe accurately. Proper
nouns and spell names are where it slips — check those specifically.

### Phase 5 — Claude

Send transcript + system prompt (below). Log the answer.

**Done when:** answers are correct 2024 rules, two to three sentences of plain prose
with no markdown, and it says it's unsure rather than inventing a ruling.

### Phase 6 — Speech

Pipe each sentence into Piper, play the resulting WAV through `createAudioResource`.
Post the text answer to the channel too.

```bash
echo "text" | piper --model en_GB-alba-medium.onnx --output_file out.wav
```

Split the answer on sentence boundaries and queue each — first audio starts while the
rest is still synthesizing.

**Done when:** you ask a question out loud and hear a correct spoken answer.

### Phase 7 — Harden

- `pm2` / `systemd` for auto-restart
- Per-user cooldown and a max recording length
- Error paths: STT fails, Claude times out, Piper crashes → say something in channel
  rather than going silent
- Log every Q&A pair to a file; it's your eval set

### Phase 8 — Later

- **Retrieval over the 2024 SRD** — the single biggest accuracy win
- **VPS deploy** (Hetzner, ~€5/mo) if the bot needs to be up when your machine isn't

---

## 5. System prompt (draft)

```
You are Ralf, a rules assistant sitting at a D&D table.

RULESET: Answer according to D&D 5e, 2024 rulebooks (Player's Handbook 2024)
— NOT the 2014 rules. If a rule changed between editions, give the 2024
version. Watch especially: Weapon Mastery, Grapple and Unarmed Strike, Bardic
Inspiration, species instead of race, Surprise and Exhaustion.

FORMAT: Two to three sentences maximum. Read aloud by a speech synthesiser,
so write flowing prose — no bullets, tables, parentheses or asterisks. Write
dice as spoken: "two d six", not "2d6".

UNCERTAINTY: If unsure, say so and point to the book rather than guessing. A
confident wrong ruling mid-combat is worse than no answer. Never invent rules
or page references.
```

Live version: `src/data/prompt.txt`.

---

## 6. Voice selection

Piper has a wide English voice catalogue, so this is a taste decision rather than a
technical constraint. Candidates:

| Voice | Character |
|---|---|
| `en_GB-alba-medium` | Scottish, warm — the default here |
| `en_GB-northern_english_male-medium` | Northern English |
| `en_US-lessac-medium` | Most neutral, clearest diction |
| `en_US-ryan-high` | Best quality, slower to synthesize |

Audition them on real D&D sentences rather than isolated words:

```powershell
node src/util/tts-test.js
node src/util/tts-test.js models/en_US-ryan-high.onnx
```

Ralf's voice is the most opinionated choice in the whole project — worth ten minutes.

---

## 7. Known gotchas

1. **2014 vs 2024 rule blending** is now the top accuracy risk. The editions overlap
   heavily but differ exactly where people ask questions. Prompt hard, and add
   retrieval in Phase 8.
2. **Whisper spells the name inconsistently** (*Ralf / Ralph / Rolf*). `stripWakeWord`
   matches loosely — extend the list if you see new variants in the logs.
3. **Long answers are painful as audio.** Enforce brevity in the prompt, not in
   post-processing.
4. **Markdown leaks into speech.** If Claude emits asterisks or bullet points they get
   read aloud literally. Tighten the prompt; strip as a last resort.
5. **Wake word false triggers** in a loud room. Tune `WAKE_SENSITIVITY` down before
   assuming the model is bad.

---

## 8. Project layout

Everything lives under `C:\Code\Ralf`.

```
C:\Code\Ralf\
├── .env                       # secrets — gitignore this
├── .gitignore
├── package.json
├── CLAUDE.md                  # project context for Claude Code
├── src\
│   ├── index.js               # entry point, commands, session management
│   ├── commands\
│   │   └── register.js        # slash command definitions
│   ├── voice\
│   │   ├── receiver.js        # per-user stream subscription
│   │   ├── resample.js        # 48k stereo → 16k mono Int16
│   │   └── wakeword.js        # Porcupine instance pool
│   ├── pipeline\
│   │   ├── transcribe.js      # OpenAI STT
│   │   ├── ask.js             # Anthropic call + system prompt
│   │   └── speak.js           # Piper → AudioResource
│   ├── data\
│   │   └── prompt.txt         # system prompt
│   └── util\
│       ├── logger.js          # logging + qa.jsonl
│       └── tts-test.js        # voice audition helper
├── models\
│   ├── ralf_windows.ppn       # Porcupine keyword (English model)
│   ├── en_GB-alba-medium.onnx
│   └── en_GB-alba-medium.onnx.json
├── bin\
│   └── piper\                 # piper.exe + dlls
├── logs\
│   └── qa.jsonl               # every Q&A pair — your eval set
└── tmp\                       # scratch WAVs, gitignored
```

`.gitignore` at minimum: `.env`, `node_modules/`, `tmp/`, `logs/`, `models/`
(model files are large and re-downloadable).

---

## 9. Windows notes

The stack all runs on Windows, but three things differ from the Linux default:

1. **`@discordjs/opus` is a native module.** Prebuilt binaries usually cover Windows
   x64, but if `npm install` tries to compile you'll need Visual Studio Build Tools
   (C++ workload) and Python 3. Faster escape hatch: use `opusscript` instead — pure
   JS, slower, fine at this scale.
2. **Piper ships a Windows build.** Grab `piper_windows_amd64.zip` from the releases
   page into `bin\piper\`. Invoke `piper.exe`, and spawn it with an explicit `cwd` —
   it resolves its espeak-ng data relative to the working directory and fails
   confusingly otherwise.
3. **No systemd.** Use `pm2` plus `pm2-windows-startup`, or NSSM to run it as a
   service. Or just leave it in a terminal while you're developing — you don't need
   auto-restart until Phase 7.

Use `path.join(__dirname, ...)` throughout rather than hardcoded separators, so nothing
breaks if you later move the bot to a Linux VPS.

---

## 10. Open questions

- Which Piper voice? See section 6 — audition before committing.
- Should Ralf answer only the person who said "Ralf", or anyone for the next 30 s?
- Do you want a private mode for the DM (ephemeral text-only rulings)?
- Retrieval over the 2024 SRD — worth doing once you have a week of `qa.jsonl` showing
  where it actually gets things wrong.
