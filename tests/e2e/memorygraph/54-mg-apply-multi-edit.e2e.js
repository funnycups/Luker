// tests/e2e/memorygraph/54-mg-apply-multi-edit.e2e.js
//
// #54 — MG schema-iteration in Workbench: multi-edit batch (across multiple
// LLM rounds within a turn) lands every field after Apply.

import { test, expect } from '../../harness/playwright.js';
import { startServer } from '../../harness/server.js';
import { startMockLLM } from '../_lib/mockLLM.js';
import { bootstrapCustomBackend, appendConnectionProfile, markOnboarded } from '../_lib/fixtures.js';
import {
    awaitMainUI,
    selectCharacterByName,
} from '../_lib/page.js';
import { openIterStudio, sendIterPrompt, applyIterBatch } from '../_lib/ui-iter-studio.js';
import { openMgSchemaEditor, setMgSettings } from '../_lib/ui-mg-varops.js';
import { closeWorkbench, workbenchWindow } from '../_lib/ui-workbench.js';
import { normalizeIterStudioSettings } from '../preset/_helpers.js';

let server, mock;

const NEW_FIELDS = ['tags', 'priority', 'mood', 'location', 'tone'];

function buildEventSpec(activeFields) {
    return {
        id: 'event',
        label: 'Event',
        tableName: 'event_table',
        tableColumns: ['summary', ...activeFields],
        embeddingColumns: ['summary'],
        requiredColumns: ['summary'],
        primaryKeyColumns: [],
        forceUpdate: true,
        editable: false,
        level: 'semantic',
        extractHint: '',
        extractionInstructions: '',
        keywords: [],
        alwaysInject: true,
        latestOnly: false,
        compression: { mode: 'hierarchical', threshold: 9, fanIn: 3, maxDepth: 10, keepRecentLeaves: 6, summarizeInstruction: '' },
    };
}

test.beforeAll(async ({ workerResources }, testInfo) => {
    const scope = await workerResources.scenario(testInfo.file);
    mock = await startMockLLM({});
    server = await startServer({ scope, batchKey: 'memorygraph', scenarioId: 'mg-multi-edit' });
    markOnboarded({ dataRoot: server.dataRoot });
    bootstrapCustomBackend({ dataRoot: server.dataRoot, baseURL: mock.baseURL });
    appendConnectionProfile({ dataRoot: server.dataRoot, baseURL: mock.baseURL });
    normalizeIterStudioSettings(server.dataRoot);
});

test.afterAll(async () => {

    await mock?.stop();
});

test.describe('#54 — MG schema-iter Studio: 5 set-node-type rounds land every field after Apply', () => {
    test.setTimeout(360_000);

    test('multi-round tool calls add 5 distinct fields; Apply persists them; schema editor shows all', async ({ page }) => {
        await awaitMainUI(page, server.baseURL);
        await selectCharacterByName(page, 'Seraphina');
        await setMgSettings(page, { enabled: true }, { closeAfter: true });

        await openIterStudio(page, 'mg', { scope: 'character' });
        for (let i = 0; i < NEW_FIELDS.length; i++) {
            mock.scriptToolCall({
                name: 'mg_schema_set_node_type',
                arguments: { node_type: buildEventSpec(NEW_FIELDS.slice(0, i + 1)) },
            });
        }
        mock.scriptReply('All five fields have been added to the event node type. Click Apply to commit.');
        await sendIterPrompt(page, 'mg', `Add ${NEW_FIELDS.join(', ')} fields to the event node type.`);
        await applyIterBatch(page, 'mg');

        await expect.poll(async () => {
            return await page.evaluate(() => {
                const ctx = window.Luker.getContext();
                const character = ctx?.characters?.[ctx?.characterId];
                const override = character?.data?.extensions?.memory_graph?.schemaOverride;
                const overrideEvent = Array.isArray(override)
                    ? override.find(x => x?.id === 'event')
                    : null;
                return overrideEvent?.tableColumns;
            });
        }, { timeout: 10_000 }).toEqual(expect.arrayContaining(NEW_FIELDS));

        const schema = await openMgSchemaEditor(page);
        await schema.locator('.ml-schema-list .ml-schema-type', {
            has: page.locator('.ml-schema-type-name', { hasText: /^(Event|事件)$/ }),
        }).first().click();
        const renderedLabels = await schema.locator('.ml-schema-editor .ml-schema-itemname')
            .evaluateAll((inputs) => inputs.map((el) => String(el.value || '').toLowerCase()));
        for (const f of NEW_FIELDS) {
            expect(renderedLabels, `schema editor should list ${f}; saw: ${JSON.stringify(renderedLabels)}`).toContain(f);
        }
        await closeWorkbench(page);
    });

    test('separate pending turns chain schema edits before approval', async ({ page }) => {
        await awaitMainUI(page, server.baseURL);
        await selectCharacterByName(page, 'Seraphina');
        await setMgSettings(page, { enabled: true }, { closeAfter: true });
        await openIterStudio(page, 'mg', { scope: 'character' });

        const fields = ['chain_tags', 'chain_priority', 'chain_mood', 'chain_location', 'chain_tone'];
        for (let index = 0; index < fields.length; index++) {
            mock.scriptToolCall({
                name: 'mg_schema_set_node_type',
                arguments: { node_type: buildEventSpec(fields.slice(0, index + 1)) },
            });
            mock.scriptReply(`The ${fields[index]} edit is ready for review.`);
            await sendIterPrompt(page, 'mg', `Add the ${fields[index]} field.`);
            await expect(workbenchWindow(page).locator('.wb-chg.is-pending')).toHaveCount(index + 1);
        }
        await applyIterBatch(page, 'mg');
        await expect(workbenchWindow(page).locator('.wb-chg.is-applied')).toHaveCount(fields.length);
        await expect.poll(() => page.evaluate(() => {
            const ctx = window.Luker.getContext();
            return ctx.characters[ctx.characterId]?.data?.extensions?.memory_graph?.schemaOverride
                ?.find(spec => spec.id === 'event')?.tableColumns;
        })).toEqual(['summary', ...fields]);

        const schema = await openMgSchemaEditor(page);
        await schema.locator('.ml-schema-list .ml-schema-type', {
            has: page.locator('.ml-schema-type-name', { hasText: /^(Event|事件)$/ }),
        }).first().click();
        const renderedLabels = await schema.locator('.ml-schema-editor .ml-schema-itemname')
            .evaluateAll(inputs => inputs.map(el => el.value));
        expect(renderedLabels).toEqual(['Summary', 'Chain tags', 'Chain priority', 'Chain mood', 'Chain location', 'Chain tone']);
        await closeWorkbench(page);
    });
});
