// #93 — MG schema iter-studio: a read-tool result replayed after a reload
// is the original result, not a synthesized edit-commit payload (B5).
//
// REAL USER-GESTURE flow:
//   1. Open the MG schema studio, send a prompt. The mock LLM calls
//      mg_config_read_fields, the program-driven loop continues, the
//      mock answers with text.
//   2. Wait until the session is on disk, restart the server, reload.
//   3. Reopen the studio, open the history list, load the past session,
//      send a follow-up prompt.
//   4. The follow-up request's tool message for the original call id must
//      carry the same content the model saw in the first turn.

import { test, expect } from '../../harness/playwright.js';
import { startServer } from '../../harness/server.js';
import { startMockLLM } from '../_lib/mockLLM.js';
import { bootstrapCustomBackend, appendConnectionProfile, markOnboarded } from '../_lib/fixtures.js';
import { awaitMainUI, reloadAndAwait } from '../_lib/page.js';
import { openIterStudio, sendIterPrompt, closeIterStudio } from '../_lib/ui-iter-studio.js';
import { normalizeIterStudioSettings, readGlobalWorkbenchBodies } from './_helpers.js';

let server, mock;

const FIRST_REPLY = 'The schema already tracks the cartographer routes and needs no tide chart type yet.';
const SECOND_REPLY = 'The logbook fits under the existing event type and the schema can stay as it is.';

function schemaStudioRequests() {
    return mock.requests.filter((r) => String(r.url || '').includes('/chat/completions')
        && Array.isArray(r.body?.tools)
        && r.body.tools.some((t) => t?.function?.name === 'mg_config_read_fields'));
}

function toolMessages(request) {
    return (Array.isArray(request?.body?.messages) ? request.body.messages : []).filter((m) => m?.role === 'tool');
}

test.beforeAll(async ({ workerResources }, testInfo) => {
    const scope = await workerResources.scenario(testInfo.file);
    mock = await startMockLLM({});
    server = await startServer({ scope,
        batchKey: 'iterstudio',
        scenarioId: '93-mg-schema-read-reload',
        extraConfig: { storage: { mode: 'fs' } },
    });
    markOnboarded({ dataRoot: server.dataRoot });
    bootstrapCustomBackend({ dataRoot: server.dataRoot, baseURL: mock.baseURL });
    appendConnectionProfile({ dataRoot: server.dataRoot, baseURL: mock.baseURL });
    normalizeIterStudioSettings(server.dataRoot);
});

test.afterAll(async () => {

    await mock?.stop();
});

test.describe('#93 — MG schema read-tool results survive a session reload (real UI)', () => {
    test('replayed tool message equals the original read result', async ({ page }) => {
        await awaitMainUI(page, server.baseURL);
        await openIterStudio(page, 'mg');

        mock.scriptToolCall({ name: 'mg_config_read_fields', arguments: { paths: ['schema.length', 'schema[0].id'] } });
        mock.scriptReply(FIRST_REPLY);
        await sendIterPrompt(page, 'mg', 'Before we add anything for the tide charts, check how many node types the schema holds.');

        await expect.poll(() => schemaStudioRequests().length, { timeout: 60_000 }).toBe(2);
        const originalTool = toolMessages(schemaStudioRequests()[1])[0];
        expect(originalTool?.tool_call_id).toBeTruthy();
        const readResult = JSON.parse(originalTool.content);
        expect(readResult.missing_paths).toEqual([]);
        expect(readResult.values['schema.length']).toBeGreaterThan(0);
        expect(readResult.values['schema[0].id']).toEqual(expect.any(String));

        await expect.poll(() => {
            const raw = JSON.stringify(readGlobalWorkbenchBodies(server.dataRoot, session => session.ws === 'memory'));
            return raw.includes(FIRST_REPLY) && raw.includes('mg_config_read_fields');
        }, { timeout: 30_000 }).toBe(true);

        await closeIterStudio(page);
        await server.restart();
        await reloadAndAwait(page, server.baseURL);
        await openIterStudio(page, 'mg');

        const popup = page.locator('.wbench .wb-win');
        const pastSession = popup.locator('.wb-sess-item', { hasText: 'Before we add anything' });
        await pastSession.waitFor({ state: 'visible', timeout: 10_000 });
        await pastSession.click();

        mock.scriptReply(SECOND_REPLY);
        await sendIterPrompt(page, 'mg', 'Look at the schema you read earlier. Does the cartographer logbook need its own type?');

        await expect.poll(() => schemaStudioRequests().length, { timeout: 60_000 }).toBe(3);
        const replayed = toolMessages(schemaStudioRequests()[2]).find((m) => m.tool_call_id === originalTool.tool_call_id);
        expect(replayed).toBeTruthy();
        expect(replayed.content).toBe(originalTool.content);
    });
});
