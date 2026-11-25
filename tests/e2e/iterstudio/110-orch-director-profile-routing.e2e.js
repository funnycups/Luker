// #110 — A director agent bound to a connection profile by name sends its
// request through that profile.
//
// Director-mode twin of #109.
//
// REAL USER-GESTURE flow:
//   1. Fixtures (before the page loads): the main chat connection points at
//      the mock with model `mock-gpt-4o`; an extra connection profile points
//      at the same mock with a distinct model id.
//   2. In the orchestrator drawer: enable, switch to director mode, and pick
//      the extra profile as the agent API preset on the General tab.
//   3. Send one chat turn from the composer. The director main agent writes
//      the reply and finalizes; its text becomes the chat bubble.
//   4. The mock request log must hold the director main agent requests, each
//      carrying the profile's model id: the agent calls were resolved
//      through the profile and reached the mock.

import { test, expect } from '../../harness/playwright.js';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { startServer } from '../../harness/server.js';
import { startMockLLM } from '../_lib/mockLLM.js';
import { bootstrapCustomBackend, appendConnectionProfile, markOnboarded } from '../_lib/fixtures.js';
import { awaitMainUI, selectCharacterByName, sendMessageAndAwaitReply } from '../_lib/page.js';
import { enableOrchestratorMode, setOrchestratorDefaultApiProfile } from '../_lib/ui-orchestrator.js';

const ROUTE_PROFILE = 'Lighthouse Relay';
const ROUTE_MODEL = 'lighthouse-relay-model';
const REPLY = '*Seraphina shields the lantern with one hand.* "The relay fire on the north cliff is lit."';

let server, mock;

function readSettings() {
    return JSON.parse(readFileSync(resolve(server.dataRoot, 'default-user', 'settings.json'), 'utf8'));
}

function directorMainRequests() {
    return mock.requests.filter((r) => r.url.includes('/chat/completions')
        && (r.body?.tools || []).some((t) => t?.function?.name === 'write_message'));
}

test.beforeAll(async ({ workerResources }, testInfo) => {
    const scope = await workerResources.scenario(testInfo.file);
    mock = await startMockLLM({});
    server = await startServer({ scope, batchKey: 'iterstudio', scenarioId: '110-orch-director-profile-routing' });
    markOnboarded({ dataRoot: server.dataRoot });
    bootstrapCustomBackend({ dataRoot: server.dataRoot, baseURL: mock.baseURL });
    appendConnectionProfile({ dataRoot: server.dataRoot, baseURL: mock.baseURL, name: ROUTE_PROFILE, model: ROUTE_MODEL });
});

test.afterAll(async () => {

    await mock?.stop();
});

test.describe('#110 — orchestrator director connection profile routing', () => {
    test.setTimeout(180_000);

    test('a director agent bound to a fixture profile reaches the mock through that profile', async ({ page }) => {
        await awaitMainUI(page, server.baseURL);
        await selectCharacterByName(page, 'Seraphina');

        await enableOrchestratorMode(page, 'director', { closeAfter: false });
        await setOrchestratorDefaultApiProfile(page, ROUTE_PROFILE);
        await expect.poll(() => readSettings().extension_settings?.orchestrator?.llmNodeApiPresetName, { timeout: 15_000 })
            .toBe(ROUTE_PROFILE);

        mock.scriptDirectorRun({
            route: ({ role, turn }) => {
                if (role !== 'director-main') return null;
                if (turn === 0) return { tool: 'write_message', arguments: { text: REPLY, mode: 'replace' } };
                if (turn === 1) return { tool: 'finalize', arguments: {} };
                return null;
            },
        });

        const { text } = await sendMessageAndAwaitReply(page, '*I point at the far cliff.* "Is that a fire, or the moon on wet rock?"');
        expect(text).toContain('The relay fire on the north cliff is lit.');

        const routed = directorMainRequests();
        expect(routed.length, 'the director main agent requests must reach the mock').toBeGreaterThan(1);
        expect(
            routed.every((r) => r.body?.model === ROUTE_MODEL),
            `every director main agent request must carry the bound profile's model; saw ${JSON.stringify(routed.map((r) => r.body?.model))}`,
        ).toBe(true);
    });
});
