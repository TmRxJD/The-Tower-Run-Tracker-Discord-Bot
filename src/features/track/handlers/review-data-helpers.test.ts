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

  it('formats raw parse text from canonical values when conflicting aliases exist', () => {
    const text = buildRawParseText({
      wave: '7676',
      Wave: '167963',
      killedBy: 'Fast',
      'Killed By': 'Apathy',
      totalDice: '16.80K',
      rerollShards: '420',
    });

    expect(text).toContain('wave: 7676');
    expect(text).toContain('killedBy: Fast');
    expect(text).toContain('totalDice: 16.80K');
    expect(text).not.toContain('Wave: 167963');
    expect(text).not.toContain('Killed By: Apathy');
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

  it('builds submit payloads from canonical fields when aliases conflict', async () => {
    const payload = await buildSubmitPayload('user-3', 'name', {
      wave: '7676',
      Wave: '167963',
      totalCoins: '76.37T',
      coins: '76.37T',
      totalCells: '128.82K',
      cells: '128.82K',
      totalDice: '16.80K',
      rerollShards: '420',
      killedBy: 'Fast',
      'Killed By': 'Apathy',
      roundDuration: '9h54m5s',
      date: '2026-03-21',
      time: '13:47:00',
    }, false, false);

    expect(payload.runData).toMatchObject({
      wave: '7676',
      totalCoins: '76.37T',
      totalCells: '128.82K',
      totalDice: '16.80K',
      killedBy: 'Fast',
    });
  });
});