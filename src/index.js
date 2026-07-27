'use strict';

const fs = require('fs');
const path = require('path');
const {
  Client,
  GatewayIntentBits,
  MessageFlags,
} = require('discord.js');
const {
  joinVoiceChannel,
  createAudioPlayer,
  entersState,
  VoiceConnectionStatus,
  NoSubscriberBehavior,
} = require('@discordjs/voice');

const config = require('./config');
const log = require('./util/logger');
const wakeword = require('./voice/wakeword');
const { VoiceListener } = require('./voice/receiver');
const { transcribe, stripWakeWord, _client: whisper } = require('./pipeline/transcribe');
const { ask } = require('./pipeline/ask');
const { speak, prepareAck, playAck } = require('./pipeline/speak');
const character = require('./pipeline/character');
const {
  startSession,
  latestSession,
  saveSegment,
  readManifest,
  summarizeSession,
} = require('./pipeline/summarize');

const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildVoiceStates,
    GatewayIntentBits.GuildMessages,
  ],
});

/** guildId -> { connection, player, listener, textChannel } */
const sessions = new Map();

// ---------------------------------------------------------------- pipeline

/**
 * The single shared path: question in, spoken + written answer out.
 * Both the wake word and /ralf funnel through here, so they can't drift apart.
 */
async function handleQuestion({ guildId, question, source, userId }) {
  const session = sessions.get(guildId);
  if (!question) return null;

  let answer;
  try {
    answer = await ask(question, { persona: session?.persona });
  } catch (err) {
    log.error(`Claude failed: ${err.message}`);
    if (session?.textChannel) {
      await session.textChannel.send('Ralf could not answer just now. Try again.');
    }
    return null;
  }

  log.qa({ guildId, userId, source, question, answer });

  if (session?.textChannel) {
    await session.textChannel.send(`**Ralf:** ${answer}`).catch(() => {});
  }

  if (session?.player) {
    try {
      await speak(session.player, answer);
    } catch (err) {
      log.error(`TTS failed: ${err.message}`);
    }
  }

  return answer;
}

// ---------------------------------------------------------------- voice

async function joinChannel(interaction) {
  const channel = interaction.member?.voice?.channel;
  if (!channel) {
    return interaction.reply({
      content: 'You need to be in a voice channel first.',
      flags: MessageFlags.Ephemeral,
    });
  }

  await interaction.deferReply();
  leaveChannel(interaction.guildId);

  const connection = joinVoiceChannel({
    channelId: channel.id,
    guildId: interaction.guildId,
    adapterCreator: interaction.guild.voiceAdapterCreator,
    selfDeaf: false, // must be false to receive audio
    // NOTE: daveEncryption defaults to true and must stay that way — turning
    // DAVE off stopped the voice handshake reaching Ready at all. The decrypt
    // errors it can throw are handled per-stream in receiver.js instead.
  });

  try {
    await entersState(connection, VoiceConnectionStatus.Ready, 20_000);
  } catch (err) {
    // The stuck state says where the handshake stalled (Signalling = no voice
    // server answer, Connecting = UDP/encryption trouble).
    log.error(
      `Voice connect failed for ${channel.name} ` +
        `(state=${connection.state?.status}): ${err.message}`
    );
    connection.destroy();
    return interaction.editReply('Could not connect to the voice channel.');
  }

  const player = createAudioPlayer({
    behaviors: { noSubscriber: NoSubscriberBehavior.Pause },
  });
  connection.subscribe(player);

  // Roll tonight's character before anything else needs it, so the intro line
  // is already being written while the receiver is wired up.
  const rolled = character.enabled() ? character.rollCharacter() : null;
  const persona = rolled ? character.personaPrompt(rolled) : null;
  const intro = rolled ? character.introduce(rolled) : Promise.resolve(null);

  const recordDir = config.session.record ? startSession(interaction.guildId) : null;

  const listener = new VoiceListener(connection, {
    captureTest: config.capture.testMode,
    record: Boolean(recordDir),
  });
  const textChannel = interaction.channel;

  // Every speech segment goes to disk, wake word or not. Deliberately just a
  // file write — transcription happens later via /ralf-summary.
  if (recordDir) {
    listener.on('speech', ({ userId, wav, durationMs, startedAt }) => {
      try {
        const member = channel.guild.members.cache.get(userId);
        saveSegment(recordDir, {
          userId,
          speaker: member?.displayName || member?.user?.username || userId,
          wav,
          durationMs,
          startedAt,
        });
      } catch (err) {
        log.error(`Failed to save segment: ${err.message}`);
      }
    });
  }
  listener.on('utterance', async ({ userId, wav, durationMs }) => {
    // Phase 2 debug path: save the clip so you can play it back, don't transcribe.
    if (config.capture.testMode) {
      try {
        fs.mkdirSync(config.paths.tmp, { recursive: true });
        const file = path.join(config.paths.tmp, `capture-${userId}-${Date.now()}.wav`);
        fs.writeFileSync(file, wav);
        log.info(`Saved ${durationMs}ms capture to ${file}`);
        await textChannel
          ?.send(`Captured ${durationMs} ms of audio — saved to \`${file}\``)
          .catch(() => {});
      } catch (err) {
        log.error(`Capture save failed: ${err.message}`);
      }
      return;
    }

    // Instant ack: the user was heard. Plays while STT + Claude run (~13 s),
    // so the channel isn't silent. Fire-and-forget; never blocks the pipeline.
    playAck(player);

    try {
      const raw = await transcribe(wav);
      const question = stripWakeWord(raw);
      if (!question) {
        log.debug('Empty transcript after wake word — ignoring');
        return;
      }
      await handleQuestion({
        guildId: interaction.guildId,
        question,
        source: 'wakeword',
        userId,
      });
    } catch (err) {
      log.error(`Utterance pipeline failed: ${err.message}`);
    }
  });

  sessions.set(interaction.guildId, {
    connection,
    player,
    listener,
    persona,
    character: rolled,
    textChannel: interaction.channel,
  });

  // Self-heal when Discord drops or migrates the voice connection. Without this
  // the receiver goes silently deaf — the process stays up but stops hearing
  // anyone ("stopped listening"). The initial Ready was already consumed above,
  // so any Ready we see here is a genuine reconnect.
  const guildId = interaction.guildId;
  connection.on(VoiceConnectionStatus.Ready, () => {
    log.info('Voice connection re-established — refreshing receiver streams.');
    listener.refreshStreams();
  });
  connection.on(VoiceConnectionStatus.Disconnected, async () => {
    log.warn('Voice connection dropped — attempting to recover.');
    try {
      await Promise.race([
        entersState(connection, VoiceConnectionStatus.Signalling, 5_000),
        entersState(connection, VoiceConnectionStatus.Connecting, 5_000),
      ]);
      // Reconnecting on its own; the Ready handler above refreshes streams.
    } catch (err) {
      log.warn(`Voice connection could not recover (${err.message}) — leaving channel.`);
      leaveChannel(guildId);
    }
  });

  const mode = config.capture.testMode
    ? 'Capture-test mode: just talk and I will save a WAV of each utterance to tmp/.'
    : wakeword.available
      ? 'Say "Ralf" followed by your question, or use /ralf.'
      : 'Wake word is not active — use /ralf to ask questions.';
  // Say so out loud: everyone in the channel is being recorded.
  const rec = recordDir
    ? '\n🔴 Recording this session for an end-of-game summary — everything said in this channel is saved to disk. Use `/ralf-summary` when you finish.'
    : '';
  const who = rolled ? `\n🎲 Ralf rolled a **${character.describe(rolled)}** for tonight.` : '';
  await interaction.editReply(`Ralf joined ${channel.name}. ${mode}${who}${rec}`);

  // Say the roll out loud once the line is written. Deliberately not awaited —
  // joining must not hang on an API call, and the text reply already named the
  // character.
  intro
    .then((line) => {
      if (!line) return;
      textChannel?.send(`**Ralf:** ${line}`).catch(() => {});
      return speak(player, line);
    })
    .catch((err) => log.warn(`Character intro could not be announced: ${err.message}`));
}

function leaveChannel(guildId) {
  const session = sessions.get(guildId);
  if (!session) return false;
  try {
    session.listener.stop();
    session.player.stop(true);
    session.connection.destroy();
  } catch (err) {
    log.error(`Error tearing down session: ${err.message}`);
  }
  sessions.delete(guildId);
  return true;
}

// ---------------------------------------------------------------- summary

/** Split for Discord's 2000-character message limit, preferring line breaks. */
function chunkMessage(text, limit = 1900) {
  const chunks = [];
  let rest = text;
  while (rest.length > limit) {
    let cut = rest.lastIndexOf('\n', limit);
    if (cut < limit * 0.5) cut = limit; // no sensible break — hard split
    chunks.push(rest.slice(0, cut));
    rest = rest.slice(cut).replace(/^\n+/, '');
  }
  if (rest) chunks.push(rest);
  return chunks;
}

/**
 * Transcribe the recorded session and post a recap.
 *
 * Runs long — transcription is roughly 3x the spoken length on CPU — so it
 * replies immediately and posts results to the channel instead of holding the
 * interaction open past its 15 minute token.
 */
async function summarizeCommand(interaction) {
  const dir = latestSession(interaction.guildId);
  if (!dir) {
    return await interaction.reply('No recorded session found for this server yet.');
  }

  const segments = readManifest(dir);
  if (!segments.length) {
    return await interaction.reply('That session has no recorded speech to summarize.');
  }

  const spokenMs = segments.reduce((t, s) => t + (s.durationMs || 0), 0);
  const estMin = Math.max(1, Math.round((spokenMs * 3) / 60000));
  await interaction.reply(
    `Transcribing ${segments.length} clips (about ${Math.round(spokenMs / 60000)} min of speech). ` +
      `This runs locally and takes roughly ${estMin} min — I'll post the recap here when it's done.`
  );

  const channel = interaction.channel;
  try {
    let lastNote = Date.now();
    const { summary, spoken } = await summarizeSession(dir, (done, total) => {
      // Occasional progress so a long run doesn't look hung.
      if (Date.now() - lastNote > 120000) {
        lastNote = Date.now();
        channel?.send(`Still transcribing… ${done}/${total} clips.`).catch(() => {});
      }
    });

    if (!summary) {
      return void channel?.send('Nothing intelligible was transcribed from that session.');
    }
    for (const part of chunkMessage(`**Session recap** (${spoken} clips)\n\n${summary}`)) {
      await channel?.send(part).catch(() => {});
    }
  } catch (err) {
    log.error(`Summary failed: ${err.message}`);
    await channel?.send(`Could not build the summary: ${err.message}`).catch(() => {});
  }
}

// ---------------------------------------------------------------- commands

client.on('interactionCreate', async (interaction) => {
  if (!interaction.isChatInputCommand()) return;

  try {
    switch (interaction.commandName) {
      case 'ralf-join':
        return await joinChannel(interaction);

      case 'ralf-summary':
        return await summarizeCommand(interaction);

      case 'ralf-leave': {
        const left = leaveChannel(interaction.guildId);
        return await interaction.reply(left ? 'Ralf left the channel.' : 'Ralf is not in a channel.');
      }

      case 'ralf': {
        const question = interaction.options.getString('question');
        await interaction.deferReply();

        const session = sessions.get(interaction.guildId);
        if (!session) {
          // Answer in text even without a voice session.
          const answer = await ask(question);
          log.qa({ guildId: interaction.guildId, userId: interaction.user.id, source: 'slash', question, answer });
          return await interaction.editReply(`**Ralf:** ${answer}`);
        }

        await interaction.editReply(`*Asking Ralf: ${question}*`);
        return void handleQuestion({
          guildId: interaction.guildId,
          question,
          source: 'slash',
          userId: interaction.user.id,
        });
      }
    }
  } catch (err) {
    log.error(`Command ${interaction.commandName} failed: ${err.message}`);
    const msg = 'Something went wrong.';
    if (interaction.deferred || interaction.replied) {
      await interaction.editReply(msg).catch(() => {});
    } else {
      await interaction.reply({ content: msg, flags: MessageFlags.Ephemeral }).catch(() => {});
    }
  }
});

// ---------------------------------------------------------------- lifecycle

// Without an 'error' listener, any error the Client emits (e.g. a rejected
// interaction reply captured by discord.js) is an unhandled 'error' event, and
// Node throws — killing the whole bot. Log and keep running instead.
client.on('error', (err) => log.error(`Discord client error: ${err.message}`));

client.once('clientReady', async (c) => {
  log.info(`Logged in as ${c.user.tag}`);
  await wakeword.init();
  if (!wakeword.available) {
    log.warn('Running without wake word — /ralf is the only trigger.');
  } else {
    whisper.warm(); // pre-load the STT model so the first spoken question isn't slow
    // Pre-synthesize the instant-ack clip once, so the wake-word path can play
    // it with zero Piper latency. Degrades to no ack if it fails.
    prepareAck(config.ack.phrase)
      .then((p) => log.info(p ? `Ack ready ("${config.ack.phrase}")` : 'Ack disabled'))
      .catch((err) => log.warn(`Ack pre-synth failed, continuing without it: ${err.message}`));
  }
});

function shutdown() {
  log.info('Shutting down...');
  for (const guildId of [...sessions.keys()]) leaveChannel(guildId);
  wakeword.releaseAll();
  whisper.shutdown();
  client.destroy();
  process.exit(0);
}

process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
process.on('unhandledRejection', (err) => log.error(`Unhandled rejection: ${err}`));

client.login(config.discord.token());
