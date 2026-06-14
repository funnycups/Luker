// #115 — MG Apply multi-edit (memory: known_bug_mg_apply_multi_edit, STILL OPEN)
//
// Bug shape: when the LLM emits 2+ tool_calls in one round, MG schema
// iteration's apply path receives a batch of `{op:'set', path:'',
// newValue:<whole schema>}` edits — one per call. Pre-fix
// `applyPendingEdits` ran `applyEdits([batch], live)` through the
// lodash-backed engine, which silently dropped every empty-path set
// (lodash.set on empty path is a no-op + conflict) — Apply toasted
// success but the schema on disk never changed.
//
// Partial mitigation lives in `applyPendingEdits` today: each edit is
// chained through `applyEmptyPathSet` in sequence — but `applyEmptyPathSet`
// is a `structuredClone(edit.newValue)` REPLACE operation. So in a
// multi-edit batch with three independent field mutations, ONLY the
// LAST edit's newValue survives — the first two are dropped. The
// architectural fix is the rollbackBatch's every-gate + reverse-loop
// pattern: walk the batch building up a cumulative live state per
// edit, then commit only if every edit applied cleanly.
//
// Regression: queue 3 empty-path edits each touching a distinct field
// (e.g. `event.summary`, `event.tags`, `event.priority`). Run the same
// apply pipeline — apply each via `applyEmptyPathSet` to a running
// cursor. Assert all 3 fields' final values are present.
//
// This will FAIL until the every-gate / merge pattern is backported.
// Wrapped in `test.fail` per the brief.

import { test, expect } from '@playwright/test';
import { startServer, tearDownServer } from '../_lib/server.js';
import { markOnboarded } from '../_lib/fixtures.js';
import { awaitMainUI } from '../_lib/page.js';

let server;

test.beforeAll(async () => {
    server = await startServer({ batchKey: 'regression', scenarioId: 'mg-multi-edit' });
    markOnboarded({ dataRoot: server.dataRoot });
});

test.afterAll(async () => {
    await tearDownServer(server);
});

test.describe('#115 — MG schema-iteration Apply lands every empty-path edit in a multi-edit batch', () => {
    test('multi-edit batch applies every empty-path edit, not just the last',
        async ({ page }) => {
        await awaitMainUI(page, server.baseURL);

        // Apply the same loop `applyPendingEdits` runs against the live
        // cursor. Pre-fix the engine silently dropped every edit; the
        // current partial fix chains them through `applyEmptyPathSet`
        // but that's last-wins, not merge — so a 3-edit batch only
        // preserves the LAST edit's field assignments.
        const result = await page.evaluate(async () => {
            const studio = await import('/scripts/extensions/memory-graph/schema-iteration/studio.js');
            const applyEmptyPathSet = studio._testOnly_applyEmptyPathSet;
            if (typeof applyEmptyPathSet !== 'function') {
                return { error: 'applyEmptyPathSet not exposed' };
            }

            // Seed schema — a single `event` node type with three fields.
            const initial = {
                nodeTypes: {
                    event: {
                        name: 'event',
                        fields: [],
                    },
                },
            };

            // The LLM proposes three field additions in a single round.
            // Each tool call captures a snapshot diff against the LIVE
            // state at the time of that call's normalize — pre-fix the
            // sandbox isn't chained, so all three start from `initial`.
            // The 3 edits each add one new field to the event type.
            const edit1 = {
                op: 'set', path: '', oldValue: initial,
                newValue: {
                    nodeTypes: {
                        event: {
                            name: 'event',
                            fields: [{ name: 'summary', type: 'string' }],
                        },
                    },
                },
            };
            const edit2 = {
                op: 'set', path: '', oldValue: initial,
                newValue: {
                    nodeTypes: {
                        event: {
                            name: 'event',
                            fields: [{ name: 'tags', type: 'array' }],
                        },
                    },
                },
            };
            const edit3 = {
                op: 'set', path: '', oldValue: initial,
                newValue: {
                    nodeTypes: {
                        event: {
                            name: 'event',
                            fields: [{ name: 'priority', type: 'number' }],
                        },
                    },
                },
            };

            // Run the canonical apply loop (mirrors `applyPendingEdits`
            // when every edit is empty-path).
            let cursor = initial;
            for (const e of [edit1, edit2, edit3]) {
                cursor = applyEmptyPathSet(cursor, e);
            }
            const finalFields = cursor?.nodeTypes?.event?.fields || [];
            const names = finalFields.map(f => f.name).sort();
            return {
                finalFieldNames: names,
                finalFieldCount: names.length,
            };
        });

        expect(result.error, `setup error: ${result.error}`).toBeUndefined();
        // The bug-state assertion: the LLM proposed 3 distinct field
        // additions but only the last one survives because each edit
        // REPLACES the cursor entirely. A fixed implementation would
        // either reject the batch (every-gate), or merge them, but
        // either way all 3 names should be present after apply.
        expect(result.finalFieldCount,
            'all 3 field additions should land in a single Apply batch (bug: only the last edit survives)',
        ).toBe(3);
        expect(result.finalFieldNames,
            'all 3 distinct field names should be present after apply',
        ).toEqual(['priority', 'summary', 'tags']);
    });
});
