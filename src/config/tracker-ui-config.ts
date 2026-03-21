import rawTrackConfig from './track-ui-config.json';
import rawLifetimeOverrides from './lifetime-ui-config.json';

export type ButtonStyleName = 'Primary' | 'Secondary' | 'Success' | 'Danger' | 'Link';

export type UiButtonItem = {
  key: string;
  label: string;
  style: ButtonStyleName;
  emoji?: string;
};

export type TrackUiConfig = typeof rawTrackConfig;
export type TrackerUiMode = 'track' | 'lifetime';

type PlainObject = Record<string, unknown>;

function isPlainObject(value: unknown): value is PlainObject {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function deepMerge<T>(base: T, override: unknown): T {
  if (!isPlainObject(base) || !isPlainObject(override)) {
    return (override as T) ?? base;
  }

  const result: PlainObject = { ...(base as PlainObject) };
  for (const [key, value] of Object.entries(override)) {
    const current = result[key];
    if (isPlainObject(current) && isPlainObject(value)) {
      result[key] = deepMerge(current, value);
    } else {
      result[key] = value;
    }
  }

  return result as T;
}

let cachedTrackConfig: TrackUiConfig | null = null;
let cachedLifetimeConfig: TrackUiConfig | null = null;

function getTrackConfigInternal(): TrackUiConfig {
  if (cachedTrackConfig) return cachedTrackConfig;
  cachedTrackConfig = rawTrackConfig as TrackUiConfig;
  return cachedTrackConfig;
}

function getLifetimeConfigInternal(): TrackUiConfig {
  if (cachedLifetimeConfig) return cachedLifetimeConfig;
  cachedLifetimeConfig = deepMerge(getTrackConfigInternal(), rawLifetimeOverrides) as TrackUiConfig;
  return cachedLifetimeConfig;
}

export function getTrackUiConfig(): TrackUiConfig {
  return getTrackConfigInternal();
}

export function getTrackerUiConfig(mode: TrackerUiMode = 'track'): TrackUiConfig {
  return mode === 'lifetime' ? getLifetimeConfigInternal() : getTrackConfigInternal();
}
