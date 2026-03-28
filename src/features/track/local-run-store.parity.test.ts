import { beforeEach, describe, expect, it, vi } from 'vitest';

const mockGetTrackerKv = vi.fn();
const mockSetTrackerKv = vi.fn();

vi.mock('../../services/idb', () => ({
  getTrackerKv: (...args: unknown[]) => mockGetTrackerKv(...args),
  setTrackerKv: (...args: unknown[]) => mockSetTrackerKv(...args),
}));

vi.mock('../../core/logger', () => ({
  logger: {
    warn: vi.fn(),
  },
}));

describe('local-run-store parity hydration', () => {
  beforeEach(() => {
    vi.resetModules();
    mockGetTrackerKv.mockReset();
    mockSetTrackerKv.mockReset();
  });

  it('drops malformed queue items during hydration', async () => {
    mockGetTrackerKv.mockResolvedValue({
      version: 1,
      users: {},
      queue: [
        {
          id: 'queue-1',
          op: 'settings',
          userId: 'user-1',
          username: 'tester',
          settingsData: {
            defaultRunType: 'Farming',
            cloudSyncEnabled: true,
          },
          settingsUpdatedAt: 123,
          createdAt: 123,
          retryCount: 0,
          nextRetryAt: 123,
        },
        {
          id: 'queue-2',
          op: 'settings',
          userId: '',
          username: 'tester',
          settingsData: {
            defaultRunType: 'Farming',
          },
          settingsUpdatedAt: 123,
          createdAt: 123,
          retryCount: 0,
          nextRetryAt: 123,
        },
      ],
    });

    const store = await import('./local-run-store');
    const items = await store.getQueueItems('user-1');

    expect(items).toHaveLength(1);
    expect(items[0].id).toBe('queue-1');
  });
});