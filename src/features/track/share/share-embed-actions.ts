import {
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  type ActionRowBuilder as ActionRowBuilderType,
  type ButtonBuilder as ButtonBuilderType,
} from 'discord.js';
import { getTrackerUiConfig } from '../../../config/tracker-ui-config';
import { TRACKER_IDS } from '../track-custom-ids';

export type ShareEmbedActionOptions = {
  websiteUrl?: string | null;
};

function resolveShareWebsiteUrl(options: ShareEmbedActionOptions = {}): string {
  const configured = getTrackerUiConfig().initialMenu.url.trim();
  const override = typeof options.websiteUrl === 'string' ? options.websiteUrl.trim() : '';
  return override || configured;
}

export function buildShareEmbedActionRows(options: ShareEmbedActionOptions = {}): ActionRowBuilderType<ButtonBuilderType>[] {
  const websiteUrl = resolveShareWebsiteUrl(options);
  const primaryRow = new ActionRowBuilder<ButtonBuilder>().addComponents(
    new ButtonBuilder()
      .setCustomId(TRACKER_IDS.share.trackRun)
      .setLabel('Use Run Tracker')
      .setStyle(ButtonStyle.Primary),
  );

  if (websiteUrl) {
    primaryRow.addComponents(
      new ButtonBuilder()
        .setLabel('Go to Website')
        .setStyle(ButtonStyle.Link)
        .setURL(websiteUrl),
    );
  }

  return [primaryRow];
}
