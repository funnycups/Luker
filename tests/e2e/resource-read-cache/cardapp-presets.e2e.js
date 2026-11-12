import { test, expect } from '@playwright/test';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

import { write as writePngCard } from '../../../src/character-card-parser.js';
import { awaitMainUI } from '../_lib/page.js';
import { startServer, tearDownServer } from '../_lib/server.js';
import { openCharacterList } from '../_lib/ui-character.js';

const REPO_ROOT = resolve(import.meta.dirname, '../../..');
const CHARACTER_NAME = 'The Harbor Archivist';
const PRESET_NAME = 'Harbor Ledger';
const PRESET_BODY = {
    temperature: 0.37,
    top_p: 0.81,
    extensions: {
        harbor_ledger: { columns: ['departure', 'destination'], archived: true },
    },
};
const CARD_APP_ENTRY = `
export function init(ctx) {
    for (const [id, label, action] of [
        ['save', 'Save ledger preset', async () => {
            const saved = await ctx.lukerContext.presets.save(
                { collection: 'openai', name: ${JSON.stringify(PRESET_NAME)}, origin: { kind: 'global' } },
                ${JSON.stringify(PRESET_BODY)},
                { select: false },
            );
            return { ok: saved.ok, name: saved.ref?.name };
        }],
        ['list', 'List ledger presets', () => ctx.listPresetDocuments('openai')],
        ['read', 'Read ledger preset', () => ctx.readPresetDocument('openai', ${JSON.stringify(PRESET_NAME)})],
    ]) {
        const button = document.createElement('button');
        button.type = 'button';
        button.textContent = label;
        const output = document.createElement('pre');
        output.id = 'ledger-preset-' + id;
        button.addEventListener('click', async () => {
            output.textContent = '';
            try {
                output.textContent = JSON.stringify(await action());
            } catch (error) {
                output.textContent = JSON.stringify({ error: error.message });
            }
        });
        ctx.container.append(button, output);
    }
}
`;

let server;
let directory;
let cardPath;

test.beforeAll(async () => {
    directory = mkdtempSync(join(tmpdir(), 'luker-cardapp-presets-'));
    const dataRoot = join(directory, 'data');
    mkdirSync(dataRoot);
    server = await startServer({
        batchKey: 'server',
        scenarioId: 'cardapp-presets',
        useExistingDataRoot: dataRoot,
    });
    cardPath = join(directory, 'harbor-archivist.png');
    writeFileSync(cardPath, writePngCard(
        readFileSync(join(REPO_ROOT, 'default/content/default_Seraphina.png')),
        JSON.stringify({
            spec: 'chara_card_v2',
            spec_version: '2.0',
            data: {
                name: CHARACTER_NAME,
                description: 'Keeps the harbor records in a weathered ledger.',
                first_mes: 'The departures are ready to be recorded.',
                tags: [],
                extensions: {
                    card_app: { enabled: true, entry: 'index.js', files: { 'index.js': CARD_APP_ENTRY } },
                },
            },
        }),
    ));
});

test.afterAll(async () => {
    await tearDownServer(server);
    if (directory) rmSync(directory, { recursive: true, force: true });
});

async function openArchivist(page) {
    await openCharacterList(page);
    await page.locator('#rm_print_characters_block .character_select', { hasText: CHARACTER_NAME }).click();
    const drawer = page.locator('#rightNavDrawerIcon');
    if (await drawer.evaluate(element => element.classList.contains('openIcon'))) {
        await drawer.click();
    }
    await expect(page.getByRole('button', { name: 'Save ledger preset', exact: true })).toBeVisible();
}

test('CardApp buttons list and read persisted preset documents through the real context', async ({ page }) => {
    await awaitMainUI(page, server.baseURL);
    await openCharacterList(page);
    const chooser = page.waitForEvent('filechooser');
    await page.locator('#character_import_button').click();
    await (await chooser).setFiles(cardPath);
    await expect(page.locator('#rm_print_characters_block .character_select', { hasText: CHARACTER_NAME })).toBeVisible();
    await openArchivist(page);

    await page.getByRole('button', { name: 'Save ledger preset', exact: true }).click();
    await expect(page.locator('#ledger-preset-save')).toHaveText(JSON.stringify({ ok: true, name: PRESET_NAME }));
    const persisted = JSON.parse(readFileSync(
        join(server.dataRoot, 'default-user', 'OpenAI Settings', `${PRESET_NAME}.json`), 'utf8'));
    expect(persisted).toEqual(PRESET_BODY);

    // Start a new page lifecycle so the reads cannot use the save's live preset cache.
    await awaitMainUI(page, server.baseURL);
    await openArchivist(page);
    const requests = [];
    page.on('request', request => requests.push({ method: request.method(), url: new URL(request.url()) }));

    await page.getByRole('button', { name: 'List ledger presets', exact: true }).click();
    await page.getByRole('button', { name: 'Read ledger preset', exact: true }).click();
    const listing = page.locator('#ledger-preset-list');
    const document = page.locator('#ledger-preset-read');
    await expect(listing).not.toBeEmpty();
    await expect(document).not.toBeEmpty();
    expect({ list: JSON.parse(await listing.textContent()), read: JSON.parse(await document.textContent()) }).toEqual({
        list: expect.arrayContaining([PRESET_NAME]),
        read: PRESET_BODY,
    });
    for (const path of ['/api/presets/list', '/api/presets/get']) {
        expect(requests.some(request => request.method === 'GET'
            && request.url.pathname === path && request.url.searchParams.get('apiId') === 'openai')).toBe(true);
    }
});
