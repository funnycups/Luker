// #109 — An orchestrator agent bound to a connection profile by name sends
// its request through that profile.
//
// REAL USER-GESTURE flow:
//   1. Fixtures (before the page loads): the main chat connection points at
//      the mock with model `mock-gpt-4o`; an extra connection profile points
//      at the same mock with a distinct model id.
//   2. In the orchestrator drawer: enable, switch to loop mode, and pick the
//      extra profile as the agent API preset on the General tab.
//   3. Send one chat turn from the composer. The loop agent finalizes in its
//      first round; the main model then writes the reply.
//   4. The mock request log must hold the loop agent request carrying the
//      profile's model id: the agent call was resolved through the profile
//      and reached the mock.

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

let server, mock;

function readSettings() {
    return JSON.parse(readFileSync(resolve(server.dataRoot, 'default-user', 'settings.json'), 'utf8'));
}

function loopAgentRequests() {
    return mock.requests.filter((r) => r.url.includes('/chat/completions')
        && (r.body?.tools || []).some((t) => t?.function?.name === 'finalize'));
}

test.beforeAll(async ({ workerResources }, testInfo) => {
    const scope = await workerResources.scenario(testInfo.file);
    mock = await startMockLLM({ scriptedReplies: ['*Seraphina shields the lantern with one hand.* "The relay fire on the north cliff is lit."'] });
    server = await startServer({ scope, batchKey: 'iterstudio', scenarioId: '109-orch-agent-profile-routing' });
    markOnboarded({ dataRoot: server.dataRoot });
    bootstrapCustomBackend({ dataRoot: server.dataRoot, baseURL: mock.baseURL });
    appendConnectionProfile({ dataRoot: server.dataRoot, baseURL: mock.baseURL, name: ROUTE_PROFILE, model: ROUTE_MODEL });
});

test.afterAll(async () => {

    await mock?.stop();
});

test.describe('#109 — orchestrator agent connection profile routing', () => {
    test.setTimeout(180_000);

    test('a loop agent bound to a fixture profile reaches the mock through that profile', async ({ page }) => {
        await awaitMainUI(page, server.baseURL);
        await selectCharacterByName(page, 'Seraphina');

        await enableOrchestratorMode(page, 'loop', { closeAfter: false });
        await setOrchestratorDefaultApiProfile(page, ROUTE_PROFILE);
        await expect.poll(() => readSettings().extension_settings?.orchestrator?.llmNodeApiPresetName, { timeout: 15_000 })
            .toBe(ROUTE_PROFILE);

        // The loop agent request carries `finalize`, which the mock's
        // director router classifies as 'director-main'. The main-model
        // reply falls through to the scripted reply queue.
        mock.scriptDirectorRun({
            route: ({ role }) => (role === 'director-main'
                ? { tool: 'finalize', arguments: { capsule_text: 'The north relay fire is lit.' } }
                : null),
        });

        const { text } = await sendMessageAndAwaitReply(page, '*I point at the far cliff.* "Is that a fire, or the moon on wet rock?"');
        expect(text).toContain('The relay fire on the north cliff is lit.');

        const routed = loopAgentRequests();
        expect(routed.length, 'the loop agent request must reach the mock').toBeGreaterThan(0);
        expect(
            routed.every((r) => r.body?.model === ROUTE_MODEL),
            `every loop agent request must carry the bound profile's model; saw ${JSON.stringify(routed.map((r) => r.body?.model))}`,
        ).toBe(true);
    });
});
