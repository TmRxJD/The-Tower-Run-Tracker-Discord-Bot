import { type Client } from 'discord.js';
import { logger } from '../../core/logger';
import { getTrackerKv, setTrackerKv } from '../../services/idb';
import { createUpdateDelivery, getUpdatesChannel } from './discord-delivery';
import { mirrorPublishedUpdates, type MirrorStore } from './mirror';
import { fetchPublishedUpdates, UPDATES_CHANNEL, UPDATES_SOURCE } from './source';

export const UPDATES_STATE_KEY = 'website-updates-mirror:v1';
export const UPDATES_STATUS_KEY = 'website-updates-status:v1';
export const UPDATES_POLL_MS = 60_000;
let stopMirror: (() => void) | null = null;
const store: MirrorStore = {
  load: () => getTrackerKv(UPDATES_STATE_KEY),
  save: state => setTrackerKv(UPDATES_STATE_KEY, state, { requirePersistent: true }),
};

export function startWebsiteUpdatesMirror(client: Client, mode: 'dev' | 'prod'): void {
  if (mode !== 'prod' || stopMirror) return;
  let stopped = false;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const tick = async () => {
    if (stopped) return;
    let stage: 'readiness' | 'source' | 'channel' | 'delivery' | 'status' = 'readiness';
    try {
      if (!client.isReady()) throw new Error('Discord is not ready');
      stage = 'source';
      const releases = await fetchPublishedUpdates();
      if (stopped) return;
      stage = 'channel';
      const channel = await getUpdatesChannel(client);
      if (stopped) return;
      stage = 'delivery';
      const result = await mirrorPublishedUpdates(releases, store, createUpdateDelivery(channel, client.user.id));
      stage = 'status';
      await setTrackerKv(UPDATES_STATUS_KEY, {
        pid: process.pid, checkedAt: Date.now(), ok: true, source: UPDATES_SOURCE,
        channelId: channel.id, channelName: channel.name, publishedEntries: releases.length,
        latestTitle: releases[0].title, latestHash: releases[0].hash, result,
      }, { requirePersistent: true });
      if (Object.values(result).some(Boolean)) logger.warn('[website-updates] mirror checkpoint', result);
    } catch (error) {
      // Do not log remote bodies, tokens or raw exceptions. Durable pending intents remain retryable.
      const code = typeof error === 'object' && error !== null && 'code' in error ? String(error.code).slice(0, 40) : undefined;
      logger.warn('[website-updates] poll failed; retrying after one minute', { stage, code });
      await setTrackerKv(UPDATES_STATUS_KEY, {
        pid: process.pid, checkedAt: Date.now(), ok: false, source: UPDATES_SOURCE, channelId: UPDATES_CHANNEL, stage, code,
      }, { requirePersistent: true }).catch(() => undefined);
    } finally {
      if (!stopped) { timer = setTimeout(() => void tick(), UPDATES_POLL_MS); timer.unref(); }
    }
  };
  stopMirror = () => { stopped = true; if (timer) clearTimeout(timer); };
  void tick();
}

export function stopWebsiteUpdatesMirror(): void {
  stopMirror?.();
  stopMirror = null;
}
