import { beforeEach, describe, expect, it, vi } from 'vitest';

const mockListDocuments = vi.fn();
const mockAppendTrackerAnalyticsEvent = vi.fn();

vi.mock('../services/idb', () => ({
  appendTrackerAnalyticsEvent: (...args: unknown[]) => {
    mockAppendTrackerAnalyticsEvent(...args);
    return Promise.resolve();
  },
  listTrackerAnalyticsBetween: vi.fn().mockResolvedValue([]),
}));

vi.mock('../config', () => ({
  getAppConfig: () => ({
    appwrite: {
      databaseId: 'tracker',
      analyticsCollectionId: 'analytics',
    },
  }),
}));

vi.mock('node-appwrite', () => ({
  ID: {
    unique: () => 'generated-id',
  },
  Query: {
    greaterThanEqual: (field: string, value: unknown) => ({ field, value, op: 'gte' }),
    lessThanEqual: (field: string, value: unknown) => ({ field, value, op: 'lte' }),
    limit: (value: number) => ({ value, op: 'limit' }),
  },
}));

vi.mock('../core/logger', () => ({
  logger: {
    warn: vi.fn(),
  },
}));

describe('AnalyticsRepo', () => {
  beforeEach(() => {
    vi.resetModules();
    mockListDocuments.mockReset();
    mockAppendTrackerAnalyticsEvent.mockReset();
  });

  it('filters malformed remote analytics events from list results', async () => {
    mockListDocuments.mockResolvedValue({
      documents: [
        {
          $id: 'event-1',
          ts: '2026-03-27T10:00:00.000Z',
          event: 'command_used',
          userId: 'user-1',
          guildId: 'guild-1',
          commandName: 'analytics',
          runId: 'run-1',
          meta: '{}',
        },
        {
          $id: 'event-2',
          ts: '',
          event: 'command_used',
        },
      ],
    });

    const { AnalyticsRepo } = await import('./analytics-repo.js');
    const repo = new AnalyticsRepo({
      listDocuments: (...args: unknown[]) => mockListDocuments(...args),
    } as never);

    const events = await repo.listBetween('2026-03-27T00:00:00.000Z', '2026-03-28T00:00:00.000Z');

    expect(events).toHaveLength(1);
    expect(events[0].ts).toBe('2026-03-27T10:00:00.000Z');
    expect(mockAppendTrackerAnalyticsEvent).toHaveBeenCalledTimes(1);
  });
});