// The HarmonyOS background keep-alive holds a continuous task (and its
// "generating a reply" notification) only while a generation is in flight.
// The web side used to derive that state from the GENERATION_STARTED /
// GENERATION_ENDED pair, which is not balanced: a tool-call round re-enters
// Generate() (emitting STARTED) while the intermediate round deliberately
// skips ENDED, so the counter stayed above zero after the turn finished and
// the shell kept the notification up for the rest of the session. This test
// drives a real tool-call turn through the UI and asserts the shell is told
// to release the keep-alive once the turn ends.

import { test, expect } from '../../harness/playwright.js';
import { readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { startServer } from '../../harness/server.js';
import { startMockLLM } from '../_lib/mockLLM.js';
import { bootstrapCustomBackend, appendConnectionProfile, markOnboarded } from '../_lib/fixtures.js';
import { awaitMainUI, selectCharacterByName, sendMessageAndAwaitReply } from '../_lib/page.js';

const USER_TURN = 'Sound the lead before we lose the light.';
const FINAL_REPLY = '*Ash pays the line out over the rail.* "Four fathoms, sand and shell — we can hold here."';

let server, mock;

test.beforeAll(async ({ workerResources }, testInfo) => {
    const scope = await workerResources.scenario(testInfo.file);
    mock = await startMockLLM({ scriptedReplies: [] });
    server = await startServer({ scope, batchKey: 'regression', scenarioId: 'harmony-keepalive-release' });
    markOnboarded({ dataRoot: server.dataRoot });
    bootstrapCustomBackend({ dataRoot: server.dataRoot, baseURL: mock.baseURL, stream: false });
    appendConnectionProfile({ dataRoot: server.dataRoot, baseURL: mock.baseURL });
    // Keep background extraction (memory-graph) from consuming the scripted
    // replies against its own /chat/completions calls.
    const settingsPath = resolve(server.dataRoot, 'default-user', 'settings.json');
    const settings = JSON.parse(readFileSync(settingsPath, 'utf8'));
    settings.extension_settings = settings.extension_settings || {};
    settings.extension_settings.memory_graph = { ...(settings.extension_settings.memory_graph || {}), enabled: false };
    // Native tool calling on, non-streamed (deterministic shapes).
    settings.oai_settings = settings.oai_settings || {};
    settings.oai_settings.function_calling = true;
    settings.oai_settings.custom_prompt_post_processing = '';
    settings.oai_settings.stream_openai = false;
    settings.oai_settings.tool_call_recurse_limit = 5;
    writeFileSync(settingsPath, JSON.stringify(settings, null, 4));
});

test.afterAll(async () => {

    await mock?.stop();
});

async function openUserSettings(page) {
    await page.locator('#user-settings-button').waitFor({ state: 'visible', timeout: 10_000 });
    const closed = await page.locator('#user-settings-button .drawer-icon.closedIcon').count().then(n => n > 0);
    if (closed) {
        await page.locator('#user-settings-button .drawer-toggle').click();
        await page.waitForFunction(() => {
            const el = document.getElementById('user-settings-block');
            return el && !el.classList.contains('closedDrawer');
        }, { timeout: 5_000 });
    }
}

test('releases the HarmonyOS keep-alive after a tool-call turn ends', async ({ browser }) => {
    const page = await browser.newPage();
    // The shell bridge records every generation-active transition.
    await page.addInitScript(() => {
        window.__harmonyGenerationActive = [];
        window.LukerHarmony = {
            setGenerationActive(active) { window.__harmonyGenerationActive.push(active === true); },
            setImmersiveModeEnabled() {},
            openExternalUrl() {},
        };
    });
    await awaitMainUI(page, server.baseURL);

    // Enable the mobile keep-alive through its real checkbox.
    await openUserSettings(page);
    await page.locator('#luker_mobile_keep_alive').check();
    await page.waitForFunction(() => window.Luker.getContext().powerUserSettings.luker_mobile_keep_alive_harmony_enabled === true);

    await selectCharacterByName(page, 'Seraphina');

    // Register one tool the model can call.
    await page.evaluate(() => {
        const ctx = window.Luker.getContext();
        ctx.ToolManager.RECURSE_LIMIT = 5;
        try { ctx.unregisterFunctionTool('sound_lead'); } catch { /* not registered */ }
        ctx.registerFunctionTool({
            name: 'sound_lead',
            displayName: 'Sound the lead',
            description: 'Drops the sounding lead and returns the depth reading.',
            parameters: {
                type: 'object',
                properties: { spot: { type: 'string', description: 'Where to sound.' } },
                required: ['spot'],
                additionalProperties: false,
            },
            action: async ({ spot }) => `depth reading at ${spot}: four fathoms over shell`,
            formatMessage: ({ spot }) => `Sounding the lead at ${spot}...`,
            shouldRegister: () => true,
            stealth: false,
        });
    });

    // Tool round → final reply. The tool round re-enters Generate() without
    // emitting GENERATION_ENDED, which is what used to pin the flag.
    mock.scriptToolCall({ name: 'sound_lead', arguments: { spot: 'the reef edge' } });
    mock.scriptReply(FINAL_REPLY);
    const { text } = await sendMessageAndAwaitReply(page, USER_TURN);
    expect(text, 'the tool-call turn must land the final reply').toContain('Four fathoms');

    // The keep-alive must have been held while the generation ran...
    const activeCalls = await page.evaluate(() => window.__harmonyGenerationActive.slice());
    expect(activeCalls, 'the shell must be told a generation is active').toContain(true);

    // ...and released once the turn ended. The exit is scheduled after the
    // grace window that covers chained generations, so allow for it.
    await page.waitForFunction(
        () => window.__harmonyGenerationActive.lastIndexOf(false) > window.__harmonyGenerationActive.indexOf(true),
        undefined,
        { timeout: 30_000 },
    );
    const finalCalls = await page.evaluate(() => window.__harmonyGenerationActive.slice());
    expect(finalCalls[finalCalls.length - 1], 'the shell must be told the generation ended').toBe(false);

    await page.close();
});
