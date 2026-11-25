// #106 — CEA editor iter-studio: a proposal staged by a turn reaches disk
// while the popup is still open.
//
// The mock LLM sets Seraphina's description. Once the proposal card shows,
// the stored session must carry the pending proposal; after a restart and
// reload, loading the session from the history list brings the card back,
// Approve writes the new description to the card file, and Rollback
// restores the original.
//
// Real UI/gestures: select Seraphina → Extensions drawer → CEA → "Open
// Editor" → Send → reload → reopen → history → load session → Approve →
// Rollback.

import { test, expect } from '../../harness/playwright.js';
import { readdirSync } from 'node:fs';
import { resolve } from 'node:path';
import { startServer } from '../../harness/server.js';
import { startMockLLM } from '../_lib/mockLLM.js';
import { bootstrapCustomBackend, appendConnectionProfile, markOnboarded } from '../_lib/fixtures.js';
import { awaitMainUI, reloadAndAwait, selectCharacterByName } from '../_lib/page.js';
import { openIterStudio, sendIterPrompt, applyIterBatch, rollbackIterBatch, closeIterStudio } from '../_lib/ui-iter-studio.js';
import { normalizeIterStudioSettings, readCharacterWorkbenchBodies } from './_helpers.js';

const NEW_DESCRIPTION = 'Seraphina keeps a ledger of every traveller the glade has sheltered, written in moss-green ink.';
const SESSIONS_SUFFIX = '.state.workbench_sessions.json';

let server, mock;

function charactersDir() {
    return resolve(server.dataRoot, 'default-user', 'characters');
}

function storedDecisionStates() {
    const file = readdirSync(charactersDir()).find(name => name.endsWith(`Seraphina${SESSIONS_SUFFIX}`));
    if (!file) return [];
    const base = file.slice(0, -SESSIONS_SUFFIX.length);
    return readCharacterWorkbenchBodies(server.dataRoot, base, session => session.ws === 'card')
        .flatMap(session => (session.turns || []).filter(turn => turn.changes?.length).map(turn => turn.state));
}

async function storedDescription(page) {
    return page.evaluate(async () => {
        const ctx = globalThis.SillyTavern.getContext();
        const avatar = ctx.characters.find(c => c.name === 'Seraphina')?.avatar;
        const resp = await fetch('/api/characters/get', {
            method: 'POST',
            headers: ctx.getRequestHeaders(),
            body: JSON.stringify({ avatar_url: avatar }),
        });
        const data = await resp.json();
        return data?.data?.description || data?.description || '';
    });
}

test.beforeAll(async ({ workerResources }, testInfo) => {
    const scope = await workerResources.scenario(testInfo.file);
    mock = await startMockLLM({});
    server = await startServer({ scope,
        batchKey: 'iterstudio',
        scenarioId: '106-cea-proposal-survives-reload',
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

test.describe('#106 — CEA editor proposal saved during the turn', () => {
    test('a pending proposal survives a restart and can be approved after reload', async ({ page }) => {
        await awaitMainUI(page, server.baseURL);
        await selectCharacterByName(page, 'Seraphina');
        await openIterStudio(page, 'cea');
        mock.scriptToolCall({
            name: 'cea_set_card_field',
            arguments: { field: 'description', value: NEW_DESCRIPTION },
        });
        await sendIterPrompt(page, 'cea', 'Mention the ledger of travellers Seraphina keeps for the glade.');

        // Popup still open: the pending proposal must already be on disk.
        await expect.poll(storedDecisionStates, { timeout: 30_000 }).toEqual(['pending']);

        await server.restart();
        await reloadAndAwait(page, server.baseURL);
        await selectCharacterByName(page, 'Seraphina');
        await openIterStudio(page, 'cea');

        const reopened = page.locator('.wbench .wb-win');
        const pastSession = reopened.locator('.wb-sess-item', { hasText: 'Mention the ledger' });
        await pastSession.waitFor({ state: 'visible', timeout: 10_000 });
        await pastSession.click();
        await expect(reopened.locator('.wb-chg.is-pending .wb-chg-line')).toHaveCount(1, { timeout: 15_000 });

        const originalDescription = await storedDescription(page);
        expect(originalDescription).not.toBe(NEW_DESCRIPTION);
        await applyIterBatch(page, 'cea');
        await expect(reopened.locator('.wb-chg.is-applied .wb-chg-line')).toHaveCount(1, { timeout: 15_000 });
        await expect.poll(storedDecisionStates, { timeout: 15_000 }).toEqual(['applied']);
        await expect.poll(() => storedDescription(page), { timeout: 15_000 }).toBe(NEW_DESCRIPTION);

        await rollbackIterBatch(page, 'cea');
        await expect(reopened.locator('.wb-chg.is-discarded .wb-chg-line')).toHaveCount(1, { timeout: 15_000 });
        await expect.poll(storedDecisionStates, { timeout: 15_000 }).toEqual(['discarded']);
        await expect.poll(() => storedDescription(page), { timeout: 15_000 }).toBe(originalDescription);

        await closeIterStudio(page);
    });
});
