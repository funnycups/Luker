// #104 — CEA editor iter-studio: an edit on a world book other than the
// character's primary book keeps that book's existing entries.
//
// Seraphina's primary book is Eldoria. A second book is bound to her as an
// additional lorebook through the character world popup. The mock LLM adds
// an entry to that second book; Approve must write the book with its old
// entries plus the new one, and Rollback must restore the original file.
//
// Real UI/gestures: select Seraphina → shift-click the character world
// button → pick the additional lorebook → Extensions drawer → CEA → "Open
// Editor" → Send → Approve → Rollback. mockLLM scripts the edit tool call.

import { test, expect } from '../../harness/playwright.js';
import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { startServer } from '../../harness/server.js';
import { startMockLLM } from '../_lib/mockLLM.js';
import { bootstrapCustomBackend, appendConnectionProfile, markOnboarded, writeWorldBook } from '../_lib/fixtures.js';
import { awaitMainUI, closeRightNavDrawer, selectCharacterByName } from '../_lib/page.js';
import { openIterStudio, sendIterPrompt, applyIterBatch, rollbackIterBatch, closeIterStudio } from '../_lib/ui-iter-studio.js';
import { normalizeIterStudioSettings } from '../preset/_helpers.js';

const AUX_BOOK = 'Eldoria Wayfarers';
const AUX_ENTRIES = [
    {
        key: ['moonwell', 'moon well'],
        comment: 'moonwell',
        content: 'The moonwell at the heart of the glade fills only on nights when both moons rise together.',
    },
    {
        key: ['thornward', 'thorn ward'],
        comment: 'thornward',
        content: 'Thornward hedges grow wherever Seraphina has sung a warding verse, and part only for travellers she trusts.',
    },
];
const NEW_UID = 7;
const NEW_ENTRY = {
    uid: NEW_UID,
    key: ['lantern-moss'],
    comment: 'lantern-moss',
    content: 'Lantern-moss glows along the safe paths of the Eldoria wood and dims wherever shadowfang have passed.',
};

let server, mock;

function readBook(dataRoot) {
    return JSON.parse(readFileSync(resolve(dataRoot, 'default-user', 'worlds', `${AUX_BOOK}.json`), 'utf8'));
}

async function bindAdditionalLorebook(page, bookName) {
    await page.locator('#rightNavDrawerIcon').click();
    await expect(page.locator('#world_button')).toBeVisible({ timeout: 10_000 });
    await page.locator('#world_button').click({ modifiers: ['Shift'] });
    const popup = page.locator('.popup:visible', { has: page.locator('.character_extra_world_info_selector') }).last();
    await expect(popup).toBeVisible({ timeout: 10_000 });
    await popup.locator('.select2-selection').click();
    await page.locator('.select2-results__option', { hasText: bookName }).click();
    await expect(popup.locator('.select2-selection__choice', { hasText: bookName })).toHaveCount(1);
    await popup.locator('h3').first().click();
    await expect(page.locator('.select2-container--open')).toHaveCount(0);
    await popup.locator('.popup-button-ok').click();
    await expect(popup).toBeHidden({ timeout: 10_000 });
    await closeRightNavDrawer(page);
}

test.beforeAll(async ({ workerResources }, testInfo) => {
    const scope = await workerResources.scenario(testInfo.file);
    mock = await startMockLLM({});
    server = await startServer({ scope,
        batchKey: 'iterstudio',
        scenarioId: '104-cea-auxiliary-book-edit',
        extraConfig: { storage: { mode: 'fs' } },
    });
    markOnboarded({ dataRoot: server.dataRoot });
    bootstrapCustomBackend({ dataRoot: server.dataRoot, baseURL: mock.baseURL });
    appendConnectionProfile({ dataRoot: server.dataRoot, baseURL: mock.baseURL });
    normalizeIterStudioSettings(server.dataRoot);
    writeWorldBook({ dataRoot: server.dataRoot, name: AUX_BOOK, entries: AUX_ENTRIES });
});

test.afterAll(async () => {

    await mock?.stop();
});

test.describe('#104 — CEA editor edit on an additional world book', () => {
    test('adding an entry keeps the existing entries and rollback restores the book', async ({ page }) => {
        const original = readBook(server.dataRoot);
        expect(Object.keys(original.entries)).toEqual(['0', '1']);

        await awaitMainUI(page, server.baseURL);
        await selectCharacterByName(page, 'Seraphina');
        await bindAdditionalLorebook(page, AUX_BOOK);

        await openIterStudio(page, 'cea');
        mock.scriptToolCall({
            name: 'cea_add_lorebook_entry',
            arguments: { book_name: AUX_BOOK, entry: NEW_ENTRY },
        });
        await sendIterPrompt(page, 'cea', 'Add the lantern-moss that marks the safe paths of the Eldoria wood to the wayfarers book.');
        await applyIterBatch(page, 'cea');

        await expect.poll(() => readBook(server.dataRoot).entries?.[String(NEW_UID)]?.content, { timeout: 15_000 })
            .toBe(NEW_ENTRY.content);
        const approved = readBook(server.dataRoot);
        expect(Object.keys(approved.entries).sort()).toEqual(['0', '1', String(NEW_UID)]);
        expect(approved.entries['0']).toEqual(original.entries['0']);
        expect(approved.entries['1']).toEqual(original.entries['1']);

        await rollbackIterBatch(page, 'cea');
        const popup = page.locator('.wbench .wb-win');
        await expect(popup.locator('.wb-chg.is-discarded .wb-chg-line')).toHaveCount(1, { timeout: 15_000 });
        await expect.poll(() => Object.keys(readBook(server.dataRoot).entries).sort(), { timeout: 15_000 })
            .toEqual(['0', '1']);
        const restored = readBook(server.dataRoot);
        expect(restored.entries['0']).toEqual(original.entries['0']);
        expect(restored.entries['1']).toEqual(original.entries['1']);

        await closeIterStudio(page);
    });

    test('an entry added to a world book that does not exist fails without creating the book', async ({ page }) => {
        const MISSING_BOOK = 'Eldoria Hinterlands';
        const FOLLOW_UP = 'The hinterlands have no book of their own yet, so the lantern-moss stays unrecorded for now.';
        const missingPath = resolve(server.dataRoot, 'default-user', 'worlds', `${MISSING_BOOK}.json`);
        const FINAL = 'Noted. The hinterlands entry waits until that book exists.';
        const requestMessages = [];
        mock.scriptCompletion(({ turn, body }) => {
            requestMessages.push(body?.messages || []);
            if (turn === 0) {
                return { tool: 'cea_add_lorebook_entry', arguments: { book_name: MISSING_BOOK, entry: NEW_ENTRY } };
            }
            return { text: turn === 1 ? FOLLOW_UP : FINAL };
        });

        await awaitMainUI(page, server.baseURL);
        await selectCharacterByName(page, 'Seraphina');
        await openIterStudio(page, 'cea');
        const popup = page.locator('.wbench .wb-win');
        const input = popup.locator('.wb-chat .wb-input');
        const send = popup.locator('.wb-chat .wb-send');
        await input.fill('Record the lantern-moss of the Eldoria hinterlands.');
        await send.click();
        await expect(popup).toContainText(FOLLOW_UP, { timeout: 30_000 });

        await expect(popup.locator('.wb-tool-sec-label.is-error')).toHaveCount(1);
        await expect(popup.locator('.wb-chg')).toHaveCount(0);
        expect(existsSync(missingPath)).toBe(false);

        // The next turn replays the failed call with its structured result.
        await input.fill('Leave the hinterlands for later.');
        await send.click();
        await expect(popup).toContainText(FINAL, { timeout: 30_000 });
        const toolMessage = requestMessages.at(-1).find(m => m?.role === 'tool');
        expect(JSON.parse(toolMessage.content)).toMatchObject({ ok: false, error: 'not_found' });
        expect(existsSync(missingPath)).toBe(false);

        mock.clearScriptedCompletion();
        await closeIterStudio(page);
    });
});
