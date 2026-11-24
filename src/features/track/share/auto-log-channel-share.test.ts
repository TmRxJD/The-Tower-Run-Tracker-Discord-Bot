import { AttachmentBuilder, MessagePayload } from 'discord.js';
import { beforeEach, expect, it, vi } from 'vitest';
import type { ShareEmbedChannelPayload } from './share-embed-delivery';

const mocks = vi.hoisted(() => ({
  chart: vi.fn(), settings: vi.fn(), previous: vi.fn(), saveRef: vi.fn(), snapshot: vi.fn(),
}));
vi.mock('../tracker-api-client', () => ({ getUserSettings: mocks.settings }));
vi.mock('../local-run-store', () => ({ getLocalRuns: vi.fn() }));
vi.mock('../ui/per-hour-chart-helpers', async original => ({
  ...await original<object>(), buildPerHourChartAttachment: mocks.chart,
}));
vi.mock('./log-channel-state', () => ({ getAutoLogMessageRef: mocks.previous, setAutoLogMessageRef: mocks.saveRef }));
vi.mock('./share-snapshot-store', () => ({ saveShareSnapshot: mocks.snapshot }));
vi.mock('../handlers/error-handlers', () => ({ logError: vi.fn() }));

import { autoShareToConfiguredLogChannel } from './auto-log-channel-share';

const run = { type: 'Farming', localId: 'run', totalCoins: '1.25K', duration: '2h' };
const chartUrl = 'attachment://per-hour-chart.png';

beforeEach(() => {
  vi.clearAllMocks();
  mocks.settings.mockResolvedValue({ logChannelId: 'channel' });
  mocks.snapshot.mockResolvedValue(true);
  mocks.saveRef.mockResolvedValue(undefined);
});

it.each([
  [false, true],
  [false, false],
  [true, true],
  [true, false],
])('auto-log edit=%s chart=%s binds the generated file and safely replaces previous attachments', async (editExisting, hasChart) => {
  mocks.previous.mockResolvedValue(editExisting ? { messageId: 'old', channelId: 'channel' } : null);
  mocks.chart.mockResolvedValue(hasChart ? new AttachmentBuilder(Buffer.from('chart'), { name: 'per-hour-chart.png' }) : null);
  const edit = vi.fn<(payload: ShareEmbedChannelPayload & { attachments: [] }) => Promise<{ id: string }>>().mockResolvedValue({ id: 'old' });
  const send = vi.fn<(payload: ShareEmbedChannelPayload) => Promise<{ id: string }>>().mockResolvedValue({ id: 'new' });
  const fetch = vi.fn().mockResolvedValue({ edit });
  const interaction = { user: { username: 'fixture' }, client: { channels: { fetch: vi.fn().mockResolvedValue({ send, messages: { fetch } }) } } };
  await autoShareToConfiguredLogChannel({ interaction: interaction as never, userId: 'fixture', run, runTypeCounts: { Farming: 2 }, allRuns: [run] });

  expect(mocks.chart).toHaveBeenCalledWith([run], 'Farming');
  expect(edit).toHaveBeenCalledTimes(editExisting ? 1 : 0);
  expect(send).toHaveBeenCalledTimes(editExisting ? 0 : 1);
  const payload = (editExisting ? edit : send).mock.lastCall![0];
  expect(payload.embeds[0].toJSON().thumbnail?.url).toMatch(/^https:\/\//);
  expect(payload.embeds[0].toJSON().image?.url).toBe(hasChart ? chartUrl : undefined);
  expect(payload.files?.map(file => file.name)).toEqual(hasChart ? ['per-hour-chart.png'] : []);
  if (editExisting) {
    expect(payload).toHaveProperty('attachments', []);
    // Resolve through Discord.js itself: the edit retains zero old IDs and sends only the new file, if any.
    const wire = MessagePayload.create({ client: { options: {} } } as never, payload).resolveBody().body as { attachments?: { id: string }[] };
    expect(wire?.attachments?.map(file => String(file.id))).toEqual(hasChart ? ['0'] : []);
  } else {
    expect(payload).not.toHaveProperty('attachments');
  }
});
