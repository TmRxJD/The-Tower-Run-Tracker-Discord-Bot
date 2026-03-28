import {
  ActionRowBuilder,
  AttachmentBuilder,
  ButtonBuilder,
  ButtonStyle,
  Colors,
  EmbedBuilder,
  MessageComponentInteraction,
  ModalSubmitInteraction,
  StringSelectMenuBuilder,
} from 'discord.js';
import { randomUUID } from 'node:crypto';
import { getLastRun, getLocalLifetimeData, getUserSettings, removeLastRun, removeLifetimeEntry } from '../tracker-api-client';
import { createPendingRun } from '../pending-run-store';
import { renderEditFieldPicker } from './data-review-handlers';
import { calculateHourlyRate } from '../tracker-helpers';
import { getViewRunsState, updateViewRunsState } from '../view-runs-store';
import { parsePrefixedTrackerToken, parseViewRunsOrientationTarget, TRACKER_IDS, withToken, withViewRunsOrientationTarget } from '../track-custom-ids';
import { logError } from './error-handlers';
import { generateCoverageDescription } from './upload-helpers';
import { renderViewRunsTablePng } from '../ui/view-runs-chart';
import { getTrackerUiConfig } from '../../../config/tracker-ui-config';
import { getTrackerFlowMode } from '../flow-mode-store';
import { formatNumberForDisplay, parseNumberInput, standardizeNotation } from '../../../utils/tracker-math';
import { buildShareEmbed } from '../share/share-embed';
import type { TrackReplyInteractionLike } from '../interaction-types';
import { trimDisplayTimeSeconds } from './upload-helpers';

type RunListItem = {
  runId?: string;
  localId?: string;
  type?: string;
  tier?: string | number;
  tierDisplay?: string | number;
  wave?: string | number;
  roundDuration?: string;
  duration?: string;
  killedBy?: string;
  totalCoins?: string | number;
  coins?: string | number;
  totalCells?: string | number;
  cells?: string | number;
  totalDice?: string | number;
  rerollShards?: string | number;
  dice?: string | number;
  date?: string;
  time?: string;
  runDate?: string;
  runTime?: string;
  coinsEarned?: string | number;
  cellsEarned?: string | number;
  rerollShardsEarned?: string | number;
  [key: string]: unknown;
};

type ViewFilters = {
  selectedTypes: string[];
  selectedTiers: string[];
};

type ShareSessionRun = {
  run: RunListItem;
  runNumber: number;
};

type ShareSessionState = {
  token: string;
  userId: string;
  mode: 'track' | 'lifetime';
  sourceInteraction: MessageComponentInteraction;
  selectedIndices: number[];
  pageRuns: ShareSessionRun[];
  runTypeCounts: Record<string, number>;
  createdAt: number;
};

function buildShareActionButtons(token: string, selectedCount: number): ActionRowBuilder<ButtonBuilder> {
  const disableSingleRunActions = selectedCount > 1;
  return new ActionRowBuilder<ButtonBuilder>().addComponents(
    new ButtonBuilder()
      .setCustomId(withToken(TRACKER_IDS.viewRuns.shareConfirmPrefix, token))
      .setLabel('Share')
      .setStyle(ButtonStyle.Success)
      .setDisabled(disableSingleRunActions),
    new ButtonBuilder()
      .setCustomId(withToken(TRACKER_IDS.viewRuns.shareEditPrefix, token))
      .setLabel('Edit')
      .setStyle(ButtonStyle.Primary)
      .setDisabled(disableSingleRunActions),
    new ButtonBuilder()
      .setCustomId(withToken(TRACKER_IDS.viewRuns.shareDeletePrefix, token))
      .setLabel('Delete')
      .setStyle(ButtonStyle.Danger),
  );
}

const runShareSessions = new Map<string, ShareSessionState>();

function buildShareRunOption(entry: ShareSessionRun, index: number, selectedIndex: number): { label: string; description: string; value: string; default: boolean } {
  const run = entry.run;
  const tier = String(run.tierDisplay ?? run.tier ?? '?');
  const wave = String(run.wave ?? '?');
  const coins = formatMetric(run.totalCoins ?? run.coins ?? run.coinsEarned);
  return {
    label: `Tier ${tier} | Wave ${wave} | Coin ${coins}`,
    description: `Run #${entry.runNumber}`,
    value: String(index),
    default: index === selectedIndex,
  };
}

async function updateOrEdit(interaction: TrackMenuInteraction, payload: {
  content: string;
  components: ActionRowBuilder<StringSelectMenuBuilder | ButtonBuilder>[] | ActionRowBuilder<ButtonBuilder>[] | [];
  embeds?: EmbedBuilder[];
}) {
  const normalizedPayload = {
    ...payload,
    embeds: payload.embeds ?? [],
    files: [],
    attachments: [],
  };
  const alreadyAcknowledged = interaction.deferred || interaction.replied;
  if (!alreadyAcknowledged && 'update' in interaction && typeof interaction.update === 'function') {
    const updated = await interaction.update(normalizedPayload)
      .then(() => true)
      .catch(() => false);
    if (updated) {
      return;
    }
  }
  if ('editReply' in interaction && typeof interaction.editReply === 'function') {
    await interaction.editReply(normalizedPayload).catch(() => {});
  }
}

const TRACK_COLUMN_OPTIONS = [
  'Tier',
  'Wave',
  'Duration',
  'Coins',
  'Cells',
  'Dice',
  'Coins/Hr',
  'Cells/Hr',
  'Dice/Hr',
  'Orbs',
  'SL',
  'DW',
  'GB',
  'SMN',
  'Type',
  'Date/Time',
] as const;

function formatMetric(value: unknown): string {
  if (value === null || value === undefined) return '0';
  const raw = String(value).trim();
  if (!raw) return '0';
  const parsed = parseNumberInput(standardizeNotation(raw));
  if (!Number.isFinite(parsed) || parsed <= 0) return '0';
  return formatNumberForDisplay(parsed);
}

function normalizeCoveragePercentages(run: RunListItem): Record<'Orbs' | 'SL' | 'DW' | 'GB' | 'SMN', string> {
  const fallback = { Orbs: 'N/A', SL: 'N/A', DW: 'N/A', GB: 'N/A', SMN: 'N/A' };
  const coverage = generateCoverageDescription(run);
  if (!coverage) return fallback;

  const lines = coverage.split('\n').map(line => line.trim()).filter(Boolean);
  const map = { ...fallback };

  for (const line of lines) {
    const match = /^([A-Za-z]+):\s*([^\s]+)$/.exec(line);
    if (!match) continue;
    const key = match[1].toLowerCase();
    const value = match[2];
    if (key === 'orbs') map.Orbs = value;
    if (key === 'sl') map.SL = value;
    if (key === 'dw') map.DW = value;
    if (key === 'gb') map.GB = value;
    if (key === 'summon' || key === 'summoned') map.SMN = value;
  }

  return map;
}

function clampCellValue(value: unknown): string {
  const str = String(value ?? 'N/A').trim() || 'N/A';
  return str.length > 28 ? `${str.slice(0, 25)}...` : str;
}

function runIdentityKey(run: RunListItem): string {
  const runId = String(run.runId ?? '').trim();
  if (runId) return `runId:${runId}`;
  const localId = String(run.localId ?? '').trim();
  if (localId) return `localId:${localId}`;
  const type = String(run.type ?? 'Farming').trim();
  const tier = String(run.tierDisplay ?? run.tier ?? '').trim();
  const wave = String(run.wave ?? '').trim();
  const duration = String(run.roundDuration ?? run.duration ?? '').trim();
  const date = String(run.runDate ?? run.date ?? '').trim();
  const time = String(run.runTime ?? run.time ?? '').trim();
  return `fp:${type}|${tier}|${wave}|${duration}|${date}|${time}`;
}

function buildRunIndexMap(runs: RunListItem[]): Map<string, number> {
  const result = new Map<string, number>();
  const total = runs.length;
  runs.forEach((run, index) => {
    const key = runIdentityKey(run);
    if (!result.has(key)) {
      result.set(key, Math.max(1, total - index));
    }
  });
  return result;
}

function normalizeTrackColumnOrder(columns: string[]): (typeof TRACK_COLUMN_OPTIONS[number])[] {
  const mapped = columns.map((column) => (column === 'Summon' ? 'SMN' : column));
  const selected = new Set(mapped.filter((column): column is typeof TRACK_COLUMN_OPTIONS[number] => TRACK_COLUMN_OPTIONS.includes(column as typeof TRACK_COLUMN_OPTIONS[number])));
  if (!selected.size) {
    return [...TRACK_COLUMN_OPTIONS];
  }
  return TRACK_COLUMN_OPTIONS.filter((column) => selected.has(column));
}

function buildTrackColumnValue(run: RunListItem, column: typeof TRACK_COLUMN_OPTIONS[number]): string {
  const duration = String(run.roundDuration ?? run.duration ?? 'N/A');
  const coins = run.totalCoins ?? run.coins;
  const cells = run.totalCells ?? run.cells;
  const dice = run.totalDice ?? run.rerollShards ?? run.dice;
  const coinsHr = calculateHourlyRate(coins, duration) || 'N/A';
  const cellsHr = calculateHourlyRate(cells, duration) || 'N/A';
  const diceHr = calculateHourlyRate(dice, duration) || 'N/A';
  const dateTime = `${String(run.date ?? run.runDate ?? 'Unknown')} ${trimDisplayTimeSeconds(run.time ?? run.runTime ?? '')}`.trim();
  const coverage = normalizeCoveragePercentages(run);

  const valueByColumn: Record<typeof TRACK_COLUMN_OPTIONS[number], string> = {
    Tier: String(run.tierDisplay ?? run.tier ?? '?'),
    Wave: String(run.wave ?? '?'),
    Duration: duration,
    Coins: formatMetric(coins),
    Cells: formatMetric(cells),
    Dice: formatMetric(dice),
    'Coins/Hr': String(coinsHr),
    'Cells/Hr': String(cellsHr),
    'Dice/Hr': String(diceHr),
    'Date/Time': dateTime,
      Type: String(run.type ?? 'Farming'),
    Orbs: coverage.Orbs,
    SL: coverage.SL,
    DW: coverage.DW,
    GB: coverage.GB,
    SMN: coverage.SMN,
  };

  return clampCellValue(valueByColumn[column]);
}

async function buildTrackRunsImage(
  page: RunListItem[],
  runIndexMap: Map<string, number>,
  selectedColumns: readonly (typeof TRACK_COLUMN_OPTIONS[number])[],
  orientation: 'landscape' | 'portrait',
): Promise<Buffer> {
  if (orientation === 'portrait') {
    const headers = ['Field', 'Value'];
    const rows: string[][] = [];

    page.forEach((run, index) => {
      const runNumber = runIndexMap.get(runIdentityKey(run)) ?? 0;
      rows.push(['Run', `#${runNumber}`]);
      selectedColumns.forEach((column) => {
        rows.push([column, buildTrackColumnValue(run, column)]);
      });
      if (index < page.length - 1) {
        rows.push(['', '']);
      }
    });

    return renderViewRunsTablePng({
      title: 'Run History',
      headers,
      rows,
    });
  }

  const headers = ['#', ...selectedColumns];
  const rows = page.map((run) => [
    String(runIndexMap.get(runIdentityKey(run)) ?? 0),
    ...selectedColumns.map((column) => buildTrackColumnValue(run, column)),
  ]);
  return renderViewRunsTablePng({
    title: 'Run History',
    headers,
    rows,
  });
}

function buildFilteredRuns(runs: RunListItem[], filters: ViewFilters): RunListItem[] {
  return runs.filter((run) => {
    const type = run.type || 'Farming';
    const tier = String(run.tier ?? run.tierDisplay ?? '');
    const typeMatch = filters.selectedTypes.includes(type);
    const tierMatch = filters.selectedTiers.includes('All') ? true : filters.selectedTiers.includes(tier);
    return typeMatch && tierMatch;
  });
}

type TrackMenuInteraction = MessageComponentInteraction | ModalSubmitInteraction;

function getSelectedValues(interaction: TrackMenuInteraction): string[] {
  if ('values' in interaction && Array.isArray(interaction.values)) {
    return interaction.values;
  }
  return [];
}

function asRunListItems(value: unknown): RunListItem[] {
  if (!Array.isArray(value)) return [];
  return value as RunListItem[];
}

export async function handleTrackMenuViewRuns(interaction: TrackMenuInteraction) {
  try {
    const mode = getTrackerFlowMode(interaction.user.id);
    if (!interaction.deferred && !interaction.replied) {
      await interaction.deferUpdate().catch(() => {});
    }

    const runs = mode === 'lifetime'
      ? asRunListItems(await getLocalLifetimeData(interaction.user.id).catch(() => []))
      : asRunListItems((await getLastRun(interaction.user.id, { cloudSyncMode: 'none' }))?.allRuns ?? []);
    const state = getViewRunsState(interaction.user.id);
    await renderViewRunsPanel(interaction, runs, state, mode);
  } catch (error) {
    await logError(interaction.client, interaction.user, error, 'track_menu_viewruns');
    await interaction.editReply({ content: 'Unable to load runs right now.', embeds: [], components: [] }).catch(() => {});
  }
}

async function renderViewRunsPanel(
  interaction: TrackMenuInteraction,
  runs: RunListItem[],
  state: ReturnType<typeof getViewRunsState>,
  mode: 'track' | 'lifetime',
  options?: { disableShareButton?: boolean },
) {
  const ui = getTrackerUiConfig(mode);
  const viewUi = ui.viewRuns;
  if (!runs.length) {
    await interaction.editReply({ content: viewUi.noRuns, embeds: [], components: [] }).catch(() => {});
    return;
  }

  if (mode === 'lifetime') {
    const sorted = [...runs].sort((a, b) => new Date(String(b.date ?? '')).getTime() - new Date(String(a.date ?? '')).getTime());
    const count = Math.max(1, state.count || 10);
    const maxOffset = Math.max(0, sorted.length - count);
    const offset = Math.min(Math.max(0, state.offset || 0), maxOffset);
    if (offset !== state.offset) {
      updateViewRunsState(interaction.user.id, { offset });
    }

    const page = sorted.slice(offset, offset + count);
    const headers = ['#', 'Date', 'Coins', 'Cells', 'Dice'];
    const rows = page.map((entry, idx) => [
      String(offset + idx + 1),
      String(entry.date ?? 'Unknown'),
      formatMetric(entry.coinsEarned),
      formatMetric(entry.cellsEarned),
      formatMetric(entry.rerollShardsEarned),
    ]);
    const image = await renderViewRunsTablePng({
      title: 'Lifetime Entries',
      headers,
      rows,
    }).catch(() => null);

    const embed = new EmbedBuilder()
      .setTitle('📈 Lifetime Runs Viewer')
      .setColor(Colors.Blue)
      .setDescription(`Showing ${sorted.length ? offset + 1 : 0}-${Math.min(offset + count, sorted.length)} of ${sorted.length} lifetime entries.`);

    const files = image
      ? [new AttachmentBuilder(image, { name: 'lifetime-runs-table.png' })]
      : [];
    if (image) {
      embed.setImage('attachment://lifetime-runs-table.png');
    }

    const countMenu = new ActionRowBuilder<StringSelectMenuBuilder>().addComponents(
      new StringSelectMenuBuilder()
        .setCustomId(TRACKER_IDS.viewRuns.count)
        .setPlaceholder(viewUi.countPlaceholder)
        .addOptions(...viewUi.countOptions.map((opt) => ({ label: `${opt} per page`, value: String(opt), default: count === opt }))),
    );

    const nav = new ActionRowBuilder<ButtonBuilder>().addComponents(
      new ButtonBuilder().setCustomId(TRACKER_IDS.viewRuns.prev).setLabel(viewUi.buttons.prev).setStyle(ButtonStyle.Secondary).setDisabled(offset <= 0),
      new ButtonBuilder().setCustomId(TRACKER_IDS.viewRuns.next).setLabel(viewUi.buttons.next).setStyle(ButtonStyle.Secondary).setDisabled(offset + count >= sorted.length),
      new ButtonBuilder().setCustomId(TRACKER_IDS.viewRuns.share).setLabel(viewUi.buttons.share).setStyle(ButtonStyle.Success).setDisabled(Boolean(options?.disableShareButton)),
      new ButtonBuilder().setCustomId(TRACKER_IDS.flow.mainMenu).setLabel(viewUi.buttons.mainMenu).setStyle(ButtonStyle.Primary),
    );

    await interaction.editReply({ content: '', embeds: [embed], components: [countMenu, nav], files }).catch(() => {});
    return;
  }

  const availableTypes = [...new Set(runs.map((r) => (r.type || 'Farming')))].sort();
  const availableTiers = [...new Set(runs.map((r) => String(r.tier ?? r.tierDisplay ?? '')).filter(Boolean))]
    .sort((a, b) => parseInt(a, 10) - parseInt(b, 10));

  const selectedTypes = state.selectedTypes.length ? state.selectedTypes.filter(t => availableTypes.includes(t)) : [...availableTypes];
  const selectedTiers = state.selectedTiers.length ? state.selectedTiers : ['All'];

  const filtered = buildFilteredRuns(runs, { selectedTypes, selectedTiers });
  const runIndexMap = buildRunIndexMap(runs);

  const count = Math.max(1, state.count || 10);
  const pageSize = state.orientation === 'portrait' ? 1 : count;
  const maxOffset = Math.max(0, filtered.length - count);
  const effectiveMaxOffset = Math.max(0, filtered.length - pageSize);
  const offset = Math.min(Math.max(0, state.offset || 0), effectiveMaxOffset);
  if (offset !== state.offset) {
    updateViewRunsState(interaction.user.id, { offset });
  }

  const page = filtered.slice(offset, offset + pageSize);
  const selectedColumns = normalizeTrackColumnOrder(state.selectedColumns.length ? state.selectedColumns : [...TRACK_COLUMN_OPTIONS]);

  let image: Buffer | null = null;
  try {
    image = await buildTrackRunsImage(page, runIndexMap, selectedColumns, state.orientation);
  } catch (error) {
    await logError(interaction.client, interaction.user, error, 'track_menu_viewruns_image_render').catch(() => {});
    if (state.orientation === 'portrait') {
      image = await buildTrackRunsImage(page, runIndexMap, selectedColumns, 'landscape').catch(() => null);
    }
  }
  const imageName = `runs-history-${state.orientation}.png`;
  const files = image
    ? [new AttachmentBuilder(image, { name: imageName })]
    : [];

  const embed = new EmbedBuilder()
    .setTitle('📊 Runs Viewer')
    .setColor(Colors.Blue)
    .setDescription(`Showing ${filtered.length ? offset + 1 : 0}-${Math.min(offset + pageSize, filtered.length)} of ${filtered.length} runs.`);

  if (image) {
    embed.setImage(`attachment://${imageName}`);
  }

  const typeMenu = new ActionRowBuilder<StringSelectMenuBuilder>().addComponents(
    new StringSelectMenuBuilder()
      .setCustomId(TRACKER_IDS.viewRuns.types)
      .setPlaceholder(viewUi.typePlaceholder)
      .setMinValues(1)
      .setMaxValues(Math.max(1, availableTypes.length))
      .addOptions(availableTypes.map(type => ({ label: type, value: type, default: selectedTypes.includes(type) }))),
  );

  const tierOptions = [{ label: viewUi.allTiersLabel, value: 'All', default: selectedTiers.includes('All') }, ...availableTiers.map(tier => ({ label: `Tier ${tier}`, value: tier, default: selectedTiers.includes(tier) }))];
  const tierMenu = new ActionRowBuilder<StringSelectMenuBuilder>().addComponents(
    new StringSelectMenuBuilder()
      .setCustomId(TRACKER_IDS.viewRuns.tiers)
      .setPlaceholder(viewUi.tierPlaceholder)
      .setMinValues(1)
      .setMaxValues(Math.max(1, tierOptions.length))
      .addOptions(tierOptions),
  );

  const countMenu = new ActionRowBuilder<StringSelectMenuBuilder>().addComponents(
    new StringSelectMenuBuilder()
      .setCustomId(TRACKER_IDS.viewRuns.count)
      .setPlaceholder(viewUi.countPlaceholder)
      .addOptions(...viewUi.countOptions.map((opt) => ({ label: `${opt} per page`, value: String(opt), default: count === opt }))),
  );

  const columnsMenu = new ActionRowBuilder<StringSelectMenuBuilder>().addComponents(
    new StringSelectMenuBuilder()
      .setCustomId(TRACKER_IDS.viewRuns.columns)
      .setPlaceholder(viewUi.columnsPlaceholder)
      .setMinValues(1)
      .setMaxValues(TRACK_COLUMN_OPTIONS.length)
      .addOptions(...TRACK_COLUMN_OPTIONS.map((col) => ({ label: col, value: col, default: selectedColumns.includes(col) }))),
  );

  const nav = new ActionRowBuilder<ButtonBuilder>().addComponents(
    new ButtonBuilder().setCustomId(TRACKER_IDS.viewRuns.prev).setLabel(viewUi.buttons.prev).setStyle(ButtonStyle.Secondary).setDisabled(offset <= 0),
    new ButtonBuilder().setCustomId(TRACKER_IDS.viewRuns.next).setLabel(viewUi.buttons.next).setStyle(ButtonStyle.Secondary).setDisabled(offset + pageSize >= filtered.length),
    new ButtonBuilder().setCustomId(TRACKER_IDS.viewRuns.share).setLabel(viewUi.buttons.share).setStyle(ButtonStyle.Success).setDisabled(Boolean(options?.disableShareButton)),
    new ButtonBuilder()
      .setCustomId(withViewRunsOrientationTarget(state.orientation === 'landscape' ? 'portrait' : 'landscape'))
      .setLabel(state.orientation === 'landscape' ? 'Landscape' : 'Portrait')
      .setStyle(ButtonStyle.Secondary),
    new ButtonBuilder().setCustomId(TRACKER_IDS.flow.mainMenu).setLabel(viewUi.buttons.mainMenu).setStyle(ButtonStyle.Primary),
  );

  const controls = state.orientation === 'portrait'
    ? [typeMenu, tierMenu, columnsMenu, nav]
    : [typeMenu, tierMenu, countMenu, columnsMenu, nav];

  await interaction.editReply({ content: '', embeds: [embed], components: controls, files }).catch(() => {});
}

export async function handleTrackMenuViewRunsTypes(interaction: TrackMenuInteraction) {
  const mode = getTrackerFlowMode(interaction.user.id);
  if (mode === 'lifetime') {
    await interaction.deferUpdate().catch(() => {});
    const runs = asRunListItems(await getLocalLifetimeData(interaction.user.id).catch(() => []));
    await renderViewRunsPanel(interaction, runs, getViewRunsState(interaction.user.id), mode);
    return;
  }
  const selected = getSelectedValues(interaction);
  const state = updateViewRunsState(interaction.user.id, { selectedTypes: selected, offset: 0 });
  const summary = await getLastRun(interaction.user.id, { cloudSyncMode: 'none' });
  await interaction.deferUpdate().catch(() => {});
  await renderViewRunsPanel(interaction, asRunListItems(summary?.allRuns ?? []), state, mode);
}

export async function handleTrackMenuViewRunsTiers(interaction: TrackMenuInteraction) {
  const mode = getTrackerFlowMode(interaction.user.id);
  if (mode === 'lifetime') {
    await interaction.deferUpdate().catch(() => {});
    const runs = asRunListItems(await getLocalLifetimeData(interaction.user.id).catch(() => []));
    await renderViewRunsPanel(interaction, runs, getViewRunsState(interaction.user.id), mode);
    return;
  }
  const selected = getSelectedValues(interaction);
  const normalized = selected.includes('All') ? ['All'] : selected;
  const state = updateViewRunsState(interaction.user.id, { selectedTiers: normalized, offset: 0 });
  const summary = await getLastRun(interaction.user.id, { cloudSyncMode: 'none' });
  await interaction.deferUpdate().catch(() => {});
  await renderViewRunsPanel(interaction, asRunListItems(summary?.allRuns ?? []), state, mode);
}

export async function handleTrackMenuViewRunsSelect(interaction: TrackMenuInteraction) {
  const mode = getTrackerFlowMode(interaction.user.id);
  const nextCount = parseInt(getSelectedValues(interaction)[0] ?? '10', 10);
  const state = updateViewRunsState(interaction.user.id, { count: Number.isFinite(nextCount) ? nextCount : 10, offset: 0 });
  const runs = mode === 'lifetime'
    ? asRunListItems(await getLocalLifetimeData(interaction.user.id).catch(() => []))
    : asRunListItems((await getLastRun(interaction.user.id, { cloudSyncMode: 'none' }))?.allRuns ?? []);
  await interaction.deferUpdate().catch(() => {});
  await renderViewRunsPanel(interaction, runs, state, mode);
}

export async function handleTrackMenuViewRunsColumns(interaction: TrackMenuInteraction) {
  const mode = getTrackerFlowMode(interaction.user.id);
  const selectedColumns = getSelectedValues(interaction);
  const state = updateViewRunsState(interaction.user.id, { selectedColumns });
  const runs = mode === 'lifetime'
    ? asRunListItems(await getLocalLifetimeData(interaction.user.id).catch(() => []))
    : asRunListItems((await getLastRun(interaction.user.id, { cloudSyncMode: 'none' }))?.allRuns ?? []);
  await interaction.deferUpdate().catch(() => {});
  await renderViewRunsPanel(interaction, runs, state, mode);
}

export async function handleTrackMenuViewRunsOrientation(interaction: TrackMenuInteraction) {
  const mode = getTrackerFlowMode(interaction.user.id);
  if (mode === 'lifetime') {
    await interaction.deferUpdate().catch(() => {});
    const runs = asRunListItems(await getLocalLifetimeData(interaction.user.id).catch(() => []));
    await renderViewRunsPanel(interaction, runs, getViewRunsState(interaction.user.id), mode);
    return;
  }

  const current = getViewRunsState(interaction.user.id);
  const explicitTarget = parseViewRunsOrientationTarget('customId' in interaction ? interaction.customId : '');
  const orientation: 'landscape' | 'portrait' = explicitTarget === 'portrait'
    ? 'portrait'
    : explicitTarget === 'landscape'
      ? 'landscape'
      : current.orientation === 'landscape'
        ? 'portrait'
        : 'landscape';
  const state = updateViewRunsState(interaction.user.id, { orientation });
  const runs = asRunListItems((await getLastRun(interaction.user.id, { cloudSyncMode: 'none' }))?.allRuns ?? []);
  await interaction.deferUpdate().catch(() => {});
  await renderViewRunsPanel(interaction, runs, state, mode);
}

export async function handleTrackMenuViewRunsPrev(interaction: TrackMenuInteraction) {
  const mode = getTrackerFlowMode(interaction.user.id);
  const current = getViewRunsState(interaction.user.id);
  const step = current.orientation === 'portrait' ? 1 : current.count;
  const state = updateViewRunsState(interaction.user.id, { offset: Math.max(0, current.offset - step) });
  const runs = mode === 'lifetime'
    ? asRunListItems(await getLocalLifetimeData(interaction.user.id).catch(() => []))
      : asRunListItems((await getLastRun(interaction.user.id, { cloudSyncMode: 'none' }))?.allRuns ?? []);
  await interaction.deferUpdate().catch(() => {});
  await renderViewRunsPanel(interaction, runs, state, mode);
}

export async function handleTrackMenuViewRunsNext(interaction: TrackMenuInteraction) {
  const mode = getTrackerFlowMode(interaction.user.id);
  const current = getViewRunsState(interaction.user.id);
  const step = current.orientation === 'portrait' ? 1 : current.count;
  const state = updateViewRunsState(interaction.user.id, { offset: Math.max(0, current.offset + step) });
  const runs = mode === 'lifetime'
    ? asRunListItems(await getLocalLifetimeData(interaction.user.id).catch(() => []))
      : asRunListItems((await getLastRun(interaction.user.id, { cloudSyncMode: 'none' }))?.allRuns ?? []);
  await interaction.deferUpdate().catch(() => {});
  await renderViewRunsPanel(interaction, runs, state, mode);
}

export async function handleTrackMenuShareRuns(interaction: TrackMenuInteraction) {
  try {
    const mode = getTrackerFlowMode(interaction.user.id);
    const ui = getTrackerUiConfig(mode);
    const viewUi = ui.viewRuns;
    const summary = mode === 'track'
      ? await getLastRun(interaction.user.id, { cloudSyncMode: 'none' }).catch(() => null)
      : null;
    const runs = mode === 'lifetime'
      ? asRunListItems(await getLocalLifetimeData(interaction.user.id).catch(() => []))
      : asRunListItems(summary?.allRuns ?? []);
    const runTypeCounts = mode === 'track' ? (summary?.runTypeCounts ?? {}) : {};
    const state = getViewRunsState(interaction.user.id);

    const pageRuns = (() => {
      if (mode === 'lifetime') {
        const sorted = [...runs].sort((a, b) => new Date(String(b.date ?? '')).getTime() - new Date(String(a.date ?? '')).getTime());
        const count = Math.max(1, state.count || 10);
        const maxOffset = Math.max(0, sorted.length - count);
        const offset = Math.min(Math.max(0, state.offset || 0), maxOffset);
        const page = sorted.slice(offset, offset + count);
        return page.map((run, index) => ({ run, runNumber: offset + index + 1 }));
      }

      const availableTypes = [...new Set(runs.map((r) => (r.type || 'Farming')))].sort();
      const selectedTypes = state.selectedTypes.length ? state.selectedTypes.filter(t => availableTypes.includes(t)) : [...availableTypes];
      const selectedTiers = state.selectedTiers.length ? state.selectedTiers : ['All'];
      const filtered = buildFilteredRuns(runs, { selectedTypes, selectedTiers });
      const runIndexMap = buildRunIndexMap(runs);
      const count = Math.max(1, state.count || 10);
      const pageSize = state.orientation === 'portrait' ? 1 : count;
      const effectiveMaxOffset = Math.max(0, filtered.length - pageSize);
      const offset = Math.min(Math.max(0, state.offset || 0), effectiveMaxOffset);
      const page = filtered.slice(offset, offset + pageSize);
      return page.map((run) => ({ run, runNumber: runIndexMap.get(runIdentityKey(run)) ?? 0 }));
    })();

    if (!pageRuns.length) {
      await interaction.reply({ content: viewUi.share.empty, ephemeral: true }).catch(() => {});
      return;
    }

    const token = randomUUID();
    runShareSessions.set(token, {
      token,
      userId: interaction.user.id,
      mode,
      sourceInteraction: interaction as MessageComponentInteraction,
      selectedIndices: [0],
      pageRuns,
      runTypeCounts,
      createdAt: Date.now(),
    });

    const options = pageRuns.slice(0, 25).map((entry, index) => buildShareRunOption(entry, index, 0));

    const selectRow = new ActionRowBuilder<StringSelectMenuBuilder>().addComponents(
      new StringSelectMenuBuilder()
        .setCustomId(withToken(TRACKER_IDS.viewRuns.shareSelectPrefix, token))
        .setPlaceholder('Select runs to share/delete')
        .setMinValues(1)
        .setMaxValues(Math.max(1, Math.min(options.length, 25)))
        .addOptions(options),
    );

    const buttonRow = buildShareActionButtons(token, 1);

    await interaction.reply({
      ephemeral: true,
      components: [selectRow, buttonRow],
    }).catch(() => {});
  } catch (error) {
    const ui = getTrackerUiConfig(getTrackerFlowMode(interaction.user.id));
    await logError(interaction.client, interaction.user, error, 'track_menu_share_runs');
    const details = error instanceof Error ? ` ${error.message}` : '';
    await interaction.reply({ content: `${ui.viewRuns.share.failed}${details}`.trim(), ephemeral: true }).catch(() => {});
  }
}

export async function handleTrackMenuShareRunsSelect(interaction: TrackMenuInteraction) {
  try {
    const token = parsePrefixedTrackerToken(TRACKER_IDS.viewRuns.shareSelectPrefix, interaction.customId);
    if (!token) {
      await updateOrEdit(interaction, { content: 'Share session expired. Please start again.', components: [] });
      return;
    }
    const session = runShareSessions.get(token);
    if (!session || session.userId !== interaction.user.id) {
      await updateOrEdit(interaction, { content: 'Share session expired. Please start again.', components: [] });
      return;
    }

    const selectedValues = getSelectedValues(interaction);
    const nextIndices = selectedValues
      .map((value) => parseInt(value, 10))
      .filter((value) => Number.isFinite(value))
      .map((value) => Math.max(0, Math.min(session.pageRuns.length - 1, value)));
    const uniqueIndices = Array.from(new Set(nextIndices));
    session.selectedIndices = uniqueIndices.length ? uniqueIndices : [0];
    runShareSessions.set(token, session);
    const firstSelected = session.selectedIndices[0] ?? 0;

    const selectedSet = new Set(session.selectedIndices);
    const options = session.pageRuns.slice(0, 25).map((entry, index) => ({
      ...buildShareRunOption(entry, index, firstSelected),
      default: selectedSet.has(index),
    }));

    const selectRow = new ActionRowBuilder<StringSelectMenuBuilder>().addComponents(
      new StringSelectMenuBuilder()
        .setCustomId(withToken(TRACKER_IDS.viewRuns.shareSelectPrefix, token))
        .setPlaceholder('Select runs to share/delete')
        .setMinValues(1)
        .setMaxValues(Math.max(1, Math.min(options.length, 25)))
        .addOptions(options),
    );

    const buttonRow = buildShareActionButtons(token, session.selectedIndices.length);

    await updateOrEdit(interaction, {
      content: '',
      components: [selectRow, buttonRow],
    });
  } catch (error) {
    await logError(interaction.client, interaction.user, error, 'track_menu_share_runs_select');
    await updateOrEdit(interaction, { content: 'Unable to update selected run.', components: [] });
  }
}

export async function handleTrackMenuShareRunsConfirm(interaction: TrackMenuInteraction) {
  try {
    const token = parsePrefixedTrackerToken(TRACKER_IDS.viewRuns.shareConfirmPrefix, interaction.customId);
    if (!token) {
      await updateOrEdit(interaction, { content: 'Share session expired. Please start again.', components: [] });
      return;
    }
    const session = runShareSessions.get(token);
    if (!session || session.userId !== interaction.user.id) {
      await updateOrEdit(interaction, { content: 'Share session expired. Please start again.', components: [] });
      return;
    }
    const viewUi = getTrackerUiConfig(session.mode).viewRuns;

    const firstSelectedIndex = session.selectedIndices[0] ?? 0;
    const selected = session.pageRuns[firstSelectedIndex];
    if (!selected) {
      await updateOrEdit(interaction, { content: viewUi.share.empty, components: [] });
      return;
    }

    const run = selected.run;
    let embed: EmbedBuilder;
    if (session.mode === 'lifetime') {
      embed = new EmbedBuilder()
        .setTitle(viewUi.share.title)
        .setDescription(`Shared Run #${selected.runNumber}`)
        .setColor(Colors.Blue);
      embed.addFields({
        name: `Run #${selected.runNumber}`,
        value: `Date: ${String(run.date ?? 'Unknown')}\nCoins: ${String(run.coinsEarned ?? '0')} · Cells: ${String(run.cellsEarned ?? '0')} · Dice: ${String(run.rerollShardsEarned ?? '0')}`,
        inline: false,
      });
    } else {
      const settings = await getUserSettings(session.userId).catch(() => null);
      embed = buildShareEmbed({
        user: interaction.user,
        run,
        runTypeCounts: session.runTypeCounts,
        options: {
          includeTier: settings?.shareTier !== false,
          includeWave: settings?.shareWave !== false,
          includeDuration: settings?.shareDuration !== false,
          includeKilledBy: settings?.shareKilledBy !== false,
          includeTotalCoins: settings?.shareTotalCoins !== false,
          includeTotalCells: settings?.shareTotalCells !== false,
          includeTotalDice: settings?.shareTotalDice !== false,
          includeCoinsPerHour: settings?.shareCoinsPerHour !== false,
          includeCellsPerHour: settings?.shareCellsPerHour !== false,
          includeDicePerHour: settings?.shareDicePerHour !== false,
          includeNotes: settings?.shareNotes !== false,
          includeCoverage: settings?.shareCoverage !== false,
          includeScreenshot: settings?.shareScreenshot !== false,
        },
      });
    }

    const channel = interaction.channel;
    if (channel && 'send' in channel && typeof channel.send === 'function') {
      try {
        await channel.send({ embeds: [embed] });
      } catch (error) {
        const message = error instanceof Error ? error.message : 'unknown channel error';
        throw new Error(`Share failed: ${message}`);
      }
    } else {
      throw new Error('Share failed: channel does not support sending embeds.');
    }

    const sourceMode = session.mode;
    const sourceState = getViewRunsState(session.userId);
    const latestRuns = sourceMode === 'lifetime'
      ? asRunListItems(await getLocalLifetimeData(session.userId).catch(() => []))
      : asRunListItems((await getLastRun(session.userId, { cloudSyncMode: 'none' }))?.allRuns ?? []);
    await renderViewRunsPanel(session.sourceInteraction, latestRuns, sourceState, sourceMode, { disableShareButton: true }).catch(() => {});

    runShareSessions.delete(token);
    await updateOrEdit(interaction, { content: 'Run Shared!', components: [], embeds: [] });
  } catch (error) {
    const ui = getTrackerUiConfig(getTrackerFlowMode(interaction.user.id));
    await logError(interaction.client, interaction.user, error, 'track_menu_share_runs_confirm');
    const details = error instanceof Error ? ` ${error.message}` : '';
    await updateOrEdit(interaction, { content: `${ui.viewRuns.share.failed}${details}`.trim(), components: [] });
  }
}

export async function handleTrackMenuShareRunsDelete(interaction: TrackMenuInteraction) {
  try {
    const token = parsePrefixedTrackerToken(TRACKER_IDS.viewRuns.shareDeletePrefix, interaction.customId);
    if (!token) {
      await updateOrEdit(interaction, { content: 'Share/Delete session expired. Please start again.', components: [] });
      return;
    }
    const session = runShareSessions.get(token);
    if (!session || session.userId !== interaction.user.id) {
      await updateOrEdit(interaction, { content: 'Share/Delete session expired. Please start again.', components: [] });
      return;
    }

    const selectedRuns = session.selectedIndices
      .map((index) => session.pageRuns[index])
      .filter((item): item is ShareSessionRun => Boolean(item));

    if (!selectedRuns.length) {
      await updateOrEdit(interaction, { content: 'No runs selected to delete.', components: [] });
      return;
    }

    await updateOrEdit(interaction, { content: 'Deleting run(s)...', components: [] });
    runShareSessions.delete(token);

    const deletionResults = await Promise.allSettled(selectedRuns.map(async (item) => {
      const run = item.run;
      if (session.mode === 'lifetime') {
        const entryId = String(run.$id ?? run.id ?? run.runId ?? run.localId ?? '').trim();
        if (!entryId) return false;
        await removeLifetimeEntry({ userId: session.userId, username: interaction.user.username, entryId });
        return true;
      }

      const runId = String(run.runId ?? '').trim() || null;
      const localId = String(run.localId ?? '').trim() || null;
      if (!runId && !localId) return false;
      await removeLastRun({ userId: session.userId, runId, localId });
      return true;
    }));

    const deletedCount = deletionResults.reduce((count, result) => {
      if (result.status === 'fulfilled' && result.value) {
        return count + 1;
      }
      return count;
    }, 0);

    const sourceMode = session.mode;
    const sourceState = getViewRunsState(session.userId);
    const latestRuns = sourceMode === 'lifetime'
      ? asRunListItems(await getLocalLifetimeData(session.userId).catch(() => []))
      : asRunListItems((await getLastRun(session.userId, { cloudSyncMode: 'none' }))?.allRuns ?? []);
    await renderViewRunsPanel(session.sourceInteraction, latestRuns, sourceState, sourceMode).catch(() => {});

    if (deletedCount <= 0) {
      await updateOrEdit(interaction, { content: 'No runs were deleted.', components: [] });
    }
  } catch (error) {
    const ui = getTrackerUiConfig(getTrackerFlowMode(interaction.user.id));
    await logError(interaction.client, interaction.user, error, 'track_menu_share_runs_delete');
    await updateOrEdit(interaction, { content: `${ui.viewRuns.share.failed}`.trim(), components: [] });
  }
}

export async function handleTrackMenuShareRunsEdit(interaction: TrackMenuInteraction) {
  try {
    const token = parsePrefixedTrackerToken(TRACKER_IDS.viewRuns.shareEditPrefix, interaction.customId);
    if (!token) {
      await updateOrEdit(interaction, { content: 'Share/Edit session expired. Please start again.', components: [] });
      return;
    }
    const session = runShareSessions.get(token);
    if (!session || session.userId !== interaction.user.id) {
      await updateOrEdit(interaction, { content: 'Share/Edit session expired. Please start again.', components: [] });
      return;
    }

    const firstSelectedIndex = session.selectedIndices[0] ?? 0;
    const selected = session.pageRuns[firstSelectedIndex];
    if (!selected) {
      await updateOrEdit(interaction, { content: 'No run selected to edit.', components: [] });
      return;
    }

    const pending = await createPendingRun({
      userId: interaction.user.id,
      username: interaction.user.username,
      runData: {
        ...selected.run,
        runId: selected.run.runId,
      },
      screenshot: typeof selected.run.screenshotUrl === 'string' && selected.run.screenshotUrl.trim()
        ? { url: selected.run.screenshotUrl, name: 'screenshot.png', contentType: 'image/png' }
        : null,
      canonicalRunData: {
        ...selected.run,
      },
      decimalPreference: undefined,
      isDuplicate: Boolean(selected.run.runId),
      runSource: 'unknown',
    });

    runShareSessions.delete(token);
    await renderEditFieldPicker(interaction as unknown as TrackReplyInteractionLike, pending.token, pending, 'update');
  } catch (error) {
    await logError(interaction.client, interaction.user, error, 'track_menu_share_runs_edit');
    await updateOrEdit(interaction, { content: 'Unable to open edit flow for selected run.', components: [] });
  }
}

export async function handleTrackMenuShareRunsCancel(interaction: TrackMenuInteraction) {
  try {
    const token = parsePrefixedTrackerToken(TRACKER_IDS.viewRuns.shareCancelPrefix, interaction.customId);
    if (!token) {
      await updateOrEdit(interaction, { content: 'Run share canceled.', components: [] });
      return;
    }
    runShareSessions.delete(token);
    await updateOrEdit(interaction, { content: 'Run share canceled.', components: [] });
  } catch (error) {
    await logError(interaction.client, interaction.user, error, 'track_menu_share_runs_cancel');
    await updateOrEdit(interaction, { content: 'Unable to cancel run share.', components: [] });
  }
}
