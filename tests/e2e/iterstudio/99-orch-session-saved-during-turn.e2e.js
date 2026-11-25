// A global orchestration conversation is durable while Workbench remains open.
// Restarting the server and selecting its saved conversation restores the reply.

import { test, expect } from '../../harness/playwright.js';
import { startServer } from '../../harness/server.js';
import { startMockLLM } from '../_lib/mockLLM.js';
import { bootstrapCustomBackend, appendConnectionProfile, markOnboarded } from '../_lib/fixtures.js';
import { awaitMainUI, reloadAndAwait } from '../_lib/page.js';
import { openIterStudio, closeIterStudio, sendIterPrompt } from '../_lib/ui-iter-studio.js';
import { normalizeIterStudioSettings, readGlobalWorkbenchBodies } from './_helpers.js';

const PROMPT = 'The keeper wants the tide-watch agent to log the evening swell before the lamps are lit.';
const REPLY = 'The tide-watch agent can log the evening swell from the harbor gauge before the lamps are lit.';

let server, mock;

function storedGlobalSessions() {
    return readGlobalWorkbenchBodies(server.dataRoot, session => session.ws === 'orch')
        .filter(session => (session.turns || []).some(turn => turn.role === 'user' && turn.text === PROMPT));
}

test.beforeAll(async ({ workerResources }, testInfo) => {
    const scope = await workerResources.scenario(testInfo.file);
    mock = await startMockLLM({});
    server = await startServer({ scope,
        batchKey: 'iterstudio',
        scenarioId: '99-orch-session-saved-during-turn',
        extraConfig: { storage: { mode: 'fs' } },
    });
    markOnboarded({ dataRoot: server.dataRoot });
    bootstrapCustomBackend({ dataRoot: server.dataRoot, baseURL: mock.baseURL });
    appendConnectionProfile({ dataRoot: server.dataRoot, baseURL: mock.baseURL });
    normalizeIterStudioSettings(server.dataRoot);

    mock.scriptCompletion(({ userMessages }) => {
        const lastUser = String(userMessages[userMessages.length - 1] || '');
        return lastUser.includes(PROMPT) ? { text: REPLY } : null;
    });
});

test.afterAll(async () => {

    await mock?.stop();
});

test.describe('#99 — Orchestrator iter-studio: session saved during the turn', () => {
    test('a turn sent with Workbench open survives a server restart', async ({ page }) => {
        await awaitMainUI(page, server.baseURL);
        const studio = await openIterStudio(page, 'orch', { scope: 'global' });

        await sendIterPrompt(page, 'orch', PROMPT, { waitForSettle: false });
        await expect(studio).toContainText(REPLY, { timeout: 60_000 });

        await expect(studio).toBeVisible();
        await expect.poll(() => storedGlobalSessions(), { timeout: 30_000 }).toHaveLength(1);
        const [saved] = storedGlobalSessions();
        expect(saved.messages).toContainEqual(expect.objectContaining({ role: 'assistant', content: REPLY }));

        await server.restart();
        await reloadAndAwait(page, server.baseURL);
        const reopened = await openIterStudio(page, 'orch', { scope: 'global' });
        const pastSession = reopened.locator('.wb-sess-item').filter({ hasText: saved.title });
        await pastSession.waitFor({ state: 'visible', timeout: 10_000 });
        await pastSession.click();
        await expect(reopened).toContainText(REPLY, { timeout: 15_000 });
        expect(storedGlobalSessions()).toEqual([saved]);

        await closeIterStudio(page);
    });
});
