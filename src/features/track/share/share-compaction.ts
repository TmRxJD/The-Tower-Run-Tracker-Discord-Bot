/**
 * This one server asked every run share to be compact so a busy channel isn't buried under
 * full battle reports. Everywhere else the sharer's own preference wins, defaulting to the
 * fully expanded message.
 */
export const COMPACT_ONLY_GUILD_ID = '850137217828388904';

export function shouldCompactShare(params: {
  guildId?: string | null;
  shareCompact?: boolean;
}): boolean {
  if (params.guildId === COMPACT_ONLY_GUILD_ID) return true;
  return params.shareCompact === true;
}
