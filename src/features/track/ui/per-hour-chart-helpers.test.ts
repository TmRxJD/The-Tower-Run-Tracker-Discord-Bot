import type * as PlatformTools from '@tmrxjd/platform/tools';
import { describe, expect, it, vi } from 'vitest';

const renderAnalyticsLineChartPngMock = vi.fn(async () => new Uint8Array([1, 2, 3]));

vi.mock('@tmrxjd/platform/tools', async () => {
  const actual = await vi.importActual<typeof PlatformTools>('@tmrxjd/platform/tools');
  return {
    ...actual,
    renderAnalyticsLineChartPng: (...args: unknown[]) => renderAnalyticsLineChartPngMock(...args),
  };
});

import { buildPerHourChartAttachment } from './per-hour-chart-helpers';

describe('buildPerHourChartAttachment', () => {
  it('returns null when the last 7 days only contain a single active day', async () => {
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
});