// #103 — CEA editor iter-studio: approve then roll back restores the card
// and the world book on disk.
//
// The CEA popup registers `character` and `lorebook` proposal-bus targets;
// Approve commits through them and the proposal card's Rollback button
// writes the pre-approval state back through the same targets.
//
// Real UI/gestures: select Seraphina → Extensions drawer → CEA → "Open
// Editor" → Send → Approve → Rollback. mockLLM scripts the edit tool calls.

import { test, expect } from '../../harness/playwright.js';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { startServer } from '../../harness/server.js';
import { startMockLLM } from '../_lib/mockLLM.js';
import { bootstrapCustomBackend, appendConnectionProfile, markOnboarded } from '../_lib/fixtures.js';
import { awaitMainUI, selectCharacterByName } from '../_lib/page.js';
import { openIterStudio, sendIterPrompt, applyIterBatch, rollbackIterBatch, closeIterStudio } from '../_lib/ui-iter-studio.js';
import { normalizeIterStudioSettings } from '../preset/_helpers.js';

const BOOK_NAME = 'Eldoria';
const TARGET_UID = 0;
const NEW_DESCRIPTION = 'Seraphina keeps a satchel of pressed moonpetals and a ledger of every traveller she has mended.';
const NEW_CONTENT = 'The Eldoria wood keeps a hush beneath its oldest beeches, where lantern-moss marks the safe paths.';

let server, mock;

function readEntry(dataRoot, uid) {
    const raw = JSON.parse(readFileSync(resolve(dataRoot, 'default-user', 'worlds', `${BOOK_NAME}.json`), 'utf8'));
    return raw?.entries?.[String(uid)] || null;
}

/** Read the active character's description from disk through the characters API. */
async function readDiskDescription(page) {
    return page.evaluate(async () => {
        const ctx = window.Luker.getContext();
        const avatar = ctx.characters?.[ctx.characterId]?.avatar || '';
        const resp = await fetch('/api/characters/get', {
            method: 'POST',
            headers: ctx.getRequestHeaders(),
            body: JSON.stringify({ avatar_url: avatar }),
        });
        const data = await resp.json();
        return data?.data?.description ?? data?.description ?? '';
    });
}

test.beforeAll(async ({ workerResources }, testInfo) => {
    const scope = await workerResources.scenario(testInfo.file);
    mock = await startMockLLM({});
    server = await startServer({ scope,
        batchKey: 'iterstudio',
        scenarioId: '103-cea-approve-rollback',
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

test.describe('#103 — CEA editor approve then rollback', () => {
    test('rolling back an approved card edit restores the description on disk', async ({ page }) => {
        await awaitMainUI(page, server.baseURL);
        await selectCharacterByName(page, 'Seraphina');
        const before = await readDiskDescription(page);
        expect(before).not.toBe(NEW_DESCRIPTION);

        await openIterStudio(page, 'cea');
        mock.scriptToolCall({
            name: 'cea_set_card_field',
            arguments: { field: 'description', value: NEW_DESCRIPTION },
        });
        await sendIterPrompt(page, 'cea', 'Give Seraphina a satchel of pressed moonpetals and a ledger of the travellers she has mended.');
        await applyIterBatch(page, 'cea');
        await expect.poll(() => readDiskDescription(page), { timeout: 15_000 }).toBe(NEW_DESCRIPTION);

        await rollbackIterBatch(page, 'cea');
        const popup = page.locator('.wbench .wb-win');
        await expect(popup.locator('.wb-chg.is-discarded .wb-chg-line')).toHaveCount(1, { timeout: 15_000 });
        await expect.poll(() => readDiskDescription(page), { timeout: 15_000 }).toBe(before);

        await closeIterStudio(page);
    });

    test('rolling back an approved world book edit restores the entry on disk', async ({ page }) => {
        await awaitMainUI(page, server.baseURL);
        await selectCharacterByName(page, 'Seraphina');
        const before = readEntry(server.dataRoot, TARGET_UID);
        expect(before.content).not.toBe(NEW_CONTENT);

        await openIterStudio(page, 'cea');
        mock.scriptToolCall({
            name: 'cea_update_lorebook_entry',
            arguments: { book_name: BOOK_NAME, uid: TARGET_UID, patch: { content: NEW_CONTENT } },
        });
        await sendIterPrompt(page, 'cea', 'Describe the hush under the oldest beeches of the Eldoria wood and the lantern-moss on its safe paths.');
        await applyIterBatch(page, 'cea');
        await expect.poll(() => readEntry(server.dataRoot, TARGET_UID)?.content, { timeout: 15_000 }).toBe(NEW_CONTENT);

        await rollbackIterBatch(page, 'cea');
        const popup = page.locator('.wbench .wb-win');
        await expect(popup.locator('.wb-chg.is-discarded .wb-chg-line')).toHaveCount(1, { timeout: 15_000 });
        await expect.poll(() => readEntry(server.dataRoot, TARGET_UID)?.content, { timeout: 15_000 }).toBe(before.content);
        const after = readEntry(server.dataRoot, TARGET_UID);
        expect(after.key).toEqual(before.key);
        expect(after.comment).toBe(before.comment);

        await closeIterStudio(page);
    });
});
