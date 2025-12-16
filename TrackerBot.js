// Tower Run Tracker Bot - https://github.com/TmRxJD/TheTowerRunTrackerBot
const fs = require('node:fs');
const path = require('node:path');
const { Client, Collection, Events, GatewayIntentBits, MessageFlags } = require('discord.js');
const { REST, Routes } = require('discord.js');
const { token, clientId } = require('./config.json');
const db = require('./lib/db');
db.init();

const client = new Client({ intents: [
	GatewayIntentBits.Guilds,
	GatewayIntentBits.GuildMessages,
] });

// Handlers for modal-based inputs (replace message-content collectors)
const manualEntry = require('./commands/utility/TrackerUtils/trackerHandlers/manualEntryHandlers');
const editHandlers = require('./commands/utility/TrackerUtils/trackerHandlers/editHandlers');

// Simple in-process lock queue to serialize config read/write and deployments
const _locks = new Map();
function queueLock(name, job) {
	const prev = _locks.get(name) || Promise.resolve();
	const next = prev.then(() => job());
	// store a version that won't reject the chain
	_locks.set(name, next.catch(() => {}));
	return next;
}

client.cooldowns = new Collection();
client.commands = new Collection();
const foldersPath = path.join(__dirname, 'commands');
const commandFolders = fs.readdirSync(foldersPath);

for (const folder of commandFolders) {
	const commandsPath = path.join(foldersPath, folder);
	const commandFiles = fs.readdirSync(commandsPath).filter(file => file.endsWith('.js'));
	for (const file of commandFiles) {
		const filePath = path.join(commandsPath, file);
		const command = require(filePath);
		if ('data' in command && 'execute' in command) {
			client.commands.set(command.data.name, command);
			console.log(`Loaded command: ${command.data.name}`);
		} else {
			console.log(`[WARNING] The command at ${filePath} is missing a required "data" or "execute" property.`);
		}
	}
}

client.once(Events.ClientReady, async c => {
	console.log('Github relay started.');
	console.log(`Ready! Logged in as ${c.user.tag}`);

	// On startup, ensure any guilds the bot is already in have commands deployed
	try {
		await queueLock('guild_ops', async () => {
			const registered = new Set(db.listGuildIds());

			// Build commands payload once
			const commands = [];
			for (const command of client.commands.values()) {
				if (command && command.data && typeof command.data.toJSON === 'function') {
					commands.push(command.data.toJSON());
				}
			}
			const rest = new REST().setToken(token);

			for (const [guildId, guild] of client.guilds.cache) {
				if (!registered.has(guildId)) {
					try {
						await db.addGuild(guildId);
						const data = await rest.put(
							Routes.applicationGuildCommands(clientId, guildId),
							{ body: commands }
						);
						console.log(`On startup: registered ${data.length} commands for guild ${guildId}`);
					} catch (err) {
						console.error(`Failed to register commands for guild ${guildId} on startup:`, err);
					}
				}
			}
		});
	} catch (err) {
		console.error('Error syncing guild commands on startup:', err);
	}
});

client.on(Events.InteractionCreate, async interaction => {
	console.log(`Interaction received: ${interaction.type}, command: ${interaction.commandName}, id: ${interaction.id}, deferred: ${interaction.deferred}, replied: ${interaction.replied}`);
	if (!client.readyAt) {
		console.log('Bot not ready, ignoring interaction');
		return;
	}

	// Handle modal submits first (modal-based text inputs)
	try {
		if (interaction.isModalSubmit && interaction.isModalSubmit()) {
			const customId = interaction.customId || '';
			if (customId.startsWith('tracker_manual_modal:')) {
				const field = customId.split(':')[1];
				await manualEntry.handleManualModalSubmit(interaction, field);
				return;
			}
			if (customId.startsWith('tracker_edit_modal:')) {
				const field = customId.split(':')[1];
				await editHandlers.handleEditModalSubmit(interaction, field);
				return;
			}
		}
	} catch (modalErr) {
		console.error('Error handling modal submit:', modalErr);
	}

	if (!interaction.isChatInputCommand()) return;
	const command = client.commands.get(interaction.commandName);

	if (!command) {
		console.error(`No command matching ${interaction.commandName} was found.`);
		return;
	}

	const { cooldowns } = interaction.client;

	if (!cooldowns.has(command.data.name)) {
		cooldowns.set(command.data.name, new Collection());
	}

	const now = Date.now();
	const timestamps = cooldowns.get(command.data.name);
	const defaultCooldownDuration = 5;
	const cooldownAmount = (command.cooldown ?? defaultCooldownDuration) * 1000;

	if (timestamps.has(interaction.user.id)) {
		const expirationTime = timestamps.get(interaction.user.id) + cooldownAmount;

		if (now < expirationTime) {
			const expiredTimestamp = Math.round(expirationTime / 1000);
			console.log(`Cooldown triggered for user ${interaction.user.id}, replying with cooldown message`);
			return interaction.reply({ content: `Please wait, you are on a cooldown for \`${command.data.name}\`. You can use it again <t:${expiredTimestamp}:R>.`, flags: MessageFlags.Ephemeral });
		}
	}

	timestamps.set(interaction.user.id, now);
	setTimeout(() => timestamps.delete(interaction.user.id), cooldownAmount);

	try {
		console.log(`Executing command ${command.data.name} for interaction ${interaction.id}`);
		await command.execute(interaction);
	} catch (error) {
		console.error(error);
		try {
			if (interaction.replied || interaction.deferred) {
				await interaction.followUp({ content: 'There was an error while executing this command!', ephemeral: true });
			} else {
				await interaction.reply({ content: 'There was an error while executing this command!', flags: MessageFlags.Ephemeral });
			}
		} catch (replyError) {
			console.error('Failed to send error message:', replyError);
		}
	}
});

// When the bot is added to a new guild, register commands and persist the guild id
client.on(Events.GuildCreate, async (guild) => {
	try {
		await queueLock('guild_ops', async () => {
			await db.addGuild(guild.id);
			console.log(`Added guild ${guild.id} to sqlite DB`);

			// Build commands payload from loaded commands
			const commands = [];
			for (const command of client.commands.values()) {
				if (command && command.data && typeof command.data.toJSON === 'function') {
					commands.push(command.data.toJSON());
				}
			}

			const rest = new REST().setToken(token);
			const data = await rest.put(
				Routes.applicationGuildCommands(clientId, guild.id),
				{ body: commands },
			);
			console.log(`Successfully registered ${data.length} commands for guild ${guild.id}`);
		});
	} catch (error) {
		console.error('Error handling guildCreate:', error);
	}
});

// When the bot is removed from a guild, remove the guild id from config.json
client.on(Events.GuildDelete, async (guild) => {
	try {
		await queueLock('guild_ops', async () => {
			await db.removeGuild(guild.id);
			console.log(`Removed guild ${guild.id} from sqlite DB`);
		});
	} catch (error) {
		console.error('Error handling guildDelete:', error);
	}
});

process.on('uncaughtException', (err) => {
	console.error('Uncaught Exception:', err);
});

process.on('unhandledRejection', (reason, promise) => {
	console.error('Unhandled Rejection at:', promise, 'reason:', reason);
});

client.login(token);