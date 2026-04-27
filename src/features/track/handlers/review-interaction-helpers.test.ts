import { describe, expect, it } from 'vitest';
import { setTrackerFlowMode } from '../flow-mode-store';
import { ensureType, isTrackReviewFlowEnabled, asTrackReplyInteraction } from './review-interaction-helpers';

describe('review-interaction-helpers', () => {
  it('normalizes supported run types case-insensitively', () => {
    expect(ensureType('overnight')).toBe('Overnight');
    expect(ensureType('TOURNAMENT')).toBe('Tournament');
    expect(ensureType('dissonance')).toBe('Dissonance');
  });

  it('falls back to Farming for empty or unsupported types', () => {
    expect(ensureType('')).toBe('Farming');
    expect(ensureType('speedrun')).toBe('Farming');
  });

  it('treats track as the default and disables review controls for lifetime mode', () => {
    const userId = 'review-helper-lifetime';
    expect(isTrackReviewFlowEnabled(userId)).toBe(true);
    setTrackerFlowMode(userId, 'lifetime');
    expect(isTrackReviewFlowEnabled(userId)).toBe(false);
  });

  it('passes through a tracker reply-shaped interaction', () => {
    const interaction = {
      user: { id: 'user-1', username: 'tester' },
      client: {},
      deferReply: async () => undefined,
      reply: async () => undefined,
      editReply: async () => undefined,
    };

    expect(asTrackReplyInteraction(interaction as never)).toBe(interaction);
  });
});