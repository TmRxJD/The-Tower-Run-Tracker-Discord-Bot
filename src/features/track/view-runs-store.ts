type ViewRunsState = {
  count: number;
  offset: number;
  selectedTypes: string[];
  selectedTiers: string[];
  selectedColumns: string[];
  orientation: 'landscape' | 'portrait';
};

/** Layout prefs honored outside the Runs Viewer. Filters are viewer-only and must not hide import rows. */
export type ViewRunsPresentationPrefs = {
  selectedColumns: string[];
  orientation: 'landscape' | 'portrait';
  count: number;
};

const state = new Map<string, ViewRunsState>();

const defaultColumns = [
  'Tier',
  'Wave',
  'Duration',
  'Coins',
  'Cells',
  'Dice',
  'Coins/Hr',
  'Cells/Hr',
  'Dice/Hr',
  'Golden Tower',
  'Black Hole',
  'Spotlight',
  'Orbs',
  'Death Wave',
  'Golden Bot',
  'Amp Bot',
  'Summoned',
  'Type',
  'Date/Time',
];

export function getViewRunsState(userId: string): ViewRunsState {
  if (!state.has(userId)) {
    state.set(userId, {
      count: 10,
      offset: 0,
      selectedTypes: [],
      selectedTiers: ['All'],
      selectedColumns: [...defaultColumns],
      orientation: 'landscape',
    });
  }
  return state.get(userId)!;
}

export function getViewRunsPresentationPrefs(userId: string): ViewRunsPresentationPrefs {
  const { selectedColumns, orientation, count } = getViewRunsState(userId);
  return {
    selectedColumns: [...selectedColumns],
    orientation,
    count,
  };
}

export function updateViewRunsState(userId: string, patch: Partial<ViewRunsState>) {
  const current = getViewRunsState(userId);
  const next = {
    ...current,
    ...patch,
  };
  state.set(userId, next);
  return next;
}

export function resetViewRunsOffset(userId: string) {
  const current = getViewRunsState(userId);
  current.offset = 0;
  state.set(userId, current);
  return current;
}
