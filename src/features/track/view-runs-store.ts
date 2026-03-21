type ViewRunsState = {
  count: number;
  offset: number;
  selectedTypes: string[];
  selectedTiers: string[];
  selectedColumns: string[];
  orientation: 'landscape' | 'portrait';
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
  'Orbs',
  'SL',
  'DW',
  'GB',
  'SMN',
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
