# Effect-active coverage in structured exports

The coverage calculation is unchanged: `killsWithOrbs / totalEnemies` and `killsWithBlackHole / totalEnemies`. Hits and direct final blows are different counters and cannot supply these values.

## Confirmed shared importer gap

The pinned SDK 0.11.3 ships both `enemiesDestroyedInOrbsThisRound` and `enemiesDestroyedInBlackholeThisRound` in its player-data schema (`dist/data/player-stats/fields.data.js`). The same schema separately identifies the **By**-Orbs final-blow field, while the existing save mapper maps **In**-Orbs and **In**-Blackhole fields to effect-active kills. The current-round **In** variants were missing from that mapper, although neighboring current-round Spotlight and Death Wave fields were supported.

The SDK patch adds only those two documented current-round names to the existing shared alias lists. Canonical values and previously supported aliases retain priority; explicit zero remains zero. There is no copied calculation or display-only substitution.

The `save-effect-coverage.test.ts` regression first failed against the deployed dependency, then verifies the same entry’s counters through import planning, local split/stitch, share rendering, tables, charts and comparisons. Its effect counts 410/740 produce 41%/74% despite different hit counts 980/990 and final-blow counts 80/90. The absence test prohibits borrowing current player-root counters for an older history entry.

## Evidence limit

This confirms a supported structured-export field-loss bug. It does **not** establish that a particular affected player’s original export used those fields. The inspected same-run cloud base/extended documents already lacked both effect-active counts, and the supplied bot-generated Markdown cannot reconstruct the source values. An original same-run report or export is required to attribute and recover that player’s missing measurements. No stored production rows are changed by this patch. Existing duplicate-import behavior is unchanged.

SDK source references at `9a95672578fa064d71ddd54fad2ce5027a310b3a` (also present in the pinned 0.11.3 artifact):
- `src/data/player-stats/fields.data.ts`
- `src/save/battle/report-fields.ts`
- `src/save/battle/history-normalize.ts`
