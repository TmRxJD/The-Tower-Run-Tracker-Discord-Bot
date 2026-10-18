import { expect, it } from 'vitest';
import { createSuccessButtons } from './tracker-ui';
import { TRACKER_IDS } from '../track-custom-ids';
function ids() { return createSuccessButtons().flatMap(row => row.components.map(button => button.toJSON())).map(button => 'custom_id' in button ? button.custom_id : ''); }
it('keeps default lifetime success controls free of run-history verification', () => { expect(ids()).not.toContain(TRACKER_IDS.flow.shareLastVerified); });
it('keeps normal report share controls within Discord row limits', () => {
  const rows = createSuccessButtons();
  expect(ids()).not.toContain(TRACKER_IDS.flow.shareLastVerified);
  expect(rows.length).toBeLessThanOrEqual(5); expect(rows.every(row => row.components.length <= 5)).toBe(true);
});
