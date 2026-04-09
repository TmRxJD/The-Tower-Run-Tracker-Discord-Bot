import * as Discord from 'discord.js';
import { canonicalizeRunDataForOutput, canonicalizeTrackerRunData } from '@tmrxjd/platform/tools';
import {
  extractTrackerImageText,
  preprocessTrackerImageForOcr,
} from '@tmrxjd/platform/node';
import {
  ActionRowBuilder,
  Attachment,
  ButtonBuilder,
  ButtonStyle,
  Colors,
  ComponentType,
  EmbedBuilder,
  ModalBuilder,
  MessageComponentInteraction,
  ModalSubmitInteraction,
  TextInputBuilder,
  TextInputStyle,
  StringSelectMenuBuilder,
} from 'discord.js';
import { awaitOwnedModalSubmit } from '../../../core/interaction-session';
import { handleError, logError } from './error-handlers';
import { logger } from '../../../core/logger';
import {
  formatOCRExtraction,
  getDecimalForLanguage,
  extractDateTimeFromImage,
  applyTierMetadata,
  parseTierString,
  hasPlusTier,
  formatDuration,
  formatDate,
  formatTime,
  parseBattleDateTime,
  parseRunDataFromText,
  findPotentialDuplicateRun,
} from './upload-helpers';
import { awaitBackgroundRunHydration, beginBackgroundRunHydration, getLastRun, getLocalLifetimeData, runOCR } from '../tracker-api-client';
import { getLocalRuns, getLocalSettings } from '../local-run-store';
import { resolveInteractionDisplayName } from '../discord-display-name';
import { getTrackerUiConfig } from '../../../config/tracker-ui-config';
import type { TrackerUiMode } from '../../../config/tracker-ui-config';
import {
  createLoadingEmbed,
  createUploadEmbed,
  createCancelButton,
  createErrorEmbed,
  createErrorRecoveryButtons,
  createInitialEmbed,
  createMainMenuButtons,
} from '../ui/tracker-ui';
import { createPendingRun, getPendingRun, updatePendingRun } from '../pending-run-store';
import { renderDataReview, renderEditFieldPicker } from './data-review-handlers';
import { buildRunSummaryEmbed } from '../track-presenter';
import { formatNumberForDisplay, parseNumberInput, standardizeNotation } from '../../../utils/tracker-math';
import { TRACKER_IDS, withToken } from '../track-custom-ids';
import type { TrackReplyInteractionLike } from '../interaction-types';
import { createManualHandlers } from './manual-handlers';
import { getTrackerFlowMode } from '../flow-mode-store';
import { parseLifetimeStatsFromOcrText } from './lifetime-ocr';

type LooseRecord = Record<string, unknown>;

type RunDataLike = LooseRecord & {
  tier?: unknown;
  wave?: unknown;
  roundDuration?: unknown;
  duration?: unknown;
  type?: unknown;
  runId?: unknown;
  notes?: unknown;
  note?: unknown;
  runDateTime?: {
    full?: unknown;
    combined?: unknown;
    date?: unknown;
    time?: unknown;
  };
};

type AttachmentLike = {
  url: string;
  name?: string;
  id?: string;
  contentType?: string;
};

type DynamicFileLike = {
  url?: string;
  proxy_url?: string;
  attachment?: string;
  name?: string;
  filename?: string;
  content_type?: string;
  contentType?: string;
  size?: number;
};

type NormalizedAttachment = {
  url: string;
  name: string;
  contentType: string;
};

type ModalWithLabelComponents = ModalBuilder & {
  addLabelComponents: (...components: unknown[]) => ModalBuilder;
};

type BuildersLike = {
  StringSelectMenuBuilder: typeof StringSelectMenuBuilder;
  LabelBuilder: new () => {
    setLabel: (label: string) => {
      setStringSelectMenuComponent: (component: StringSelectMenuBuilder) => unknown;
      setFileUploadComponent: (component: unknown) => unknown;
    };
  };
  FileUploadBuilder: new () => {
    setCustomId: (customId: string) => {
      setRequired: (required: boolean) => void;
    };
  };
};

type ModalLookup = {
  customId?: string;
  values?: string[];
  value?: string;
  files?: unknown;
  attachments?: unknown;
  [key: string]: unknown;
};

type LogClient = { channels: { fetch: (id: string) => Promise<unknown> } };

function toRecord(value: unknown): LooseRecord {
  return typeof value === 'object' && value !== null ? (value as LooseRecord) : {};
}

function toRunDataLike(value: unknown): RunDataLike {
  return toRecord(value) as RunDataLike;
}

function getRunDataFromParsedResponse(parsed: unknown): RunDataLike {
  const parsedRecord = toRunDataLike(parsed);
  return toRunDataLike(parsedRecord.runData ?? parsedRecord);
}

function findByCustomIdDeep(node: unknown, id: string, seen = new Set<unknown>()): ModalLookup | null {
  if (!node || typeof node !== 'object') return null;
  if (seen.has(node)) return null;
  seen.add(node);

  const record = toRecord(node);
  if (record.customId === id) return record as ModalLookup;

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

  if (typeof Symbol !== 'undefined' && Symbol.iterator in record) {
    try {
      return Array.from(value as Iterable<unknown>);
    } catch {
      return [];
    }
  }

  return Object.values(record);
}

function looksLikeFile(value: unknown): value is DynamicFileLike {
  if (!value || typeof value !== 'object') return false;
  const record = toRecord(value);
  return 'name' in record || 'filename' in record || 'content_type' in record || 'size' in record || 'url' in record || 'attachment' in record || 'proxy_url' in record;
}

function resolveBattleDateTime(...candidates: unknown[]) {
  for (const candidate of candidates) {
    if (!candidate) continue;
    if (candidate instanceof Date && !Number.isNaN(candidate.getTime())) return candidate;
    const parsed = parseBattleDateTime(candidate);
    if (parsed) return parsed;
  }
  return null;
}

function isInvalidDateValue(value: unknown) {
  if (!value || String(value).trim() === '' || String(value).toLowerCase() === 'nan') return true;
  const parsed = new Date(String(value));
  return Number.isNaN(parsed.getTime());
}

function isInvalidTimeValue(value: unknown) {
  if (!value) return true;
  const str = String(value).trim();
  return str === '' || str.toLowerCase() === 'nan';
}

function deriveBattleDateInfoFromRun(runData: RunDataLike | null | undefined) {
  const fallback = new Date();
  if (!runData || typeof runData !== 'object') {
    return {
      timestamp: fallback,
      displayDate: formatDate(fallback),
      displayTime: formatTime(fallback),
    };
  }

  const resolvedTimestamp =
    resolveBattleDateTime(
      runData?.runDateTime?.full,
      runData?.runDateTime?.combined,
      runData?.runDateTime?.date,
      runData?.runDateTime?.time,
      runData?.['Battle Date'],
      runData?.battleDate,
      runData?.date,
    ) || fallback;

  const explicitDate = runData?.runDateTime?.date || runData?.runDate || runData?.date;
  const explicitTime = runData?.runDateTime?.time || runData?.runTime || runData?.time;

  return {
    timestamp: resolvedTimestamp,
    displayDate: isInvalidDateValue(explicitDate) ? formatDate(resolvedTimestamp) : explicitDate,
    displayTime: isInvalidTimeValue(explicitTime) ? formatTime(resolvedTimestamp) : explicitTime,
  };
}

function applyAutoTournament(processedData: RunDataLike, rawTierCandidates: unknown[] = []) {
  if (!processedData) return;
  applyTierMetadata(processedData, rawTierCandidates);
  if (hasPlusTier(processedData, rawTierCandidates)) {
    processedData.tierHasPlus = true;
    if (!processedData.tierDisplay && typeof processedData.tier === 'number' && !Number.isNaN(processedData.tier)) {
      processedData.tierDisplay = `${processedData.tier}+`;
    } else if (processedData.tierDisplay && !String(processedData.tierDisplay).trim().endsWith('+')) {
      const numericInfo = parseTierString(String(processedData.tierDisplay));
      const normalized = numericInfo.numeric !== null ? `${numericInfo.numeric}+` : `${String(processedData.tierDisplay).trim()}+`;
      processedData.tierDisplay = normalized;
    }
    processedData.type = 'Tournament';
  }
}

async function createPendingRunWithMetadata(params: { userId: string; username: string; runData: RunDataLike; screenshot?: AttachmentLike | null; canonicalRunData?: RunDataLike | null }) {
  const { userId, username, runData, screenshot, canonicalRunData } = params;
  const hydratedRunData = { ...runData };
  let isDuplicate = false;
  let decimalPreference = 'Period (.)';

  try {
    const settings = await getLocalSettings(userId);
    if (settings?.decimalPreference) decimalPreference = settings.decimalPreference;
    const shouldCheckDuplicate = (settings?.autoDetectDuplicates ?? true) && !hydratedRunData.runId;

    if (shouldCheckDuplicate) {
      void awaitBackgroundRunHydration(userId).catch(() => {});
      const localRuns = await getLocalRuns(userId);
      const duplicateCheck = findPotentialDuplicateRun(hydratedRunData, localRuns);
      if (duplicateCheck.isDuplicate) {
        isDuplicate = true;
        if (duplicateCheck.duplicateRunId && !hydratedRunData.runId) hydratedRunData.runId = duplicateCheck.duplicateRunId;
        if (duplicateCheck.duplicateLocalId && !hydratedRunData.localId) hydratedRunData.localId = duplicateCheck.duplicateLocalId;
      }
    }
  } catch {
    /* Ignore duplicate detection failures; proceed without flagging */
  }

  return createPendingRun({
    userId,
    username,
    runData: canonicalizeTrackerRunData(hydratedRunData),
    canonicalRunData: canonicalRunData ? canonicalizeTrackerRunData(canonicalRunData) : null,
    screenshot,
    isDuplicate,
    decimalPreference,
  });
}

function buildProcessedRunDataFromParsed(
  runData: RunDataLike,
  params: { preNote?: string | null; defaultRunType?: string | null; mode?: TrackerUiMode }
): RunDataLike {
  const runDataRecord = toRecord(runData);
  const { timestamp: resolvedTimestamp, displayDate, displayTime } = deriveBattleDateInfoFromRun(runData);
  const processedData: RunDataLike = {
    ...runDataRecord,
    ...runData,
    tier: runData.tier ?? runDataRecord['Tier'],
    wave: runData.wave ?? runDataRecord['Wave'],
    totalCoins: runData.totalCoins ?? runDataRecord['Coins earned'],
    totalCells: runData.totalCells ?? runDataRecord['Cells Earned'],
    totalDice: runData.totalDice ?? runDataRecord['Reroll Shards Earned'] ?? runDataRecord['rerollShards'] ?? runDataRecord['dice'],
    roundDuration: runData.roundDuration ?? runDataRecord['Real Time'],
    killedBy: (runData.killedBy ?? runDataRecord['Killed By'] ?? '').toString().trim() || 'Apathy',
    date: displayDate,
    time: displayTime,
    reportTimestamp: resolvedTimestamp.toISOString(),
    notes: params.preNote || '',
    totalEnemies: runData.totalEnemies ?? runDataRecord['Total Enemies'] ?? runDataRecord['totalEnemies'],
    destroyedByOrbs: runData.destroyedByOrbs ?? runDataRecord['Destroyed By Orbs'] ?? runDataRecord['destroyedByOrbs'],
    taggedByDeathWave: runData.taggedByDeathWave ?? runDataRecord['Tagged by Death Wave'] ?? runDataRecord['taggedByDeathWave'],
    destroyedInSpotlight: runData.destroyedInSpotlight ?? runDataRecord['Destroyed in Spotlight'] ?? runDataRecord['destroyedInSpotlight'],
    destroyedInGoldenBot: runData.destroyedInGoldenBot ?? runDataRecord['Destroyed in Golden Bot'] ?? runDataRecord['destroyedInGoldenBot'],
  };

  applyTierMetadata(processedData, [runDataRecord['Tier'], runData.tier]);
  applyAutoTournament(processedData, [runDataRecord['Tier'], runData.tier]);

  if (params.mode === 'track' && !processedData.type) {
    processedData.type = params.defaultRunType || 'Farming';
  }

  if (params.preNote) {
    processedData.notes = params.preNote;
  }

  return canonicalizeTrackerRunData(canonicalizeRunDataForOutput(processedData)) as RunDataLike;
}

function normalizeVerificationValue(key: string, value: unknown): string {
  if (value === undefined || value === null) return '';
  const raw = String(value).trim();
  if (!raw) return '';

  switch (key) {
    case 'tier': {
      const parsed = parseTierString(raw);
      return parsed.display ?? raw;
    }
    case 'wave': {
      const numeric = Number(raw);
      return Number.isFinite(numeric) ? String(numeric) : raw;
    }
    case 'roundDuration':
      return formatDuration(raw);
    case 'totalCoins':
    case 'totalCells':
    case 'totalDice':
      return standardizeNotation(raw);
    case 'killedBy':
      return raw.toLowerCase().replace(/\s+/g, ' ');
    case 'date':
      return raw;
    case 'time':
      return raw;
    default:
      return raw;
  }
}

async function verifyScreenshotMatchesPastedRun(
  attachment: AttachmentLike,
  pastedRunData: RunDataLike,
): Promise<void> {
  const response = await fetch(attachment.url);
  if (!response.ok) {
    throw new Error(`Failed to fetch screenshot for verification: ${response.status}`);
  }

  const arrayBuffer = await response.arrayBuffer();
  const fileData = Buffer.from(arrayBuffer);
  const ocrResult = await runOCR({
    data: fileData,
    filename: attachment.name ?? attachment.id ?? 'screenshot.png',
    contentType: attachment.contentType ?? 'application/octet-stream',
  });

  const ocrProcessed = buildProcessedRunDataFromParsed(toRunDataLike(ocrResult.runData), {
    mode: 'track',
  });

  const comparisonFields: Array<{ key: keyof RunDataLike; label: string }> = [
    { key: 'tier', label: 'Tier' },
    { key: 'wave', label: 'Wave' },
    { key: 'roundDuration', label: 'Duration' },
    { key: 'totalCoins', label: 'Coins' },
    { key: 'totalCells', label: 'Cells' },
    { key: 'totalDice', label: 'Reroll Shards' },
    { key: 'killedBy', label: 'Killed By' },
  ];

  const mismatches = comparisonFields.flatMap(({ key, label }) => {
    const pastedValue = normalizeVerificationValue(String(key), pastedRunData[key]);
    const ocrValue = normalizeVerificationValue(String(key), ocrProcessed[key]);
    if (!pastedValue || !ocrValue || pastedValue === ocrValue) return [];
    return [`${label}: pasted ${pastedValue}, screenshot ${ocrValue}`];
  });

  if (!mismatches.length) {
    logger.info('Tracker screenshot verification matched pasted values', {
      source: ocrResult.source,
      screenshotName: attachment.name ?? attachment.id ?? 'screenshot.png',
    });
    return;
  }

  logger.warn('Tracker screenshot verification mismatch detected', {
    source: ocrResult.source,
    screenshotName: attachment.name ?? attachment.id ?? 'screenshot.png',
    mismatches,
  });
}

async function robustProcessImage({ interaction, imageBuffer, filename, contentType, attachmentUrl, user, updateReply, scanLanguage = 'English', notes = '' }: {
  interaction: TrackReplyInteractionLike;
  imageBuffer: Buffer;
  filename: string;
  contentType: string;
  attachmentUrl: string;
  user: TrackReplyInteractionLike['user'];
  updateReply?: (msg: string) => Promise<unknown>;
  scanLanguage?: string;
  notes?: string;
}) {
  let backendError: unknown = null;
  let processedData: RunDataLike | null = null;
  let extractedData: unknown = null;
  let usedBackend = false;

  const isValidData = (data: RunDataLike | null) => {
    if (!data) return false;
    const tier = Number(data.tier);
    const wave = Number(data.wave);
    const hasValue = (value: unknown) => value !== undefined && value !== null && String(value).trim() !== '';
    return Number.isFinite(tier)
      && Number.isFinite(wave)
      && tier >= 1
      && wave >= 1
      && hasValue(data.roundDuration)
      && hasValue(data.totalCoins)
      && hasValue(data.totalCells)
      && hasValue(data.totalDice);
  };

  const buildProcessedData = (backendData: RunDataLike, extractionPayload: RunDataLike) => {
    const combinedRunDateTime = extractionPayload?.runDateTime ? `${extractionPayload.runDateTime.date || ''} ${extractionPayload.runDateTime.time || ''}`.trim() : null;
    const resolvedTimestamp = resolveBattleDateTime(
      backendData['Battle Date'],
      backendData.battleDate,
      backendData.date,
      extractionPayload?.runDateTime?.combined,
      extractionPayload?.runDateTime?.full,
      combinedRunDateTime,
    ) || new Date();
    const explicitDate = extractionPayload?.runDateTime?.date;
    const explicitTime = extractionPayload?.runDateTime?.time;
    const displayDate = isInvalidDateValue(explicitDate) ? formatDate(resolvedTimestamp) : explicitDate;
    const displayTime = isInvalidTimeValue(explicitTime) ? formatTime(resolvedTimestamp) : explicitTime;
    return {
      tier: backendData.tier ?? null,
      wave: backendData.wave ?? null,
      totalCoins: backendData.totalCoins ?? backendData.coins ?? null,
      totalCells: backendData.totalCells ?? backendData.cells ?? null,
      totalDice: backendData.totalDice ?? backendData.dice ?? backendData.rerollShards ?? null,
      roundDuration: backendData.roundDuration ?? backendData.duration ?? null,
      killedBy: backendData.killedBy ?? null,
      date: displayDate,
      time: displayTime,
      reportTimestamp: resolvedTimestamp.toISOString(),
      notes: backendData.notes ?? '',
      totalEnemies: backendData.totalEnemies ?? null,
      destroyedByOrbs: backendData.destroyedByOrbs ?? null,
      taggedByDeathWave: backendData.taggedByDeathWave ?? null,
      destroyedInSpotlight: backendData.destroyedInSpotlight ?? null,
      destroyedInGoldenBot: backendData.destroyedInGoldenBot ?? null,
    };
  };

  try {
    if (updateReply) await updateReply('Processing image with cloud OCR...');
    const ocrResult = await runOCR({
      data: imageBuffer,
      filename,
      contentType,
    });
    const dateTimeInfo = await extractDateTimeFromImage({ name: filename });
    processedData = buildProcessedData(
      toRunDataLike(ocrResult.runData),
      {
        runDateTime: dateTimeInfo,
      },
    );
    const tierCandidates = [processedData.tierDisplay, processedData.tier];
    applyTierMetadata(processedData, tierCandidates);
    if (isValidData(processedData)) {
      usedBackend = false;
      return { processedData, extractedData: ocrResult.text, usedBackend, tierCandidates };
    }
  } catch (localErr) {
    backendError = localErr;
  }

  await logError(
    interaction.client as LogClient,
    user,
    backendError || new Error('Unable to extract valid data from image.'),
    'Robust OCR Failure',
    null,
    attachmentUrl,
  );
  return null;
}

export async function handleDirectAttachment(
  interaction: TrackReplyInteractionLike,
  attachment: AttachmentLike,
  preNote: string | null = null,
  defaultRunType?: string,
  mode?: TrackerUiMode,
) {
  const resolvedMode = mode ?? getTrackerFlowMode(interaction.user.id);
  const uploadUi = getTrackerUiConfig(resolvedMode).uploadFlows;
  const userId = interaction.user.id;
  const username = interaction.user.username;
  await interaction.editReply({ embeds: [createLoadingEmbed(uploadUi.processingScreenshot)], components: [] }).catch(() => {});

  try {
    const response = await fetch(attachment.url);
    if (!response.ok) throw new Error(`Failed to fetch attachment: ${response.status}`);
    const arrayBuffer = await response.arrayBuffer();
    const imageBuffer = Buffer.from(arrayBuffer);
    const attachmentName = attachment.name ?? attachment.id ?? 'screenshot.png';
    const attachmentContentType = attachment.contentType ?? 'application/octet-stream';

    if (resolvedMode === 'lifetime') {
      const ocrResult = await runOCR({
        data: imageBuffer,
        filename: attachmentName,
        contentType: attachmentContentType,
      });
      const ocrText = ocrResult.text.join('\n');
      const lifetimeData = parseLifetimeStatsFromOcrText(ocrText);
      if (!lifetimeData) {
        await interaction.editReply({ content: uploadUi.parseScreenshotFailed, embeds: [], components: [] });
        return;
      }

      const pending = await createPendingRunWithMetadata({
        userId,
        username,
        runData: {
          ...lifetimeData,
          date: lifetimeData.date,
          runId: undefined,
        },
        screenshot: { url: attachment.url, name: attachment.name ?? attachment.id, contentType: attachment.contentType ?? undefined },
      });

      await renderDataReview(interaction, pending.token, pending, 'Extracted');
      return;
    }

    const result = await robustProcessImage({
      interaction,
      imageBuffer,
      filename: attachmentName,
      contentType: attachmentContentType,
      attachmentUrl: attachment.url,
      user: interaction.user,
      updateReply: (msg: string) => interaction.editReply({ embeds: [createLoadingEmbed(msg)], components: [] }).catch(() => {}),
      scanLanguage: 'English',
      notes: preNote ?? '',
    });

    if (!result) {
      await interaction.editReply({ content: uploadUi.parseScreenshotFailed, embeds: [], components: [] });
      return;
    }

    applyAutoTournament(result.processedData, result.tierCandidates);

    const { timestamp, displayDate, displayTime } = deriveBattleDateInfoFromRun(result.processedData);

    const runData: Record<string, unknown> = {
      ...result.processedData,
      runDate: displayDate,
      runTime: displayTime,
      reportTimestamp: timestamp.toISOString(),
      notes: preNote ?? '',
    };

    if (resolvedMode === 'track') {
      runData.type = result.processedData.type || defaultRunType || 'Farming';
    }

    const pending = await createPendingRunWithMetadata({
      userId,
      username,
      runData,
      screenshot: { url: attachment.url, name: attachment.name ?? attachment.id, contentType: attachment.contentType ?? undefined },
    });

    await renderDataReview(interaction, pending.token, pending);
  } catch (error) {
    await handleError({
      client: interaction.client as { channels: { fetch: (id: string) => Promise<unknown> } },
      user: interaction.user,
      error,
      context: 'handleDirectAttachment',
      attachmentUrl: attachment.url,
    });
    await interaction.editReply({ content: uploadUi.runSubmissionFailed, embeds: [], components: [] }).catch(() => {});
  }
}

export async function handleUploadFlow(interaction: MessageComponentInteraction | ModalSubmitInteraction) {
  if (!('showModal' in interaction) || typeof interaction.showModal !== 'function') return;
  const userId = interaction.user.id;
  const mode = getTrackerFlowMode(userId);

  const ui = getTrackerUiConfig(mode);
  const uploadUi = ui.uploadFlows;
  const Builders = Discord as unknown as BuildersLike;
  const modal = new ModalBuilder().setCustomId(TRACKER_IDS.flow.uploadModal).setTitle(uploadUi.uploadModalTitle);

  const includeTypeSelection = mode === 'track';
  const runTypeSelect = includeTypeSelection
    ? new Builders.StringSelectMenuBuilder()
      .setCustomId(TRACKER_IDS.flow.uploadRunType)
      .setPlaceholder(ui.review.typePlaceholder)
      .setMinValues(1)
      .setMaxValues(1)
      .addOptions(...uploadUi.runTypeOptions.map((item, idx) => ({ label: item, value: item, default: idx === 0 })))
    : null;
  const labeledRunType = runTypeSelect
    ? new Builders.LabelBuilder().setLabel(uploadUi.runTypeLabel).setStringSelectMenuComponent(runTypeSelect)
    : null;

  const includeNotes = mode === 'track';
  const noteInput = new TextInputBuilder().setCustomId(TRACKER_IDS.flow.uploadNote).setLabel(uploadUi.optionalNoteLabel).setStyle(TextInputStyle.Short).setRequired(false);
  const fileUpload = new Builders.FileUploadBuilder().setCustomId(TRACKER_IDS.flow.uploadFile);
  try {
    fileUpload.setRequired(true);
  } catch {
    /* ignore */
  }
  const labeledFile = new Builders.LabelBuilder().setLabel(uploadUi.uploadFileLabel).setFileUploadComponent(fileUpload);

  if (includeNotes) {
    modal.addComponents(new ActionRowBuilder<TextInputBuilder>().addComponents(noteInput));
  }
  if (labeledRunType) {
    (modal as ModalWithLabelComponents).addLabelComponents(labeledRunType);
  }
  (modal as ModalWithLabelComponents).addLabelComponents(labeledFile);

  await interaction.showModal(modal);

  try {
    const submitted = await awaitOwnedModalSubmit(interaction as MessageComponentInteraction, TRACKER_IDS.flow.uploadModal);
    try {
      await submitted.deferUpdate();
    } catch {
      /* ignore */
    }

    let selectedRunType: string | undefined = mode === 'track' ? 'Farming' : undefined;
    let normalizedAttachment: NormalizedAttachment | null = null;

    const assignNormalizedAttachment = (file: unknown) => {
      if (!file || !looksLikeFile(file)) return;
      const url = file.url || file.proxy_url || file.attachment || null;
      const name = file.name || file.filename || 'screenshot.png';
      const contentType = file.content_type || file.contentType || 'image/png';
      if (url) normalizedAttachment = { url, name, contentType };
    };

    try {
      if (mode === 'track') {
        const submittedRecord = toRecord(submitted);
        const typeComp = findByCustomIdDeep(submittedRecord.components, TRACKER_IDS.flow.uploadRunType);
        let values = Array.isArray(typeComp?.values) ? typeComp.values : [];
        if (!values.length && typeComp && typeof typeComp.value === 'string') values = [typeComp.value];
        if (values.length) selectedRunType = values[0];
      }
    } catch {
      /* ignore */
    }

    try {
      const submittedRecord = toRecord(submitted);
      const attachmentContainer = toRecord(submittedRecord.attachments);
      const first = typeof attachmentContainer.first === 'function' ? (attachmentContainer.first as () => unknown)() : null;
      const modalAttachment = first || (Array.isArray(submittedRecord.attachments) ? submittedRecord.attachments[0] : null);
      if (modalAttachment) assignNormalizedAttachment(modalAttachment);
    } catch {
      /* ignore */
    }

    if (!normalizedAttachment) {
      try {
        const submittedRecord = toRecord(submitted);
        const fileComp = findByCustomIdDeep(submittedRecord.components, TRACKER_IDS.flow.uploadFile);
        const fileCompRecord = toRecord(fileComp);
        const primary = toArray(fileCompRecord.files);
        const alt = toArray(fileCompRecord.attachments);
        let candidates = primary.length ? primary : alt;
        if (!candidates.length) {
          const dataRecord = toRecord(submittedRecord.data);
          const resolvedRecord = toRecord(dataRecord.resolved);
          const more = [
            submittedRecord.files,
            submittedRecord.attachments,
            dataRecord.attachments,
            resolvedRecord.attachments,
          ];
          for (const c of more) {
            const arr = toArray(c);
            if (arr.length && looksLikeFile(arr[0])) {
              candidates = arr;
              break;
            }
          }
        }
        if (candidates.length) assignNormalizedAttachment(candidates[0]);
      } catch {
        /* ignore */
      }
    }

    if (!normalizedAttachment) {
      await submitted.editReply({ content: uploadUi.uploadNoFile, embeds: [], components: [] }).catch(() => {});
      return;
    }

    const preNote = includeNotes
      ? submitted.fields.getTextInputValue(TRACKER_IDS.flow.uploadNote)?.trim() || null
      : null;
    await submitted.editReply({ embeds: [createLoadingEmbed(uploadUi.processingScreenshot)], components: [] }).catch(() => {});
    await handleDirectAttachment(interaction as unknown as TrackReplyInteractionLike, normalizedAttachment, preNote, selectedRunType, mode);
  } catch (err: unknown) {
    if (String(err || '').includes('TIME')) {
      await interaction.editReply({ content: uploadUi.uploadTimeout, embeds: [], components: [] }).catch(() => {});
    } else {
      await handleError({ client: interaction.client as LogClient, user: interaction.user, error: err, context: 'upload_flow_modal' });
      await interaction.editReply({ content: uploadUi.uploadError, embeds: [], components: [] }).catch(() => {});
    }
  }
}

export async function renderTrackMenu(interaction: TrackReplyInteractionLike, mode?: TrackerUiMode) {
  const resolvedMode = mode ?? getTrackerFlowMode(interaction.user.id);
  const uploadUi = getTrackerUiConfig(resolvedMode).uploadFlows;
  try {
    const userId = interaction.user.id;
    const userLabel = resolveInteractionDisplayName(interaction);
    const summary = resolvedMode === 'lifetime'
      ? await (async () => {
          const entries = await getLocalLifetimeData(userId).catch(() => [] as Array<Record<string, unknown>>);
          const sorted = [...entries].sort((a, b) => new Date(String(b.date ?? '')).getTime() - new Date(String(a.date ?? '')).getTime());
          return {
            lastRun: sorted[0] ?? null,
            allRuns: sorted,
            runTypeCounts: {},
          };
        })()
      : await getLastRun(userId, { cloudSyncMode: 'none' }).catch(() => null);

    const summarySignature = (input: { lastRun?: Record<string, unknown> | null; allRuns?: unknown[]; runTypeCounts?: Record<string, number> } | null | undefined): string => {
      const lastRun = input?.lastRun ?? null;
      return JSON.stringify({
        totalRuns: Array.isArray(input?.allRuns) ? input!.allRuns!.length : 0,
        runTypeCounts: input?.runTypeCounts ?? {},
        lastRunId: lastRun ? (lastRun.runId ?? lastRun.id ?? null) : null,
        lastRunUpdatedAt: lastRun ? (lastRun.updatedAt ?? lastRun.createdAt ?? null) : null,
        lastRunDate: lastRun ? (lastRun.date ?? lastRun.runDate ?? null) : null,
        lastRunTime: lastRun ? (lastRun.time ?? lastRun.runTime ?? null) : null,
        lastRunTier: lastRun ? (lastRun.tier ?? null) : null,
        lastRunWave: lastRun ? (lastRun.wave ?? null) : null,
      });
    };

    const initialSignature = summarySignature(summary);
    const embed = createInitialEmbed({
      mode: resolvedMode,
      userLabel,
      userId,
      lastRun: summary?.lastRun ?? null,
      runCount: summary?.allRuns?.length ?? 0,
      runTypeCounts: summary?.runTypeCounts ?? {},
    });
    const rows = createMainMenuButtons(resolvedMode);
    if (interaction.replied || interaction.deferred) {
      await interaction.editReply({ content: '', embeds: [embed], components: rows, files: [], attachments: [] }).catch(() => {});
    } else {
      await interaction.reply({ embeds: [embed], components: rows, ephemeral: true }).catch(() => {});
    }

    if (resolvedMode !== 'lifetime') {
      beginBackgroundRunHydration(userId);
      void (async () => {
        await awaitBackgroundRunHydration(userId).catch(() => {});
        const refreshed = await getLastRun(userId, { cloudSyncMode: 'none' }).catch(() => null);
        if (!refreshed) return;
        const refreshedSignature = summarySignature(refreshed);
        if (refreshedSignature === initialSignature) return;

        const refreshedEmbed = createInitialEmbed({
          mode: resolvedMode,
          userLabel,
          userId,
          lastRun: refreshed.lastRun ?? null,
          runCount: refreshed.allRuns?.length ?? 0,
          runTypeCounts: refreshed.runTypeCounts ?? {},
        });
        const refreshedRows = createMainMenuButtons(resolvedMode);
        await interaction.editReply({ content: '', embeds: [refreshedEmbed], components: refreshedRows, files: [], attachments: [] }).catch(() => {});
      })();
    }
  } catch (error) {
    await logError(interaction.client as LogClient, interaction.user, error, 'render_track_menu');
    if (interaction.replied || interaction.deferred) {
      await interaction.editReply({ content: uploadUi.openMenuFailed, embeds: [], components: [], files: [], attachments: [] }).catch(() => {});
    } else {
      await interaction.reply({ content: uploadUi.openMenuFailed, ephemeral: true }).catch(() => {});
    }
  }
}

export async function handleTrackMenuUpload(interaction: MessageComponentInteraction | ModalSubmitInteraction) {
  try {
    await handleUploadFlow(interaction);
  } catch (error) {
    await logError(interaction.client as LogClient, interaction.user, error, 'track_menu_upload');
  }
}

export async function handleTrackMenuPaste(interaction: MessageComponentInteraction | ModalSubmitInteraction) {
  try {
    await handlePasteFlow(interaction);
  } catch (error) {
    await logError(interaction.client as LogClient, interaction.user, error, 'track_menu_paste');
  }
}

export async function handleTrackMenuCancel(interaction: MessageComponentInteraction | ModalSubmitInteraction) {
  const uploadUi = getTrackerUiConfig(getTrackerFlowMode(interaction.user.id)).uploadFlows;
  if ('update' in interaction && typeof interaction.update === 'function') {
    await interaction.update({ content: uploadUi.cancelMessage, embeds: [], components: [] }).catch(() => {});
  }
}

export async function handleTrackMenuSupport(interaction: MessageComponentInteraction | ModalSubmitInteraction) {
  const supportChannelId = '1373107292547055718';
  const content = `Need help? Open support in <#${supportChannelId}>.`;
  if (!interaction.deferred && !interaction.replied) {
    await interaction.deferUpdate().catch(() => {});
  }
  await interaction.editReply({ content, embeds: [], components: [] }).catch(() => {});
}

export async function handleTrackMenuMainMenu(interaction: MessageComponentInteraction | ModalSubmitInteraction) {
  try {
    await interaction.deferUpdate().catch(() => {});
    await renderTrackMenu(interaction as unknown as TrackReplyInteractionLike);
  } catch (error) {
    await logError(interaction.client as LogClient, interaction.user, error, 'track_menu_mainmenu');
  }
}

export async function handleTrackMenuAddRun(interaction: MessageComponentInteraction | ModalSubmitInteraction) {
  try {
    await handleAddRunFlow(interaction);
  } catch (error) {
    await logError(interaction.client as LogClient, interaction.user, error, 'track_menu_addrun');
  }
}

export async function handleTrackMenuEditLast(interaction: MessageComponentInteraction | ModalSubmitInteraction) {
  try {
    const mode = getTrackerFlowMode(interaction.user.id);
    const uploadUi = getTrackerUiConfig(mode).uploadFlows;
    await interaction.deferUpdate().catch(() => {});
    if (mode === 'lifetime') {
      const entries = await getLocalLifetimeData(interaction.user.id);
      const sorted = [...entries].sort((a, b) => new Date(String(b.date ?? '')).getTime() - new Date(String(a.date ?? '')).getTime());
      const latest = sorted[0];
      if (!latest) {
        await interaction.editReply({ content: uploadUi.editLastNone, embeds: [], components: [] }).catch(() => {});
        return;
      }

      const entryId = typeof latest.$id === 'string' ? latest.$id : (typeof latest.id === 'string' ? latest.id : undefined);
      const pending = await createPendingRunWithMetadata({
        userId: interaction.user.id,
        username: interaction.user.username,
        runData: { ...latest, runId: entryId },
        screenshot: typeof latest.screenshotUrl === 'string'
          ? { url: latest.screenshotUrl, name: 'screenshot.png', contentType: 'image/png' }
          : null,
      });

      await renderEditFieldPicker(interaction as unknown as TrackReplyInteractionLike, pending.token, pending);
      return;
    }
    const summary = await getLastRun(interaction.user.id);
    if (!summary?.lastRun) {
      await interaction.editReply({ content: uploadUi.editLastNone, embeds: [], components: [] }).catch(() => {});
      return;
    }

    const pending = await createPendingRunWithMetadata({
      userId: interaction.user.id,
      username: interaction.user.username,
      runData: { ...summary.lastRun, runId: summary.lastRun.runId },
      screenshot: summary.lastRun.screenshotUrl
        ? { url: summary.lastRun.screenshotUrl, name: 'screenshot.png', contentType: 'image/png' }
        : null,
    });

    await renderEditFieldPicker(interaction as unknown as TrackReplyInteractionLike, pending.token, pending);
  } catch (error) {
    const uploadUi = getTrackerUiConfig(getTrackerFlowMode(interaction.user.id)).uploadFlows;
    await logError(interaction.client as LogClient, interaction.user, error, 'track_menu_editlast');
    await interaction.editReply({ content: uploadUi.editLastFailed, embeds: [], components: [] }).catch(() => {});
  }
}
export {
  handleTrackMenuViewRuns,
  handleTrackMenuViewRunsTypes,
  handleTrackMenuViewRunsTiers,
  handleTrackMenuViewRunsSelect,
  handleTrackMenuViewRunsColumns,
  handleTrackMenuViewRunsPrev,
  handleTrackMenuViewRunsNext,
  handleTrackMenuShareRuns,
} from './view-runs-handlers';

export {
  handleTrackMenuRemoveLastPrompt,
  handleTrackMenuConfirmRemove,
} from './remove-handlers';

export async function handleTrackMenuCancelRemove(interaction: MessageComponentInteraction | ModalSubmitInteraction) {
  try {
    await interaction.deferUpdate().catch(() => {});
    await renderTrackMenu(interaction as unknown as TrackReplyInteractionLike);
  } catch (error) {
    await logError(interaction.client as LogClient, interaction.user, error, 'track_menu_cancel_remove');
  }
}

export {
  handleTrackMenuSettings,
  handleTrackMenuForceSave,
  handleTrackMenuToggleCloud,
  handleTrackMenuToggleDuplicates,
  handleTrackMenuToggleConfirm,
  handleTrackMenuSelectLanguage,
  handleTrackMenuSelectTracker,
  handleTrackMenuSelectDefaultRunType,
  handleTrackMenuSelectTimezone,
  handleTrackMenuSetLogChannel,
  handleTrackMenuShareSettings,
  handleTrackMenuStats,
  handleTrackMenuImport,
  handleTrackMenuImportYes,
  handleTrackMenuImportNo,
} from './settings-handlers';

export async function handleDirectTextPaste(
  interaction: TrackReplyInteractionLike,
  text: string,
  attachmentOrNull: AttachmentLike | null,
  preNote: string | null = null,
  defaultRunType: string | null = null,
  mode?: TrackerUiMode,
) {
  const resolvedMode = mode ?? getTrackerFlowMode(interaction.user.id);
  const uploadUi = getTrackerUiConfig(resolvedMode).uploadFlows;
  const userId = interaction.user.id;
  const username = interaction.user.username;

  await interaction.editReply({ embeds: [createLoadingEmbed(uploadUi.processingPaste)], components: [] }).catch(async (err: unknown) => {
    const errorRecord = toRecord(err);
    if (errorRecord.code === 'InteractionNotReplied') {
      await interaction.reply({ embeds: [createLoadingEmbed(uploadUi.processingPaste)], components: [], ephemeral: true });
    } else {
      throw err;
    }
  });

  try {
    const runData = toRunDataLike(parseRunDataFromText(text));
    const processedData = buildProcessedRunDataFromParsed(runData, {
      preNote,
      defaultRunType,
      mode: resolvedMode,
    });

    logger.info('tracker direct paste parsed', {
      userId,
      rawTier: runData.tier,
      rawWave: runData.wave,
      rawKilledBy: runData.killedBy,
      rawTaggedByDeathWave: runData.taggedByDeathWave,
      canonicalTier: processedData.tier,
      canonicalWave: processedData.wave,
      canonicalKilledBy: processedData.killedBy,
      canonicalTaggedByDeathWave: processedData.taggedByDeathWave,
    });

    const pending = await createPendingRunWithMetadata({
      userId,
      username,
      runData: processedData,
      canonicalRunData: runData,
      screenshot: attachmentOrNull ? { url: attachmentOrNull.url, name: attachmentOrNull.name, contentType: attachmentOrNull.contentType } : null,
    });

    if (resolvedMode === 'track' && attachmentOrNull) {
      void verifyScreenshotMatchesPastedRun(attachmentOrNull, processedData).catch((verificationError) => {
        logger.warn('Tracker screenshot verification failed', {
          screenshotName: attachmentOrNull.name ?? 'screenshot.png',
          error: verificationError instanceof Error ? verificationError.message : 'unknown verification failure',
        });
      });
    }

    await renderDataReview(interaction, pending.token, pending);
  } catch (err: unknown) {
    await logError(interaction.client as LogClient, interaction.user, err, 'direct_text_paste');
    await interaction.editReply({ content: uploadUi.unableParsePasted, embeds: [], components: [] }).catch(() => {});
  }
}

export async function handlePasteFlow(interaction: MessageComponentInteraction | ModalSubmitInteraction) {
  if (!('showModal' in interaction) || typeof interaction.showModal !== 'function') return;
  const mode = getTrackerFlowMode(interaction.user.id);
  const uploadUi = getTrackerUiConfig(mode).uploadFlows;
  if (mode === 'lifetime') {
    await interaction.deferUpdate().catch(() => {});
    await interaction.editReply({ content: uploadUi.processingPaste, embeds: [], components: [] }).catch(() => {});
    return;
  }
  const userId = interaction.user.id;
  const username = interaction.user.username;

  const modal = new ModalBuilder().setCustomId(TRACKER_IDS.flow.pasteModal).setTitle(uploadUi.pasteModalTitle);
  const textInput = new TextInputBuilder().setCustomId(TRACKER_IDS.flow.pasteText).setLabel(uploadUi.battleReportLabel).setStyle(TextInputStyle.Paragraph).setRequired(true);
  const noteInput = new TextInputBuilder().setCustomId(TRACKER_IDS.flow.pasteNote).setLabel(uploadUi.optionalNoteLabel).setStyle(TextInputStyle.Short).setRequired(false);
  modal.addComponents(new ActionRowBuilder<TextInputBuilder>().addComponents(textInput), new ActionRowBuilder<TextInputBuilder>().addComponents(noteInput));

  await interaction.showModal(modal);

  try {
    const submitted = await awaitOwnedModalSubmit(interaction as MessageComponentInteraction, TRACKER_IDS.flow.pasteModal);
    try {
      await submitted.deferUpdate();
    } catch (deferError: unknown) {
      if (toRecord(deferError).code !== 40060) throw deferError;
    }

    const text = submitted.fields.getTextInputValue(TRACKER_IDS.flow.pasteText);
    const preNote = submitted.fields.getTextInputValue(TRACKER_IDS.flow.pasteNote) || null;
    await interaction.editReply({ embeds: [createLoadingEmbed(uploadUi.processingPaste)], components: [] }).catch(() => {});

    try {
      const runData = toRunDataLike(parseRunDataFromText(text));
      const processedData = buildProcessedRunDataFromParsed(runData, {
        preNote,
        defaultRunType: 'Farming',
        mode,
      });

      const pending = await createPendingRunWithMetadata({ userId, username, runData: processedData, canonicalRunData: runData, screenshot: null });
      await renderDataReview(interaction as unknown as TrackReplyInteractionLike, pending.token, pending);
    } catch (err: unknown) {
      if (String(err || '').includes('TIME')) {
        await interaction.editReply({ content: uploadUi.pasteTimeout, embeds: [], components: [] }).catch(() => {});
      } else {
        await logError(interaction.client as LogClient, interaction.user, err, 'paste_flow_modal');
        await interaction.editReply({ content: uploadUi.unableParsePasted, embeds: [], components: [] }).catch(() => {});
      }
    }
  } catch (err: unknown) {
    if (String(err || '').includes('TIME')) {
      await interaction.editReply({ content: uploadUi.pasteTimeout, embeds: [], components: [] }).catch(() => {});
    } else {
      await logError(interaction.client as LogClient, interaction.user, err, 'paste_flow_modal');
    }
  }
}

export async function handleAddRunFlow(interaction: MessageComponentInteraction | ModalSubmitInteraction) {
  if (!('showModal' in interaction) || typeof interaction.showModal !== 'function') return;
  const mode = getTrackerFlowMode(interaction.user.id);
  const ui = getTrackerUiConfig(mode);
  const uploadUi = ui.uploadFlows;
  const userId = interaction.user.id;
  const username = interaction.user.username;

  const Builders = Discord as unknown as BuildersLike;
  if (typeof interaction.showModal !== 'function') {
    await interaction.deferUpdate().catch(() => {});
    await interaction.editReply({ content: uploadUi.clickAddRunAgain, embeds: [], components: [] }).catch(() => {});
    return;
  }
  const modal = new ModalBuilder().setCustomId(TRACKER_IDS.flow.addRunModal).setTitle(uploadUi.addRunModalTitle);

  const includeTypeSelection = mode === 'track';
  const runTypeSelect = includeTypeSelection
    ? new Builders.StringSelectMenuBuilder()
      .setCustomId(TRACKER_IDS.flow.addRunType)
      .setPlaceholder(ui.review.typePlaceholder)
      .setMinValues(1)
      .setMaxValues(1)
      .addOptions(...uploadUi.runTypeOptions.map((item, idx) => ({ label: item, value: item, default: idx === 0 })))
    : null;
  const labeledRunType = runTypeSelect
    ? new Builders.LabelBuilder().setLabel(uploadUi.runTypeLabel).setStringSelectMenuComponent(runTypeSelect)
    : null;

  const includeNotes = mode === 'track';
  const pasteInput = new TextInputBuilder().setCustomId(TRACKER_IDS.flow.addRunPasteText).setLabel(uploadUi.battleReportLabel).setStyle(TextInputStyle.Paragraph).setRequired(false);
  const noteInput = new TextInputBuilder().setCustomId(TRACKER_IDS.flow.addRunNote).setLabel(uploadUi.addRunNotesLabel).setStyle(TextInputStyle.Short).setRequired(false);

  const fileUpload = new Builders.FileUploadBuilder().setCustomId(TRACKER_IDS.flow.addRunFile);
  try {
    fileUpload.setRequired(false);
  } catch {
    /* ignore */
  }
  const labeledFile = new Builders.LabelBuilder().setLabel(uploadUi.optionalUploadFileLabel).setFileUploadComponent(fileUpload);

  modal.addComponents(new ActionRowBuilder<TextInputBuilder>().addComponents(pasteInput));
  if (includeNotes) {
    modal.addComponents(new ActionRowBuilder<TextInputBuilder>().addComponents(noteInput));
  }
  if (labeledRunType) {
    (modal as ModalWithLabelComponents).addLabelComponents(labeledRunType);
  }
  (modal as ModalWithLabelComponents).addLabelComponents(labeledFile);

  await interaction.showModal(modal);

  try {
    const submitted = await awaitOwnedModalSubmit(interaction as MessageComponentInteraction, TRACKER_IDS.flow.addRunModal);

    try {
      await submitted.deferUpdate();
    } catch {
      /* already acknowledged */
    }

    const pastedText = submitted.fields.getTextInputValue(TRACKER_IDS.flow.addRunPasteText)?.trim() || '';
    const preNote = includeNotes
      ? submitted.fields.getTextInputValue(TRACKER_IDS.flow.addRunNote)?.trim() || null
      : null;
    let normalizedAttachment: NormalizedAttachment | null = null;

    const assignNormalizedAttachment = (file: unknown) => {
      if (!file || !looksLikeFile(file)) return;
      const url = file.url || file.proxy_url || file.attachment || null;
      const name = file.name || file.filename || 'screenshot.png';
      const contentType = file.content_type || file.contentType || 'image/png';
      if (url) normalizedAttachment = { url, name, contentType };
    };

    let selectedRunType: string | undefined = mode === 'track' ? 'Farming' : undefined;
    try {
      if (mode === 'track') {
        const submittedRecord = toRecord(submitted);
        const typeComp = findByCustomIdDeep(submittedRecord.components, TRACKER_IDS.flow.addRunType);
        let values = Array.isArray(typeComp?.values) ? typeComp.values : [];
        if (!values.length && typeComp && typeof typeComp.value === 'string') values = [typeComp.value];
        if (values.length) selectedRunType = values[0];
      }
    } catch {
      /* ignore */
    }

    // Try to capture screenshot upload from modal attachments/components first
    try {
      const submittedRecord = toRecord(submitted);
      const attachmentContainer = toRecord(submittedRecord.attachments);
      const first = typeof attachmentContainer.first === 'function' ? (attachmentContainer.first as () => unknown)() : null;
      const modalAttachment = first || (Array.isArray(submittedRecord.attachments) ? submittedRecord.attachments[0] : null);
      if (modalAttachment) assignNormalizedAttachment(modalAttachment);
    } catch {
      /* ignore */
    }

    if (!normalizedAttachment) {
      try {
        const submittedRecord = toRecord(submitted);
        const fileComp = findByCustomIdDeep(submittedRecord.components, TRACKER_IDS.flow.addRunFile);
        const fileCompRecord = toRecord(fileComp);
        const primary = toArray(fileCompRecord.files);
        const alt = toArray(fileCompRecord.attachments);
        let candidates = primary.length ? primary : alt;
        if (!candidates.length) {
          const dataRecord = toRecord(submittedRecord.data);
          const resolvedRecord = toRecord(dataRecord.resolved);
          const more = [
            submittedRecord.files,
            submittedRecord.attachments,
            dataRecord.attachments,
            resolvedRecord.attachments,
          ];
          for (const c of more) {
            const arr = toArray(c);
            if (arr.length && looksLikeFile(arr[0])) {
              candidates = arr;
              break;
            }
          }
        }
        if (candidates.length) assignNormalizedAttachment(candidates[0]);
      } catch {
        /* ignore */
      }
    }

    const handleParsed = async (runData: RunDataLike, attachmentOrNull: NormalizedAttachment | null) => {
      const processedData = buildProcessedRunDataFromParsed(runData, {
        preNote,
        defaultRunType: selectedRunType ?? 'Farming',
        mode,
      });

      const pending = await createPendingRunWithMetadata({
        userId,
        username,
        runData: processedData,
        canonicalRunData: runData,
        screenshot: attachmentOrNull ? { url: attachmentOrNull.url, name: attachmentOrNull.name, contentType: attachmentOrNull.contentType } : null,
      });

      if (mode === 'track' && attachmentOrNull) {
        void verifyScreenshotMatchesPastedRun(attachmentOrNull, processedData).catch((verificationError) => {
          logger.warn('Tracker screenshot verification failed', {
            screenshotName: attachmentOrNull.name ?? 'screenshot.png',
            error: verificationError instanceof Error ? verificationError.message : 'unknown verification failure',
          });
        });
      }

      await renderDataReview(interaction as unknown as TrackReplyInteractionLike, pending.token, pending);
    };

    if (mode === 'track' && pastedText.trim().length > 0) {
      await submitted.editReply({ embeds: [createLoadingEmbed(uploadUi.processingPaste)], components: [] }).catch(() => {});
      try {
        const runData = toRunDataLike(parseRunDataFromText(pastedText));
        await handleParsed(runData, normalizedAttachment);
        return;
      } catch (err: unknown) {
        await logError(submitted.client, submitted.user, err, 'add_run_modal_flow');
        await submitted.editReply({ content: uploadUi.unableParsePasted, embeds: [], components: [] }).catch(() => {});
        return;
      }
    }
    if (normalizedAttachment) {
      await submitted.editReply({ embeds: [createLoadingEmbed(uploadUi.processingScreenshot)], components: [] }).catch(() => {});
      await handleDirectAttachment(interaction as unknown as TrackReplyInteractionLike, normalizedAttachment, preNote, selectedRunType, mode);
      return;
    }

    await submitted.editReply({ content: uploadUi.providePasteOrScreenshot, embeds: [], components: [] }).catch(() => {});
    return;
  } catch (err: unknown) {
    if (String(err || '').includes('TIME')) {
      if (!interaction.deferred && !interaction.replied) {
        await interaction.deferUpdate().catch(() => {});
      }
      await interaction.editReply({ content: uploadUi.addRunTimedOut, embeds: [], components: [] }).catch(() => {});
    } else {
      await logError(interaction.client as LogClient, interaction.user, err, 'add_run_modal_flow');
    }
  }
}

const manualHandlers = createManualHandlers({
  createPendingRunWithMetadata,
  handleAddRunFlow,
  renderTrackMenu,
});

export const handleTrackMenuUploadAnother = manualHandlers.handleTrackMenuUploadAnother;
export const handleTrackMenuManual = manualHandlers.handleTrackMenuManual;
export const handleManualTypeSelection = manualHandlers.handleManualTypeSelection;
export const handleManualNote = manualHandlers.handleManualNote;
export const handleManualEditStageOne = manualHandlers.handleManualEditStageOne;
export const handleManualEditStageTwo = manualHandlers.handleManualEditStageTwo;
export const handleManualNext = manualHandlers.handleManualNext;
export const handleManualBackToMenu = manualHandlers.handleManualBackToMenu;
