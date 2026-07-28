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

### 2. Discord application

1. https://discord.com/developers/applications → **New Application**
2. **Bot** tab → Reset Token → copy it
3. Enable **Server Members Intent** and **Message Content Intent**
4. **OAuth2 → URL Generator**: scopes `bot` + `applications.commands`;
   permissions **Connect**, **Speak**, **Send Messages**, **Use Slash Commands**
5. Open the generated URL, invite to your server
6. Copy the **Application ID** from the General Information tab

### 3. Environment

```powershell
copy .env.example .env
```

Fill in `DISCORD_TOKEN`, `DISCORD_CLIENT_ID`, `ANTHROPIC_API_KEY`,
`OPENAI_API_KEY`. Set `DISCORD_GUILD_ID` to your server's ID for instant
command updates while developing.

### 4. Register slash commands

```powershell
npm run register
```

### 5. Run it

```powershell
npm start
```

At this point `/ralf` works in text. The wake word and speech come next.

---

## Wake word (optional, adds hands-free)

The bot runs fine without this. `/ralf` covers every case; the wake word just
makes it hands-free mid-combat.

1. Sign up at https://console.picovoice.ai (free tier)
2. Copy your **AccessKey** → `PICOVOICE_ACCESS_KEY` in `.env`
3. Porcupine → **English** (the default model), type `Ralf`, test it with the
   mic button
   - Say it inside real sentences, not in isolation
   - Try *Rolf, Ralph, half* and normal chatter to check false triggers
4. Download the keyword for **Windows** → `models\ralf_windows.ppn`

No separate language model file is needed — English is built in.

Restart. The log should say `Wake word ready`. If files are missing it warns and
falls back to `/ralf` only — it never crashes over this.

Tune `WAKE_SENSITIVITY` in `.env` (0–1): higher catches more, false-triggers more.

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
  index.js              entry point, commands, session management
  config.js             all paths and tunables
  commands/register.js  slash command definitions
  voice/
    receiver.js         per-user streams, capture state machine
    resample.js         48k stereo -> 16k mono, WAV wrapping
    wakeword.js         Porcupine instance pool
  pipeline/
    transcribe.js       OpenAI STT
    ask.js              Claude + system prompt
    speak.js            respell -> Piper -> playback
  data/
    prompt.txt          system prompt (5e 2024)
  util/
    logger.js           logging + logs/qa.jsonl
    tts-test.js         Piper voice audition helper
```

Every Q&A pair is appended to `logs\qa.jsonl`. That's your eval set — when Ralf
gets a ruling wrong, the record is already there.

---

## Tunables

In `.env`, or `src/config.js` for the rest:

| Setting | Default | What it does |
|---|---|---|
| `WAKE_SENSITIVITY` | 0.6 | Higher = more detections and more false triggers |
| `capture.silenceMs` | 1500 | Silence before a question is considered finished |
| `capture.maxMs` | 20000 | Hard cap on one recording |
| `capture.minMs` | 700 | Shorter captures are discarded as false triggers |
| `wakeword.cooldownMs` | 8000 | Per-user pause after a trigger |
| `STT_MODEL` | gpt-4o-mini-transcribe | `gpt-4o-transcribe` is pricier and more accurate |
| `LOG_LEVEL` | info | Set `debug` while wiring up the wake word |

---

## Status

Scaffold written but **never executed** — no package has been installed or run
against it. Expect small fixes on first boot, particularly around Opus decoding
and the Piper spawn arguments.
