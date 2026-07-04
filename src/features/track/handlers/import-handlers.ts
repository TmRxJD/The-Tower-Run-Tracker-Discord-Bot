import * as Discord from 'discord.js';
import {
  ActionRowBuilder,
  AttachmentBuilder,
  ButtonBuilder,
  ButtonStyle,
  Colors,
  EmbedBuilder,
  ModalBuilder,
  StringSelectMenuBuilder,
  StringSelectMenuOptionBuilder,
  type MessageComponentInteraction,
  type ModalSubmitInteraction,
} from 'discord.js';
import { logger } from '../../../core/logger';
import {
  defaultSelectedSaveImportTrackerKeys,
  detectMisplacedPlayerInfoSave,
  discoverSaveImportTrackers,
  executeSaveImportTrackers,
  formatSaveImportDiscoverySummary,
  SAVE_IMPORT_TRACKER_ORDER,
  type SaveImportExecutionOutcome,
  type SaveImportTrackerKey,
} from '@tmrxjd/platform/tools';
import { createDiscordSaveImportPort } from '../import/save-import-port';
import { decodePlayerInfoSaveBytes } from '@tmrxjd/platform/node';
import { awaitOwnedModalSubmit } from '../../../core/interaction-session';
import { getTrackUiConfig } from '../../../config/tracker-ui-config';
import { TRACKER_IDS, withToken } from '../track-custom-ids';
import { logError } from './error-handlers';
import { getLocalRuns } from '../local-run-store';
import { invalidateBotLocalRunsCache } from '../../../rxdb/run-rxdb-store';
import { getUserSettings } from '../tracker-api-client';
import { getViewRunsPresentationPrefs } from '../view-runs-store';
import { renderImportPreviewTableImage, type ViewRunsTableRun } from '../ui/view-runs-table-image';
import {
  createImportPendingSession,
  deleteImportPendingSession,
  getImportPendingSession,
  updateImportPendingSession,
  type ImportPendingSession,
  type ImportTrackerOutcome,
} from '../import/import-pending-store';
import type { TrackReplyInteractionLike } from '../interaction-types';

type TrackMenuInteraction = MessageComponentInteraction | ModalSubmitInteraction;
type LogClient = { channels: { fetch: (id: string) => Promise<unknown> } };
type BuildersLike = {
  LabelBuilder: new () => {
    setLabel: (label: string) => {
      setFileUploadComponent: (component: unknown) => unknown;
    };
  };
  FileUploadBuilder: new () => {
    setCustomId: (customId: string) => {
      setRequired: (required: boolean) => void;
    };
  };
};

type ModalWithLabelComponents = ModalBuilder & {
  addLabelComponents: (...components: unknown[]) => ModalBuilder;
};

type DynamicFileLike = {
  url?: string;
  proxy_url?: string;
  attachment?: string;
  name?: string;
  filename?: string;
  content_type?: string;
  contentType?: string;
};

type NormalizedFile = {
  url: string;
  name: string;
  contentType: string;
};

function resolveSaveImportSourcePathFromFileName(name?: string | null): string | null {
  const normalized = String(name ?? '').trim();
  if (!normalized) return null;
  if (normalized.includes('/') || normalized.includes('\\')) return normalized;
  return null;
}

function toRecord(value: unknown): Record<string, unknown> {
  return typeof value === 'object' && value !== null ? (value as Record<string, unknown>) : {};
}

function looksLikeFile(value: unknown): value is DynamicFileLike {
  if (!value || typeof value !== 'object') return false;
  const record = toRecord(value);
  return 'name' in record || 'filename' in record || 'url' in record || 'attachment' in record || 'proxy_url' in record;
}

function findByCustomIdDeep(node: unknown, id: string, seen = new Set<unknown>()): Record<string, unknown> | null {
  if (!node || typeof node !== 'object') return null;
  if (seen.has(node)) return null;
  seen.add(node);
  const record = toRecord(node);
  if (record.customId === id) return record;
  if (Array.isArray(node)) {
    for (const item of node) {
      const found = findByCustomIdDeep(item, id, seen);
      if (found) return found;
    }
    return null;
  }
  for (const value of Object.values(record)) {
    const found = findByCustomIdDeep(value, id, seen);
    if (found) return found;
  }
  return null;
}

function toArray(value: unknown): unknown[] {
  if (!value) return [];
  if (Array.isArray(value)) return value;
  const record = toRecord(value);
  if (typeof record.values === 'function') {
    try {
      return Array.from((record.values as () => Iterable<unknown>)());
    } catch {
      return [];
    }
  }
  return Object.values(record);
}

async function extractModalUploadedFile(
  submitted: ModalSubmitInteraction,
  customId: string,
): Promise<NormalizedFile | null> {
  const assign = (file: unknown): NormalizedFile | null => {
    if (!file || !looksLikeFile(file)) return null;
    const url = file.url || file.proxy_url || file.attachment || null;
    const name = file.name || file.filename || 'playerInfo.dat';
    const contentType = file.content_type || file.contentType || 'application/octet-stream';
    return url ? { url, name, contentType } : null;
  };

  try {
    const submittedRecord = toRecord(submitted);
    const attachmentContainer = toRecord(submittedRecord.attachments);
    const first = typeof attachmentContainer.first === 'function'
      ? (attachmentContainer.first as () => unknown)()
      : null;
    const modalAttachment = first || (Array.isArray(submittedRecord.attachments) ? submittedRecord.attachments[0] : null);
    const normalized = assign(modalAttachment);
    if (normalized) return normalized;
  } catch {
    /* ignore */
  }

  const fileComp = findByCustomIdDeep(submitted, customId);
  const candidates = [...toArray(fileComp?.files), ...toArray(fileComp?.attachments)];
  for (const candidate of candidates) {
    const normalized = assign(candidate);
    if (normalized) return normalized;
  }

  return null;
}

async function downloadFileBuffer(file: NormalizedFile): Promise<Buffer> {
  const response = await fetch(file.url);
  if (!response.ok) {
    throw new Error(`Failed to download save file: ${response.status}`);
  }
  const arrayBuffer = await response.arrayBuffer();
  return Buffer.from(arrayBuffer);
}

async function buildImportPreviewImage(userId: string, runs: Record<string, unknown>[]): Promise<Buffer> {
  const presentation = getViewRunsPresentationPrefs(userId);
  return renderImportPreviewTableImage(runs as ViewRunsTableRun[], presentation);
}

function buildImportWebsiteButton() {
  const ui = getTrackUiConfig();
  return new ButtonBuilder()
    .setLabel(ui.import.buttons.viewWebsite)
    .setStyle(ButtonStyle.Link)
    .setURL(ui.initialMenu.url);
}

function buildImportReviewButtons(token: string) {
  const ui = getTrackUiConfig();
  return [
    new ActionRowBuilder<ButtonBuilder>().addComponents(
      new ButtonBuilder()
        .setCustomId(withToken(TRACKER_IDS.flow.importAcceptPrefix, token))
        .setLabel(ui.import.buttons.accept)
        .setStyle(ButtonStyle.Success)
        .setEmoji('✅'),
      new ButtonBuilder()
        .setCustomId(withToken(TRACKER_IDS.flow.importCancelPrefix, token))
        .setLabel(ui.import.buttons.cancel)
        .setStyle(ButtonStyle.Secondary)
        .setEmoji('✖️'),
      new ButtonBuilder()
        .setCustomId(TRACKER_IDS.flow.mainMenu)
        .setLabel(ui.viewRuns.buttons.mainMenu)
        .setStyle(ButtonStyle.Secondary)
        .setEmoji('🏠'),
    ),
  ];
}

function buildImportTrackerSelectRow(session: ImportPendingSession) {
  const ui = getTrackUiConfig();
  const selectable = session.discoveries.filter(tracker => tracker.count > 0);
  if (selectable.length === 0) return null;

  const menu = new StringSelectMenuBuilder()
    .setCustomId(withToken(TRACKER_IDS.flow.importSelectPrefix, session.token))
    .setPlaceholder(ui.import.trackerSelectPlaceholder)
    .setMinValues(0)
    .setMaxValues(Math.min(25, selectable.length))
    .addOptions(
      selectable.map(tracker => new StringSelectMenuOptionBuilder()
        .setLabel(tracker.label)
        .setDescription(tracker.summary.slice(0, 100))
        .setValue(tracker.key)
        .setDefault(session.selectedTrackerKeys.includes(tracker.key))),
    );

  return new ActionRowBuilder<StringSelectMenuBuilder>().addComponents(menu);
}

function summarizeImportOutcomes(outcomes: ImportTrackerOutcome[]): string {
  if (!outcomes.length) return 'Nothing was imported.';
  return outcomes.map(outcome => {
    const prefix = outcome.status === 'imported' ? '✅' : outcome.status === 'skipped' ? '⏭️' : '❌';
    return `${prefix} **${outcome.label}** — ${outcome.message}`;
  }).join('\n');
}

function hasImportableSelection(session: ImportPendingSession): boolean {
  const selected = new Set(session.selectedTrackerKeys);
  return session.discoveries.some(tracker => {
    if (!selected.has(tracker.key)) return false;
    if (tracker.key === 'battleReports') return session.runs.length > 0;
    return tracker.count > 0;
  });
}

async function renderImportReviewSession(
  interaction: TrackMenuInteraction,
  session: ImportPendingSession,
) {
  const ui = getTrackUiConfig();
  const trackerSummary = formatSaveImportDiscoverySummary(session.discoveries, session.selectedTrackerKeys);
  const embed = new EmbedBuilder()
    .setColor(Colors.Gold)
    .setTitle(ui.import.reviewTitle)
    .setDescription(
      ui.import.reviewDescriptionTemplate.replace('{trackerSummary}', trackerSummary),
    );

  const files: AttachmentBuilder[] = [];
  const showBattlePreview = session.selectedTrackerKeys.includes('battleReports') && session.runs.length > 0;
  if (showBattlePreview) {
    const png = await buildImportPreviewImage(interaction.user.id, session.runs);
    files.push(new AttachmentBuilder(png, { name: 'import-preview.png' }));
    embed.setImage('attachment://import-preview.png');
  }

  const selectRow = buildImportTrackerSelectRow(session);
  const components = [
    ...(selectRow ? [selectRow] : []),
    ...buildImportReviewButtons(session.token),
  ];

  await interaction.editReply({
    content: hasImportableSelection(session) ? '' : ui.import.noRunsFound,
    embeds: [embed],
    components,
    files,
  }).catch(() => {});
}

async function importSelectedTrackers(
  interaction: TrackMenuInteraction,
  session: ImportPendingSession,
  onProgress: (message: string) => Promise<void>,
): Promise<ImportTrackerOutcome[]> {
  const selectedKeys = session.selectedTrackerKeys.filter(key =>
    session.discoveries.some(tracker => tracker.key === key && tracker.count > 0),
  ) as SaveImportTrackerKey[];

  const port = createDiscordSaveImportPort(interaction);
  const ui = getTrackUiConfig();
  invalidateBotLocalRunsCache(interaction.user.id);
  const existingRuns = await getLocalRuns(interaction.user.id);

  const outcomes = await executeSaveImportTrackers({
    parsedRoot: session.parsedRoot,
    selectedKeys,
    port,
    existingRuns,
    onProgress: async event => {
      await onProgress(
        ui.import.importingTrackerTemplate
          .replace('{label}', event.label)
          .replace('{index}', String(event.index))
          .replace('{total}', String(event.total)),
      );
    },
  });

  return outcomes.map((outcome: SaveImportExecutionOutcome) => ({
    key: outcome.key,
    label: outcome.label,
    status: outcome.status,
    message: outcome.message ?? '',
    importedCount: outcome.importedCount,
  }));
}

async function renderImportSuccess(
  interaction: TrackMenuInteraction,
  session: ImportPendingSession,
  outcomes: ImportTrackerOutcome[],
) {
  const ui = getTrackUiConfig();
  const embed = new EmbedBuilder()
    .setColor(Colors.Green)
    .setTitle(ui.import.successTitle)
    .setDescription(
      ui.import.successDescriptionTemplate.replace('{outcomeSummary}', summarizeImportOutcomes(outcomes)),
    );

  updateImportPendingSession(session.token, { importOutcomes: outcomes });

  await interaction.editReply({
    content: '',
    embeds: [embed],
    components: buildImportSuccessButtons(),
    files: [],
  }).catch(() => {});
}

function buildImportSuccessButtons() {
  const ui = getTrackUiConfig();
  return [
    new ActionRowBuilder<ButtonBuilder>().addComponents(
      new ButtonBuilder()
        .setCustomId(TRACKER_IDS.flow.viewRuns)
        .setLabel(ui.success.rows[1]?.[1]?.label ?? 'View Runs')
        .setStyle(ButtonStyle.Primary)
        .setEmoji('📈'),
      buildImportWebsiteButton(),
      new ButtonBuilder()
        .setCustomId(TRACKER_IDS.flow.mainMenu)
        .setLabel(ui.viewRuns.buttons.mainMenu)
        .setStyle(ButtonStyle.Secondary)
        .setEmoji('🏠'),
    ),
  ];
}

async function renderImportReview(
  interaction: TrackMenuInteraction,
  parsedRoot: Record<string, unknown>,
  discovery: ReturnType<typeof discoverSaveImportTrackers>,
  autoImported = false,
) {
  const ui = getTrackUiConfig();
  const userId = interaction.user.id;
  const { battleReportPlan, trackers } = discovery;
  const selectedTrackerKeys = defaultSelectedSaveImportTrackerKeys(trackers);

  if (!selectedTrackerKeys.length && !trackers.some(tracker => tracker.count > 0)) {
    await interaction.editReply({ content: ui.import.noRunsFound, embeds: [], components: [], files: [] }).catch(() => {});
    return;
  }

  const session = createImportPendingSession({
    userId,
    parsedRoot,
    runs: battleReportPlan.importable,
    discoveries: trackers,
    selectedTrackerKeys,
    skippedDuplicates: battleReportPlan.skippedDuplicates,
    totalInSave: battleReportPlan.totalInSave,
  });

  if (autoImported) {
    await handleImportAccept(interaction, session.token);
    return;
  }

  await renderImportReviewSession(interaction, session);
}

export async function processPlayerInfoSaveBuffer(
  interaction: TrackMenuInteraction,
  buffer: Buffer,
  options?: { sourcePath?: string | null },
): Promise<void> {
  const ui = getTrackUiConfig();
  await interaction.editReply({
    content: ui.import.processing,
    embeds: [],
    components: [],
    files: [],
  }).catch(() => {});

  try {
    const decoded = decodePlayerInfoSaveBytes(buffer);
    const misplaced = detectMisplacedPlayerInfoSave({
      sourcePath: options?.sourcePath ?? null,
      parsedRoot: decoded.parsedRoot,
      wasGzip: decoded.wasGzip,
    });
    if (misplaced) {
      await interaction.editReply({
        content: `${misplaced.title}\n\n${misplaced.fix}`,
        embeds: [],
        components: [],
        files: [],
      }).catch(() => {});
      return;
    }
    invalidateBotLocalRunsCache(interaction.user.id);
    const existingRuns = await getLocalRuns(interaction.user.id);
    const discovery = discoverSaveImportTrackers(decoded.parsedRoot, { existingRuns });
    logger.info('[save-import] discovery summary', {
      userId: interaction.user.id,
      wasGzip: decoded.wasGzip,
      battleRunCount: decoded.battleRunCount,
      rootKeyCount: Object.keys(decoded.parsedRoot).length,
      bots: discovery.trackers.find(tracker => tracker.key === 'bots'),
      cards: discovery.trackers.find(tracker => tracker.key === 'cards'),
      selectedByDefault: defaultSelectedSaveImportTrackerKeys(discovery.trackers),
    });
    const settings = await getUserSettings(interaction.user.id);
    const autoImport = settings?.confirmBeforeSubmit === false;
    await renderImportReview(interaction, decoded.parsedRoot as Record<string, unknown>, discovery, autoImport);
  } catch (error) {
    await logError(interaction.client as LogClient, interaction.user, error, 'import_playerinfo_decode');
    await interaction.editReply({ content: ui.import.decodeFailed, embeds: [], components: [], files: [] }).catch(() => {});
  }
}

export async function handleDirectSaveImport(
  interaction: TrackReplyInteractionLike,
  attachment: { url: string; name?: string; contentType?: string },
) {
  const file: NormalizedFile = {
    url: attachment.url,
    name: attachment.name ?? 'playerInfo.dat',
    contentType: attachment.contentType ?? 'application/octet-stream',
  };
  const ui = getTrackUiConfig();
  await interaction.editReply({ content: ui.import.downloading, embeds: [], components: [], files: [] }).catch(() => {});
  try {
    const buffer = await downloadFileBuffer(file);
    await processPlayerInfoSaveBuffer(interaction as unknown as TrackMenuInteraction, buffer, {
      sourcePath: resolveSaveImportSourcePathFromFileName(file.name),
    });
  } catch (error) {
    await logError(interaction.client as LogClient, interaction.user, error, 'import_direct_save');
    await interaction.editReply({ content: ui.import.downloadFailed, embeds: [], components: [], files: [] }).catch(() => {});
  }
}

export async function handleTrackMenuImport(interaction: TrackMenuInteraction) {
  const ui = getTrackUiConfig();
  const embed = new EmbedBuilder()
    .setTitle(ui.import.instructionsTitle)
    .setDescription(ui.import.instructionsDescription)
    .setColor(Colors.Blue);

  const openButton = new ButtonBuilder()
    .setCustomId(TRACKER_IDS.flow.importOpen)
    .setLabel(ui.import.buttons.openFilePicker)
    .setStyle(ButtonStyle.Primary);
  const cancelButton = new ButtonBuilder()
    .setCustomId(TRACKER_IDS.flow.cancel)
    .setLabel('Cancel')
    .setStyle(ButtonStyle.Secondary);
  const row = new ActionRowBuilder<ButtonBuilder>().addComponents(openButton, cancelButton);

  if (interaction.replied || interaction.deferred) {
    await interaction.editReply({ content: '', embeds: [embed], components: [row], files: [] }).catch(() => {});
  } else {
    await interaction.reply({ embeds: [embed], components: [row], ephemeral: true }).catch(() => {});
  }
}

export async function handleTrackMenuImportOpen(interaction: TrackMenuInteraction) {
  if (!('showModal' in interaction) || typeof interaction.showModal !== 'function') return;
  const ui = getTrackUiConfig();
  const Builders = Discord as unknown as BuildersLike;
  const modal = new ModalBuilder()
    .setCustomId(TRACKER_IDS.flow.importModal)
    .setTitle(ui.import.modalTitle);

  const fileUpload = new Builders.FileUploadBuilder().setCustomId(TRACKER_IDS.flow.importFile);
  try {
    fileUpload.setRequired(true);
  } catch {
    /* ignore */
  }
  const labeledFile = new Builders.LabelBuilder()
    .setLabel(ui.import.fileLabel)
    .setFileUploadComponent(fileUpload);
  (modal as ModalWithLabelComponents).addLabelComponents(labeledFile);

  await interaction.showModal(modal);

  try {
    const submitted = await awaitOwnedModalSubmit(interaction as MessageComponentInteraction, TRACKER_IDS.flow.importModal);
    await submitted.deferUpdate().catch(() => {});
    const uploaded = await extractModalUploadedFile(submitted, TRACKER_IDS.flow.importFile);
    if (!uploaded) {
      await submitted.editReply({ content: ui.import.noFile, embeds: [], components: [], files: [] }).catch(() => {});
      return;
    }
    const buffer = await downloadFileBuffer(uploaded);
    await processPlayerInfoSaveBuffer(submitted, buffer, {
      sourcePath: resolveSaveImportSourcePathFromFileName(uploaded.name),
    });
  } catch (error) {
    if (String(error || '').includes('TIME')) {
      await interaction.editReply({ content: ui.import.timedOut, embeds: [], components: [], files: [] }).catch(() => {});
      return;
    }
    await logError(interaction.client as LogClient, interaction.user, error, 'import_modal_flow');
  }
}

export async function handleImportAccept(
  interaction: TrackMenuInteraction,
  token: string,
) {
  const ui = getTrackUiConfig();
  const session = getImportPendingSession(token);
  if (!session || session.userId !== interaction.user.id) {
    await interaction.editReply({ content: ui.import.sessionExpired, embeds: [], components: [], files: [] }).catch(() => {});
    return;
  }

  if (!hasImportableSelection(session)) {
    await interaction.editReply({ content: ui.import.noRunsFound, embeds: [], components: [], files: [] }).catch(() => {});
    return;
  }

  if (!interaction.deferred && !interaction.replied) {
    await interaction.deferUpdate().catch(() => {});
  }

  await interaction.editReply({ content: ui.import.importing, embeds: [], components: [], files: [] }).catch(() => {});

  try {
    const outcomes = await importSelectedTrackers(
      interaction,
      session,
      async message => {
        await interaction.editReply({ content: message, embeds: [], components: [], files: [] }).catch(() => {});
      },
    );
    await renderImportSuccess(interaction, session, outcomes);
  } catch (error) {
    await logError(interaction.client as LogClient, interaction.user, error, 'import_accept');
    await interaction.editReply({ content: ui.import.importFailed, embeds: [], components: [], files: [] }).catch(() => {});
  }
}

export async function handleTrackMenuImportSelect(interaction: TrackMenuInteraction) {
  const ui = getTrackUiConfig();
  const token = interaction.customId.split(':').slice(1).join(':');
  const session = getImportPendingSession(token);
  if (!session || session.userId !== interaction.user.id) {
    await interaction.editReply({ content: ui.import.sessionExpired, embeds: [], components: [], files: [] }).catch(() => {});
    return;
  }

  const selectedValues = interaction.isStringSelectMenu()
    ? interaction.values.filter((value): value is SaveImportTrackerKey =>
      SAVE_IMPORT_TRACKER_ORDER.includes(value as SaveImportTrackerKey))
    : [];

  const updated = updateImportPendingSession(token, { selectedTrackerKeys: selectedValues });
  if (!updated) {
    await interaction.editReply({ content: ui.import.sessionExpired, embeds: [], components: [], files: [] }).catch(() => {});
    return;
  }

  await interaction.deferUpdate().catch(() => {});
  await renderImportReviewSession(interaction, updated);
}

export async function handleTrackMenuImportAccept(interaction: TrackMenuInteraction) {
  const token = interaction.customId.split(':').slice(1).join(':');
  await handleImportAccept(interaction, token);
}

export async function handleTrackMenuImportCancel(interaction: TrackMenuInteraction) {
  const ui = getTrackUiConfig();
  const token = interaction.customId.split(':').slice(1).join(':');
  deleteImportPendingSession(token);
  if ('update' in interaction && typeof interaction.update === 'function') {
    await interaction.update({ content: ui.import.cancelled, embeds: [], components: [], files: [] }).catch(() => {});
    return;
  }
  await interaction.editReply({ content: ui.import.cancelled, embeds: [], components: [], files: [] }).catch(() => {});
}
