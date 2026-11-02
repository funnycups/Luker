// A UI edit in each synced category marks the device dirty, so the idle
// sync carries it to the other device with no clicks.
//
// One pair of real servers: A syncs 2 s after each edit, B never syncs on
// its own. Every step is a real UI edit on A followed by a poll on B's
// data root. The dirty mark is per user, so each step also checks from A's
// responses that its own write set the mark that started the idle sync.
// The only mock is the upstream embedding API for vectors.

import { test, expect } from '@playwright/test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { startServer, tearDownServer } from '../_lib/server.js';
import { startMockLLM } from '../_lib/mockLLM.js';
import { awaitMainUI, selectCharacterByName, openExtensionsDrawer, openInlineDrawer, openUserSettingsDrawer, openTopDrawer, closeTopDrawer } from '../_lib/page.js';
import { createWorldBook, addWorldEntry } from '../_lib/ui-worldinfo.js';
import { importCharacterFile, openCharacterList } from '../_lib/ui-character.js';
import { writeCharacterPng } from '../groups/_helpers.js';
import { read as readPngCard, write as writePngCard } from '../../../src/character-card-parser.js';
import {
    openLanSyncPanel, generatePairingLink, acceptPairingLink, setSyncSchedule, closeAllPopups, openChatByName,
    readUserFile, userRootOf, waitForBackgroundSync, recordDirtyWrites, categoryStep,
} from '../_lib/sync.js';

const REPO_ROOT = path.resolve(import.meta.dirname, '../../..');
const CATEGORIES = ['worlds', 'characters', 'chats', 'backgrounds', 'image-metadata', 'stats', 'skills', 'card-apps', 'vectors'];
const listed = (server, rel) => {
    const dir = path.join(userRootOf(server), ...rel.split('/'));
    return fs.existsSync(dir) ? fs.readdirSync(dir, { recursive: true }).map(String) : [];
};
// Entries under `rel` on B that were not there before the step.
const added = (before, rel) => listed(B, rel).filter(entry => !before.includes(entry));
let A;
let B;
let mock;
let tmp;
let contexts = [];

test.beforeAll(async () => {
    mock = await startMockLLM({});
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'luker-e2e-dirty-'));
    A = await startServer({ batchKey: 'sync', scenarioId: 'dirty-A' });
    B = await startServer({ batchKey: 'sync', scenarioId: 'dirty-B' });
    for (const server of [A, B]) {
        writeCharacterPng({ dataRoot: server.dataRoot, avatarFile: 'Seraphina.png', card: { name: 'Seraphina', first_mes: 'Welcome back to the glade.' } });
        const chatDir = path.join(userRootOf(server), 'chats', 'Seraphina');
        fs.mkdirSync(chatDir, { recursive: true });
        fs.writeFileSync(path.join(chatDir, 'Dawn Patrol.jsonl'), [
            { user_name: 'User', character_name: 'Seraphina', create_date: '2026-10-01@10h00m00s', chat_metadata: { integrity: '2d3e4f5a-6b7c-4d8e-9f0a-1b2c3d4e5f6a' } },
            { name: 'Seraphina', is_user: false, mes: 'The patrol leaves at first light.', send_date: '2026-10-01@10h00m01s' },
            { name: 'User', is_user: true, mes: 'I will carry the lantern.', send_date: '2026-10-01@10h00m02s' },
        ].map(line => JSON.stringify(line)).join('\n'));
        fs.mkdirSync(path.join(userRootOf(server), 'groups'), { recursive: true });
        fs.writeFileSync(path.join(userRootOf(server), 'groups', 'g1.json'), JSON.stringify({
            id: 'g1', name: 'Glade Watch', members: ['Seraphina.png'], avatar_url: '', allow_self_responses: false,
            activation_strategy: 1, generation_mode: 0, disabled_members: [], chat_metadata: {}, fav: false, chat_id: 'gc1', chats: ['gc1'], auto_mode_delay: 5,
        }, null, 4));
    }
});

test.afterAll(async () => {
    for (const ctx of contexts) await ctx.close();
    await tearDownServer(A);
    await tearDownServer(B);
    await mock.stop();
    fs.rmSync(tmp, { recursive: true, force: true });
});

// A's idle delay; client saves debounce for at most `debounce_timeout.relaxed` (1 s).
const IDLE_SECONDS = 2;

test('a UI edit in each covered category reaches the other device after the idle delay', async ({ browser }) => {
    // Playwright budget for sequential sync round trips across every category.
    test.setTimeout(10 * 60_000);
    const ctxA = await browser.newContext();
    const ctxB = await browser.newContext();
    contexts = [ctxA, ctxB];
    const pageA = await ctxA.newPage();
    const pageB = await ctxB.newPage();
    await awaitMainUI(pageA, A.baseURL);
    await awaitMainUI(pageB, B.baseURL);
    await openTopDrawer(pageA, 'sys-settings-button');
    await pageA.locator('.connection_profile_mode_tab[data-mode="embed"]').click();
    await pageA.locator('#create_embedding_profile').click();
    const embedding = pageA.locator('#connection_profile_embed_editor');
    await embedding.locator('[data-field="name"]').fill('Sync embedding fixture');
    await embedding.locator('[data-field="name"]').blur();
    await embedding.locator('[data-field="source"]').selectOption('openai');
    await embedding.locator('[data-field="model"]').fill('mock-embed');
    await embedding.locator('[data-field="model"]').blur();
    await embedding.locator('[data-field="api-url"]').fill(mock.baseURL);
    await embedding.locator('[data-field="api-url"]').blur();
    await embedding.locator('[data-field="proxy-password"]').fill('mock-embed-key');
    await embedding.locator('[data-field="proxy-password"]').blur();
    await closeTopDrawer(pageA, 'sys-settings-button');
    await openExtensionsDrawer(pageA);
    await openInlineDrawer(pageA, 'vectors_container');
    await pageA.locator('#vectors_embedding_profile').selectOption({ label: 'Sync embedding fixture' });
    await closeTopDrawer(pageA, 'extensions-settings-button');
    const pairedSince = Date.now();
    await openLanSyncPanel(pageA);
    const link = await generatePairingLink(pageA, { label: 'B device', categories: CATEGORIES });
    await openLanSyncPanel(pageB);
    expect(await acceptPairingLink(pageB, link, { categories: CATEGORIES, localLabel: 'A device' })).toBe('success');
    await setSyncSchedule(pageB, { idleSeconds: 3600, pollSeconds: 3600 });
    await closeAllPopups(pageA);
    await openLanSyncPanel(pageA);
    await setSyncSchedule(pageA, { idleSeconds: IDLE_SECONDS, pollSeconds: 3600 });
    await closeAllPopups(pageA);
    await closeAllPopups(pageB);
    await waitForBackgroundSync(pageA, { since: pairedSince });
    await waitForBackgroundSync(pageB, { since: pairedSince });

    const writes = recordDirtyWrites(pageA);
    const step = categoryStep(pageA, writes, { idleMs: IDLE_SECONDS * 1000 });

    // Creating a book also saves the settings, so the step adds an entry to it.
    await step('worlds', {
        ownRoute: /^\/api\/worldinfo\/patch\/?$/,
        prepare: () => createWorldBook(pageA, 'Dawn Notes'),
        edit: () => addWorldEntry(pageA, { content: 'The patrol crosses the ford at first light.' }),
        arrived: () => (readUserFile(B, 'worlds/Dawn Notes.json') ?? '').includes('crosses the ford'),
    });

    // Saving a character in the editor also saves its chat and the
    // settings, so the step imports a character.
    const larkCard = { name: 'Lark', description: 'A scout who maps the eastern ridge.', first_mes: 'The ridge is clear.', tags: [] };
    const lark = path.join(tmp, 'lark.png');
    fs.writeFileSync(lark, writePngCard(fs.readFileSync(path.join(REPO_ROOT, 'default/content/default_Seraphina.png')), JSON.stringify({ spec: 'chara_card_v2', spec_version: '2.0', ...larkCard, data: larkCard })));
    await step('characters', {
        ownRoute: /^\/api\/characters\/import\/?$/,
        prepare: () => openCharacterList(pageA),
        edit: () => importCharacterFile(pageA, { filePath: lark, expectedName: 'Lark' }),
        arrived: () => {
            const file = path.join(userRootOf(B), 'characters', 'Lark.png');
            return fs.existsSync(file) && readPngCard(fs.readFileSync(file)).includes('eastern ridge');
        },
    });

    await step('groups', {
        ownRoute: /^\/api\/groups\/edit\/?$/,
        prepare: async () => {
            await openCharacterList(pageA);
            await pageA.locator('#rm_print_characters_block .group_select', { hasText: 'Glade Watch' }).click();
            await pageA.waitForFunction(() => window.Luker.getContext().getCurrentChatId() === 'gc1', null, { timeout: 30_000 });
        },
        edit: () => pageA.locator('#rm_group_chat_name').fill('Glade Watch at Dawn'),
        arrived: () => (readUserFile(B, 'groups/g1.json') ?? '').includes('Glade Watch at Dawn'),
    });

    const bg = path.join(tmp, 'dawn-glade.png');
    fs.copyFileSync(path.join(REPO_ROOT, 'default/content/default_Seraphina.png'), bg);
    // An upload also makes the image the current background and saves the
    // settings, so the step renames an uploaded image.
    await step('backgrounds', {
        ownRoute: /^\/api\/backgrounds\/rename\/?$/,
        prepare: async () => {
            await pageA.locator('#add_bg_button').setInputFiles(bg);
            await pageA.locator('#backgrounds-drawer-toggle').click();
            await pageA.locator('#bg_menu_content .bg_example[bgfile="dawn-glade.png"]').waitFor({ state: 'visible' });
        },
        edit: async () => {
            const tile = pageA.locator('#bg_menu_content .bg_example[bgfile="dawn-glade.png"]');
            await tile.hover();
            await tile.locator('.jg-edit').click();
            const renamePopup = pageA.locator('dialog.popup[open]', { hasText: 'Enter new background name' });
            await renamePopup.locator('.popup-input').fill('dawn-meadow');
            await renamePopup.locator('.popup-button-ok').click();
        },
        arrived: () => fs.existsSync(path.join(userRootOf(B), 'backgrounds', 'dawn-meadow.png')) && !fs.existsSync(path.join(userRootOf(B), 'backgrounds', 'dawn-glade.png')),
    });

    await step('image-metadata', {
        ownRoute: /^\/api\/image-metadata\/folders\/create\/?$/,
        edit: async () => {
            await pageA.locator('#bg_add_folder_button').click();
            const folderPopup = pageA.locator('dialog.popup[open]', { hasText: 'Enter folder name' });
            await folderPopup.locator('.popup-input').fill('Dawn Skies');
            await folderPopup.locator('.popup-button-ok').click();
        },
        arrived: () => (readUserFile(B, 'image-metadata.json') ?? '').includes('Dawn Skies'),
    });

    const statsBefore = readUserFile(B, 'stats.json');
    await step('stats', {
        ownRoute: /^\/api\/stats\/recreate\/?$/,
        prepare: async () => {
            await openUserSettingsDrawer(pageA);
            await pageA.locator('#debug_menu').click();
        },
        edit: () => pageA.locator('#debug_table [data-debug-function="refreshStats"]').click(),
        arrived: () => {
            const stats = readUserFile(B, 'stats.json');
            return stats !== statsBefore && stats === readUserFile(A, 'stats.json');
        },
    });
    await closeAllPopups(pageA);

    // Both installs hold the bundled skills from first use, so a new skill is the edit.
    const skillPrompt = text => pageA.locator('dialog.popup[open]', { hasText: text });
    await step('skills', {
        ownRoute: /^\/api\/skills\/global\/?$/,
        prepare: async () => {
            await openExtensionsDrawer(pageA);
            await openInlineDrawer(pageA, 'orchestrator_settings');
            await pageA.locator('#orchestrator_settings [data-luker-action="manage-skills"]:visible').first().click();
            await pageA.locator('.popup .luker_skill_manager [data-skill-toolbar="create"]').click();
            await skillPrompt('Skill name').locator('.popup-input').fill('dawn-watch');
            await skillPrompt('Skill name').locator('.popup-button-ok').click();
            await skillPrompt('One-line description').locator('.popup-input').fill('Use when the dawn patrol sets out.');
            await skillPrompt('One-line description').locator('.popup-button-ok').click();
            await skillPrompt('Install new skill into scope').waitFor({ state: 'visible' });
        },
        edit: () => skillPrompt('Install new skill into scope').locator('.popup-button-ok').click(),
        arrived: () => readUserFile(B, 'skills/global/dawn-watch/SKILL.md') !== null,
    });
    await closeAllPopups(pageA);

    const v2 = {
        name: 'Wren', description: 'A tidewright who reads the western channel.', first_mes: 'The tide is turning.', tags: [],
        extensions: { card_app: { enabled: true, entry: 'index.js', files: { 'index.js': 'export function init() {}\n' } } },
    };
    const card = path.join(tmp, 'wren.png');
    fs.writeFileSync(card, writePngCard(fs.readFileSync(path.join(REPO_ROOT, 'default/content/default_Seraphina.png')), JSON.stringify({ spec: 'chara_card_v2', spec_version: '2.0', ...v2, data: v2 })));
    const cardAppsBefore = listed(B, 'card-apps');
    await step('card-apps', {
        ownRoute: /^\/api\/characters\/import\/?$/,
        prepare: () => openCharacterList(pageA),
        edit: () => importCharacterFile(pageA, { filePath: card, expectedName: 'Wren' }),
        arrived: () => added(cardAppsBefore, 'card-apps').length > 0,
    });

    const vectorsBefore = listed(B, 'vectors');
    await step('vectors', {
        ownRoute: /^\/api\/vector\/insert\/?$/,
        prepare: async () => {
            await selectCharacterByName(pageA, 'Seraphina');
            await openChatByName(pageA, 'Dawn Patrol');
            await openExtensionsDrawer(pageA);
            await openInlineDrawer(pageA, 'vectors_container');
            await pageA.locator('#vectors_enabled_chats').check();
        },
        edit: () => pageA.locator('#vectors_vectorize_all').click(),
        arrived: () => added(vectorsBefore, 'vectors').length > 0,
    });
});
