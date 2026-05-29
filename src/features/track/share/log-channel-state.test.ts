import { describe, expect, it } from 'vitest';
import { buildAutoLogRunKey, buildAutoLogRunKeys } from './log-channel-state';

describe('log-channel-state', () => {
  it('uses normalized fallback document ids for auto-log keys', () => {
    expect(buildAutoLogRunKey({ id: ' cloud-run ' })).toBe('runId:cloud-run');
    expect(buildAutoLogRunKeys({ id: ' cloud-run ', localId: ' local-run ' })).toEqual([
      'runId:cloud-run',
      'localId:local-run',
    ]);
  });

  it('falls back to a fingerprint key when no ids exist', () => {
    expect(buildAutoLogRunKey({
      tier: '11',
      wave: '7000',
      duration: '9h 54m 5s',
      totalCoins: '76.37T',
    })).toBe('fp:11|7000|9h54m5s|76.37T');
  });
});