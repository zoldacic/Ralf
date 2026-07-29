# Ralf

Discord voice bot answering D&D 5e (2024) rules questions by voice, in English.

Two ways to ask:

- **Say "Ralf"** in the voice channel, then your question
- **`/ralf <question>`** — skips speech recognition entirely

Both produce a spoken answer in the channel plus the text version in chat.

---

## Setup

Everything below needs a browser, an account, or a download — the parts nobody
can do for you.

### 1. Install dependencies

```powershell
cd C:\Code\Ralf
npm install
```

If `@discordjs/opus` tries to compile and fails, you need Visual Studio Build
Tools (C++ workload) + Python 3. Faster escape hatch:

```powershell
npm uninstall @discordjs/opus
npm install opusscript
```

`prism-media` picks up whichever is present. `opusscript` is pure JS and slower,
which does not matter at this scale.

### 2. Python environments

Speech-to-text and the wake word are local, so they need Python 3.14 alongside
Node. Two separate virtualenvs, deliberately:

```powershell
py -3.14 -m venv .venv
.venv\Scripts\python.exe -m pip install -r requirements.txt
```

That is everything the bot needs to hear you. The Whisper weights are not in the
repo — `faster-whisper` downloads them on first use and caches them.

The second environment is only for the illustrated recap. torch is a ~3 GB tree
and must not share an environment with the wake word and Whisper, which have to
keep working:

```powershell
py -3.14 -m venv .venv-sd
.venv-sd\Scripts\python.exe -m pip install -r requirements-sd.txt
```

`requirements-sd.txt` pulls torch from the cu126 index, and that is not a
detail you can skip: this box's GTX 1050 Ti is Pascal (sm_61) and CUDA 13
dropped Pascal, so a cu128 or later build will not run. After any torch change:

```powershell
.venv-sd\Scripts\python.exe -c "import torch; print('sm_61' in torch.cuda.get_arch_list())"
```

Skip this second environment entirely and set `ILLUSTRATE=false` for text-only
recaps. Point `WHISPER_PYTHON` / `SD_PYTHON` elsewhere if your interpreters live
somewhere other than these paths.

### 3. Discord application

1. https://discord.com/developers/applications → **New Application**
2. **Bot** tab → Reset Token → copy it
3. Enable **Server Members Intent** and **Message Content Intent**
4. **OAuth2 → URL Generator**: scopes `bot` + `applications.commands`;
   permissions **Connect**, **Speak**, **Send Messages**, **Use Slash Commands**
5. Open the generated URL, invite to your server
6. Copy the **Application ID** from the General Information tab

### 4. Environment

```powershell
copy .env.example .env
```

Fill in `DISCORD_TOKEN`, `DISCORD_CLIENT_ID` and `ANTHROPIC_API_KEY` — the LLM
is the only hosted piece, so it's the only key. Set `DISCORD_GUILD_ID` to your
server's ID for instant command updates while developing.

### 5. Register slash commands

```powershell
npm run register
```

### 6. Run it

```powershell
npm start
```

At this point `/ralf` works in text. The wake word and speech come next.

---

## Wake word

No account, no key, no download beyond the Python environment the rest of STT
already needs. Every finished speech segment runs through a `tiny.en` Whisper,
and a leading "Ralf" opens a question — the name is matched in the transcript,
not heard by an acoustic model.

That is not what the build plan said. Porcupine wanted an account, so
openWakeWord replaced it; the model trained for it scored 0.99 on Piper's
synthetic speech and 0.002 on this table's actual voices saying the same words,
and no threshold rescues 0.002. The acoustic path still exists behind
`WAKEWORD_ENABLED=true` for if `models\ralf.onnx` is ever retrained on real
speech.

The trade is latency: a transcript only exists once you stop talking, so the
trigger lands about a second later than an acoustic model's would. `ACK_PHRASE`
is spoken the instant you're heard so the wait is not silent.

The gate's `initial_prompt` is load-bearing and fragile in both directions — one
natural sentence naming Ralf once caught 6 of 6 real wake words, no prompt
caught 1 of 6, and priming with the wake phrase itself sends the decoder into a
repetition loop. The numbers and the reasoning are in `src/config.js`; re-measure
against `recordings\` before touching it.

Set `WAKE_GATE=false` to turn the whole thing off and run `/ralf`-only. If the
gate can't start it warns and falls back to exactly that — it never crashes over
this.

---

## Text to speech

1. Download the Windows Piper release (`piper_windows_amd64.zip`) from
   https://github.com/rhasspy/piper/releases → extract to `bin\piper\`
   (you should end up with `bin\piper\piper.exe`)
2. Download an English voice — both the `.onnx` and `.onnx.json` — into
   `models\`. Samples: https://rhasspy.github.io/piper-samples/

   Ralf is voiced male, so pick a masculine voice:
   - `en_GB-alan-medium` (default) — Southern English, dry
   - `en_GB-northern_english_male-medium`
   - `en_US-ryan-high` — best quality, slower
   - `en_US-joe-medium`, `en_US-lessac-medium` — American
3. Set `PIPER_VOICE` in `.env` if you pick something else

Audition voices on real D&D sentences before committing:

```powershell
node src/util/tts-test.js
node src/util/tts-test.js models/en_US-ryan-high.onnx
```

---

## Layout

```
src/
  index.js              entry point, commands, handleQuestion()
  config.js             all paths and tunables
  commands/register.js  slash command definitions
  voice/
    receiver.js         per-user streams, capture state machine
    resample.js         48k stereo -> 16k mono, WAV wrapping
    wakegate.js         tiny.en transcript gate — the live wake word
    wakeword.js         openWakeWord, off unless WAKEWORD_ENABLED=true
    oww_sidecar.py      its Python half
  pipeline/
    whisper_sidecar.py  local faster-whisper, one process per model
    transcribe.js       question STT + stripWakeWord()
    ask.js              Claude + system prompt
    character.js        the rolled species/class Ralf answers as
    speak.js            Piper -> playback
    summarize.js        /ralf-summary: batch STT over recordings/ -> recap
    illustrate.js       scene planning -> Stable Diffusion
    image_sidecar.py    its Python half (separate .venv-sd)
    pdf.js              recap + images -> the posted PDF
  data/
    prompt.txt          system prompt (5e 2024)
    summary-prompt.txt  session recap prompt
    scene-prompt.txt    scene planning for the illustrations
  util/
    logger.js           logging + logs/qa.jsonl
    tts-test.js         Piper voice audition helper
```

Both trigger paths funnel into the same `handleQuestion()` in `index.js` so they
can't drift apart. Commands: `/ralf`, `/ralf-join`, `/ralf-leave`,
`/ralf-summary`.

Every Q&A pair is appended to `logs\qa.jsonl`. That's your eval set — when Ralf
gets a ruling wrong, the record is already there.

---

## Tunables

In `.env`, or `src/config.js` for the rest:

| Setting | Default | What it does |
|---|---|---|
| `WAKE_GATE` | true | `false` disables the wake word, leaving `/ralf` only |
| `GATE_WHISPER_MODEL` | tiny.en | Gate model; `base.en` or `small.en` if the name is misheard |
| `GATE_MAX_MS` | 10000 | Segments longer than this are not screened for the name |
| `GATE_MIN_RMS` | 500 | Segments quieter than this are treated as silence |
| `WHISPER_MODEL` | small | Question STT size; `medium` reads proper nouns better, slower |
| `capture.silenceMs` | 1500 | Silence before a question is considered finished |
| `capture.maxMs` | 12000 | Hard cap on one recording |
| `capture.minMs` | 700 | Shorter captures are discarded as false triggers |
| `ACK_PHRASE` | Right... | Spoken the moment you're heard, covering STT latency. Empty to disable |
| `CHARACTER_ENABLED` | true | Roll a species and class on join and answer in character |
| `SESSION_RECORD` | true | Record segments to `recordings\` for `/ralf-summary` |
| `ILLUSTRATE` | true | Draw the recap with local Stable Diffusion; `false` for text-only |
| `LOG_LEVEL` | info | Set `debug` while working on the wake gate |

`src/config.js` is the full list, and every entry there carries a note on why
the number is what it is.

---

## Status

Running software. Everything through Phase 6 of the build plan — voice receive,
wake word, transcription, Claude, spoken answers — has been exercised against
real Discord audio at a real table. Phase 7 (process supervision, cooldowns) is
where the remaining work is.

Two subsystems ended up somewhere other than the plan, and this README describes
where they landed, not where they were headed: the wake word is a transcript
gate rather than an acoustic model, and speech-to-text is local rather than
hosted.
