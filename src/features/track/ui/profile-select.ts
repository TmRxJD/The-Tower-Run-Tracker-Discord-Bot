import { ActionRowBuilder, StringSelectMenuBuilder } from 'discord.js';
import type { BotProfileOption } from '../upload-target-profile';

/** Select value that maps to "no alt" (Main). */
export const MAIN_PROFILE_VALUE = 'main';

/** Map a select value back to a profile id, or null for Main. */
export function resolveSelectedProfileId(value: string | undefined | null): string | null {
  if (!value || value === MAIN_PROFILE_VALUE) return null;
  return value;
}

/** Label for a profile option in a select row. */
function optionLabel(option: BotProfileOption): string {
  if (option.isPrimary) return 'Main';
  return `Alt ${option.index} · ${option.name}`.slice(0, 100);
}

/**
 * Build a String Select row letting the user pick which profile a run/import targets.
 * Returns null when the user has one or zero profiles (nothing to choose) so callers can
 * simply omit the row. `selectedProfileId` (null = Main) marks the current default.
 */
export function buildProfileSelectRow(params: {
  customId: string;
  options: readonly BotProfileOption[];
  selectedProfileId: string | null;
  placeholder?: string;
}): ActionRowBuilder<StringSelectMenuBuilder> | null {
  const { customId, options, selectedProfileId, placeholder } = params;
  if (options.length <= 1) return null;

  const selectedValue = selectedProfileId ?? MAIN_PROFILE_VALUE;
  const menu = new StringSelectMenuBuilder()
    .setCustomId(customId)
    .setPlaceholder(placeholder ?? 'Upload to profile')
    .setMinValues(1)
    .setMaxValues(1)
    .addOptions(
      ...options.map(option => {
        const value = option.isPrimary ? MAIN_PROFILE_VALUE : option.id;
        return { label: optionLabel(option), value, default: value === selectedValue };
      }),
    );

  return new ActionRowBuilder<StringSelectMenuBuilder>().addComponents(menu);
}

/**
 * Build a bare String Select menu (no ActionRow) for embedding inside a MODAL via
 * `LabelBuilder().setStringSelectMenuComponent(...)`. Returns null when the user has one or
 * zero profiles (nothing to choose) so callers can simply omit the label. `selectedProfileId`
 * (null = Main) marks the current default with `setDefault(true)`.
 */
export function buildProfileSelectMenu(params: {
  customId: string;
  options: readonly BotProfileOption[];
  selectedProfileId: string | null;
  placeholder?: string;
}): StringSelectMenuBuilder | null {
  const { customId, options, selectedProfileId, placeholder } = params;
  if (options.length <= 1) return null;

  const selectedValue = selectedProfileId ?? MAIN_PROFILE_VALUE;
  return new StringSelectMenuBuilder()
    .setCustomId(customId)
    .setPlaceholder(placeholder ?? 'Upload to profile')
    .setMinValues(1)
    .setMaxValues(1)
    .addOptions(
      ...options.map(option => {
        const value = option.isPrimary ? MAIN_PROFILE_VALUE : option.id;
        return { label: optionLabel(option), value, default: value === selectedValue };
      }),
    );
}
