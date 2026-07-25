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
const { speak } = require('./pipeline/speak');

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
    answer = await ask(question);
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
  });

  try {
    await entersState(connection, VoiceConnectionStatus.Ready, 20_000);
  } catch (err) {
    connection.destroy();
    return interaction.editReply('Could not connect to the voice channel.');
  }

  const player = createAudioPlayer({
    behaviors: { noSubscriber: NoSubscriberBehavior.Pause },
  });
  connection.subscribe(player);

  const listener = new VoiceListener(connection, {
    captureTest: config.capture.testMode,
  });
  const textChannel = interaction.channel;
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
    textChannel: interaction.channel,
  });

  const mode = config.capture.testMode
    ? 'Capture-test mode: just talk and I will save a WAV of each utterance to tmp/.'
    : wakeword.available
      ? 'Say "Ralf" followed by your question, or use /ralf.'
      : 'Wake word is not active — use /ralf to ask questions.';
  await interaction.editReply(`Ralf joined ${channel.name}. ${mode}`);
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

// ---------------------------------------------------------------- commands

client.on('interactionCreate', async (interaction) => {
  if (!interaction.isChatInputCommand()) return;

  try {
    switch (interaction.commandName) {
      case 'ralf-join':
        return await joinChannel(interaction);

      case 'ralf-leave': {
        const left = leaveChannel(interaction.guildId);
        return interaction.reply(left ? 'Ralf left the channel.' : 'Ralf is not in a channel.');
      }

      case 'ralf': {
        const question = interaction.options.getString('question');
        await interaction.deferReply();

        const session = sessions.get(interaction.guildId);
        if (!session) {
          // Answer in text even without a voice session.
          const answer = await ask(question);
          log.qa({ guildId: interaction.guildId, userId: interaction.user.id, source: 'slash', question, answer });
          return interaction.editReply(`**Ralf:** ${answer}`);
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

client.once('clientReady', async (c) => {
  log.info(`Logged in as ${c.user.tag}`);
  await wakeword.init();
  if (!wakeword.available) {
    log.warn('Running without wake word — /ralf is the only trigger.');
  } else {
    whisper.warm(); // pre-load the STT model so the first spoken question isn't slow
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
