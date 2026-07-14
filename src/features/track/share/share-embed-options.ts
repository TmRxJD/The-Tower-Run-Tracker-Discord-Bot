import type { ShareEmbedInput } from './share-embed';

type ShareToggleKey =
  | 'shareTier' | 'shareWave' | 'shareDuration' | 'shareKilledBy'
  | 'shareTotalCoins' | 'shareTotalCells' | 'shareTotalDice' | 'shareTotalShards' | 'shareDeathDefy'
  | 'shareCoinsPerHour' | 'shareCellsPerHour' | 'shareDicePerHour'
  | 'shareShardsPerHour' | 'shareWavesPerHour' | 'shareEnemiesPerHour'
  | 'shareNotes' | 'shareCoverage' | 'shareScreenshot'
  | 'shareCoverageGoldenTower' | 'shareCoverageBlackHole' | 'shareCoverageSpotlight' | 'shareCoverageDeathWave'
  | 'shareCoverageOrbs' | 'shareCoverageGoldenBot' | 'shareCoverageAmpBot' | 'shareCoverageSummoned';

export type ShareSettingsLike = Partial<Record<ShareToggleKey, unknown>> | null | undefined;

/**
 * Every share element defaults to enabled, so a share setting only counts as off when it
 * is explicitly `false`. Shared by the manual share, the auto log-channel share, and the
 * Expand button so all three render the same run identically.
 */
export function resolveShareEmbedOptions(settings: ShareSettingsLike): NonNullable<ShareEmbedInput['options']> {
  const enabled = (key: ShareToggleKey) => settings?.[key] !== false;

  return {
    includeTier: enabled('shareTier'),
    includeWave: enabled('shareWave'),
    includeDuration: enabled('shareDuration'),
    includeKilledBy: enabled('shareKilledBy'),
    includeTotalCoins: enabled('shareTotalCoins'),
    includeTotalCells: enabled('shareTotalCells'),
    includeTotalDice: enabled('shareTotalDice'),
    includeTotalShards: enabled('shareTotalShards'),
    includeDeathDefy: enabled('shareDeathDefy'),
    includeCoinsPerHour: enabled('shareCoinsPerHour'),
    includeCellsPerHour: enabled('shareCellsPerHour'),
    includeDicePerHour: enabled('shareDicePerHour'),
    includeShardsPerHour: enabled('shareShardsPerHour'),
    includeWavesPerHour: enabled('shareWavesPerHour'),
    includeEnemiesPerHour: enabled('shareEnemiesPerHour'),
    includeNotes: enabled('shareNotes'),
    includeCoverage: enabled('shareCoverage'),
    includeCoverageGoldenTower: enabled('shareCoverageGoldenTower'),
    includeCoverageBlackHole: enabled('shareCoverageBlackHole'),
    includeCoverageSpotlight: enabled('shareCoverageSpotlight'),
    includeCoverageDeathWave: enabled('shareCoverageDeathWave'),
    includeCoverageOrbs: enabled('shareCoverageOrbs'),
    includeCoverageGoldenBot: enabled('shareCoverageGoldenBot'),
    includeCoverageAmpBot: enabled('shareCoverageAmpBot'),
    includeCoverageSummoned: enabled('shareCoverageSummoned'),
    includeScreenshot: enabled('shareScreenshot'),
  };
}
