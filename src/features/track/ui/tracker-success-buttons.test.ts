import { expect, it } from 'vitest';
import { createSuccessButtons } from './tracker-ui';
import { TRACKER_IDS } from '../track-custom-ids';
function ids(verify: boolean) { return createSuccessButtons({ includeCloudVerification: verify }).flatMap(row => row.components.map(button => button.toJSON())).map(button => 'custom_id' in button ? button.custom_id : ''); }
it('keeps default lifetime success controls free of run-history verification', () => { expect(ids(false)).not.toContain(TRACKER_IDS.flow.shareLastVerified); });
it('offers explicit verification for reports within Discord row limits', () => {
  const rows = createSuccessButtons({ includeCloudVerification: true });
  expect(ids(true)).toContain(TRACKER_IDS.flow.shareLastVerified);
  expect(rows.length).toBeLessThanOrEqual(5); expect(rows.every(row => row.components.length <= 5)).toBe(true);
});
