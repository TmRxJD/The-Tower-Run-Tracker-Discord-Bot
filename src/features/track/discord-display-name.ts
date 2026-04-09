type RecordLike = Record<string, unknown>

function isRecord(value: unknown): value is RecordLike {
  return value !== null && typeof value === 'object'
}

function pickNonEmptyString(...values: unknown[]): string | null {
  for (const value of values) {
    if (typeof value === 'string' && value.trim()) return value.trim()
  }
  return null
}

export function resolveInteractionDisplayName(interaction: unknown): string {
  const record = isRecord(interaction) ? interaction : null
  const user = isRecord(record?.user) ? record.user : null
  const member = isRecord(record?.member) ? record.member : null
  const memberUser = isRecord(member?.user) ? member.user : null

  return pickNonEmptyString(
    member?.displayName,
    member?.nick,
    user?.globalName,
    memberUser?.globalName,
    user?.username,
    memberUser?.username,
    'unknown',
  ) ?? 'unknown'
}

export function buildEmbedUserFromInteraction(interaction: { user: { username: string; displayAvatarURL?: () => string | null } }): { username: string; displayName: string; displayAvatarURL?: () => string | null } {
  return {
    username: interaction.user.username,
    displayName: resolveInteractionDisplayName(interaction),
    displayAvatarURL: interaction.user.displayAvatarURL?.bind(interaction.user),
  }
}