import { describe, expect, it } from 'vitest';
import { buildRawParseText, buildSubmitPayload } from './review-data-helpers';

describe('review-data-helpers', () => {
  it('formats core fields before sorted additional fields', () => {
    const text = buildRawParseText({
      tierDisplay: '10+',
      wave: '2345',
      totalCoins: '1.5B',
      notes: 'hello',
      alpha: 'A',
      zeta: 'Z',
    });

    expect(text).toContain('tierDisplay: 10+\nwave: 2345\ntotalCoins: 1.5B');
    expect(text).toContain('--- additional fields ---\nalpha: A\nnotes: hello\nzeta: Z');
  });

  it('builds a submit payload with normalized type and notes', async () => {
    const payload = await buildSubmitPayload('user-1', 'name', {
      tierDisplay: '7+',
      wave: '321',
      coins: '99',
      duration: '1h2m3s',
      killedBy: 'Boss',
      date: '2026-03-13',
      time: '09:10 PM',
      type: 'overnight',
      notes: 'stored note',
    }, true, true);

    expect(payload).toMatchObject({
      userId: 'user-1',
      username: 'name',
      note: 'stored note',
    });
    expect(payload.runData).toMatchObject({
      tier: '7+',
      wave: '321',
      totalCoins: '99',
      roundDuration: '1h2m3s',
      killedBy: 'Boss',
      date: '2026-03-13',
      time: '09:10 PM',
      type: 'Overnight',
      notes: 'stored note',
    });
  });

  it('fills missing submit payload fields with defaults when optional fields are excluded', async () => {
    const payload = await buildSubmitPayload('user-2', 'name', {}, false, false);

    expect(payload.note).toBe('');
    expect(payload.runData).toMatchObject({
      tier: '1',
      wave: '1',
      totalCoins: '0',
      totalCells: '0',
      totalDice: '0',
      roundDuration: '0h0m0s',
      killedBy: 'Apathy',
    });
    expect(payload.runData.type).toBeUndefined();
    expect(payload.runData.notes).toBeUndefined();
  });
});