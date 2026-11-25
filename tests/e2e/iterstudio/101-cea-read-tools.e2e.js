// #101 — CEA editor iter-studio: lorebook read tools run through the shared
// iteration-library executor.
//
// The model calls world_book_list, then lorebook_query against the book bound
// to Seraphina. Both calls dispatch through runCeaEditorReadTool →
// runLorebookReadTool; the results render in the tool-call chips and reach
// the model as role:'tool' messages on the following request.
//
// Real UI/gestures: Extensions drawer → CEA inline-drawer → "Open Editor" →
// type into the composer → Send. mockLLM scripts the tool calls.

import { test, expect } from '../../harness/playwright.js';
import { readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { startServer } from '../../harness/server.js';
import { startMockLLM } from '../_lib/mockLLM.js';
import { bootstrapCustomBackend, appendConnectionProfile, markOnboarded } from '../_lib/fixtures.js';
import { awaitMainUI, openExtensionsDrawer, openInlineDrawer, selectCharacterByName } from '../_lib/page.js';
import { openIterStudio, closeIterStudio } from '../_lib/ui-iter-studio.js';
import { normalizeIterStudioSettings } from '../preset/_helpers.js';
import { takeDocScreenshot } from '../_lib/doc-screenshots.js';

const REPO_ROOT = resolve(import.meta.dirname, '../../..');

const BOOK_NAME = 'Eldoria';
const SHADOWFANG_UID = 1;

function settingsJsonPath(dataRoot) {
    return resolve(dataRoot, 'default-user', 'settings.json');
}

function readCeaSettings(dataRoot) {
    const settings = JSON.parse(readFileSync(settingsJsonPath(dataRoot), 'utf8'));
    return settings?.extension_settings?.character_editor_assistant || {};
}

let server, mock;

test.beforeAll(async ({ workerResources }, testInfo) => {
    const scope = await workerResources.scenario(testInfo.file);
    mock = await startMockLLM({});
    server = await startServer({ scope,
        batchKey: 'iterstudio',
        scenarioId: '101-cea-read-tools',
        extraConfig: { storage: { mode: 'fs' } },
    });
    markOnboarded({ dataRoot: server.dataRoot });
    bootstrapCustomBackend({ dataRoot: server.dataRoot, baseURL: mock.baseURL });
    appendConnectionProfile({ dataRoot: server.dataRoot, baseURL: mock.baseURL });
    normalizeIterStudioSettings(server.dataRoot);

    // An upgraded profile still carries the retired journal-size setting.
    const settingsPath = settingsJsonPath(server.dataRoot);
    const settings = JSON.parse(readFileSync(settingsPath, 'utf8'));
    settings.extension_settings = settings.extension_settings || {};
    settings.extension_settings.character_editor_assistant = {
        ...(settings.extension_settings.character_editor_assistant || {}),
        maxJournalEntries: 120,
    };
    writeFileSync(settingsPath, JSON.stringify(settings, null, 4));
});

test.afterAll(async () => {

    await mock?.stop();
});

/** Parse the actual Workbench tool-result text in execution order. */
async function readToolResultPayloads(page) {
    return page.evaluate(() => {
        return Array.from(document.querySelectorAll('.wbench .wb-tool-entry'))
            .map(entry => JSON.parse(entry.querySelector('pre:last-child').textContent));
    });
}

/** CEA editor requests are the chat/completions calls that offer `lorebook_query`. */
function ceaEditorRequests() {
    return mock.requests.filter((r) => String(r.url || '').includes('chat/completions')
        && (Array.isArray(r.body?.tools) ? r.body.tools : [])
            .some((t) => String(t?.function?.name || '') === 'lorebook_query'));
}

function toolMessagePayloads(request) {
    const messages = Array.isArray(request?.body?.messages) ? request.body.messages : [];
    return messages
        .filter((m) => m?.role === 'tool')
        .map((m) => {
            try { return JSON.parse(typeof m.content === 'string' ? m.content : ''); } catch { return null; }
        })
        .filter(Boolean);
}

test.describe('#101 — CEA editor read tools via the shared lorebook executor', () => {
    test('world_book_list and lorebook_query resolve the bound book and reach the next request', async ({ page }) => {
        await awaitMainUI(page, server.baseURL);
        await selectCharacterByName(page, 'Seraphina');
        await openIterStudio(page, 'cea');

        mock.scriptToolCall({ name: 'world_book_list', arguments: {} });
        mock.scriptToolCall({ name: 'lorebook_query', arguments: { book_name: BOOK_NAME, text: 'shadowfang' } });

        const popup = page.locator('.wbench .wb-win');
        await popup.locator('.wb-chat .wb-input')
            .fill('Which world books does Seraphina carry, and what does her lore say about the Shadowfangs?');
        const sendBtn = popup.locator('.wb-chat .wb-send');
        await sendBtn.click();

        // Two read rounds, then the mock's plain-text echo ends the loop.
        await expect.poll(async () => (await readToolResultPayloads(page)).length, { timeout: 60_000 }).toBe(2);
        await expect.poll(async () => ((await sendBtn.textContent()) || '').trim(), { timeout: 60_000 }).not.toMatch(/^stop$/i);
        await popup.locator('.wb-tool-trace > summary').click();
        await expect(popup.locator('.wb-tool-entry pre:last-child').first()).toBeVisible();

        const [bookList, query] = await readToolResultPayloads(page);
        expect(bookList.books).toContain(BOOK_NAME);
        expect(bookList.sources[BOOK_NAME]).toBe('character');
        expect(query.book_name).toBe(BOOK_NAME);
        expect(query.total_hits).toBeGreaterThanOrEqual(1);
        expect(query.entries[0].uid).toBe(SHADOWFANG_UID);
        expect(query.entries[0].match_fields).toEqual(expect.arrayContaining(['comment', 'key']));

        const requests = ceaEditorRequests();
        expect(requests.length).toBeGreaterThanOrEqual(3);
        expect(toolMessagePayloads(requests[requests.length - 1])).toEqual(expect.arrayContaining([
            expect.objectContaining({ books: expect.arrayContaining([BOOK_NAME]) }),
            expect.objectContaining({ book_name: BOOK_NAME, total_hits: query.total_hits }),
        ]));

        await closeIterStudio(page);
    });

    test('settings panel has no modification history block and drops the retired journal setting', async ({ page }) => {
        await awaitMainUI(page, server.baseURL);
        await openExtensionsDrawer(page);
        await openInlineDrawer(page, 'character_editor_assistant_settings');

        const panel = page.locator('#character_editor_assistant_settings');
        await expect(panel.locator('#cea_sync_llm_preset')).toBeVisible();
        await expect(panel.locator('#cea_history')).toHaveCount(0);
        await expect(panel.locator('#cea_refresh')).toHaveCount(0);
        await expect(panel.locator('#cea_status')).toHaveCount(0);

        // A real settings change persists the CEA block without the retired key.
        const retries = panel.locator('#cea_tool_retries');
        await retries.fill('4');
        await retries.press('Tab');
        await expect.poll(() => readCeaSettings(server.dataRoot).toolCallRetryMax, { timeout: 15_000 }).toBe(4);
        expect(Object.hasOwn(readCeaSettings(server.dataRoot), 'maxJournalEntries')).toBe(false);

        await takeDocScreenshot(panel.locator('.inline-drawer').first(), resolve(REPO_ROOT, 'docs/public/images/card-editor-popup/cea-extensions-panel.png'));
    });

    test('a settings save while the retries field is being edited keeps the typed value', async ({ page }) => {
        await awaitMainUI(page, server.baseURL);
        await openExtensionsDrawer(page);
        await openInlineDrawer(page, 'character_editor_assistant_settings');

        const panel = page.locator('#character_editor_assistant_settings');
        const retries = panel.locator('#cea_tool_retries');
        const llmPreset = panel.locator('#cea_sync_llm_preset');
        await expect(llmPreset).toBeVisible();
        const presetValues = await llmPreset.locator('option').evaluateAll(options => options.map(o => o.value));
        const presetName = presetValues.find(Boolean);
        expect(presetName).toBeTruthy();

        // Type a new retry count but do not leave the field yet.
        await retries.click();
        await retries.fill('7');
        await expect(retries).toBeFocused();

        // Another control saves settings meanwhile; the save emits
        // SETTINGS_UPDATED, which refreshes the panel.
        const saved = page.waitForResponse(r => /\/api\/settings\/(save|patch)$/.test(new URL(r.url()).pathname) && r.ok());
        await llmPreset.selectOption(presetName);
        await saved;
        await expect.poll(() => readCeaSettings(server.dataRoot).requestLlmPresetName, { timeout: 15_000 }).toBe(presetName);
        await page.evaluate(() => new Promise(r => requestAnimationFrame(() => requestAnimationFrame(r))));
        await expect(retries).toBeFocused();

        await retries.press('Tab');
        await expect(retries).toHaveValue('7');
        await expect.poll(() => readCeaSettings(server.dataRoot).toolCallRetryMax, { timeout: 15_000 }).toBe(7);
    });
});
