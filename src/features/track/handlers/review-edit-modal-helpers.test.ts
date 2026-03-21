import { describe, expect, it } from 'vitest';
import { TRACKER_IDS } from '../track-custom-ids';
import {
  applySubmittedReviewEditValues,
  buildCurrentReviewReplyPayload,
  buildTypeSelectionReviewReplyPayload,
  buildReviewEditFieldModal,
  buildReviewNoteModal,
  getSelectedReviewFields,
  getSelectedReviewValue,
  replyWithReviewSessionExpired,
  renderDataReviewOrSubmit,
  renderUpdatedReviewAfterNote,
  resolveUpdatedPendingOrReplyExpired,
  resolveUpdatedPendingOrUpdateReviewMessage,
  resolveUpdatedPendingRecord,
} from './review-edit-modal-helpers';

function getRowFirstComponent(component: unknown): unknown {
  if (!component || typeof component !== 'object' || !('components' in component)) {
    return undefined;
  }

  const row = component as { components?: unknown[] };
  return row.components?.[0];
}

describe('review-edit-modal-helpers', () => {
  it('reads selected values from component arrays and fallback value fields', () => {
    expect(getSelectedReviewValue({ values: ['Tournament'] } as never)).toBe('Tournament');
    expect(getSelectedReviewValue({ value: 'Overnight' } as never)).toBe('Overnight');
    expect(getSelectedReviewValue({ value: 42 } as never)).toBeNull();
  });

  it('deduplicates selected edit fields and caps them at five entries', () => {
    expect(getSelectedReviewFields({
      values: ['tier', 'wave', 'tier', 'notes', 'type', 'date', 'time'],
    } as never)).toEqual(['tier', 'wave', 'notes', 'type', 'date']);
  });

  it('builds note and edit modals with tracker review ids', () => {
    const noteModal = buildReviewNoteModal({
      token: 'abc123',
      title: 'Add note',
      label: 'Note',
      placeholder: 'Optional note',
      currentNote: 'Existing note',
    });
    const noteJson = noteModal.toJSON();
    expect(noteJson.custom_id).toBe('tracker_note_modal:abc123');
    expect(getRowFirstComponent(noteJson.components[0])).toMatchObject({
      custom_id: TRACKER_IDS.review.noteText,
      label: 'Note',
      placeholder: 'Optional note',
      value: 'Existing note',
      required: false,
    });

    const { modal, modalFieldList } = buildReviewEditFieldModal({
      token: 'abc123',
      title: 'Edit fields',
      selectedFields: ['tier', 'notes'],
      labels: {
        tier: 'Tier',
        notes: 'Notes',
      },
      runData: {
        tier: 12,
        tierDisplay: '12+',
        notes: 'Keep this note',
      },
    });
    const editJson = modal.toJSON();
    expect(modalFieldList).toBe('tier,notes');
    expect(editJson.custom_id).toBe('tracker_edit_modal:abc123:tier,notes');
    expect(getRowFirstComponent(editJson.components[0])).toMatchObject({
      custom_id: `${TRACKER_IDS.review.editValue}_0`,
      label: 'Tier',
      value: '12+',
      required: true,
    });
    expect(getRowFirstComponent(editJson.components[1])).toMatchObject({
      custom_id: `${TRACKER_IDS.review.editValue}_1`,
      label: 'Notes',
      value: 'Keep this note',
      required: false,
    });
  });

  it('applies submitted edit values across multiple selected fields', () => {
    expect(applySubmittedReviewEditValues({ notes: 'old' }, ['tier', 'notes'], (_field, index) => {
      return index === 0 ? '14+' : 'new note';
    })).toMatchObject({
      tier: 14,
      tierDisplay: '14+',
      tierHasPlus: true,
      notes: 'new note',
    });
  });

  it('resolves updated pending records and drops invalid payloads', () => {
    expect(resolveUpdatedPendingRecord({
      userId: 'user-1',
      username: 'runner',
      runData: { tier: 10 },
    })).toMatchObject({
      userId: 'user-1',
      username: 'runner',
      runData: { tier: 10 },
    });
    expect(resolveUpdatedPendingRecord(null)).toBeNull();
  });

  it('replies with the standard expired review payload shape', async () => {
    const calls: unknown[] = [];
    await replyWithReviewSessionExpired({
      editReply(payload) {
        calls.push(payload);
        return Promise.resolve({} as never);
      },
    }, 'Session expired');

    expect(calls).toEqual([{
      content: 'Session expired',
      embeds: [],
      components: [],
    }]);
  });

  it('returns updated pending records or replies with the expired payload', async () => {
    const calls: unknown[] = [];
    await expect(resolveUpdatedPendingOrReplyExpired({
      editReply(payload) {
        calls.push(payload);
        return Promise.resolve({} as never);
      },
    }, {
      userId: 'user-2',
      username: 'runner-2',
      runData: { wave: 123 },
    }, 'Session expired')).resolves.toMatchObject({
      userId: 'user-2',
      username: 'runner-2',
      runData: { wave: 123 },
    });
    expect(calls).toEqual([]);

    await expect(resolveUpdatedPendingOrReplyExpired({
      editReply(payload) {
        calls.push(payload);
        return Promise.resolve({} as never);
      },
    }, null, 'Session expired')).resolves.toBeNull();
    expect(calls).toEqual([{
      content: 'Session expired',
      embeds: [],
      components: [],
    }]);
  });

  it('returns updated pending records or updates the review message', async () => {
    const calls: unknown[] = [];
    await expect(resolveUpdatedPendingOrUpdateReviewMessage({
      deferred: true,
      replied: false,
      editReply(payload: unknown) {
        calls.push(payload);
        return Promise.resolve({} as never);
      },
    } as never, {
      userId: 'user-2b',
      username: 'runner-2b',
      runData: { wave: 456 },
    }, 'Session expired')).resolves.toMatchObject({
      userId: 'user-2b',
      username: 'runner-2b',
      runData: { wave: 456 },
    });
    expect(calls).toEqual([]);

    await expect(resolveUpdatedPendingOrUpdateReviewMessage({
      deferred: true,
      replied: false,
      editReply(payload: unknown) {
        calls.push(payload);
        return Promise.resolve({} as never);
      },
    } as never, null, 'Session expired')).resolves.toBeNull();
    expect(calls).toEqual([{
      content: 'Session expired',
      embeds: [],
      components: [],
    }]);
  });

  it('builds the current review reply payload from pending state', () => {
    expect(buildCurrentReviewReplyPayload('abc123', {
      userId: 'user-3',
      username: 'runner-3',
      runData: {
        type: 'overnight',
      },
      defaultRunType: 'Farming',
    }, 'Extracted')).toMatchObject({
      embeds: expect.any(Array),
      components: expect.any(Array),
    });
  });

  it('builds a type-selection review payload with the chosen type', () => {
    expect(buildTypeSelectionReviewReplyPayload('abc123', {
      userId: 'user-5',
      username: 'runner-5',
      runData: {
        type: 'Farming',
      },
      defaultRunType: 'Farming',
    }, 'Tournament')).toMatchObject({
      embeds: expect.any(Array),
      components: expect.any(Array),
    });
  });

  it('renders either the edit picker or review payload after note updates', async () => {
    const editReplyCalls: unknown[] = [];
    const pickerCalls: unknown[] = [];
    const interaction = {
      editReply(payload: unknown) {
        editReplyCalls.push(payload);
        return Promise.resolve({} as never);
      },
    } as never;
    const pending = {
      userId: 'user-4',
      username: 'runner-4',
      runData: { type: 'Farming' },
      defaultRunType: 'Farming',
    };

    await renderUpdatedReviewAfterNote(interaction, 'note-token', pending, 'edit', async (...args) => {
      pickerCalls.push(args);
    });
    expect(pickerCalls).toHaveLength(1);
    expect(editReplyCalls).toEqual([]);

    await renderUpdatedReviewAfterNote(interaction, 'note-token', pending, 'review', async (...args) => {
      pickerCalls.push(args);
    });
    expect(editReplyCalls).toHaveLength(1);
  });

  it('renders the review payload when confirmation is required', async () => {
    const editReplyCalls: unknown[] = [];
    const submitCalls: unknown[] = [];
    const interaction = {
      editReply(payload: unknown) {
        editReplyCalls.push(payload);
        return Promise.resolve({} as never);
      },
    } as never;
    const pending = {
      userId: 'user-6',
      username: 'runner-6',
      runData: { type: 'Farming' },
      defaultRunType: 'Farming',
    };

    await renderDataReviewOrSubmit(
      interaction,
      'review-token',
      pending,
      'Extracted',
      async () => ({ confirmBeforeSubmit: true }),
      async (...args) => {
        submitCalls.push(args);
      },
    );

    expect(submitCalls).toEqual([]);
    expect(editReplyCalls).toHaveLength(1);
  });

  it('submits immediately when confirmation is disabled', async () => {
    const editReplyCalls: unknown[] = [];
    const submitCalls: unknown[] = [];
    const interaction = {
      editReply(payload: unknown) {
        editReplyCalls.push(payload);
        return Promise.resolve({} as never);
      },
    } as never;
    const pending = {
      userId: 'user-7',
      username: 'runner-7',
      runData: { type: 'Farming' },
      defaultRunType: 'Farming',
    };

    await renderDataReviewOrSubmit(
      interaction,
      'review-token',
      pending,
      'Extracted',
      async () => ({ confirmBeforeSubmit: false }),
      async (...args) => {
        submitCalls.push(args);
      },
    );

    expect(submitCalls).toHaveLength(1);
    expect(editReplyCalls).toEqual([]);
  });
});