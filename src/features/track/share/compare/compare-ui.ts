import { ActionRowBuilder, ButtonBuilder, ButtonStyle, EmbedBuilder, StringSelectMenuBuilder, escapeMarkdown } from 'discord.js';
import { TRACKER_IDS, withShareCompareControl } from '../../track-custom-ids';
import { type CompareSession } from './compare-session';
import { type CompareRun } from './compare-data';
import { expandedComparePages } from './compare-model';
export { visibleCompareOptions } from './compare-access';

export const COMPARE_PAGE_SIZE = 25;
export const COMPARE_MENTIONS = { parse: [] as [], repliedUser: false };
const control = (prefix: string, session: CompareSession) => withShareCompareControl(prefix, session.token, session.revision);
const button = (prefix: string, label: string, session: CompareSession) => new ButtonBuilder().setCustomId(control(prefix, session)).setLabel(label).setStyle(ButtonStyle.Secondary);

export function comparePicker(session: CompareSession) {
  const start = session.page * COMPARE_PAGE_SIZE;
  const choices = session.choices.slice(start, start + COMPARE_PAGE_SIZE);
  const select = new StringSelectMenuBuilder().setCustomId(control(TRACKER_IDS.share.compareSelectPrefix, session))
    .setPlaceholder('Choose one of your runs').setMinValues(1).setMaxValues(1)
    .addOptions(choices.map((choice, index) => ({
      label: `Tier ${String(choice.preview.tierDisplay ?? choice.preview.tier ?? '?')} | Wave ${String(choice.preview.wave ?? '?')}`.slice(0, 100),
      description: `${String(choice.preview.type ?? 'Farming')} · ${String(choice.preview.runDate ?? choice.preview.date ?? 'Date unavailable')}`.slice(0, 100),
      value: String(start + index),
    })));
  const navigation = new ActionRowBuilder<ButtonBuilder>().addComponents(
    button(TRACKER_IDS.share.comparePrevPrefix, 'Previous', session).setDisabled(session.page === 0),
    button(TRACKER_IDS.share.compareNextPrefix, 'Next', session).setDisabled(start + COMPARE_PAGE_SIZE >= session.choices.length),
    button(TRACKER_IDS.share.compareCancelPrefix, 'Cancel', session),
  );
  return { content: `Compare with ${escapeMarkdown(session.shared.sharerName).slice(0, 150)}'s shared run. Only you can see this.\n${session.recentOnly ? 'Recent saved runs' : 'Available runs'} ${start + 1}–${start + choices.length} of ${session.choices.length}. This picker expires after five minutes.`,
    embeds: [], components: [new ActionRowBuilder<StringSelectMenuBuilder>().addComponents(select), navigation], allowedMentions: COMPARE_MENTIONS };
}

export function comparisonPageCount(session: CompareSession): number {
  return Math.max(1, session.view === 'reports' ? session.selected?.reports?.pages.length ?? 0 : session.selected?.details.length ?? 0);
}

export function compareResult(session: CompareSession, mine: CompareRun, name: string) {
  const reports = session.view === 'reports';
  const pages = reports ? session.selected?.reports?.pages ?? [] : session.selected?.details ?? expandedComparePages(session.shared, mine, session.options);
  const page = Math.max(0, Math.min((reports ? session.reportPage : session.detailPage) ?? 0, Math.max(0, pages.length - 1)));
  const report = session.selected?.reports;
  const missing = reports && (!report?.sharedAvailable || !report?.mineAvailable)
    ? '\nSome older report data was not captured. Missing values are Unavailable.' : '';
  const legend = `**S = shared run (${escapeMarkdown(session.shared.sharerName).slice(0, 80)}) · Y = your run (${escapeMarkdown(name).slice(0, 80)})**\nEach value row is S | Y. Δ is yours relative to shared; missing/zero baselines have no percentage.${missing}`;
  const embed = new EmbedBuilder().setTitle(reports ? 'Battle report comparison' : 'Expanded run comparison').setColor(0xF9A825)
    .setDescription(legend + '\n\n' + (pages[page]?.text ?? (reports ? 'No battle report fields were captured for these runs.' : 'No accessible expanded details were captured.')))
    .setFooter({ text: `Page ${page + 1} of ${Math.max(1, pages.length)} · ${String(session.shared.run.type ?? 'Farming').slice(0, 60)} vs ${String(mine.type ?? 'Farming').slice(0, 60)} · Different tiers/types affect comparisons.` });
  const actions = [button(TRACKER_IDS.share.comparePrevPrefix, 'Previous', session).setDisabled(page === 0),
    button(TRACKER_IDS.share.compareNextPrefix, 'Next', session).setDisabled(page + 1 >= pages.length)];
  if (reports) actions.push(button(TRACKER_IDS.share.compareDetailsPrefix, 'Back to details', session));
  else if (session.canCompareReports) actions.push(button(TRACKER_IDS.share.compareReportsPrefix, 'Compare battle reports', session));
  actions.push(button(TRACKER_IDS.share.compareBackPrefix, 'Choose another run', session), button(TRACKER_IDS.share.compareCancelPrefix, 'Close', session));
  return { content: '', embeds: [embed], components: [new ActionRowBuilder<ButtonBuilder>().addComponents(...actions)], allowedMentions: COMPARE_MENTIONS };
}
