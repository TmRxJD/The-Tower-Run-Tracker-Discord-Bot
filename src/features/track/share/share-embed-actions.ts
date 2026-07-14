import {
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  type ActionRowBuilder as ActionRowBuilderType,
  type ButtonBuilder as ButtonBuilderType,
} from 'discord.js';
import { getTrackerUiConfig } from '../../../config/tracker-ui-config';
import { TRACKER_IDS } from '../track-custom-ids';
import { fitsShareCustomId } from './share-run-ref';

export type ShareEmbedActionOptions = {
  websiteUrl?: string | null;
  /** `userId:runId` reference from buildShareRunRef; omit to skip the expand/report buttons. */
  shareRunRef?: string | null;
  /** Log-channel posts render expanded already, so they only get the report button. */
  collapsed?: boolean;
};

function resolveShareWebsiteUrl(options: ShareEmbedActionOptions = {}): string {
  const configured = getTrackerUiConfig().initialMenu.url.trim();
  const override = typeof options.websiteUrl === 'string' ? options.websiteUrl.trim() : '';
  return override || configured;
}

export function buildShareEmbedActionRows(options: ShareEmbedActionOptions = {}): ActionRowBuilderType<ButtonBuilderType>[] {
  const websiteUrl = resolveShareWebsiteUrl(options);
  const shareRunRef = typeof options.shareRunRef === 'string' ? options.shareRunRef.trim() : '';
  const primaryRow = new ActionRowBuilder<ButtonBuilder>();

  if (shareRunRef && options.collapsed && fitsShareCustomId(TRACKER_IDS.share.expandPrefix, shareRunRef)) {
    primaryRow.addComponents(
      new ButtonBuilder()
        .setCustomId(`${TRACKER_IDS.share.expandPrefix}${shareRunRef}`)
        .setLabel('Expand')
        .setEmoji('🔽')
        .setStyle(ButtonStyle.Secondary),
    );
  }

  if (shareRunRef && fitsShareCustomId(TRACKER_IDS.share.reportPrefix, shareRunRef)) {
    primaryRow.addComponents(
      new ButtonBuilder()
        .setCustomId(`${TRACKER_IDS.share.reportPrefix}${shareRunRef}`)
        .setLabel('Battle Report')
        .setEmoji('📋')
        .setStyle(ButtonStyle.Secondary),
    );
  }

  primaryRow.addComponents(
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
