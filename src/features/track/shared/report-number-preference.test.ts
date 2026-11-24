import { describe, expect, it, vi } from 'vitest';
import { getEffectiveUserSharedSettings } from '../../../services/user-shared-settings-db';
import { resolveReportInputPreference } from './report-number-preference';

vi.mock('../../../services/user-shared-settings-db', () => ({ getEffectiveUserSharedSettings: vi.fn() }));
const settings = vi.mocked(getEffectiveUserSharedSettings);

describe('decimal preference used for modal input', () => {
  it('uses the visible setting over Discord locale and legacy pending settings', async () => {
    settings.mockResolvedValueOnce({ decimalSeparatorPreference: 'comma' } as Awaited<ReturnType<typeof settings>>);
    expect(await resolveReportInputPreference('u', 'en-US', 'Period (.)')).toBe('Comma (,)');
    settings.mockResolvedValueOnce({ decimalSeparatorPreference: 'dot' } as Awaited<ReturnType<typeof settings>>);
    expect(await resolveReportInputPreference('u', 'de-DE', 'Comma (,)')).toBe('Period (.)');
    expect(settings).toHaveBeenLastCalledWith('u', { localOnly: true });
  });

  it('uses locale for Auto or stale invalid settings and falls back if local settings fail', async () => {
    settings.mockResolvedValueOnce({ decimalSeparatorPreference: 'auto' } as Awaited<ReturnType<typeof settings>>);
    expect(await resolveReportInputPreference('u', 'de-DE')).toBe('Comma (,)');
    settings.mockResolvedValueOnce({ decimalSeparatorPreference: 'old' } as unknown as Awaited<ReturnType<typeof settings>>);
    expect(await resolveReportInputPreference('u', 'en-US', 'Comma (,)')).toBe('Period (.)');
    settings.mockRejectedValueOnce(new Error('storage unavailable'));
    expect(await resolveReportInputPreference('u', 'en-US', 'Comma (,)')).toBe('Comma (,)');
  });
});
