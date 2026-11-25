// Request Inspector — the request detail lists the tools sent to the model in
// a dedicated Tools section: one foldable row per tool (name, description,
// parameter count) that expands into a parameter table. The raw `tools` array
// must no longer appear inside Other Params.
//
// REAL USER FLOW: boot the server, register a tool through the production
// ctx.registerFunctionTool surface, enable native function calling, send a
// message that triggers the tool, then open the Inspector from the user
// settings drawer and read the rendered Tools section.

import { test, expect } from '../../harness/playwright.js';
import { readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { startServer } from '../../harness/server.js';
import { startMockLLM } from '../_lib/mockLLM.js';
import { bootstrapCustomBackend, appendConnectionProfile, markOnboarded } from '../_lib/fixtures.js';
import { awaitMainUI, selectCharacterByName, sendMessageAndAwaitReply } from '../_lib/page.js';

let server, mock;

test.beforeAll(async ({ workerResources }, testInfo) => {
    const scope = await workerResources.scenario(testInfo.file);
    mock = await startMockLLM({ scriptedReplies: [], scriptedToolCalls: [] });
    server = await startServer({ scope, batchKey: 'regression', scenarioId: '137-inspector-tools-section' });
    markOnboarded({ dataRoot: server.dataRoot });
    bootstrapCustomBackend({ dataRoot: server.dataRoot, baseURL: mock.baseURL });
    appendConnectionProfile({ dataRoot: server.dataRoot, baseURL: mock.baseURL });
    // Keep the memory-graph extractor from firing its own completions against
    // the shared scripted queue; only two replies are scripted here.
    const sp = resolve(server.dataRoot, 'default-user', 'settings.json');
    const s = JSON.parse(readFileSync(sp, 'utf8'));
    s.extension_settings = s.extension_settings || {};
    s.extension_settings.memory_graph = { ...(s.extension_settings.memory_graph || {}), enabled: false };
    writeFileSync(sp, JSON.stringify(s, null, 4));
});

test.afterAll(async () => {

    await mock?.stop();
});

test('request detail renders a Tools section with the tool parameter table', async ({ page }) => {
    await awaitMainUI(page, server.baseURL);
    await selectCharacterByName(page, 'Seraphina');

    await page.evaluate(async () => {
        const mod = await import('/scripts/openai.js');
        mod.oai_settings.function_calling = true;
        mod.oai_settings.custom_prompt_post_processing = '';
        mod.oai_settings.stream_openai = false;
        mod.oai_settings.tool_call_recurse_limit = 5;
        window.Luker.getContext().ToolManager.RECURSE_LIMIT = 5;
    });

    await page.evaluate(() => {
        const ctx = window.Luker.getContext();
        try { ctx.unregisterFunctionTool('get_weather'); } catch { /* ignore */ }
        ctx.registerFunctionTool({
            name: 'get_weather',
            displayName: 'Get Weather',
            description: 'Returns the current weather for the named city.',
            parameters: {
                type: 'object',
                properties: {
                    city: { type: 'string', description: 'City name.' },
                    units: { type: 'string', description: 'Unit system, metric or imperial.' },
                },
                required: ['city'],
                additionalProperties: false,
            },
            action: async () => 'sunny, 21C',
            formatMessage: () => 'Checking the weather...',
            shouldRegister: () => true,
            stealth: false,
        });
    });

    mock.scriptToolCall({ name: 'get_weather', arguments: { city: 'Bryn-on-Sea' } });
    mock.scriptReply('It will be sunny tomorrow.');

    await sendMessageAndAwaitReply(page, 'What will the weather be tomorrow in Bryn-on-Sea?');

    // Open the user-settings drawer, then the Inspector button inside it.
    const drawerClosed = await page.locator('#user-settings-button .drawer-icon.closedIcon').count().then(n => n > 0);
    if (drawerClosed) {
        await page.locator('#user-settings-button .drawer-toggle').click();
        await page.waitForFunction(() => {
            const el = document.getElementById('user-settings-block');
            return el && !el.classList.contains('closedDrawer');
        }, { timeout: 5_000 });
    }
    await page.locator('#request_inspector_button').click();

    const popup = page.locator('dialog.popup[open]').last();
    await popup.locator('.ri-row').first().waitFor({ state: 'visible', timeout: 10_000 });
    await popup.locator('.ri-row').first().click();

    // The Tools section carries the tool name, description, and param count.
    await popup.locator('.ri-tools-head').waitFor({ state: 'visible', timeout: 10_000 });
    await expect(popup.locator('.ri-tool-name').first()).toHaveText('get_weather');
    await expect(popup.locator('.ri-tool-desc').first()).toContainText('weather');
    await expect(popup.locator('.ri-tool-count').first()).toContainText('2 params');

    // Expanding the row reveals the parameter table with the required marker.
    await popup.locator('.ri-tool .ri-msg-summary').first().click();
    const rows = popup.locator('.ri-tool .ri-params tbody tr');
    await expect(rows).toHaveCount(2);
    await expect(rows.nth(0)).toContainText('city');
    await expect(rows.nth(0)).toContainText('string');
    await expect(rows.nth(0)).toContainText('City name.');
    await expect(rows.nth(0)).toContainText('*');
    await expect(rows.nth(1)).toContainText('units');

    // The raw tools array must not linger inside Other Params.
    const otherParams = await popup.locator('.ri-wire-meta').first().innerText().catch(() => '');
    expect(otherParams.includes('"tools"')).toBe(false);
});
