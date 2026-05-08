import {
  ActionRowBuilder,
  AttachmentBuilder,
  ButtonBuilder,
  ButtonStyle,
  Colors,
  EmbedBuilder,
  type MessageComponentInteraction,
  type ModalSubmitInteraction,
  StringSelectMenuBuilder,
} from 'discord.js';
import { createCanvas } from '@napi-rs/canvas';
import {
  createNapiRsCanvasChartRenderRuntime,
  renderAnalyticsLineChartPng,
} from '@tmrxjd/platform/tools';
import { getLastRun } from '../tracker-api-client';
import { TRACKER_IDS } from '../track-custom-ids';
import { formatNumberForDisplay, parseNumberInput, standardizeNotation } from '../../../utils/tracker-math';
import { logError } from './error-handlers';

const runtime = createNapiRsCanvasChartRenderRuntime((w, h) => createCanvas(w, h));

type TrackMenuInteraction = MessageComponentInteraction | ModalSubmitInteraction;

// ─── Chart catalog ────────────────────────────────────────────────────────────

type AnalysisChartDef = {
  id: string;
  label: string;
  category: string;
  getYValue: (run: Record<string, unknown>) => number | null;
  color: string;
};

function toNum(val: unknown): number | null {
  if (val === null || val === undefined || val === '') return null;
  const n = parseNumberInput(standardizeNotation(String(val)));
  return Number.isFinite(n) ? n : null;
}

function toDuration(run: Record<string, unknown>): number | null {
  const raw = String(run.roundDuration ?? run.duration ?? '');
  if (!raw) return null;
  const parts = raw.split(':').map(Number);
  if (parts.length === 3) return (parts[0] * 3600 + parts[1] * 60 + parts[2]) / 3600;
  if (parts.length === 2) return (parts[0] * 60 + parts[1]) / 3600;
  const n = parseFloat(raw);
  return Number.isFinite(n) ? n / 3600 : null;
}

function perHour(metric: unknown, run: Record<string, unknown>): number | null {
  const val = toNum(metric);
  const dur = toDuration(run);
  if (val === null || dur === null || dur <= 0) return null;
  return val / dur;
}

function moduleShards(run: Record<string, unknown>): number {
  return (toNum(run.cannonShardsFetched) ?? 0)
    + (toNum(run.armorShardsFetched) ?? 0)
    + (toNum(run.generatorShardsFetched) ?? 0)
    + (toNum(run.coreShardsFetched) ?? 0);
}

const ANALYSIS_CHARTS: AnalysisChartDef[] = [
  // ── Time & Progression ────────────────────────────────────────────────────
  { id: 'wave', label: 'Wave Reached', category: 'Time & Progression', getYValue: r => toNum(r.wave), color: '#64B5F6' },
  { id: 'duration', label: 'Duration (hrs)', category: 'Time & Progression', getYValue: r => toDuration(r), color: '#7986CB' },
  { id: 'totalCoins', label: 'Total Coins', category: 'Time & Progression', getYValue: r => toNum(r.totalCoins ?? r.coins), color: '#F9A825' },
  { id: 'totalCells', label: 'Total Cells', category: 'Time & Progression', getYValue: r => toNum(r.totalCells ?? r.cells), color: '#4CAF50' },
  { id: 'totalDice', label: 'Total Dice', category: 'Time & Progression', getYValue: r => toNum(r.totalDice ?? r.rerollShards ?? r.dice), color: '#F44336' },
  // ── Economy ───────────────────────────────────────────────────────────────
  { id: 'coinsPerHour', label: 'Coins/Hr', category: 'Economy', getYValue: r => toNum(r.coinsPerHour) ?? perHour(r.totalCoins ?? r.coins, r), color: '#F9A825' },
  { id: 'cellsPerHour', label: 'Cells/Hr', category: 'Economy', getYValue: r => toNum(r.cellsPerHour) ?? perHour(r.totalCells ?? r.cells, r), color: '#4CAF50' },
  { id: 'dicePerHour', label: 'Dice/Hr', category: 'Economy', getYValue: r => toNum(r.rerollShardsPerHour ?? r.dicePerHour) ?? perHour(r.totalDice ?? r.rerollShards ?? r.dice, r), color: '#F44336' },
  { id: 'moduleShardsPerHour', label: 'Module Shards/Hr', category: 'Economy', getYValue: r => { const s = moduleShards(r); return s > 0 ? perHour(s, r) : null; }, color: '#42A5F5' },
  { id: 'wavesPerHour', label: 'Waves/Hr', category: 'Economy', getYValue: r => toNum(r.wavesPerHour) ?? perHour(r.wave, r), color: '#66BB6A' },
  { id: 'enemiesPerHour', label: 'Enemies/Hr', category: 'Economy', getYValue: r => toNum(r.enemiesPerHour) ?? perHour(r.totalEnemies, r), color: '#EF5350' },
  // ── Combat — damage dealt ─────────────────────────────────────────────────
  { id: 'damageDealt', label: 'Total Direct Damage', category: 'Combat', getYValue: r => toNum(r.damageDealt), color: '#FF7043' },
  { id: 'projectilesDamage', label: 'Projectiles Damage', category: 'Combat', getYValue: r => toNum(r.projectilesDamage), color: '#FFA726' },
  { id: 'rendArmorDamage', label: 'Rend Armor Damage', category: 'Combat', getYValue: r => toNum(r.rendArmorDamage), color: '#FFCA28' },
  { id: 'thornDamage', label: 'Thorns Damage', category: 'Combat', getYValue: r => toNum(r.thornDamage), color: '#66BB6A' },
  { id: 'orbDamage', label: 'Orbs Damage', category: 'Combat', getYValue: r => toNum(r.orbDamage), color: '#6EC6FF' },
  { id: 'landMineDamage', label: 'Land Mine Damage', category: 'Combat', getYValue: r => toNum(r.landMineDamage), color: '#A5D6A7' },
  { id: 'chainLightningDamage', label: 'Chain Lightning Damage', category: 'Combat', getYValue: r => toNum(r.chainLightningDamage), color: '#B0BEC5' },
  { id: 'smartMissileDamage', label: 'Smart Missile Damage', category: 'Combat', getYValue: r => toNum(r.smartMissileDamage), color: '#CE93D8' },
  { id: 'innerLandMineDamage', label: 'Inner Land Mine Damage', category: 'Combat', getYValue: r => toNum(r.innerLandMineDamage), color: '#80DEEA' },
  { id: 'swampDamage', label: 'Poison Swamp Damage', category: 'Combat', getYValue: r => toNum(r.swampDamage), color: '#9CCC65' },
  { id: 'deathWaveDamage', label: 'Death Wave Damage', category: 'Combat', getYValue: r => toNum(r.deathWaveDamage), color: '#EF5350' },
  { id: 'blackHoleDamage', label: 'Black Hole Damage', category: 'Combat', getYValue: r => toNum(r.blackHoleDamage), color: '#7E57C2' },
  { id: 'flameBotDamage', label: 'Flame Bot Damage', category: 'Combat', getYValue: r => toNum(r.flameBotDamage), color: '#FF5722' },
  { id: 'attackChipDamage', label: 'Attack Chip Damage', category: 'Combat', getYValue: r => toNum(r.attackChipDamage), color: '#26A69A' },
  // ── Defense ───────────────────────────────────────────────────────────────
  { id: 'defensePercentBlocked', label: 'Defense % Blocked', category: 'Defense', getYValue: r => toNum(r.defensePercentBlocked), color: '#29B6F6' },
  { id: 'defenseAbsoluteBlocked', label: 'Defense Absolute Blocked', category: 'Defense', getYValue: r => toNum(r.defenseAbsoluteBlocked), color: '#4FC3F7' },
  { id: 'chronoFieldBlocked', label: 'Chrono Field Blocked', category: 'Defense', getYValue: r => toNum(r.chronoFieldBlocked), color: '#26C6DA' },
  { id: 'chainThunderBlocked', label: 'Chain Thunder Blocked', category: 'Defense', getYValue: r => toNum(r.chainThunderBlocked), color: '#80CBC4' },
  { id: 'flameBotBlocked', label: 'Flame Bot Blocked', category: 'Defense', getYValue: r => toNum(r.flameBotBlocked), color: '#FF8A65' },
  { id: 'primordialCollapseBlocked', label: 'Primordial Collapse Blocked', category: 'Defense', getYValue: r => toNum(r.primordialCollapseBlocked), color: '#CE93D8' },
  { id: 'negativeMassProjectorBlocked', label: 'Neg. Mass Projector Blocked', category: 'Defense', getYValue: r => toNum(r.negativeMassProjectorBlocked), color: '#B0BEC5' },
  // ── Enemies ───────────────────────────────────────────────────────────────
  { id: 'totalEnemies', label: 'Total Enemies', category: 'Enemies', getYValue: r => toNum(r.totalEnemies), color: '#EF5350' },
  { id: 'basic', label: 'Basic', category: 'Enemies', getYValue: r => toNum(r.basic), color: '#BDBDBD' },
  { id: 'fast', label: 'Fast', category: 'Enemies', getYValue: r => toNum(r.fast), color: '#80DEEA' },
  { id: 'tank', label: 'Tank', category: 'Enemies', getYValue: r => toNum(r.tank), color: '#A5D6A7' },
  { id: 'ranged', label: 'Ranged', category: 'Enemies', getYValue: r => toNum(r.ranged), color: '#FFD54F' },
  { id: 'boss', label: 'Boss', category: 'Enemies', getYValue: r => toNum(r.boss), color: '#EF9A9A' },
  { id: 'protector', label: 'Protector', category: 'Enemies', getYValue: r => toNum(r.protector), color: '#CE93D8' },
  { id: 'vampires', label: 'Vampires', category: 'Enemies', getYValue: r => toNum(r.vampires), color: '#9575CD' },
  { id: 'rays', label: 'Rays', category: 'Enemies', getYValue: r => toNum(r.rays), color: '#4FC3F7' },
  { id: 'scatters', label: 'Scatters', category: 'Enemies', getYValue: r => toNum(r.scatters), color: '#F48FB1' },
  { id: 'saboteurs', label: 'Saboteurs', category: 'Enemies', getYValue: r => toNum(r.saboteurs), color: '#FFCC80' },
  { id: 'commanders', label: 'Commanders', category: 'Enemies', getYValue: r => toNum(r.commanders), color: '#80CBC4' },
  { id: 'overcharges', label: 'Overcharges', category: 'Enemies', getYValue: r => toNum(r.overcharges ?? r.overcharge), color: '#F48FB1' },
  { id: 'guardianSummonedEnemies', label: 'Summoned Enemies', category: 'Enemies', getYValue: r => toNum(r.guardianSummonedEnemies), color: '#BCAAA4' },
  // ── Utility ───────────────────────────────────────────────────────────────
  { id: 'recoveryPackages', label: 'Recovery Packages', category: 'Utility', getYValue: r => toNum(r.recoveryPackages), color: '#81C784' },
  { id: 'freeAttackUpgrade', label: 'Free Attack Upgrades', category: 'Utility', getYValue: r => toNum(r.freeAttackUpgrade), color: '#EF5350' },
  { id: 'freeDefenseUpgrade', label: 'Free Defense Upgrades', category: 'Utility', getYValue: r => toNum(r.freeDefenseUpgrade), color: '#29B6F6' },
  { id: 'freeUtilityUpgrade', label: 'Free Utility Upgrades', category: 'Utility', getYValue: r => toNum(r.freeUtilityUpgrade), color: '#66BB6A' },
  { id: 'enemyAttackLevelsSkipped', label: 'Enemy Atk Levels Skipped', category: 'Utility', getYValue: r => toNum(r.enemyAttackLevelsSkipped), color: '#FFA726' },
  { id: 'enemyHealthLevelsSkipped', label: 'Enemy HP Levels Skipped', category: 'Utility', getYValue: r => toNum(r.enemyHealthLevelsSkipped), color: '#FFCA28' },
  { id: 'wavesSkipped', label: 'Waves Skipped', category: 'Utility', getYValue: r => toNum(r.wavesSkipped), color: '#AB47BC' },
  // ── Bots ──────────────────────────────────────────────────────────────────
  { id: 'flameBotDamageBot', label: 'Flame Bot Damage', category: 'Bots', getYValue: r => toNum(r.flameBotDamage), color: '#FF5722' },
  { id: 'thunderBotStuns', label: 'Thunder Bot Stuns', category: 'Bots', getYValue: r => toNum(r.thunderBotStuns), color: '#B0BEC5' },
  { id: 'goldenBotCoinsEarned', label: 'Golden Bot Coins Earned', category: 'Bots', getYValue: r => toNum(r.goldenBotCoinsEarned), color: '#FFD54F' },
  { id: 'destroyedInGoldenBot', label: 'Killed in Golden Bot', category: 'Bots', getYValue: r => toNum(r.destroyedInGoldenBot), color: '#C99700' },
  // ── Guardian ──────────────────────────────────────────────────────────────
  { id: 'guardianDamage', label: 'Guardian Damage', category: 'Guardian', getYValue: r => toNum(r.guardianDamage), color: '#CE93D8' },
  { id: 'guardianCoinsStolen', label: 'Guardian Coins Stolen', category: 'Guardian', getYValue: r => toNum(r.guardianCoinsStolen), color: '#F9A825' },
  { id: 'coinsFetched', label: 'Coins Fetched', category: 'Guardian', getYValue: r => toNum(r.coinsFetched), color: '#FFCA28' },
  { id: 'gemsFetched', label: 'Gems Fetched', category: 'Guardian', getYValue: r => toNum(r.gemsFetched), color: '#80DEEA' },
  { id: 'medalsEarned', label: 'Medals Earned', category: 'Guardian', getYValue: r => toNum(r.medalsEarned), color: '#FFD54F' },
  { id: 'rerollShardsFetched', label: 'Dice Fetched', category: 'Guardian', getYValue: r => toNum(r.rerollShardsFetched), color: '#F44336' },
  { id: 'cannonShardsFetched', label: 'Cannon Shards Fetched', category: 'Guardian', getYValue: r => toNum(r.cannonShardsFetched), color: '#42A5F5' },
  { id: 'armorShardsFetched', label: 'Armor Shards Fetched', category: 'Guardian', getYValue: r => toNum(r.armorShardsFetched), color: '#42A5F5' },
  { id: 'generatorShardsFetched', label: 'Generator Shards Fetched', category: 'Guardian', getYValue: r => toNum(r.generatorShardsFetched), color: '#42A5F5' },
  { id: 'coreShardsFetched', label: 'Core Shards Fetched', category: 'Guardian', getYValue: r => toNum(r.coreShardsFetched), color: '#42A5F5' },
  // ── Coverage ──────────────────────────────────────────────────────────────
  { id: 'coverageGtPct', label: 'Golden Tower %', category: 'Coverage', getYValue: r => toNum(r.coverageGtPct), color: '#F4D03F' },
  { id: 'coverageBhPct', label: 'Black Hole %', category: 'Coverage', getYValue: r => toNum(r.coverageBhPct), color: '#7E57C2' },
  { id: 'coverageOrbsPct', label: 'Orbs %', category: 'Coverage', getYValue: r => toNum(r.coverageOrbsPct), color: '#6EC6FF' },
  { id: 'coverageDwPct', label: 'Death Wave %', category: 'Coverage', getYValue: r => toNum(r.coverageDwPct), color: '#E53935' },
  { id: 'coverageSlPct', label: 'Spotlight %', category: 'Coverage', getYValue: r => toNum(r.coverageSlPct), color: '#E0E0E0' },
  { id: 'coverageGbPct', label: 'Golden Bot %', category: 'Coverage', getYValue: r => toNum(r.coverageGbPct), color: '#C99700' },
  { id: 'coverageAmpPct', label: 'Amp Bot %', category: 'Coverage', getYValue: r => toNum(r.coverageAmpPct), color: '#1565C0' },
];

const ITEMS_PER_PAGE = 25;

// ─── Session state ─────────────────────────────────────────────────────────────

type AnalysisState = {
  page: number;
};

const analysisState = new Map<string, AnalysisState>();

function getAnalysisState(userId: string): AnalysisState {
  if (!analysisState.has(userId)) {
    analysisState.set(userId, { page: 0 });
  }
  return analysisState.get(userId)!;
}

function updateAnalysisState(userId: string, patch: Partial<AnalysisState>): AnalysisState {
  const current = getAnalysisState(userId);
  const next = { ...current, ...patch };
  analysisState.set(userId, next);
  return next;
}

// ─── Payload builder ──────────────────────────────────────────────────────────

function buildAnalysisMenuPayload(page: number) {
  const totalPages = Math.ceil(ANALYSIS_CHARTS.length / ITEMS_PER_PAGE);
  const start = page * ITEMS_PER_PAGE;
  const pageCharts = ANALYSIS_CHARTS.slice(start, start + ITEMS_PER_PAGE);

  // Group labels for display
  const grouped = pageCharts.reduce<Record<string, string[]>>((acc, c) => {
    (acc[c.category] ??= []).push(c.label);
    return acc;
  }, {});
  const categoryLines = Object.entries(grouped)
    .map(([cat, labels]) => `**${cat}**: ${labels.join(', ')}`)
    .join('\n');

  const embed = new EmbedBuilder()
    .setTitle('📊 Analysis Charts')
    .setDescription(`Select a chart from the dropdown below to visualise your run history.\n\n${categoryLines}`)
    .setColor(Colors.Blue)
    .setFooter({ text: `Page ${page + 1} of ${totalPages}` });

  const selectRow = new ActionRowBuilder<StringSelectMenuBuilder>().addComponents(
    new StringSelectMenuBuilder()
      .setCustomId(TRACKER_IDS.analysis.select)
      .setPlaceholder('Choose a chart…')
      .addOptions(
        pageCharts.map(c => ({
          label: c.label,
          description: c.category,
          value: c.id,
        })),
      ),
  );

  const navRow = new ActionRowBuilder<ButtonBuilder>().addComponents(
    new ButtonBuilder()
      .setCustomId(TRACKER_IDS.analysis.prev)
      .setLabel('◀ Prev')
      .setStyle(ButtonStyle.Secondary)
      .setDisabled(page === 0),
    new ButtonBuilder()
      .setCustomId(TRACKER_IDS.analysis.next)
      .setLabel('Next ▶')
      .setStyle(ButtonStyle.Secondary)
      .setDisabled(page >= totalPages - 1),
    new ButtonBuilder()
      .setCustomId(TRACKER_IDS.flow.mainMenu)
      .setLabel('Main Menu')
      .setStyle(ButtonStyle.Primary),
  );

  return {
    content: '',
    embeds: [embed],
    components: [selectRow, navRow],
    files: [],
    attachments: [],
  };
}

// ─── Handlers ─────────────────────────────────────────────────────────────────

export async function handleTrackMenuAnalysis(interaction: TrackMenuInteraction) {
  try {
    if (!interaction.deferred && !interaction.replied) {
      await interaction.deferUpdate().catch(() => {});
    }
    const state = updateAnalysisState(interaction.user.id, { page: 0 });
    const payload = buildAnalysisMenuPayload(state.page);
    await interaction.editReply(payload);
  } catch (err) {
    await logError(interaction.client, interaction.user, err, 'analysis_menu');
  }
}

export async function handleTrackMenuAnalysisPrev(interaction: TrackMenuInteraction) {
  try {
    if (!interaction.deferred && !interaction.replied) {
      await interaction.deferUpdate().catch(() => {});
    }
    const state = getAnalysisState(interaction.user.id);
    const next = updateAnalysisState(interaction.user.id, { page: Math.max(0, state.page - 1) });
    const payload = buildAnalysisMenuPayload(next.page);
    await interaction.editReply(payload);
  } catch (err) {
    await logError(interaction.client, interaction.user, err, 'analysis_prev');
  }
}

export async function handleTrackMenuAnalysisNext(interaction: TrackMenuInteraction) {
  try {
    if (!interaction.deferred && !interaction.replied) {
      await interaction.deferUpdate().catch(() => {});
    }
    const state = getAnalysisState(interaction.user.id);
    const maxPage = Math.ceil(ANALYSIS_CHARTS.length / ITEMS_PER_PAGE) - 1;
    const next = updateAnalysisState(interaction.user.id, { page: Math.min(maxPage, state.page + 1) });
    const payload = buildAnalysisMenuPayload(next.page);
    await interaction.editReply(payload);
  } catch (err) {
    await logError(interaction.client, interaction.user, err, 'analysis_next');
  }
}

export async function handleTrackMenuAnalysisSelect(interaction: TrackMenuInteraction) {
  try {
    if (!interaction.deferred && !interaction.replied) {
      await interaction.deferUpdate().catch(() => {});
    }

    const chartId = 'values' in interaction && Array.isArray((interaction as { values: unknown }).values)
      ? String((interaction as { values: string[] }).values[0] ?? '')
      : '';

    if (!chartId) {
      await interaction.editReply({ content: 'No chart selected.', embeds: [], components: [], files: [], attachments: [] });
      return;
    }

    const chartDef = ANALYSIS_CHARTS.find(c => c.id === chartId);
    if (!chartDef) {
      await interaction.editReply({ content: 'Unknown chart.', embeds: [], components: [], files: [], attachments: [] });
      return;
    }

    const summary = await getLastRun(interaction.user.id, { cloudSyncMode: 'none' });
    const allRuns = (summary?.allRuns ?? []) as Record<string, unknown>[];

    // Most recent 40 runs, oldest first for chart display
    const runs = [...allRuns].slice(0, 40).reverse();

    const labels: string[] = [];
    const values: (number | null)[] = [];

    for (const run of runs) {
      const dateRaw = String(run.date ?? run.runDate ?? '');
      const label = dateRaw.length >= 10 ? dateRaw.slice(5, 10) : dateRaw || '?';
      const val = chartDef.getYValue(run);
      labels.push(label);
      values.push(val);
    }

    const hasData = values.some(v => v !== null);
    if (!hasData) {
      const state = getAnalysisState(interaction.user.id);
      const menuPayload = buildAnalysisMenuPayload(state.page);
      await interaction.editReply({
        ...menuPayload,
        content: `No data for **${chartDef.label}** in your recent runs.`,
      });
      return;
    }

    const chartBytes = await renderAnalyticsLineChartPng(
      {
        title: chartDef.label,
        labels,
        datasets: [
          { label: chartDef.label, color: chartDef.color, values },
        ],
        width: 900,
        height: 400,
      },
      runtime,
    );

    const attachment = new AttachmentBuilder(Buffer.from(chartBytes), { name: `${chartId}-chart.png` });

    const displayValues = values.filter((v): v is number => v !== null);
    const avg = displayValues.reduce((s, v) => s + v, 0) / (displayValues.length || 1);
    const max = Math.max(...displayValues);
    const min = Math.min(...displayValues);

    const embed = new EmbedBuilder()
      .setTitle(`📊 ${chartDef.label}`)
      .setDescription(
        `**Avg:** ${formatNumberForDisplay(avg)}\n` +
        `**Max:** ${formatNumberForDisplay(max)}\n` +
        `**Min:** ${formatNumberForDisplay(min)}\n` +
        `*Last ${runs.length} runs*`,
      )
      .setColor(Colors.Blue)
      .setImage(`attachment://${chartId}-chart.png`);

    const state = getAnalysisState(interaction.user.id);
    const totalPages = Math.ceil(ANALYSIS_CHARTS.length / ITEMS_PER_PAGE);
    const start = state.page * ITEMS_PER_PAGE;
    const pageCharts = ANALYSIS_CHARTS.slice(start, start + ITEMS_PER_PAGE);
    const selectRow = new ActionRowBuilder<StringSelectMenuBuilder>().addComponents(
      new StringSelectMenuBuilder()
        .setCustomId(TRACKER_IDS.analysis.select)
        .setPlaceholder(`Select another chart…`)
        .addOptions(
          pageCharts.map(c => ({
            label: c.label,
            description: c.category,
            value: c.id,
            default: c.id === chartId,
          })),
        ),
    );
    const navRow = new ActionRowBuilder<ButtonBuilder>().addComponents(
      new ButtonBuilder()
        .setCustomId(TRACKER_IDS.analysis.prev)
        .setLabel('◀ Prev')
        .setStyle(ButtonStyle.Secondary)
        .setDisabled(state.page === 0),
      new ButtonBuilder()
        .setCustomId(TRACKER_IDS.analysis.next)
        .setLabel('Next ▶')
        .setStyle(ButtonStyle.Secondary)
        .setDisabled(state.page >= totalPages - 1),
      new ButtonBuilder()
        .setCustomId(TRACKER_IDS.analysis.menu)
        .setLabel('Chart List')
        .setStyle(ButtonStyle.Secondary),
      new ButtonBuilder()
        .setCustomId(TRACKER_IDS.flow.mainMenu)
        .setLabel('Main Menu')
        .setStyle(ButtonStyle.Primary),
    );

    await interaction.editReply({
      content: '',
      embeds: [embed],
      files: [attachment],
      components: [selectRow, navRow],
      attachments: [],
    });
  } catch (err) {
    await logError(interaction.client, interaction.user, err, 'analysis_select');
  }
}
