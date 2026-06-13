// tests/e2e/memorygraph/56-schema-add-field-persists.e2e.js
//
// #56 — MG schema editor: add field → save → restart → director sees the
// new schema.
//
// Schema persistence is the load-bearing contract: any field the user
// adds to a node type via the schema editor must survive a server
// restart AND be visible to:
//   1. The read API (`session.getSchema()`), which is what
//      orchestrator / director sub-agents consume when planning
//      extractions and reading existing nodes.
//   2. The write API (`session.createNode({ fields: { <new field> } })`),
//      so a record using the new field round-trips cleanly through the
//      Layer-1 surface.
//
// The schema editor click flow (`#luker_rpg_memory_open_schema_editor`)
// is a multi-step popup; we drive the persistence boundary directly
// (the editor's confirm path calls `persistSchemaToGlobal`, which sets
// `settings.nodeTypeSchema` + `saveSettings()`). That keeps the test
// focused on the contract the editor is meant to uphold without
// coupling to ephemeral popup HTML structure.
//
// "Director uses new schema" is asserted via the same Layer-1 API the
// director / orchestrator sub-agents use to write extracted records —
// the mock LLM can't faithfully reproduce a director extraction without
// the full prompt scaffold, so we exercise the equivalent surface
// (createNode with the new field) to prove the field actually lands.

import { test, expect } from '@playwright/test';
import { resolve as resolvePath } from 'node:path';
import { existsSync, readFileSync } from 'node:fs';
import { startServer, tearDownServer } from '../_lib/server.js';
import { startMockLLM } from '../_lib/mockLLM.js';
import { bootstrapCustomBackend, appendConnectionProfile, markOnboarded } from '../_lib/fixtures.js';
import { awaitMainUI, selectCharacterByName, sendMessageAndAwaitReply, reloadAndAwait } from '../_lib/page.js';

let server, mock;

test.beforeAll(async () => {
    mock = await startMockLLM({
        scriptedReplies: [
            '*Seraphina looks up from the chart.* "The lantern wants more oil before the next watch."',
            '*She marks a faint line on the chart.* "Note that — the wind shifted east an hour ago."',
            '*A measured nod.* "Hold here. The watch will turn at the third bell."',
        ],
    });
    server = await startServer({ batchKey: 'memorygraph', scenarioId: 'schema-add-field' });
    markOnboarded({ dataRoot: server.dataRoot });
    bootstrapCustomBackend({ dataRoot: server.dataRoot, baseURL: mock.baseURL });
    appendConnectionProfile({ dataRoot: server.dataRoot, baseURL: mock.baseURL });
});

test.afterAll(async () => {
    await tearDownServer(server);
    await mock?.stop();
});

test.describe('#56 — MG schema add-field persists and is visible to write API + read API', () => {
    test('add custom column to event type → save → restart → schema still has it, createNode round-trips the field', async ({ page }) => {
        await awaitMainUI(page, server.baseURL);
        await selectCharacterByName(page, 'Seraphina');

        // Drive 3 turns so MG has an actual chat to anchor against.
        for (const t of [
            'The first watch is calm. The lantern is steady.',
            'A skiff drifted south of the gull rocks an hour ago.',
            'Hold the watch. I will fetch the chart.',
        ]) {
            await sendMessageAndAwaitReply(page, t);
        }

        // Add a custom field `omen_score` to the `event` node type. Goes
        // through the same `settings.nodeTypeSchema = normalize(...)` +
        // `saveSettings()` path the editor uses on its Apply button.
        const CUSTOM_FIELD = 'omen_score';
        const editResult = await page.evaluate(async ({ fieldId }) => {
            const ctx = window.SillyTavern.getContext();
            const settings = ctx.extensionSettings?.memory_graph;
            if (!settings) return { error: 'memory_graph extension settings missing' };
            settings.enabled = true;

            const mod = await import('/scripts/extensions/memory-graph/main.js');
            const normalize = mod.normalizeNodeTypeSchema;
            if (typeof normalize !== 'function') return { error: 'normalizeNodeTypeSchema not exported' };

            const current = Array.isArray(settings.nodeTypeSchema)
                ? structuredClone(settings.nodeTypeSchema)
                : [];
            const eventIdx = current.findIndex(spec => String(spec?.id || '').toLowerCase() === 'event');
            if (eventIdx < 0) return { error: 'no `event` node type in schema; cannot add field' };

            // Mirror the editor's add-column flow: append to tableColumns,
            // re-emit a normalized schema, persist via saveSettings.
            current[eventIdx] = {
                ...current[eventIdx],
                tableColumns: [...(current[eventIdx].tableColumns || []), fieldId],
            };
            settings.nodeTypeSchema = normalize(current);
            // saveSettings is the persistence boundary the editor's Apply
            // button awaits.
            const saveSettings = ctx.saveSettings;
            await saveSettings();

            return {
                ok: true,
                afterColumns: settings.nodeTypeSchema.find(s => s.id === 'event')?.tableColumns?.slice() || [],
            };
        }, { fieldId: CUSTOM_FIELD });
        expect(editResult.error, `schema edit setup error: ${editResult.error}`).toBeUndefined();
        expect(editResult.afterColumns, 'event tableColumns should include the new field').toContain(CUSTOM_FIELD);

        // Settings.json disk check — the field must be written to disk by
        // saveSettings, not just held in memory.
        const settingsPath = resolvePath(server.dataRoot, 'default-user', 'settings.json');
        expect(existsSync(settingsPath), `expected settings.json at ${settingsPath}`).toBe(true);
        const beforeRestart = JSON.parse(readFileSync(settingsPath, 'utf8'));
        const mgSettings = beforeRestart?.extension_settings?.memory_graph
            || beforeRestart?.extensionSettings?.memory_graph;
        const eventSpec = (mgSettings?.nodeTypeSchema || []).find(s => s?.id === 'event');
        expect(
            eventSpec?.tableColumns,
            'event tableColumns on disk should contain the new field',
        ).toContain(CUSTOM_FIELD);

        // Round-trip the new field through the write API at this point
        // (pre-restart) — confirms the runtime sees the field too. Capture
        // the created node's id so we can find it post-restart even after
        // MG normalizes the event title to "Summary N".
        const writeResult = await page.evaluate(async ({ fieldId }) => {
            const ctx = window.SillyTavern.getContext();
            const mg = ctx.getExtensionApi?.('memory-graph');
            const session = await mg?.openSession?.(ctx);
            if (!session) return { error: 'no session pre-restart' };
            const node = await session.createNode({
                type: 'event',
                title: 'omen-score test event',
                fields: {
                    summary: '时间：第三幕；风向偏东，user 标记一次礁石异响以备复盘。',
                    [fieldId]: '7.3',
                },
            });
            const cands = await session.listVisibleCandidates({});
            const created = cands.find(n => n.id === node.id);
            return {
                ok: true,
                createdId: node?.id || '',
                createdFields: created?.fields ? { ...created.fields } : null,
            };
        }, { fieldId: CUSTOM_FIELD });
        expect(writeResult.error, `write-api round-trip error: ${writeResult.error}`).toBeUndefined();
        expect(writeResult.createdId, 'expected node id from createNode').toBeTruthy();
        expect(
            writeResult.createdFields?.[CUSTOM_FIELD],
            `expected the new field "${CUSTOM_FIELD}" to round-trip through createNode → listVisibleCandidates`,
        ).toBe('7.3');

        const PRE_RESTART_NODE_ID = writeResult.createdId;

        // Persistence-across-restart: kill the server, restart against the
        // same dataRoot, reload the page, re-select the character, and
        // assert the schema (and the field) survive.
        await server.restart();
        await reloadAndAwait(page, server.baseURL);
        await selectCharacterByName(page, 'Seraphina');

        const afterRestart = await page.evaluate(async ({ fieldId, preRestartNodeId }) => {
            const ctx = window.SillyTavern.getContext();
            const settings = ctx.extensionSettings?.memory_graph;
            if (settings) settings.enabled = true;
            // Re-query the schema via Layer-1 read-api — that's the surface
            // the director / orchestrator consumes.
            const mg = ctx.getExtensionApi?.('memory-graph');
            const session = await mg?.openSession?.(ctx);
            if (!session) return { error: 'no session post-restart' };
            const schema = session.getSchema();
            const eventSpec = (schema?.types || []).find(s => s.type === 'event');
            // Write a new record post-restart using the persisted field to
            // confirm the runtime schema accepts the field.
            const node = await session.createNode({
                type: 'event',
                title: 'post-restart omen entry',
                fields: {
                    summary: '时间：服务器重启之后；user 再次确认信号灯仍在燃烧；记录一次自检。',
                    [fieldId]: '8.1',
                },
            });
            const cands = await session.listVisibleCandidates({});
            const created = cands.find(n => n.id === node.id);
            // The pre-restart sentinel was anchored at its own id — find by id,
            // NOT title (MG auto-normalizes event titles to "Summary N" on
            // create, so the title we passed in writeResult is not the
            // post-normalization title).
            const preRestartCandidate = cands.find(n => n.id === preRestartNodeId);
            return {
                ok: true,
                schemaHasField: Array.isArray(eventSpec?.tableColumns) && eventSpec.tableColumns.includes(fieldId),
                postRestartFieldValue: created?.fields?.[fieldId] || null,
                // Pre-restart sentinel should still be in the store too —
                // looked up by stable id, not auto-normalized title.
                preRestartFieldValue: preRestartCandidate?.fields?.[fieldId] || null,
                // Diagnostic: dump titles + field-keys to clarify which path
                // is dropping data when the assertion fails.
                allCandidateTitles: cands.map(n => n.title),
                allEventNodeFieldKeys: cands
                    .filter(n => n.type === 'event')
                    .map(n => ({ id: n.id, title: n.title, fieldKeys: Object.keys(n.fields || {}) })),
                allTableColumns: Array.isArray(eventSpec?.tableColumns) ? eventSpec.tableColumns.slice() : [],
            };
        }, { fieldId: CUSTOM_FIELD, preRestartNodeId: PRE_RESTART_NODE_ID });
        expect(afterRestart.error, `post-restart inspection error: ${afterRestart.error}`).toBeUndefined();
        expect(
            afterRestart.schemaHasField,
            `schema seen by session.getSchema() must include "${CUSTOM_FIELD}" after restart; ` +
            `tableColumns=${JSON.stringify(afterRestart.allTableColumns)}`,
        ).toBe(true);
        expect(
            afterRestart.postRestartFieldValue,
            `post-restart createNode using the persisted field must round-trip; ` +
            `candidate titles=${JSON.stringify(afterRestart.allCandidateTitles)} ` +
            `event field keys=${JSON.stringify(afterRestart.allEventNodeFieldKeys)}`,
        ).toBe('8.1');
        expect(
            afterRestart.preRestartFieldValue,
            `pre-restart sentinel node must also retain the custom field across restart; ` +
            `event field keys=${JSON.stringify(afterRestart.allEventNodeFieldKeys)}`,
        ).toBe('7.3');
    });
});
