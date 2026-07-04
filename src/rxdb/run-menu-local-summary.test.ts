import { describe, expect, it, vi } from 'vitest';
import { loadBotMenuRunSummary } from './run-menu-local-summary';
vi.mock('../../services/idb', () => ({
  getTrackerKv: vi.fn(async () => null),
  setTrackerKv: vi.fn(async () => {}),
}));

vi.mock('../features/track/local-run-store', () => ({
  getLegacyKvRuns: vi.fn(async () => []),
  clearLegacyKvRuns: vi.fn(async () => {}),
}));

const part1Docs: Array<Record<string, unknown>> = [];
const part2Docs: Array<Record<string, unknown>> = [];

function makeRxDoc(payload: Record<string, unknown>) {
  return {
    ...payload,
    toJSON: () => payload,
  };
}

vi.mock('./init-database', () => ({
  initSharedBotRunTrackerRxDatabase: vi.fn(async () => ({
    run_part_1: {
      find: () => ({
        exec: async () => part1Docs.map((doc) => makeRxDoc(doc)),
      }),
    },
    run_part_2: {
      find: () => ({
        exec: async () => part2Docs.map((doc) => makeRxDoc(doc)),
      }),
    },
  })),
}));

describe('loadBotMenuRunSummary', () => {
  it('stitches only recent analytics runs while reporting full counts', async () => {
    part1Docs.length = 0;
    part2Docs.length = 0;

    const now = Date.now();
    part1Docs.push(
      {
        id: 'old-run',
        botScopeUserId: 'discord-1',
        type: 'Farming',
        runDate: '2020-01-01',
        runTime: '12:00',
        updatedAt: now - 30 * 24 * 60 * 60 * 1000,
      },
      {
        id: 'recent-run',
        botScopeUserId: 'discord-1',
        type: 'Farming',
        runDate: '2026-07-01',
        runTime: '18:00',
        updatedAt: now - 60_000,
        totalCoins: '100',
        roundDuration: '1h',
      },
    );
    part2Docs.push(
      {
        id: 'recent-run',
        botScopeUserId: 'discord-1',
        updatedAt: now - 60_000,
        coinsPerHour: '100',
      },
    );

    const summary = await loadBotMenuRunSummary('discord-1');
    expect(summary.totalRuns).toBe(2);
    expect(summary.runTypeCounts.Farming).toBe(2);
    expect(summary.lastRun?.runId ?? summary.lastRun?.id).toBe('recent-run');
    expect(summary.recentRunsForAnalytics).toHaveLength(1);
    expect(summary.recentRunsForAnalytics[0]?.id ?? summary.recentRunsForAnalytics[0]?.runId).toBe('recent-run');
  });
});
