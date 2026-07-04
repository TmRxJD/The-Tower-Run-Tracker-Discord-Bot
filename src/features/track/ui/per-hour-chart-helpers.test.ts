import type * as PlatformTools from '@tmrxjd/platform/tools';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const renderAnalyticsLineChartPngMock = vi.fn(async () => new Uint8Array([1, 2, 3]));

vi.mock('@tmrxjd/platform/tools', async () => {
  const actual = await vi.importActual<typeof PlatformTools>('@tmrxjd/platform/tools');
  return {
    ...actual,
    renderAnalyticsLineChartPng: () => renderAnalyticsLineChartPngMock(),
  };
});

import { buildPerHourChartAttachment } from './per-hour-chart-helpers';

describe('buildPerHourChartAttachment', () => {
  beforeEach(() => {
    renderAnalyticsLineChartPngMock.mockClear();
  });

  it('hides the chart when the last 7 days only contain a single active day', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-05-29T12:00:00Z'));

    const attachment = await buildPerHourChartAttachment([
      {
        type: 'Farming',
        date: '2026-05-29',
        time: '08:00:00',
        totalCoins: '100',
        duration: '01:00:00',
      },
      {
        type: 'Farming',
        date: '2026-05-29',
        time: '18:00:00',
        totalCoins: '150',
        duration: '01:00:00',
      },
    ], 'Farming');

    expect(attachment).toBeNull();
    expect(renderAnalyticsLineChartPngMock).not.toHaveBeenCalled();

    vi.useRealTimers();
  });

  it('builds a chart for bot-style run records with h/m/s durations', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-07-03T18:00:00Z'));

    const attachment = await buildPerHourChartAttachment([
      {
        type: 'Farming',
        date: '7/3/26',
        time: '11:30:00',
        coins: '5.8Q',
        cells: '820K',
        rerollShards: '365K',
        duration: '2h57m49s',
        cannonShardsFetched: '110K',
      },
      {
        type: 'Farming',
        date: '7/2/26',
        time: '10:00:00',
        coins: '5.5Q',
        cells: '800K',
        rerollShards: '350K',
        duration: '2h45m00s',
      },
    ], 'Farming');

    expect(attachment).not.toBeNull();
    expect(renderAnalyticsLineChartPngMock).toHaveBeenCalled();

    vi.useRealTimers();
  });

  it('builds a chart when cloud-synced runs only expose createdAt timestamps', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-07-03T18:00:00Z'));

    const attachment = await buildPerHourChartAttachment([
      {
        type: 'Farming',
        createdAt: new Date('2026-07-02T15:30:00Z').getTime(),
        coins: '5.8Q',
        cells: '820K',
        rerollShards: '365K',
        duration: '2h57m49s',
      },
      {
        type: 'Farming',
        createdAt: new Date('2026-07-03T11:00:00Z').getTime(),
        coins: '5.5Q',
        cells: '800K',
        rerollShards: '350K',
        duration: '2h45m00s',
      },
    ], 'Farming');

    expect(attachment).not.toBeNull();
    expect(renderAnalyticsLineChartPngMock).toHaveBeenCalled();

    vi.useRealTimers();
  });
});