import { describe, expect, it } from 'vitest';

import {
  packTrackerRemoveToken,
  parsePrefixedTrackerToken,
  parseTrackerRemoveToken,
  parseTrackerToken,
  parseViewRunsOrientationTarget,
  TRACKER_IDS,
  withToken,
  withTokenAndField,
  withViewRunsOrientationTarget,
} from './track-custom-ids';

describe('track custom ids', () => {
  it('creates tokenized custom ids', () => {
    expect(withToken(TRACKER_IDS.review.acceptPrefix, 'abc')).toBe('tracker_accept:abc');
    expect(withTokenAndField(TRACKER_IDS.review.editModalPrefix, 'abc', 'tier,wave')).toBe('tracker_edit_modal:abc:tier,wave');
  });

  it('parses tracker tokens consistently', () => {
    expect(parseTrackerToken('tracker_accept:abc')).toBe('abc');
    expect(parseTrackerToken('tracker_main_menu')).toBeNull();
    expect(parsePrefixedTrackerToken(TRACKER_IDS.viewRuns.shareConfirmPrefix, 'tracker_share_runs_confirm:abc')).toBe('abc');
    expect(parsePrefixedTrackerToken(TRACKER_IDS.viewRuns.shareConfirmPrefix, 'tracker_share_runs_delete:abc')).toBeNull();
  });

  it('packs and parses remove tokens consistently', () => {
    const token = packTrackerRemoveToken('run:123', 'local value');

    expect(parseTrackerRemoveToken(token)).toEqual({
      runId: 'run:123',
      localId: 'local value',
    });
    expect(parseTrackerRemoveToken(null)).toEqual({
      runId: null,
      localId: null,
    });
  });

  it('creates and parses orientation targets consistently', () => {
    expect(withViewRunsOrientationTarget('portrait')).toBe('tracker_viewruns_orientation:portrait');
    expect(parseViewRunsOrientationTarget('tracker_viewruns_orientation:portrait')).toBe('portrait');
    expect(parseViewRunsOrientationTarget('tracker_viewruns_orientation:landscape')).toBe('landscape');
    expect(parseViewRunsOrientationTarget('tracker_viewruns_orientation:invalid')).toBeNull();
  });
});