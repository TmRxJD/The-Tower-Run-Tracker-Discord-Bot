const { SlashCommandBuilder, MessageFlags, ChannelType } = require('discord.js');
const { ModalBuilder, StringSelectMenuBuilder, FileUploadBuilder, LabelBuilder, UserSelectMenuBuilder, RoleSelectMenuBuilder, ChannelSelectMenuBuilder } = require('@discordjs/builders');

module.exports = {
    category: 'utility',
    data: new SlashCommandBuilder()
        .setName('modal-demo')
        .setDescription('Demo a modal with a select menu and file upload input'),
    async execute(interaction) {
        const modal = new ModalBuilder()
            .setCustomId('demo_modal')
            .setTitle('New Modal Inputs');

        // Select inside modal
        const select = new StringSelectMenuBuilder()
            .setCustomId('demo_select')
            .setPlaceholder('Choose one or more options')
            .setMinValues(1)
            .setMaxValues(5)
            .addOptions(
                { label: 'Option 1', value: 'opt1' },
                { label: 'Option 2', value: 'opt2' },
                { label: 'Option 3', value: 'opt3' },
                { label: 'Option 4', value: 'opt4' },
                { label: 'Option 5', value: 'opt5' },
            );

        // File upload input
        const file = new FileUploadBuilder()
            .setCustomId('demo_file');

        // Labeled components
        const labeledSelect = new LabelBuilder()
            .setLabel('Pick one:')
            .setStringSelectMenuComponent(select);

        const labeledFile = new LabelBuilder()
            .setLabel('Upload a file (optional)')
            .setFileUploadComponent(file);

        // Channel select (multi)
        const channelSelect = new ChannelSelectMenuBuilder()
            .setCustomId('demo_channel')
            .setPlaceholder('Pick channel(s)')
            .setMinValues(1)
            .setMaxValues(3)
            // If your environment supports channel type filters, keep the next line; otherwise it's harmless
            .addChannelTypes?.(ChannelType.GuildText, ChannelType.GuildVoice, ChannelType.GuildAnnouncement, ChannelType.GuildForum, ChannelType.GuildStageVoice);

        const labeledChannel = new LabelBuilder()
            .setLabel('Pick channel(s):')
            .setChannelSelectMenuComponent(channelSelect);

        // Add user and role select menus for testing
        const userSelect = new UserSelectMenuBuilder()
            .setCustomId('demo_user')
            .setPlaceholder('Pick user(s)')
            .setMinValues(1)
            .setMaxValues(3);

        const roleSelect = new RoleSelectMenuBuilder()
            .setCustomId('demo_role')
            .setPlaceholder('Pick role(s)')
            .setMinValues(1)
            .setMaxValues(3);

        const labeledUser = new LabelBuilder()
            .setLabel('Pick user(s):')
            .setUserSelectMenuComponent(userSelect);

        const labeledRole = new LabelBuilder()
            .setLabel('Pick role(s):')
            .setRoleSelectMenuComponent(roleSelect);

        // Max 5 rows allowed in a modal; include only labeled components below
        modal
            .addLabelComponents(labeledSelect, labeledFile, labeledUser, labeledRole, labeledChannel);

        await interaction.showModal(modal);

        // Make this command fully self-contained by awaiting the modal submission here
        try {
            const submitted = await interaction.awaitModalSubmit({
                time: 60_000,
                filter: (i) => i.customId === 'demo_modal' && i.user.id === interaction.user.id,
            });

            // Deep search for submitted components by customId (handles wrapper/label nesting)
            const findByCustomIdDeep = (node, id, seen = new Set()) => {
                if (!node) return null;
                const t = typeof node;
                if (t !== 'object') return null;
                if (seen.has(node)) return null;
                seen.add(node);
                if (node.customId === id) return node;
                if (Array.isArray(node)) {
                    for (const item of node) {
                        const found = findByCustomIdDeep(item, id, seen);
                        if (found) return found;
                    }
                } else {
                    for (const key of Object.keys(node)) {
                        const found = findByCustomIdDeep(node[key], id, seen);
                        if (found) return found;
                    }
                }
                return null;
            };

            const selectComp = findByCustomIdDeep(submitted.components, 'demo_select');
            let selectedValues = Array.isArray(selectComp?.values) ? selectComp.values : [];
            if (!selectedValues.length && selectComp && typeof selectComp.value === 'string') {
                selectedValues = [selectComp.value];
            }

            // User select values (IDs); format as mentions
            const userComp = findByCustomIdDeep(submitted.components, 'demo_user');
            let userValues = Array.isArray(userComp?.values) ? userComp.values : [];
            if (!userValues.length && userComp && typeof userComp.value === 'string') {
                userValues = [userComp.value];
            }
            const userSummary = userValues.length ? userValues.map(id => `<@${id}>`).join(', ') : 'none';

            // Role select values (IDs); format as role mentions
            const roleComp = findByCustomIdDeep(submitted.components, 'demo_role');
            let roleValues = Array.isArray(roleComp?.values) ? roleComp.values : [];
            if (!roleValues.length && roleComp && typeof roleComp.value === 'string') {
                roleValues = [roleComp.value];
            }
            const roleSummary = roleValues.length ? roleValues.map(id => `<@&${id}>`).join(', ') : 'none';

            // Channel select values (IDs); format as channel mentions
            const channelComp = findByCustomIdDeep(submitted.components, 'demo_channel');
            let channelValues = Array.isArray(channelComp?.values) ? channelComp.values : [];
            if (!channelValues.length && channelComp && typeof channelComp.value === 'string') {
                channelValues = [channelComp.value];
            }
            const channelSummary = channelValues.length ? channelValues.map(id => `<#${id}>`).join(', ') : 'none';

            const fileComp = findByCustomIdDeep(submitted.components, 'demo_file');

            // Normalize various possible file container shapes into an array of file-like objects
            const toArray = (val) => {
                if (!val) return [];
                if (Array.isArray(val)) return val;
                if (typeof val.values === 'function') {
                    try { return Array.from(val.values()); } catch { /* noop */ }
                }
                if (typeof Symbol !== 'undefined' && val[Symbol.iterator]) {
                    try { return Array.from(val); } catch { /* noop */ }
                }
                if (typeof val === 'object') {
                    try { return Object.values(val); } catch { /* noop */ }
                }
                return [];
            };

            const looksLikeFile = (f) => !!f && (typeof f === 'object') && (
                'name' in f || 'filename' in f || 'content_type' in f || 'size' in f
            );

            let uploadedFiles = [];
            if (fileComp) {
                const primary = toArray(fileComp.files);
                if (primary.length && looksLikeFile(primary[0])) uploadedFiles = primary;
                if (!uploadedFiles.length) {
                    const alt = toArray(fileComp.attachments);
                    if (alt.length && looksLikeFile(alt[0])) uploadedFiles = alt;
                }
            }

            // Broader fallbacks: sometimes files may be attached at different levels
            if (!uploadedFiles.length) {
                const candidates = [submitted.files, submitted.attachments, submitted.data?.attachments, submitted.data?.resolved?.attachments];
                for (const c of candidates) {
                    const arr = toArray(c);
                    if (arr.length && looksLikeFile(arr[0])) { uploadedFiles = arr; break; }
                }
            }

            // As a last resort, scan shallowly for any property named "files" or "attachments" with file-like entries
            if (!uploadedFiles.length) {
                const scanKeys = ['files', 'attachments'];
                for (const key of scanKeys) {
                    try {
                        for (const row of submitted.components ?? []) {
                            const arr = toArray(row[key]);
                            if (arr.length && looksLikeFile(arr[0])) { uploadedFiles = arr; break; }
                            for (const comp of row.components ?? []) {
                                const a2 = toArray(comp[key]);
                                if (a2.length && looksLikeFile(a2[0])) { uploadedFiles = a2; break; }
                            }
                            if (uploadedFiles.length) break;
                        }
                    } catch { /* noop */ }
                    if (uploadedFiles.length) break;
                }
            }

            const selected = selectedValues.length ? selectedValues.join(', ') : 'none';
            const fileName = (f) => f.name || f.filename || f.fileName || 'file';
            const fileSize = (f) => (typeof f.size === 'number' ? ` (${f.size} bytes)` : (typeof f.fileSize === 'number' ? ` (${f.fileSize} bytes)` : ''));
            const filesSummary = uploadedFiles.length
                ? uploadedFiles.map(f => `${fileName(f)}${fileSize(f)}`).join(', ')
                : 'none';

            await submitted.reply({ content: `You selected: ${selected}. Users: ${userSummary}. Roles: ${roleSummary}. Channels: ${channelSummary}. Uploaded: ${filesSummary}.`, flags: MessageFlags.Ephemeral });
        } catch (err) {
            // Timed out or failed to submit; inform the user ephemerally without throwing
            try {
                await interaction.followUp({ content: 'Modal closed or timed out without submission.', flags: MessageFlags.Ephemeral });
            } catch {}
        }
    },
};
