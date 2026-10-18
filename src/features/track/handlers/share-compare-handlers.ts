import { MessageFlags, type MessageComponentInteraction, type ModalSubmitInteraction } from 'discord.js';
import { TRACKER_IDS, parsePrefixedTrackerToken, parseShareCompareControl } from '../track-custom-ids';
import { loadCompareChoices, loadSharedCompareSnapshot, readOwnedCompareRun } from '../share/compare/compare-data';
import { beginCompare, compareStillActive, COMPARE_TTL_MS, endCompare, getCompareSession, saveCompareSession, type CompareSession } from '../share/compare/compare-session';
import { comparePicker, compareResult, comparisonPageCount, COMPARE_MENTIONS, COMPARE_PAGE_SIZE } from '../share/compare/compare-ui';
import { resolveCompareAccess } from '../share/compare/compare-access';
import { expandedComparePages, battleReportComparePages } from '../share/compare/compare-model';
import { resolveInteractionDisplayName } from '../discord-display-name';
import { createCompareObservation, type CompareAction, type CompareObservation } from '../share/compare/compare-telemetry';

type Interaction = MessageComponentInteraction | ModalSubmitInteraction;
const EXPIRED = 'This private comparison expired or belongs to another session. Click Compare on the run share to start again.';
const UNAVAILABLE = 'That shared run snapshot is unavailable. Ask the sharer to post a new run share.';

async function notice(interaction: MessageComponentInteraction, content: string): Promise<void> {
  await interaction.reply({ content, ephemeral: true, allowedMentions: COMPARE_MENTIONS }).catch(() => undefined);
}
async function openComparison(interaction: Interaction, observation: CompareObservation): Promise<void> {
  if (!interaction.isMessageComponent()) { observation.outcome('rejected'); return; }
  // Never accept a lookalike share made by another account/application.
  if (interaction.message.author.id !== interaction.client.user?.id) { observation.outcome('rejected'); await notice(interaction, UNAVAILABLE); return; }
  observation.stage('acknowledge');
  try { await interaction.deferReply({ ephemeral: true }); } catch (error) { observation.failure(error, 'ack_failed'); return; }
  const ref = parsePrefixedTrackerToken(TRACKER_IDS.share.comparePrefix, interaction.customId);
  if (!ref) { observation.outcome('snapshot_unavailable'); await interaction.editReply({ content: UNAVAILABLE }); return; }
  const sourceKey = `${interaction.user.id}:${interaction.message.id}`;
  const token = beginCompare(sourceKey);
  if (!token) {
    observation.outcome('already_open');
    await interaction.editReply({ content: 'You already have a private comparison open for this share. Use its controls, or close it before starting again.' });
    return;
  }
  let keepSession = false;
  observation.stage('snapshot');
  try {
    const shared = await loadSharedCompareSnapshot(ref);
    if (!shared) { observation.outcome('snapshot_unavailable'); await interaction.editReply({ content: UNAVAILABLE }); return; }
    observation.stage('access');
    const { options, canCompareReports } = await resolveCompareAccess(ref, interaction.message.embeds[0] ?? {}, interaction.message.components);
    observation.stage('choices');
    const { choices, recentOnly, unlinked } = await loadCompareChoices(interaction.user.id);
    if (!choices.length) {
      observation.outcome(unlinked ? 'unlinked' : 'no_runs');
      await interaction.editReply({ content: unlinked
        ? 'No runs were found for your Discord account. Link this Discord account on the tracker website, or add a run with /track, then try again.'
        : 'You have no available runs to compare. Add or sync a run with /track, then try again.' });
      return;
    }
    const session: CompareSession = { token, ownerId: interaction.user.id, sourceKey, expiresAt: Date.now() + COMPARE_TTL_MS,
      revision: 0, page: 0, busy: false, shared, options, choices, recentOnly, canCompareReports, view: 'picker' };
    saveCompareSession(session);
    observation.stage('picker');
    const reply = await interaction.editReply(comparePicker(session));
    session.messageId = reply.id;
    keepSession = true;
    observation.outcome('picker_delivered');
  } catch (error) {
    observation.failure(error);
    await interaction.editReply({ content: 'Unable to open a private comparison right now. Please try again.', components: [], embeds: [], allowedMentions: COMPARE_MENTIONS }).catch(() => undefined);
  } finally {
    if (!keepSession) endCompare(token, sourceKey);
  }
}

type ControlAction = Exclude<CompareAction, 'open'>;
const prefixes: Record<ControlAction, string> = {
  select: TRACKER_IDS.share.compareSelectPrefix, previous: TRACKER_IDS.share.comparePrevPrefix,
  next: TRACKER_IDS.share.compareNextPrefix, back: TRACKER_IDS.share.compareBackPrefix, cancel: TRACKER_IDS.share.compareCancelPrefix,
  reports: TRACKER_IDS.share.compareReportsPrefix, details: TRACKER_IDS.share.compareDetailsPrefix,
};

async function executeControl(interaction: Interaction, action: ControlAction, observation: CompareObservation): Promise<void> {
  if (!interaction.isMessageComponent()) { observation.outcome('rejected'); return; }
  const parsed = parseShareCompareControl(prefixes[action], interaction.customId);
  const session = parsed ? getCompareSession(parsed.token) : undefined;
  // Only the original ephemeral reply can be edited. All rejection notices are new private replies.
  if (!parsed || !session || session.ownerId !== interaction.user.id || session.messageId !== interaction.message.id
    || !interaction.message.flags.has(MessageFlags.Ephemeral)) { observation.outcome('rejected'); await notice(interaction, EXPIRED); return; }
  if (action === 'cancel') {
    // Cancellation invalidates an in-flight selection before awaiting Discord acknowledgement.
    endCompare(session.token, session.sourceKey);
    observation.stage('acknowledge');
    try { await interaction.deferUpdate(); } catch (error) { observation.failure(error, 'ack_failed'); return; }
    observation.stage('reply');
    try {
      await interaction.editReply({ content: 'Comparison closed.', embeds: [], components: [], allowedMentions: COMPARE_MENTIONS });
      observation.outcome('closed');
    } catch (error) { observation.failure(error); }
    return;
  }
  if (session.revision !== parsed.revision || session.busy) {
    observation.outcome('stale_control');
    await notice(interaction, 'Use the latest controls in your private comparison. A previous selection may still be loading.'); return;
  }
  if ((action === 'select' && session.view !== 'picker')
    || ((action === 'reports' || action === 'details') && !session.selected)
    || (action === 'reports' && !session.canCompareReports)) {
    observation.outcome('rejected'); await notice(interaction, 'That comparison view is not available for this share.'); return;
  }
  const value = 'values' in interaction && Array.isArray(interaction.values) && typeof interaction.values[0] === 'string' ? interaction.values[0] : undefined;
  const index = value && /^(0|[1-9]\d*)$/.test(value) ? Number(value) : -1;
  if (action === 'select' && (index < session.page * COMPARE_PAGE_SIZE || index >= Math.min(session.choices.length, (session.page + 1) * COMPARE_PAGE_SIZE))) {
    observation.outcome('rejected');
    await notice(interaction, 'Choose a run from the current page.'); return;
  }
  session.busy = true;
  observation.stage('acknowledge');
  try { await interaction.deferUpdate(); }
  catch (error) { session.busy = false; observation.failure(error, 'ack_failed'); return; }
  try {
    if (!compareStillActive(session)) { observation.outcome('cancelled_or_expired'); return; }
    if (action === 'select') {
      observation.stage('run-read');
      const mine = await readOwnedCompareRun(session.ownerId, session.choices[index]);
      if (!compareStillActive(session)) { observation.outcome('cancelled_or_expired'); return; }
      session.revision++;
      if (!mine) {
        observation.stage('reply');
        await interaction.editReply({ ...comparePicker(session), content: 'That selected run changed or is no longer available. Choose another run or reopen the comparison.' });
        observation.outcome('run_unavailable');
      } else {
        observation.stage('render');
        session.selected = { choice: session.choices[index], run: mine, name: resolveInteractionDisplayName(interaction),
          details: expandedComparePages(session.shared, mine, session.options) };
        session.view = 'details'; session.detailPage = 0; session.reportPage = 0;
        const payload = compareResult(session, mine, resolveInteractionDisplayName(interaction));
        observation.stage('reply');
        await interaction.editReply(payload);
        observation.outcome('comparison_delivered');
      }
    } else if (action === 'reports') {
      observation.stage('run-read');
      const selected = session.selected!;
      const fresh = await readOwnedCompareRun(session.ownerId, selected.choice);
      if (!compareStillActive(session)) { observation.outcome('cancelled_or_expired'); return; }
      session.revision++;
      if (!fresh) {
        session.selected = undefined; session.view = 'picker';
        await interaction.editReply({ ...comparePicker(session), content: 'That selected run is no longer available. Choose another run.' });
        observation.outcome('run_unavailable');
      } else {
        observation.stage('render');
        selected.run = fresh; selected.details = expandedComparePages(session.shared, fresh, session.options);
        selected.reports = battleReportComparePages(session.shared.run, fresh);
        session.view = 'reports'; session.reportPage = 0;
        observation.stage('reply');
        await interaction.editReply(compareResult(session, fresh, selected.name));
        observation.outcome(selected.reports.pages.length ? 'report_delivered' : 'report_unavailable');
      }
    } else if (action === 'details' || ((action === 'previous' || action === 'next') && session.view !== 'picker')) {
      if (action === 'details') session.view = 'details';
      else {
        const field = session.view === 'reports' ? 'reportPage' : 'detailPage';
        session[field] = Math.max(0, Math.min(comparisonPageCount(session) - 1, (session[field] ?? 0) + (action === 'next' ? 1 : -1)));
      }
      session.revision++; observation.stage('reply');
      await interaction.editReply(compareResult(session, session.selected!.run, session.selected!.name));
      observation.outcome(session.view === 'reports' ? 'report_delivered' : 'comparison_delivered');
    } else {
      session.view = 'picker';
      if (action === 'back') session.selected = undefined;
      const nextPage = session.page + (action === 'next' ? 1 : action === 'previous' ? -1 : 0);
      session.page = Math.max(0, Math.min(Math.ceil(session.choices.length / COMPARE_PAGE_SIZE) - 1, nextPage));
      session.revision++;
      observation.stage('picker');
      await interaction.editReply(comparePicker(session));
      observation.outcome('picker_delivered');
    }
  } catch (error) {
    observation.failure(error);
    if (compareStillActive(session)) {
      session.view = 'picker'; session.selected = undefined;
      session.revision++;
      await interaction.editReply({ ...comparePicker(session), content: 'Unable to compare this run right now. Please choose again or reopen the comparison.' }).catch(() => undefined);
    }
  } finally { session.busy = false; }
}

async function measured(action: CompareAction, run: (observation: CompareObservation) => Promise<void>): Promise<void> {
  const observation = createCompareObservation(action);
  try { await run(observation); }
  catch (error) { observation.failure(error); throw error; }
  finally { observation.finish(); }
}
export const handleShareCompareOpen = (interaction: Interaction) => measured('open', observation => openComparison(interaction, observation));
const handleControl = (interaction: Interaction, action: ControlAction) => measured(action, observation => executeControl(interaction, action, observation));

export const handleShareCompareSelect = (interaction: Interaction) => handleControl(interaction, 'select');
export const handleShareComparePrevious = (interaction: Interaction) => handleControl(interaction, 'previous');
export const handleShareCompareNext = (interaction: Interaction) => handleControl(interaction, 'next');
export const handleShareCompareBack = (interaction: Interaction) => handleControl(interaction, 'back');
export const handleShareCompareCancel = (interaction: Interaction) => handleControl(interaction, 'cancel');
export const handleShareCompareReports = (interaction: Interaction) => handleControl(interaction, 'reports');
export const handleShareCompareDetails = (interaction: Interaction) => handleControl(interaction, 'details');
