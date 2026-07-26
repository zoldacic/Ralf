'use strict';

const { REST, Routes, SlashCommandBuilder } = require('discord.js');
const config = require('../config');

const commands = [
  new SlashCommandBuilder()
    .setName('ralf-join')
    .setDescription('Have Ralf join your voice channel'),

  new SlashCommandBuilder()
    .setName('ralf-leave')
    .setDescription('Have Ralf leave the voice channel'),

  new SlashCommandBuilder()
    .setName('ralf-summary')
    .setDescription('Transcribe the last recorded session and post a recap'),

  new SlashCommandBuilder()
    .setName('ralf')
    .setDescription('Ask Ralf a rules question (D&D 5e 2024)')
    .addStringOption((opt) =>
      opt
        .setName('question')
        .setDescription('Your rules question')
        .setRequired(true)
        .setMaxLength(500)
    ),
].map((c) => c.toJSON());

async function register() {
  const rest = new REST({ version: '10' }).setToken(config.discord.token());
  const clientId = config.discord.clientId();
  const guildId = config.discord.guildId;

  if (guildId) {
    await rest.put(Routes.applicationGuildCommands(clientId, guildId), { body: commands });
    console.log(`Registered ${commands.length} commands to guild ${guildId} (instant).`);
  } else {
    await rest.put(Routes.applicationCommands(clientId), { body: commands });
    console.log(
      `Registered ${commands.length} commands globally. ` +
        'Global registration can take up to an hour to propagate — ' +
        'set DISCORD_GUILD_ID in .env for instant updates while developing.'
    );
  }
}

if (require.main === module) {
  register().catch((err) => {
    console.error(err);
    process.exit(1);
  });
}

module.exports = { commands, register };
