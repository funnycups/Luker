import { test, expect } from '@playwright/test';
import { chmodSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { startServer, tearDownServer } from '../_lib/server.js';
import { awaitMainUI, openExtensionsDrawer } from '../_lib/page.js';

let server;

test.beforeAll(async () => {
    server = await startServer({
        batchKey: 'extensions',
        scenarioId: 'settings-save-failure',
        extraConfig: { enableUserAccounts: false },
    });
});

test.afterAll(async () => {
    await tearDownServer(server);
});

test('a failed settings write reports an error and allows saving the same edit again', async ({ page }) => {
    await awaitMainUI(page, server.baseURL);
    await openExtensionsDrawer(page);
    const field = page.locator('#cea_editor_system_prompt');
    await expect(field).toBeAttached();
    for (const drawer of await field.locator('xpath=ancestor::*[contains(concat(" ", normalize-space(@class), " "), " inline-drawer ")]').all()) {
        if (!(await drawer.locator('> .inline-drawer-content').isVisible())) {
            await drawer.locator('> .inline-drawer-toggle').click();
        }
    }
    for (const details of await field.locator('xpath=ancestor::details').all()) {
        if ((await details.getAttribute('open')) === null) await details.locator('> summary').click();
    }
    await expect(field).toBeVisible();
    const directory = join(server.dataRoot, 'default-user');
    const readPrompt = () => JSON.parse(readFileSync(join(directory, 'settings.json'), 'utf8'))
        .extension_settings.character_editor_assistant.editorIterationSystemPrompt;
    const saved = 'Describe the supplied card content.\n';
    await field.fill(saved);
    await expect.poll(readPrompt).toBe(saved);
    const unsaved = '  Keep this requested edit.\n\n';
    const mode = statSync(directory).mode & 0o777;
    chmodSync(directory, 0o555);
    try {
        const [response] = await Promise.all([
            page.waitForResponse(value => new URL(value.url()).pathname === '/api/settings/save'
                && value.request().method() === 'POST'
                && value.request().postDataJSON().extension_settings.character_editor_assistant.editorIterationSystemPrompt === unsaved),
            field.fill(unsaved),
        ]);
        expect(response.status()).toBe(500);
        expect((await response.json()).details).toContain('EACCES');
        const errorTitle = await page.evaluate(() => window.Luker.getContext().translate('Settings could not be saved'));
        await expect(page.getByText(errorTitle, { exact: true })).toBeVisible();
        await expect(field).toHaveValue(unsaved);
        expect(readPrompt()).toBe(saved);
    } finally {
        chmodSync(directory, mode);
    }
    await field.fill(unsaved);
    await expect.poll(readPrompt).toBe(unsaved);
});
