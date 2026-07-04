import { describe, expect, it, vi } from 'vitest';
import { renderImportPreviewTableImage } from './view-runs-table-image';

const renderCalls: Array<{ title: string; rows: string[][] }> = [];
vi.mock('./view-runs-chart', () => ({
  renderViewRunsTablePng: vi.fn(async (input: { title: string; rows: string[][] }) => {
    renderCalls.push({ title: input.title, rows: input.rows });
    return Buffer.from('png');
  }),
}));

describe('renderImportPreviewTableImage', () => {
  it('does not apply type or tier filters to imported runs', async () => {
    renderCalls.length = 0;

    const runs = [      { type: 'Farming', tier: '12', wave: '1000', runDate: '2026-07-01', runTime: '10:00' },
      { type: 'Tournament', tier: '14', wave: '2000', runDate: '2026-07-02', runTime: '11:00' },
      { type: 'Volcano', tier: '16', wave: '3000', runDate: '2026-07-03', runTime: '12:00' },
    ];

    await renderImportPreviewTableImage(runs, {
      selectedColumns: ['Tier', 'Wave', 'Type'],
      orientation: 'landscape',
      count: 2,
    });

    expect(renderCalls[0]?.title).toBe('Runs to Import (3 runs)');
    expect(renderCalls[0]?.rows).toHaveLength(3);
    expect(renderCalls[0]?.rows[0]?.[3]).toBe('Farming');
    expect(renderCalls[0]?.rows[1]?.[3]).toBe('Tournament');
  });
});
