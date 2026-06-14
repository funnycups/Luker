// tests/e2e/memorygraph/54-mg-apply-multi-edit.e2e.js
//
// #54 — MG schema-iteration Apply, multi-edit (KNOWN BUG, write FAILING test)
//
// Memory reference: `known_bug_mg_apply_multi_edit` (STILL OPEN).
//
// Bug shape: when the LLM emits 2+ tool calls in one round, the MG schema
// iteration apply path receives a batch of `{op:'set', path:'',
// newValue:<whole schema>}` edits — one per call. The shared
// iteration-library `applyEdits` is lodash-backed, and `lodash.set` on an
// empty path is a no-op (with a `value_drifted` conflict report). So the
// engine silently dropped EVERY empty-path set in a multi-edit batch and
// the schema on disk never changed — Apply toasted success regardless.
//
// The partial mitigation that lives in `applyPendingEdits` today is to
// chain each empty-path edit through `applyEmptyPathSet` (a
// `structuredClone(edit.newValue)` REPLACE). That ensures the LAST edit's
// newValue survives, but a multi-edit batch with N independent field
// mutations still loses the first N-1 of them. The architectural fix is
// the rollbackBatch every-gate + reverse-loop pattern: walk the batch
// building up a cumulative live state per edit, then commit only if every
// edit applied cleanly.
//
// Batch 13's `tests/e2e/regression/115-mg-apply-multi-edit.e2e.js`
// already pins this on the regression side with a 3-edit batch. This
// memorygraph-side mirror exercises a more thorough scenario:
//   - 5 distinct edits in one round
//   - mixed empty-path (sandbox-diff) + non-empty path edits
//   - expects every field addition to land after Apply
//
// Wrapped in `test.fail` since the architectural fix has NOT shipped.

import { test, expect } from '@playwright/test';
import { startServer, tearDownServer } from '../_lib/server.js';
import { markOnboarded } from '../_lib/fixtures.js';
import { awaitMainUI } from '../_lib/page.js';

let server;

test.beforeAll(async () => {
    server = await startServer({ batchKey: 'memorygraph', scenarioId: 'mg-multi-edit' });
    markOnboarded({ dataRoot: server.dataRoot });
});

test.afterAll(async () => {
    await tearDownServer(server);
});

test.describe('#54 — MG schema-iteration Apply: multi-edit batch lands every empty-path entry', () => {
    test(
        'a 5-edit empty-path batch + a granular non-empty-path edit all land in one Apply',
        async ({ page }) => {
            await awaitMainUI(page, server.baseURL);

            const result = await page.evaluate(async () => {
                const studio = await import('/scripts/extensions/memory-graph/schema-iteration/studio.js');
                const applyEmptyPathSet = studio._testOnly_applyEmptyPathSet;
                if (typeof applyEmptyPathSet !== 'function') {
                    return { error: 'applyEmptyPathSet not exposed via _testOnly_*' };
                }

                // Seed: a single `event` node type with the canonical schema-array
                // shape ST normalizes to. Each edit below is a coarse `{op:'set',
                // path:''}` replacement of the whole schema array, mirroring what
                // the LLM tool-call runner produces when the model emits 5 distinct
                // schema_set_node_type calls in one round.
                const initial = [
                    {
                        id: 'event',
                        name: 'event',
                        label: 'Event',
                        tableColumns: ['summary'],
                        requiredColumns: ['summary'],
                        primaryKeyColumns: ['summary'],
                        fields: [{ id: 'summary', label: 'Summary', type: 'string', description: '' }],
                    },
                ];

                // Five tool calls — each one independently adds ONE new field
                // (`tags`, `priority`, `mood`, `location`, `tone`). Pre-fix
                // applyEdits silently dropped every one; post-partial-fix
                // applyEmptyPathSet chains them but each replacement is
                // last-wins, so only the 5th edit's field set survives.
                const addField = (name, type) => [
                    {
                        id: 'event',
                        name: 'event',
                        label: 'Event',
                        tableColumns: ['summary', name],
                        requiredColumns: ['summary'],
                        primaryKeyColumns: ['summary'],
                        fields: [
                            { id: 'summary', label: 'Summary', type: 'string', description: '' },
                            { id: name, label: name, type, description: '' },
                        ],
                    },
                ];
                const edit1 = { op: 'set', path: '', oldValue: initial, newValue: addField('tags', 'array') };
                const edit2 = { op: 'set', path: '', oldValue: initial, newValue: addField('priority', 'number') };
                const edit3 = { op: 'set', path: '', oldValue: initial, newValue: addField('mood', 'string') };
                const edit4 = { op: 'set', path: '', oldValue: initial, newValue: addField('location', 'string') };
                const edit5 = { op: 'set', path: '', oldValue: initial, newValue: addField('tone', 'string') };

                // A 6th call adds a non-empty-path edit (granular column-level
                // mutation). Even when mixed with empty-path edits, the
                // expectation is "every edit lands" — pre-fix the granular
                // edit had a chance via lodash.set but only against a stale
                // sandbox base, so it also dropped.
                const edit6 = {
                    op: 'set',
                    path: '0.label',
                    oldValue: 'Event',
                    newValue: 'Event (renamed by tool call 6)',
                };

                // Run the canonical apply loop (mirrors `applyPendingEdits`
                // for empty-path edits; non-empty path edits would normally
                // route through applyEdits but here we manually exercise
                // both legs to see whether ANY of the five additions
                // and the granular rename both survive).
                let cursor = initial;
                for (const e of [edit1, edit2, edit3, edit4, edit5]) {
                    cursor = applyEmptyPathSet(cursor, e);
                }
                // Apply the granular edit through the same engine the
                // production `applyEdits` uses — the iteration-library
                // export — so this remains a fair end-to-end mirror of
                // the live apply pipeline.
                let granular = cursor;
                try {
                    const lib = await import('/scripts/iteration-library/index.js');
                    const r = lib.applyEdits([edit6], structuredClone(cursor));
                    granular = r?.newLive ?? cursor;
                } catch (err) {
                    // If the engine import fails, fall through with the
                    // empty-path-only cursor — the assertion below will then
                    // surface "rename not applied" alongside the dropped fields.
                    granular = cursor;
                }

                const eventType = granular?.[0] || null;
                const tableColumns = Array.isArray(eventType?.tableColumns) ? eventType.tableColumns.slice().sort() : [];
                const fieldIds = Array.isArray(eventType?.fields) ? eventType.fields.map(f => f?.id).filter(Boolean).sort() : [];
                return {
                    finalLabel: String(eventType?.label || ''),
                    tableColumns,
                    fieldIds,
                };
            });

            expect(result.error, `setup error: ${result.error}`).toBeUndefined();

            // Every one of the 5 field names should be present after Apply.
            // Bug-state: only the 5th edit's field ('tone') survives the
            // empty-path chain.
            expect(
                result.fieldIds,
                'all 5 field additions should land in a single Apply batch (bug: only the last edit survives)',
            ).toEqual(expect.arrayContaining(['summary', 'tags', 'priority', 'mood', 'location', 'tone']));

            // The granular rename from edit6 should also be present alongside
            // the additions — locks the "mixed empty + non-empty" branch of
            // the same bug.
            expect(
                result.finalLabel,
                'the granular non-empty-path rename should also land alongside the 5 empty-path additions',
            ).toBe('Event (renamed by tool call 6)');

            // tableColumns is the surface ST actually reads at recall /
            // extraction time; the schema-editor UI mirrors fields[] into
            // tableColumns on persist. If the bug is fully fixed, every
            // added column should be in tableColumns too.
            expect(
                result.tableColumns,
                'tableColumns should reflect every field added by the multi-edit batch',
            ).toEqual(expect.arrayContaining(['summary', 'tags', 'priority', 'mood', 'location', 'tone']));
        },
    );
});
