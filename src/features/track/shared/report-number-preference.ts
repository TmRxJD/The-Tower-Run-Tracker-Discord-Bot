import { detectGovernedDecimalSeparator } from '@tmrxjd/platform/tools';
import { getEffectiveUserSharedSettings } from '../../../services/user-shared-settings-db';

export async function resolveReportInputPreference(userId: string, localeTag: string | undefined, fallback?: string): Promise<string | undefined> {
  const settings = await getEffectiveUserSharedSettings(userId, { localOnly: true }).catch(() => null);
  if (!settings) return fallback;
  const preference = settings.decimalSeparatorPreference;
  const separator = preference === 'comma' || preference === 'dot'
    ? preference
    : detectGovernedDecimalSeparator(localeTag);
  return separator === 'comma' ? 'Comma (,)' : 'Period (.)';
}
