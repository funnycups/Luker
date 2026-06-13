// #18 — Import a byaf (Backyard Archive Format) character. BYAF is a
// zipped bundle with manifest.json + character + scenario JSON files +
// images. We fabricate a minimal layout that's enough to drive
// ByafParser.parse() to completion.

import { test, expect } from '@playwright/test';
import { resolve } from 'node:path';
import { readFileSync } from 'node:fs';
import AdmZip from 'adm-zip';
import { startServer, tearDownServer } from '../_lib/server.js';
import { startMockLLM } from '../_lib/mockLLM.js';
import { bootstrapCustomBackend, appendConnectionProfile, markOnboarded, listCharacters } from '../_lib/fixtures.js';
import { awaitMainUI, reloadAndAwait } from '../_lib/page.js';

let server, mock;

const REPO_ROOT = resolve(import.meta.dirname, '../../..');

const CHARACTER_NAME = 'Halden the Quill-Keeper';

const MANIFEST = {
    formatVersion: 1,
    characters: ['character/halden.json'],
    scenarios: ['scenario/library-stairwell.json'],
    author: { name: 'luker-e2e', backyardURL: '' },
};

const CHARACTER = {
    name: CHARACTER_NAME,
    displayName: CHARACTER_NAME,
    persona: 'A quiet archivist who keeps a wax-sealed ledger of every borrowed lantern in the harbor library.',
    isNSFW: false,
    images: [{ path: '../image/halden.png', label: '' }],
    loreItems: [
        { key: 'lantern ledger', value: 'The ledger records every lantern that ever left the library and the names of those who took them.' },
    ],
};

const SCENARIO = {
    narrative: 'You meet Halden at the foot of the library stairwell with a lantern that does not yet have an entry in the ledger.',
    firstMessages: [{ text: '*Halden taps the spine of his ledger with the back of a pen.* "If you brought that lantern in here, friend, it needs a name and a seal. Step closer to the lamp."' }],
    exampleMessages: [],
    formattingInstructions: 'You are Halden. Stay in scene. Reply with one or two paragraphs.',
    messages: [],
};

test.beforeAll(async () => {
    mock = await startMockLLM({});
    server = await startServer({ batchKey: 'character', scenarioId: 'import-byaf' });
    markOnboarded({ dataRoot: server.dataRoot });
    bootstrapCustomBackend({ dataRoot: server.dataRoot, baseURL: mock.baseURL });
    appendConnectionProfile({ dataRoot: server.dataRoot, baseURL: mock.baseURL });
});

test.afterAll(async () => {
    await tearDownServer(server);
    await mock?.stop();
});

test.describe('#18 — Import byaf character card', () => {
    test('byaf zip with manifest + character + scenario imports and persists', async ({ page }) => {
        // Build the byaf zip: manifest.json + character/<name>.json +
        // scenario/<name>.json + image/<name>.png.
        const iconPng = readFileSync(resolve(REPO_ROOT, 'default/content/default_Seraphina.png'));
        const zip = new AdmZip();
        zip.addFile('manifest.json', Buffer.from(JSON.stringify(MANIFEST), 'utf8'));
        zip.addFile('character/halden.json', Buffer.from(JSON.stringify(CHARACTER), 'utf8'));
        zip.addFile('scenario/library-stairwell.json', Buffer.from(JSON.stringify(SCENARIO), 'utf8'));
        zip.addFile('image/halden.png', iconPng);
        const byafBuf = zip.toBuffer();

        await awaitMainUI(page, server.baseURL);

        const importResult = await page.evaluate(async ({ b64, name }) => {
            const ctx = window.SillyTavern.getContext();
            const binary = atob(b64);
            const bytes = new Uint8Array(binary.length);
            for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
            const file = new File([bytes], `${name}.byaf`, { type: 'application/zip' });
            const form = new FormData();
            form.append('avatar', file);
            form.append('file_type', 'byaf');
            const headers = ctx.getRequestHeaders({ omitContentType: true });
            const res = await fetch('/api/characters/import', { method: 'POST', body: form, headers, cache: 'no-cache' });
            const text = await res.text();
            let data; try { data = JSON.parse(text); } catch { data = { rawText: text }; }
            return { ok: res.ok, status: res.status, data };
        }, { b64: byafBuf.toString('base64'), name: 'Halden' });

        // byaf import has more moving parts than the others — if it doesn't
        // complete in our minimal layout we'd rather record it as an expected
        // bug than fail noisily, but with the minimal scaffold above it
        // should land. Assert hard; fall back to a clear error if not.
        expect(importResult.ok, `byaf import failed: ${JSON.stringify(importResult.data)}`).toBe(true);
        expect(importResult.data?.error).toBeFalsy();
        expect(importResult.data?.file_name).toBeTruthy();

        const onDisk = listCharacters({ dataRoot: server.dataRoot });
        expect(onDisk.length).toBeGreaterThan(0);

        await page.evaluate(async () => {
            const mod = await import('/script.js');
            await mod.getCharacters();
        });
        await page.waitForFunction((name) => {
            const ctx = window.SillyTavern?.getContext?.();
            return !!ctx?.characters?.find?.(c => c?.name === name);
        }, CHARACTER_NAME, { timeout: 15_000 });

        const full = await page.evaluate(async (name) => {
            const ctx = window.SillyTavern.getContext();
            const shallow = ctx.characters.find(c => c?.name === name);
            const res = await fetch('/api/characters/get', {
                method: 'POST',
                headers: ctx.getRequestHeaders(),
                body: JSON.stringify({ avatar_url: shallow.avatar }),
                cache: 'no-cache',
            });
            const body = await res.json();
            return {
                description: body.description || body.data?.description || '',
                first_mes: body.first_mes || body.data?.first_mes || '',
                book: body.data?.character_book,
            };
        }, CHARACTER_NAME);
        expect(full.description).toContain('archivist');
        expect(full.first_mes).toContain('ledger');
        expect(full.book, 'character_book copied from loreItems').toBeTruthy();
        expect(full.book.entries.length).toBeGreaterThan(0);

        await server.restart();
        await reloadAndAwait(page, server.baseURL);

        const persisted = await page.evaluate(async (name) => {
            const ctx = window.SillyTavern.getContext();
            const shallow = ctx.characters.find(c => c?.name === name);
            if (!shallow) return null;
            const res = await fetch('/api/characters/get', {
                method: 'POST',
                headers: ctx.getRequestHeaders(),
                body: JSON.stringify({ avatar_url: shallow.avatar }),
                cache: 'no-cache',
            });
            const body = await res.json();
            return { description: body.description || body.data?.description || '' };
        }, CHARACTER_NAME);
        expect(persisted, 'Halden survived restart').toBeTruthy();
        expect(persisted.description).toContain('archivist');
    });
});
