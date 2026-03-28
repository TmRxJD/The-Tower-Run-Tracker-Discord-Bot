import { describe, expect, it } from 'vitest';
import { buildRawParseText, buildSubmitPayload } from './review-data-helpers';

describe('review-data-helpers', () => {
  it('formats only scanned battle report fields in shared report order', () => {
    const text = buildRawParseText({
      values: {
        battleDate: 'Mar 26, 2026 06:10',
        gameTime: '20h 4m 30s',
        roundDuration: '4h 3m 56s',
        tier: '20',
        wave: '5169',
        totalCoins: '16.17Q',
        damageDealt: '1.32ad',
        totalEnemies: '678115',
        guardianSummonedEnemies: '72.44K',
      },
      tierDisplay: '20',
      type: 'Farming',
      notes: 'hello',
      reportTimestamp: '2026-03-26T06:10:00.000Z',
    });

    expect(text).toBe([
      'Battle Report',
      'Battle Date\tMar 26, 2026 06:10',
      'Game Time\t20h 4m 30s',
      'Real Time\t4h 3m 56s',
      'Tier\t20',
      'Wave\t5169',
      'Coins earned\t16.17Q',
      'Combat',
      'Damage Dealt\t1.32ad',
      'Enemies Destroyed',
      'Total Enemies\t678115',
      'Guardian',
      'Summoned enemies\t72.44K',
    ].join('\n'));
    expect(text).not.toContain('type');
    expect(text).not.toContain('notes');
    expect(text).not.toContain('reportTimestamp');
  });

  it('formats raw parse text from canonical scanned values when conflicting aliases exist', () => {
    const text = buildRawParseText({
      values: {
        wave: '7676',
        killedBy: 'Fast',
        totalDice: '16.80K',
      },
      wave: '7676',
      Wave: '167963',
      killedBy: 'Fast',
      'Killed By': 'Apathy',
      totalDice: '16.80K',
      rerollShards: '420',
    });

    expect(text).toContain('Wave\t7676');
    expect(text).toContain('Killed By\tFast');
    expect(text).toContain('Reroll Shards Earned\t16.80K');
    expect(text).not.toContain('Wave: 167963');
    expect(text).not.toContain('Killed By: Apathy');
  });

  it('builds a submit payload with normalized type and notes', async () => {
    const payload = await buildSubmitPayload('user-1', 'name', {
      tierDisplay: '7+',
      wave: '321',
      'Coins earned': '99',
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