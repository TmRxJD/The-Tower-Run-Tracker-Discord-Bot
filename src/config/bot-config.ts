import type { ConfigsRepo } from '../persistence/configs-repo';
import { loadBotConfig as loadBotConfigFromRepo } from './bot-config-loader';

// Default bot configuration mirroring the Mod Bot structure: meta/common plus per-command config.
export const defaultBotConfig = {
  meta: {
    botName: 'Tower Run Tracker',
  },
  common: {
    responses: {
      notReady: 'Bot not ready. Please try again.',
      genericError: 'Something went wrong. Please try again later.',
    },
  },
  commands: {
    ping: {
      name: 'ping',
      description: 'Check bot responsiveness',
      messages: {
        pending: 'Pinging...',
        resultPrefix: 'Pong! Latency: ',
        latencyUnit: 'ms',
        apiLabel: ' | API: ',
      },
    },
    analytics: {
      name: 'analytics',
      description: 'View bot usage analytics',
      options: {
        daysBack: {
          name: 'days_back',
          description: 'Days back to display (1-30, default 7)',
          min: 1,
          max: 30,
        },
      },
      messages: {
        titlePrefix: 'Analytics (last ',
        titleSuffix: ' days)',
        footerPrefix: 'Requested by ',
        noData: 'No analytics events recorded for this period.',
        summaryLabel: 'Total events',
        usersLabel: 'Unique users',
        guildsLabel: 'Unique guilds',
        commandsHeader: 'By command',
        eventsHeader: 'By event type',
        none: 'none',
        loadFailed: 'Failed to load analytics.',
      },
    },
    track: {
      name: 'track',
      description: 'Track and analyze your Tower runs',
      options: {
        paste: { name: 'paste', description: 'Paste Battle Report text' },
        note: { name: 'note', description: 'Optional note to attach' },
        type: {
          name: 'type',
          description: 'Run type',
          choices: [
            { name: 'Farming', value: 'Farming' },
            { name: 'Overnight', value: 'Overnight' },
            { name: 'Tournament', value: 'Tournament' },
            { name: 'Milestone', value: 'Milestone' },
          ] as const,
        },
        screenshot: { name: 'screenshot', description: 'Screenshot of your run' },
        settings: { name: 'settings', description: 'Open settings menu' },
      },
      messages: {
        placeholder: 'Tracker is being rewritten in TS. Flow coming soon.',
        accepted: 'Run received. We will process it shortly.',
        missingInput: 'Provide a battle report paste or a screenshot to log a run.',
          parseFailed: 'Could not parse that run. Please check the battle report text or try again with a clearer screenshot.',
        submitFailed: 'Run submission failed. Please try again.',
        settingsTitle: 'Tracker Settings',
        settingsDescription: 'Settings sync with your tracker account. UI editing will return soon.',
        noSettings: 'No saved settings found; defaults are in use.',
        summaryTitle: 'Run logged',
        fields: {
          tier: 'Tier',
          wave: 'Wave',
          duration: 'Real Time',
          coins: 'Coins',
          cells: 'Cells',
          dice: 'Reroll Shards',
          killedBy: 'Killed By',
          runType: 'Run Type',
          date: 'Battle Date',
          note: 'Note',
          rates: 'Per hour',
        },
      },
    },
    lifetime: {
      name: 'lifetime',
      description: 'Track and analyze your Tower lifetime stats',
      options: {
        screenshot: { name: 'screenshot', description: 'Screenshot of your lifetime stats' },
        settings: { name: 'settings', description: 'Open settings menu' },
      },
      messages: {
        accepted: 'Lifetime stats received. We will process it shortly.',
        missingInput: 'Provide a lifetime stats screenshot or use manual entry to log stats.',
        parseFailed: 'Could not parse that lifetime screenshot. Please try again with a clearer screenshot.',
        submitFailed: 'Lifetime stats submission failed. Please try again.',
        settingsTitle: 'Lifetime Tracker Settings',
        settingsDescription: 'Settings are shared with /track and sync with your tracker account.',
        noSettings: 'No saved settings found; defaults are in use.',
        summaryTitle: 'Lifetime stats logged',
      },
    },
    cph: {
      name: 'cph',
      description: 'Calculate coins, cells, or dice earned per hour',
      options: {
        time: { name: 'time', description: 'Enter game time (e.g., 5h10m14s or 1:15:00)' },
        coins: { name: 'coins', description: 'Enter coins earned (e.g., 1k, 1M, 1B)' },
        cells: { name: 'cells', description: 'Enter cells earned (e.g., 1k, 1M, 1B)' },
        dice: { name: 'dice', description: 'Enter dice earned (e.g., 750, 1.2K)' },
      },
      messages: {
        invalidTime: 'Invalid time input. Try formats like 1h30m, 45m, or 1:15:00.',
        missingResources: 'Provide at least one resource: coins, cells, or dice.',
        invalidAmountsPrefix: 'Invalid amount for: ',
        invalidAmountsHint: '. Use values like 1.5M or 750k.',
        headerPrefix: '> Game time: ',
        headerHoursSuffix: 'h',
        summaryDelimiter: '\n',
        totalLabel: ' total -> ',
        perHourSuffix: '/hr',
      },
    },
  },
} as const;

export type BotConfig = typeof defaultBotConfig;
export type CommandCopy = BotConfig['commands'];

export function getBotConfig(): BotConfig {
  return runtimeBotConfig;
}

let runtimeBotConfig: BotConfig = defaultBotConfig;

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function mergeConfig(base: unknown, override: unknown): unknown {
  if (!isPlainObject(override)) return override ?? base;
  if (!isPlainObject(base)) return override;

  const result: Record<string, unknown> = { ...base };
  for (const key of Object.keys(override)) {
    const overrideVal = override[key];
    const baseVal = base[key];
    if (isPlainObject(overrideVal) && isPlainObject(baseVal)) {
      result[key] = mergeConfig(baseVal, overrideVal);
    } else {
      result[key] = overrideVal;
    }
  }
  return result;
}

export async function hydrateBotConfig(configsRepo: ConfigsRepo): Promise<BotConfig> {
  const doc = await loadBotConfigFromRepo(configsRepo);
  if (doc) {
    runtimeBotConfig = mergeConfig(defaultBotConfig, doc) as BotConfig;
  } else {
    runtimeBotConfig = defaultBotConfig;
  }
  return runtimeBotConfig;
}
