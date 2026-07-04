import { describe, expect, it } from 'vitest';
import { getViewRunsPresentationPrefs, getViewRunsState, updateViewRunsState } from './view-runs-store';

describe('getViewRunsPresentationPrefs', () => {
  it('returns layout prefs without viewer filters', () => {
    const userId = 'presentation-prefs-user';
    updateViewRunsState(userId, {
      selectedTypes: ['Farming'],
      selectedTiers: ['12'],
      selectedColumns: ['Tier', 'Wave', 'Coins'],
      orientation: 'portrait',
      count: 5,
      offset: 20,
    });

    const presentation = getViewRunsPresentationPrefs(userId);
    const fullState = getViewRunsState(userId);

    expect(presentation).toEqual({
      selectedColumns: ['Tier', 'Wave', 'Coins'],
      orientation: 'portrait',
      count: 5,
    });
    expect(presentation).not.toHaveProperty('selectedTypes');
    expect(presentation).not.toHaveProperty('selectedTiers');
    expect(presentation).not.toHaveProperty('offset');
    expect(fullState.selectedTypes).toEqual(['Farming']);
    expect(fullState.selectedTiers).toEqual(['12']);
  });
});
