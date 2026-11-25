// tests/e2e/memorygraph/56-schema-add-field-persists.e2e.js
//
// #56 — MG schema editor in Memory Lens: add field → save → restart → field still there.

import { test, expect } from '../../harness/playwright.js';
import { startServer } from '../../harness/server.js';
import { startMockLLM } from '../_lib/mockLLM.js';
import { bootstrapCustomBackend, appendConnectionProfile, markOnboarded } from '../_lib/fixtures.js';
import {
    awaitMainUI,
    selectCharacterByName,
    sendMessageAndAwaitReply,
    reloadAndAwait,
} from '../_lib/page.js';
import { closeWorkbench } from '../_lib/ui-workbench.js';
import { openMgSchemaEditor, setMgSettings } from '../_lib/ui-mg-varops.js';

let server, mock;

test.beforeAll(async ({ workerResources }, testInfo) => {
    const scope = await workerResources.scenario(testInfo.file);
    mock = await startMockLLM({
        scriptedReplies: [
            '*Seraphina looks up from the chart.* "The lantern wants more oil before the next watch."',
            '*She marks a faint line on the chart.* "Note that — the wind shifted east an hour ago."',
            '*A measured nod.* "Hold here. The watch will turn at the third bell."',
        ],
    });
    server = await startServer({ scope, batchKey: 'memorygraph', scenarioId: 'schema-add-field' });
    markOnboarded({ dataRoot: server.dataRoot });
    bootstrapCustomBackend({ dataRoot: server.dataRoot, baseURL: mock.baseURL });
    appendConnectionProfile({ dataRoot: server.dataRoot, baseURL: mock.baseURL });
});

test.afterAll(async () => {

    await mock?.stop();
});

const CUSTOM_FIELD = 'omen_score';

test.describe('#56 — MG schema editor: add field through real UI → persists across restart', () => {
    test.setTimeout(180_000);

    test('open editor, add record item to event, Save, restart, item still in editor', async ({ page }) => {
        await awaitMainUI(page, server.baseURL);
        await selectCharacterByName(page, 'Seraphina');
        await setMgSettings(page, { enabled: true, autoExtractionEnabled: false, recallEnabled: false }, { closeAfter: true });

        for (const t of [
            'The first watch is calm. The lantern is steady.',
            'A skiff drifted south of the gull rocks an hour ago.',
            'Hold the watch. I will fetch the chart.',
        ]) {
            await sendMessageAndAwaitReply(page, t);
        }

        const schema = await openMgSchemaEditor(page);
        await schema.locator('.ml-schema-list .ml-schema-type', {
            has: page.locator('.ml-schema-type-name', { hasText: /^(Event|事件)$/ }),
        }).first().click();

        await schema.locator('.ml-schema-additem').first().click();
        const newInput = schema.locator('.ml-schema-item.is-new .ml-schema-itemname').last();
        await newInput.waitFor({ state: 'visible', timeout: 5000 });
        await newInput.fill(CUSTOM_FIELD);

        await schema.locator('.ml-schema-bar .lw-btn.is-primary').first().click();
        const confirmModal = page.locator('.wbench .mlens .ml-dialog-backdrop:has(.ml-schema-modal)').last();
        await confirmModal.waitFor({ state: 'visible', timeout: 5000 });
        await confirmModal.locator('.ml-schema-modal-foot .lw-btn.is-primary').first().click();
        await confirmModal.waitFor({ state: 'detached', timeout: 10_000 });

        await closeWorkbench(page);

        await server.restart();
        await reloadAndAwait(page, server.baseURL);
        await selectCharacterByName(page, 'Seraphina');
        await setMgSettings(page, { enabled: true });

        const reopened = await openMgSchemaEditor(page);
        await reopened.locator('.ml-schema-list .ml-schema-type', {
            has: page.locator('.ml-schema-type-name', { hasText: /^(Event|事件)$/ }),
        }).first().click();
        const itemLabels = await reopened.locator('.ml-schema-editor .ml-schema-itemname')
            .evaluateAll((inputs) => inputs.map((el) => String(el.value || '')));
        expect(
            itemLabels,
            `event record items should contain "${CUSTOM_FIELD}" after restart; saw: ${JSON.stringify(itemLabels)}`,
        ).toContain(CUSTOM_FIELD);

        await closeWorkbench(page);
    });
});
