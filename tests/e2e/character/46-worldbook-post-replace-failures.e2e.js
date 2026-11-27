import { test as base, expect } from '../../harness/playwright.js';
import { chmodSync, existsSync, readFileSync, renameSync, statSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { createHash } from 'node:crypto';
import { startServer } from '../../harness/server.js';
import { startMockLLM } from '../_lib/mockLLM.js';
import { appendConnectionProfile, bootstrapCustomBackend, markOnboarded, writeWorldBook } from '../_lib/fixtures.js';
import { awaitMainUI, closeAnyOpenTopSettingsDrawer, selectCharacterByName } from '../_lib/page.js';
import { closeWorkbench } from '../_lib/ui-workbench.js';
import { writeEmbeddedCharacter } from './_helpers.js';
import { read as readPngCard, write as writePngCard } from '../../../src/character-card-parser.js';
import { makeTempMysqlEngineHarness } from '../../storage/harness/mysql-harness.js';
import { makeTempPgEngineHarness } from '../../storage/harness/pg-harness.js';
import { WorldInfoRepo } from '../../../src/storage/repositories/world-info-repo.js';
import { SettingsRepo } from '../../../src/storage/repositories/settings-repo.js';
import { holdWorldRow } from '../../storage/harness/world-row-lock.js';

const AVATAR = 'replace-world-ledger.png';
const OTHER = 'replace-world-other.png';
const NAME = 'Keeper of the Replace Ledger';
const OTHER_NAME = 'Keeper of the Untouched Replace Ledger';
const OLD = 'replace-ledger-old';
const IMPORTED = 'replace-ledger-imported';
const BOOK = { name: IMPORTED, extensions: {}, entries: [{ id: 9, uid: 9, keys: ['bell'], content: 'The bell marks the fourth watch.', enabled: true, insertion_order: 61, extensions: {} }] };
const test = base.extend({ embeddedBook: [BOOK, { option: true }], storageMode: ['fs', { option: true }] });
const IMPORTED_BOOK = { originalData: BOOK, entries: { '9': {
    uid: 9, key: ['bell'], keysecondary: [], comment: '', content: 'The bell marks the fourth watch.',
    constant: false, vectorized: false, selective: false, selectiveLogic: 0, addMemo: false, order: 61, position: 1,
    disable: false, ignoreBudget: false, excludeRecursion: false, preventRecursion: false,
    matchPersonaDescription: false, matchCharacterDescription: false, matchCharacterPersonality: false, matchCharacterDepthPrompt: false, matchScenario: false, matchCreatorNotes: false,
    delayUntilRecursion: false, probability: 100, useProbability: true, depth: 4, outletName: '', group: '', groupOverride: false, groupWeight: 100,
    scanDepth: null, caseSensitive: null, matchWholeWords: null, useGroupScoring: null, automationId: '', role: 0, sticky: null, cooldown: null, delay: null,
    triggers: [], displayIndex: 0, extensions: {},
} } };
const EDITED_CONTENT = 'The external editor retained the winter ledger.';
const EDITED_BOOK = {
    entries: { '9': { ...IMPORTED_BOOK.entries['9'], content: EDITED_CONTENT, addMemo: true, selective: true, role: null, sticky: 0, cooldown: 0, delay: 0 } },
    originalData: { ...BOOK, entries: [{ ...BOOK.entries[0], content: EDITED_CONTENT, comment: '', constant: false, selective: true, selectiveLogic: 0, position: 'after_char', extensions: {
        triggers: [], automation_id: '', case_sensitive: null, cooldown: 0, delay: 0, delay_until_recursion: false, depth: 4, exclude_recursion: false,
        group: '', group_override: false, group_weight: 100, ignore_budget: false,
        match_character_depth_prompt: false, match_character_description: false, match_character_personality: false, match_creator_notes: false,
        match_persona_description: false, match_scenario: false, match_whole_words: null, outlet_name: '', position: 1,
        prevent_recursion: false, probability: 100, role: null, scan_depth: null, sticky: 0, use_group_scoring: null, vectorized: false,
    } }] },
};
const EXT = { world: '', fav: false, talkativeness: 0.5, depth_prompt: { prompt: '', depth: 4, role: 'system' }, retained: { source: 'replacement', ledger: ['keep'] } };
const OTHER_EXT = { world: '', retained: { source: 'other', ledger: ['untouched'] } };
let server, incoming, mock, responses, database;
const path = (avatar = AVATAR) => resolve(server.dataRoot, 'default-user', 'characters', avatar);
const decode = bytes => JSON.parse(readPngCard(bytes)).data;

test.beforeAll(async () => { mock = await startMockLLM({}); });
test.afterAll(async () => { await mock.stop(); });

test.beforeEach(async ({ resources, page, context, embeddedBook, storageMode }) => {
    database = storageMode === 'mysql' ? await makeTempMysqlEngineHarness({ scope: resources }) : storageMode === 'postgres' ? await makeTempPgEngineHarness({ scope: resources }) : null;
    const extraConfig = { storage: { mode: storageMode } };
    if (database) {
        await database.engine.ping(database.handle);
        extraConfig.storage[storageMode] = { url: database.url };
    }
    server = await startServer({ scope: resources, batchKey: 'character', scenarioId: '46-world-replace-failure', extraConfig });
    markOnboarded({ dataRoot: server.dataRoot });
    bootstrapCustomBackend({ dataRoot: server.dataRoot, baseURL: mock.baseURL, storageMode });
    appendConnectionProfile({ dataRoot: server.dataRoot, baseURL: mock.baseURL });
    responses = [];
    page.on('response', response => {
        if (/\/api\/(characters\/merge-attributes|worldinfo\/(delete|edit|patch))$/.test(response.url())) responses.push({ url: response.url(), body: response.request().postDataJSON(), status: response.status(), characterVersion: response.headers()['x-character-version'], worldVersion: response.headers()['x-world-version'] });
    });
    // Immutable preload configuration: the replacement still uses its real
    // world-book decision popup, without an unrelated tag-import confirmation.
    const settingsPath = resolve(server.dataRoot, 'default-user', 'settings.json'); const settings = JSON.parse(readFileSync(settingsPath, 'utf8'));
    settings.power_user ??= {}; settings.power_user.tag_import_setting = 2; delete settings.power_user.import_card_tags;
    settings.world_info_settings = { ...settings.world_info_settings, world_info: { ...(settings.world_info_settings?.world_info ?? settings.world_info ?? {}), globalSelect: [], charLore: [], retained: { sibling: ['settings'] } } };
    writeFileSync(settingsPath, JSON.stringify(settings));
    if (database) await new SettingsRepo({ engine: database.engine }).save('default-user', settings);
    writeWorldBook({ dataRoot: server.dataRoot, name: OLD, entries: [{ key: ['old'], content: 'The old ledger remains intact.' }] });
    if (database) await new WorldInfoRepo({ engine: database.engine }).save('default-user', OLD, JSON.parse(readFileSync(resolve(server.dataRoot, 'default-user', 'worlds', OLD + '.json'), 'utf8')));
    writeEmbeddedCharacter({ dataRoot: server.dataRoot, avatarFile: AVATAR, overrides: { name: NAME, extensions: { ...EXT, world: OLD } } });
    writeEmbeddedCharacter({ dataRoot: server.dataRoot, avatarFile: OTHER, overrides: { name: OTHER_NAME, extensions: OTHER_EXT } });
    const bytes = readFileSync(path()); const card = JSON.parse(readPngCard(bytes)); card.data.extensions = EXT; card.data.character_book = embeddedBook;
    incoming = resolve(server.dataRoot, 'incoming-ledger.png'); writeFileSync(incoming, writePngCard(bytes, JSON.stringify(card)));
    await context.addInitScript(() => {
        window.replaceWorldEvents = [];
        window.worldSettingsAckEvents = [];
        document.addEventListener('DOMContentLoaded', () => import('/scripts/events.js').then(({ eventSource, event_types }) => {
            eventSource.on(event_types.APP_READY, () => {
                window.jQuery(document).on('change.replaceWorldProbe', '#character_world', () => window.replaceWorldEvents.push({ type: 'control', value: document.querySelector('#character_world').value }));
                eventSource.on(event_types.WORLDINFO_UPDATED, name => window.replaceWorldEvents.push({ type: 'book', name }));
                eventSource.on(event_types.CHARACTER_REPLACED, event => window.replaceWorldEvents.push({ type: 'replaced', avatar: event.detail.character.avatar, world: event.detail.character.data.extensions.world }));
                eventSource.on(event_types.SETTINGS_UPDATED, async () => {
                    const { settings } = await import('/script.js');
                    window.worldSettingsAckEvents.push(JSON.parse(JSON.stringify(settings.world_info_settings.world_info)));
                });
            });
        }));
    });
    await awaitMainUI(page, server.baseURL);
    await selectCharacterByName(page, OTHER_NAME); await expect(page.locator('#character_name_pole')).toHaveValue(OTHER_NAME);
    await selectCharacterByName(page, NAME); await expect(page.locator('#character_name_pole')).toHaveValue(NAME);
    await page.locator('#rightNavDrawerIcon').click();
});

test.afterEach(async ({}, testInfo) => {
    try { const path = testInfo.outputPath('world-replace-responses.json'); writeFileSync(path, JSON.stringify(responses, null, 2)); await testInfo.attach('world-replace-responses', { path, contentType: 'application/json' }); }
    finally { if (database) await database.cleanup(); }
});

async function replace(page) {
    const drawer = page.locator('#rightNavDrawerIcon');
    if (await drawer.evaluate(element => element.classList.contains('closedIcon'))) await drawer.click();
    const select = page.locator('#char-management-dropdown');
    const index = await select.locator('option').evaluateAll(options => options.findIndex(o => o.id === 'replace_update'));
    await select.selectOption({ index });
    const chooser = page.waitForEvent('filechooser');
    await page.locator('dialog[open] .popup-button-custom', { hasText: /Replace with File|用文件替换|用檔案替換/ }).click();
    await (await chooser).setFiles(incoming);
    const choice = page.locator('dialog[open]', { hasText: /Replace: what should happen to the world book\?|替换角色卡：要如何处理世界书？|替換角色卡：要如何處理世界書？/ }); await expect(choice).toBeVisible();
    expect(decode(readFileSync(path())).extensions).toEqual(EXT);
    return choice;
}

async function assertSelected(page, expected, events, book = BOOK) {
    const state = await page.evaluate(avatar => {
        const ctx = window.Luker.getContext(); const a = ctx.characters.find(c => c.avatar === avatar);
        return { data: a.data.extensions, json: JSON.parse(a.json_data).data.extensions, editor: JSON.parse(document.querySelector('#character_json_data').value).data.extensions, book: a.data.character_book, field: document.querySelector('#character_world').value, bound: document.querySelector('#world_button').classList.contains('world_set'), menuBound: document.querySelector('#set_character_world').classList.contains('world_set'), selected: ctx.characters[ctx.characterId].avatar, events: window.replaceWorldEvents };
    }, AVATAR);
    expect(state).toEqual({ data: expected, json: expected, editor: expected, book, field: expected.world, bound: !!expected.world, menuBound: !!expected.world, selected: AVATAR, events });
}

async function assertOtherAndReturn(page, expected, events, book = BOOK) {
    // Replacement refreshes the list with shallow cards. Hydrate the other
    // fixture through real selection before comparing its complete mirrors.
    await selectCharacterByName(page, OTHER_NAME); await expect(page.locator('#character_name_pole')).toHaveValue(OTHER_NAME);
    const other = await page.evaluate(avatar => {
        const ctx = window.Luker.getContext(); const card = ctx.characters.find(c => c.avatar === avatar);
        return { data: card.data.extensions, json: JSON.parse(card.json_data).data.extensions, editor: JSON.parse(document.querySelector('#character_json_data').value).data.extensions };
    }, OTHER);
    expect(other).toEqual({ data: OTHER_EXT, json: OTHER_EXT, editor: OTHER_EXT });
    expect(decode(readFileSync(path(OTHER))).extensions).toEqual(OTHER_EXT);
    await selectCharacterByName(page, NAME); await expect(page.locator('#character_name_pole')).toHaveValue(NAME);
    await assertSelected(page, expected, events, book);
}

async function cleanupState(page) {
    return page.evaluate(async () => {
        const ctx = window.Luker.getContext(); const card = ctx.characters[ctx.characterId];
        return {
            avatar: card.avatar, live: card.data, json: JSON.parse(card.json_data).data,
            editor: JSON.parse(document.querySelector('#character_json_data').value).data,
            form: document.querySelector('#character_world').value,
            bound: document.querySelector('#world_button').classList.contains('world_set'),
            menuBound: document.querySelector('#set_character_world').classList.contains('world_set'),
            settings: (await import('/scripts/world-info.js')).world_info,
            events: window.replaceWorldEvents,
            listed: ctx.getWorldInfoNames(),
        };
    });
}

async function selectWorldInEditor(other, worldName) {
    const icon = other.locator('#WIDrawerIcon');
    if (await icon.evaluate(element => element.classList.contains('closedIcon'))) await icon.click();
    const select = other.locator('#world_editor_select');
    await expect(select).toBeVisible();
    await select.selectOption({ label: worldName });
}

async function openWorldDialogForCharacter(other, charName) {
    await selectCharacterByName(other, charName);
    await expect(other.locator('#character_name_pole')).toHaveValue(charName);
    const drawer = other.locator('#rightNavDrawerIcon');
    if (await drawer.evaluate(element => element.classList.contains('closedIcon'))) await drawer.click();
    await other.locator('#world_button').click({ modifiers: ['Shift'] });
    // Popup binds primarySelect/extrasSelect change listeners inside onOpen,
    // which fires only after the opening animation removes [opening] and initializes select2.
    const dialog = other.locator('dialog[open]:not([opening])', { has: other.locator('.character_world_info_selector') });
    await expect(dialog).toBeVisible();
    await expect(dialog.locator('.character_extra_world_info_selector + .select2')).toBeVisible();
    return dialog;
}

async function adoptPrimaryInUI(other, charName, worldName = IMPORTED) {
    const dialog = await openWorldDialogForCharacter(other, charName);
    const saved = other.waitForResponse(response => response.url().endsWith('/api/characters/merge-attributes') && response.request().postDataJSON()?.data?.extensions?.world === worldName);
    await dialog.locator('.character_world_info_selector').selectOption({ label: worldName });
    expect((await saved).ok()).toBe(true);
    await dialog.locator('.popup-button-ok').click();
    await expect(dialog).toHaveCount(0);
}

async function rebindSameNameInUI(other) {
    const dialog = await openWorldDialogForCharacter(other, NAME);
    const cleared = other.waitForResponse(response => response.url().endsWith('/api/characters/merge-attributes') && response.request().postDataJSON()?.data?.extensions?.world === '');
    await dialog.locator('.character_world_info_selector').selectOption('');
    expect((await cleared).ok()).toBe(true);
    const rebound = other.waitForResponse(response => response.url().endsWith('/api/characters/merge-attributes') && response.request().postDataJSON()?.data?.extensions?.world === IMPORTED);
    await dialog.locator('.character_world_info_selector').selectOption({ label: IMPORTED });
    expect((await rebound).ok()).toBe(true);
    await dialog.locator('.popup-button-ok').click();
    await expect(dialog).toHaveCount(0);
}

async function deleteBookInUI(other, worldName = IMPORTED) {
    await selectWorldInEditor(other, worldName);
    const deleted = other.waitForResponse(response => response.url().endsWith('/api/worldinfo/delete') && response.request().postDataJSON()?.name === worldName);
    await other.locator('#world_popup_delete').click();
    const confirm = other.locator('dialog[open] .popup-button-ok').last();
    await expect(confirm).toBeVisible();
    await confirm.click();
    expect((await deleted).ok()).toBe(true);
}

for (const action of ['Keep old book', 'Merge in editor']) {
    test(`${action} preserves the actual replacement and reports refused binding`, async ({ page }) => {
        const choice = await replace(page);
        const bytes = readFileSync(path());
        const held = path() + '.held'; renameSync(path(), held);
        const expectedEvents = action === 'Merge in editor' ? [{ type: 'book', name: IMPORTED }, { type: 'replaced', avatar: AVATAR, world: '' }] : [{ type: 'replaced', avatar: AVATAR, world: '' }];
        try {
            await choice.locator('.popup-button-custom', { hasText: action }).click();
            await expect.poll(() => responses.filter(r => r.body.data?.extensions?.world !== undefined).map(r => r.status)).toEqual([500]);
            await expect.poll(() => page.evaluate(() => window.replaceWorldEvents.some(e => e.type === 'replaced'))).toBe(true);
            await assertSelected(page, EXT, expectedEvents);
            expect(readFileSync(held)).toEqual(bytes); expect(decode(readFileSync(path(OTHER))).extensions).toEqual(OTHER_EXT);
            const bookPath = resolve(server.dataRoot, 'default-user', 'worlds', IMPORTED + '.json');
            expect(existsSync(bookPath)).toBe(action === 'Merge in editor');
            if (action === 'Merge in editor') expect(JSON.parse(readFileSync(bookPath, 'utf8')).originalData).toEqual(BOOK);
            await expect(page.locator('#toast-container')).toContainText('could not be confirmed');
            await expect(page.locator('#toast-container')).not.toContainText('Kept the previous primary world book bound');
            await expect(page.locator('#toast-container')).not.toContainText('imported and linked to the character successfully');
            await expect(page.locator('.wbench .wb-win:visible')).toHaveCount(0);
        } finally { renameSync(held, path()); }
        await assertOtherAndReturn(page, EXT, expectedEvents);
    });
}

for (const failure of ['binding', 'delete']) {
    test(`closing the merge editor exposes a real ${failure} cleanup failure`, async ({ page }) => {
        const choice = await replace(page);
        mock.scriptReply('The ledger review is complete.');
        await choice.locator('.popup-button-custom', { hasText: 'Merge in editor' }).click();
        const studio = page.locator('.wbench .wb-win');
        await expect(studio).toBeVisible(); await expect(studio).toContainText('The ledger review is complete.');
        await expect(studio.locator('.wb-chat .wb-send')).toHaveText('Send');
        const bookPath = resolve(server.dataRoot, 'default-user', 'worlds', IMPORTED + '.json');
        const bookBytes = readFileSync(bookPath); const bytes = readFileSync(path());
        expect(decode(bytes).extensions).toEqual({ ...EXT, world: IMPORTED });
        const worlds = resolve(server.dataRoot, 'default-user', 'worlds'); const mode = statSync(worlds).mode; const held = path() + '.held';
        if (failure === 'binding') renameSync(path(), held); else chmodSync(worlds, 0o555);
        const world = failure === 'binding' ? IMPORTED : OLD;
        const events = [{ type: 'book', name: IMPORTED }, { type: 'control', value: IMPORTED }, ...(failure === 'delete' ? [{ type: 'control', value: OLD }] : []), { type: 'replaced', avatar: AVATAR, world }];
        try {
            await closeWorkbench(page);
            await expect.poll(() => responses.filter(r => failure === 'binding' ? r.body.data?.extensions?.world === OLD : r.url.endsWith('/api/worldinfo/delete') && r.body.name === IMPORTED).map(r => r.status)).toEqual([500]);
            await expect(page.locator('#toast-container')).toContainText('Rollback failed:');
            await expect(page.locator('#toast-container')).not.toContainText('Cancelled — restored previous world book');
            await expect.poll(() => page.evaluate(() => window.replaceWorldEvents.some(e => e.type === 'replaced'))).toBe(true);
            await assertSelected(page, { ...EXT, world }, events);
            expect(readFileSync(bookPath)).toEqual(bookBytes);
            expect(JSON.parse(bookBytes).originalData).toEqual(BOOK);
            const retained = await page.evaluate(async name => {
                const context = window.Luker.getContext();
                return { listed: context.getWorldInfoNames().includes(name), book: await context.loadWorldInfo(name) };
            }, IMPORTED);
            expect(retained).toEqual({ listed: true, book: JSON.parse(bookBytes) });
            expect(decode(readFileSync(failure === 'binding' ? held : path())).extensions).toEqual({ ...EXT, world });
        } finally { if (failure === 'binding') renameSync(held, path()); else chmodSync(worlds, mode); }
        await assertOtherAndReturn(page, { ...EXT, world }, events);
    });
}

async function openOwnedMerge(page) {
    const choice = await replace(page);
    mock.scriptReply('The ownership review is complete. No edits were requested.');
    await choice.locator('.popup-button-custom', { hasText: /Merge in editor|在编辑器中合并|在編輯器中合併/ }).click();
    const studio = page.locator('.wbench .wb-win');
    await expect(studio).toContainText('The ownership review is complete. No edits were requested.');
    await expect(studio.locator('.wb-chat .wb-send')).toHaveText(/^(Send|发送|發送)$/);
    return studio;
}

async function openExternalPage(context) {
    const other = await context.newPage();
    await awaitMainUI(other, server.baseURL);
    await selectCharacterByName(other, OTHER_NAME); await expect(other.locator('#character_name_pole')).toHaveValue(OTHER_NAME);
    await selectCharacterByName(other, NAME); await expect(other.locator('#character_name_pole')).toHaveValue(NAME);
    return other;
}

async function editMaterializedBook(other) {
    await selectWorldInEditor(other, IMPORTED);
    const entry = other.locator('.world_entry[uid="9"]'); await expect(entry).toBeVisible();
    await entry.locator('.inline-drawer-toggle').first().click();
    const content = entry.locator('textarea[name="content"]'); await expect(content).toBeVisible();
    const saved = other.waitForResponse(response => /\/api\/worldinfo\/(edit|patch)$/.test(response.url()) && response.request().postDataJSON()?.name === IMPORTED);
    await content.fill(EDITED_CONTENT); await content.blur();
    expect((await saved).ok()).toBe(true);
    expect(JSON.parse(readFileSync(resolve(server.dataRoot, 'default-user', 'worlds', IMPORTED + '.json'), 'utf8'))).toEqual(EDITED_BOOK);
}

async function openAuxiliary(page) {
    return openWorldDialogForCharacter(page, OTHER_NAME);
}

async function chooseAuxiliary(page, dialog) {
    await dialog.locator('.character_extra_world_info_selector + .select2 .select2-selection').click();
    await page.locator('.select2-results__option', { hasText: IMPORTED }).click();
}

async function adoptAuxiliary(page) {
    const dialog = await openAuxiliary(page);
    const saved = page.waitForResponse(response => /\/api\/settings\/(save|patch)$/.test(response.url()) && JSON.stringify(response.request().postDataJSON()).includes(IMPORTED));
    await chooseAuxiliary(page, dialog);
    expect((await saved).ok()).toBe(true);
    await dialog.locator('.character_name').click();
    await dialog.locator('.popup-button-ok').click(); await expect(dialog).toHaveCount(0);
}

test('conversation cancellation remains acknowledged before replacement completion after folding', async ({ page, context }) => {
    const studio = await openOwnedMerge(page);
    const otherBytes = readFileSync(path(OTHER));
    const oldBytes = readFileSync(resolve(server.dataRoot, 'default-user', 'worlds', OLD + '.json'));
    const cdp = await context.newCDPSession(page);
    let paused;
    const held = new Promise(resolve => cdp.once('Fetch.requestPaused', event => { paused = event; resolve(event); }));
    await cdp.send('Fetch.enable', { patterns: [{ urlPattern: '*/api/characters/merge-attributes', requestStage: 'Response' }] });
    try {
        await studio.locator('.wb-sess-head button').filter({ hasText: 'New conversation' }).click();
        const response = await held;
        expect(response.responseStatusCode).toBe(200);
        expect(JSON.parse(response.request.postData).data.extensions.world).toBe(OLD);
        await closeWorkbench(page);
        await expect(studio).toBeHidden();
        expect((await cleanupState(page)).form).toBe(IMPORTED);
        await cdp.send('Fetch.continueRequest', { requestId: response.requestId });
        paused = null;
        await expect.poll(() => page.evaluate(() => window.replaceWorldEvents.some(event => event.type === 'replaced'))).toBe(true);
        await expect.poll(() => existsSync(resolve(server.dataRoot, 'default-user', 'worlds', IMPORTED + '.json'))).toBe(false);
        await assertSelected(page, { ...EXT, world: OLD }, [
            { type: 'book', name: IMPORTED }, { type: 'control', value: IMPORTED },
            { type: 'control', value: OLD }, { type: 'replaced', avatar: AVATAR, world: OLD },
        ]);
        expect(readFileSync(path(OTHER))).toEqual(otherBytes);
        expect(readFileSync(resolve(server.dataRoot, 'default-user', 'worlds', OLD + '.json'))).toEqual(oldBytes);
    } finally {
        if (paused) await cdp.send('Fetch.continueRequest', { requestId: paused.requestId });
        await cdp.send('Fetch.disable');
        await cdp.detach();
    }
});

test('acknowledged auxiliary adoption preserves the book and complete settings', async ({ page, context }, testInfo) => {
    const studio = await openOwnedMerge(page);
    const originalBytes = readFileSync(path()); const otherBytes = readFileSync(path(OTHER));
    const bookPath = resolve(server.dataRoot, 'default-user', 'worlds', IMPORTED + '.json');
    const oldBytes = readFileSync(resolve(server.dataRoot, 'default-user', 'worlds', OLD + '.json'));
    const external = await openExternalPage(context);
    try {
        const settingsPath = resolve(server.dataRoot, 'default-user', 'settings.json');
        const beforeSettings = await external.evaluate(async () => (await import('/scripts/world-info.js')).world_info);
        await adoptAuxiliary(external);
        const expectedSettings = { ...beforeSettings, charLore: [...(beforeSettings.charLore ?? []).filter(entry => entry.name !== 'replace-world-other'), { name: 'replace-world-other', extraBooks: [IMPORTED] }] };
        expect(JSON.parse(readFileSync(settingsPath, 'utf8')).world_info_settings.world_info).toEqual(expectedSettings);
        const settingsAck = JSON.parse(readFileSync(settingsPath, 'utf8'));
        await closeWorkbench(page); await expect(studio).toBeHidden();
        await expect.poll(() => page.evaluate(() => window.replaceWorldEvents.some(event => event.type === 'replaced'))).toBe(true);
        await expect.poll(() => page.evaluate(async () => (await import('/scripts/util/AccountStorage.js')).accountStorage.getItem('StoryStringValidationCache'))).not.toBeNull();
        const validationInput = await page.evaluate(async () => (await import('/scripts/util/AccountStorage.js')).accountStorage.getItem('StoryStringValidationCache'));
        const expectedAcknowledged = { ...settingsAck, accountStorage: { ...settingsAck.accountStorage, StoryStringValidationCache: validationInput } };
        await expect.poll(() => JSON.parse(readFileSync(settingsPath, 'utf8'))).toEqual(expectedAcknowledged);
        const evidence = { settingsAck, validationInput, expectedAcknowledged, settings: JSON.parse(readFileSync(settingsPath, 'utf8')), responses, exists: existsSync(bookPath), card: decode(readFileSync(path())), other: decode(readFileSync(path(OTHER))) };
        const observationPath = testInfo.outputPath('auxiliary-adoption-outcome.json'); writeFileSync(observationPath, JSON.stringify(evidence, null, 2));
        await testInfo.attach('auxiliary-adoption-outcome', { path: observationPath, contentType: 'application/json' });
        expect(existsSync(bookPath)).toBe(true); expect(JSON.parse(readFileSync(bookPath, 'utf8'))).toEqual(IMPORTED_BOOK);
        expect(JSON.parse(readFileSync(settingsPath, 'utf8'))).toEqual(expectedAcknowledged);
        expect(createHash('sha256').update(readFileSync(path())).digest('hex')).toBe(createHash('sha256').update(originalBytes).digest('hex'));
        expect(createHash('sha256').update(readFileSync(path(OTHER))).digest('hex')).toBe(createHash('sha256').update(otherBytes).digest('hex'));
        expect(readFileSync(resolve(server.dataRoot, 'default-user', 'worlds', OLD + '.json'))).toEqual(oldBytes);
        expect(decode(readFileSync(path())).extensions).toEqual({ ...EXT, world: IMPORTED });
        expect(decode(readFileSync(path(OTHER))).extensions).toEqual(OTHER_EXT);
        await assertSelected(page, { ...EXT, world: IMPORTED }, [{ type: 'book', name: IMPORTED }, { type: 'control', value: IMPORTED }, { type: 'replaced', avatar: AVATAR, world: IMPORTED }]);
        expect(responses.filter(response => response.url.endsWith('/api/worldinfo/delete'))).toEqual([]);
        expect(await page.evaluate(name => window.Luker.getContext().loadWorldInfo(name), IMPORTED)).toEqual(IMPORTED_BOOK);
        const liveSettings = await external.evaluate(async () => (await import('/scripts/world-info.js')).world_info);
        expect(liveSettings).toEqual(expectedSettings);
        const originalState = await cleanupState(page); const otherState = await cleanupState(external);
        expect(originalState.live).toEqual(decode(originalBytes)); expect(originalState.json).toEqual(decode(originalBytes)); expect(originalState.editor).toEqual(decode(originalBytes));
        expect(otherState.live).toEqual(decode(otherBytes)); expect(otherState.json).toEqual(decode(otherBytes)); expect(otherState.editor).toEqual(decode(otherBytes));
        expect(otherState.form).toBe(''); expect(otherState.bound).toBe(false); expect(otherState.menuBound).toBe(false);
        await expect(page.locator('#toast-container .toast-info, #toast-container .toast-success')).toHaveCount(0);
        await assertOtherAndReturn(page, { ...EXT, world: IMPORTED }, [{ type: 'book', name: IMPORTED }, { type: 'control', value: IMPORTED }, { type: 'replaced', avatar: AVATAR, world: IMPORTED }]);
    } finally { await external.close(); }
});

for (const { loss, locale } of [
    { loss: 'lost-response', locale: 'en' },
    { loss: 'already-missing', locale: 'en' },
    { loss: 'lost-response', locale: 'zh-cn' },
    { loss: 'lost-response', locale: 'zh-tw' },
]) {
    test(`${locale} cleanup distinguishes ${loss} from confirmed retained storage`, async ({ page, context }, testInfo) => {
        if (locale !== 'en') {
            await page.locator('#user-settings-button .drawer-toggle').click();
            const loaded = page.waitForEvent('load'); await page.locator('#ui_language_select').selectOption(locale); await loaded;
            await page.waitForFunction(() => document.getElementById('preloader') === null && !!window.Luker?.getContext);
            await expect(page.locator('html')).toHaveAttribute('lang', locale);
            await closeAnyOpenTopSettingsDrawer(page);
            await selectCharacterByName(page, OTHER_NAME); await expect(page.locator('#character_name_pole')).toHaveValue(OTHER_NAME);
            await selectCharacterByName(page, NAME); await expect(page.locator('#character_name_pole')).toHaveValue(NAME);
        }
        const studio = await openOwnedMerge(page);
        const original = decode(readFileSync(path()));
        const bookPath = resolve(server.dataRoot, 'default-user', 'worlds', IMPORTED + '.json');
        const oldBytes = readFileSync(resolve(server.dataRoot, 'default-user', 'worlds', OLD + '.json'));
        const cdp = await context.newCDPSession(page); let paused; let resolvePaused; let source;
        const held = new Promise(resolve => { resolvePaused = resolve; });
        const target = loss === 'lost-response' ? '/api/worldinfo/delete' : '/api/characters/merge-attributes';
        const onPause = event => { paused = event; resolvePaused(event); };
        cdp.on('Fetch.requestPaused', onPause);
        cdp.on('Network.requestWillBeSent', event => { if (event.request.url.endsWith(target)) source = event.initiator; });
        await cdp.send('Network.enable');
        await cdp.send('Fetch.enable', { patterns: [{ urlPattern: '*' + target, requestStage: 'Response' }] });
        let external;
        try {
            const close = closeWorkbench(page);
            const response = await held;
            expect(response.responseStatusCode).toBe(200);
            expect(decode(readFileSync(path())).extensions).toEqual({ ...EXT, world: OLD });
            if (loss === 'already-missing') {
                external = await openExternalPage(context);
                await deleteBookInUI(external, IMPORTED);
            }
            expect(existsSync(bookPath)).toBe(false);
            const body = await cdp.send('Fetch.getResponseBody', { requestId: response.requestId });
            const evidence = { response, body, source, storedCard: decode(readFileSync(path())), bookMissingBeforeRelease: !existsSync(bookPath), cache: await page.evaluate(name => window.Luker.getContext().loadWorldInfo(name), IMPORTED) };
            await testInfo.attach('deletion-delivery-outcome', { body: JSON.stringify(evidence, null, 2), contentType: 'application/json' });
            expect(evidence.cache).toEqual(IMPORTED_BOOK);
            await cdp.send(loss === 'lost-response' ? 'Fetch.failRequest' : 'Fetch.continueRequest', { requestId: response.requestId, ...(loss === 'lost-response' ? { errorReason: 'Failed' } : {}) }); paused = null;
            await close; await expect(studio).toBeHidden();
            await expect.poll(() => page.evaluate(() => window.replaceWorldEvents.some(event => event.type === 'replaced'))).toBe(true);
            const feedback = page.locator('#toast-container .toast-error .toast-message');
            await expect(feedback).toBeVisible();
            await expect(feedback).toContainText(IMPORTED);
            await expect(feedback).toContainText(OLD);
            const feedbackText = (await feedback.innerText()).trim();
            if (locale !== 'en') {
                expect(feedbackText).toMatch(/[\u4e00-\u9fff]/);
            }
            await testInfo.attach('localized-deletion-feedback', { body: JSON.stringify({ locale, loss, feedback: feedbackText }), contentType: 'application/json' });
            await expect(page.locator('#toast-container .toast-success')).toHaveCount(0);
            expect(existsSync(bookPath)).toBe(false);
            expect(await page.evaluate(name => window.Luker.getContext().loadWorldInfo(name), IMPORTED)).toEqual(IMPORTED_BOOK);
            expect(readFileSync(resolve(server.dataRoot, 'default-user', 'worlds', OLD + '.json'))).toEqual(oldBytes);
            const events = [{ type: 'book', name: IMPORTED }, { type: 'control', value: IMPORTED }, { type: 'control', value: OLD }, { type: 'replaced', avatar: AVATAR, world: OLD }];
            await assertSelected(page, { ...EXT, world: OLD }, events);
            const expectedData = { ...original, extensions: { ...EXT, world: OLD } };
            expect(decode(readFileSync(path()))).toEqual(expectedData);
            const client = await cleanupState(page);
            expect(client.live).toEqual(expectedData); expect(client.json).toEqual(expectedData); expect(client.editor).toEqual(expectedData);
            await assertOtherAndReturn(page, { ...EXT, world: OLD }, events);
        } finally {
            if (paused) await cdp.send('Fetch.continueRequest', { requestId: paused.requestId });
            cdp.off('Fetch.requestPaused', onPause); await cdp.send('Fetch.disable'); await cdp.detach();
            if (external) await external.close();
        }
    });
}

for (const change of ['edit', 'adopt', 'same-name', 'during-delete']) {
    test(`merge close preserves ${change} ownership after acknowledged materialization`, async ({ page, context }, testInfo) => {
        const studio = await openOwnedMerge(page);
        const bookPath = resolve(server.dataRoot, 'default-user', 'worlds', IMPORTED + '.json');
        const materialized = JSON.parse(readFileSync(bookPath, 'utf8'));
        expect(materialized).toEqual(IMPORTED_BOOK);
        const bookSave = responses.find(response => response.url.endsWith('/api/worldinfo/edit') && response.body.name === IMPORTED);
        const binding = responses.find(response => response.body.data?.extensions?.world === IMPORTED);
        expect(bookSave.worldVersion).toEqual(expect.any(String)); expect(binding.characterVersion).toEqual(expect.any(String));
        const oldBytes = readFileSync(resolve(server.dataRoot, 'default-user', 'worlds', OLD + '.json'));
        const external = await openExternalPage(context);
        let cdp; let onPause; let paused; let resolvePaused; let requestSource;
        const restoredResponse = new Promise(resolve => { resolvePaused = resolve; });
        if (change === 'during-delete') {
            cdp = await context.newCDPSession(page);
            cdp.on('Network.requestWillBeSent', event => { if (event.request.url.endsWith('/api/characters/merge-attributes')) requestSource = event.initiator; });
            onPause = event => { paused = event; resolvePaused(event); };
            cdp.on('Fetch.requestPaused', onPause);
            await cdp.send('Network.enable');
            await cdp.send('Fetch.enable', { patterns: [{ urlPattern: '*/api/characters/merge-attributes', requestStage: 'Response' }] });
        }
        try {
            if (change === 'edit') await editMaterializedBook(external);
            if (change === 'adopt') await adoptPrimaryInUI(external, OTHER_NAME, IMPORTED);
            if (change === 'same-name') await rebindSameNameInUI(external);
            const close = closeWorkbench(page);
            if (change === 'during-delete') {
                const request = await restoredResponse;
                expect(JSON.parse(request.request.postData).data.extensions.world).toBe(OLD);
                expect(request.responseStatusCode).toBe(200);
                expect(decode(readFileSync(path())).extensions).toEqual({ ...EXT, world: OLD });
                await editMaterializedBook(external);
                const body = await cdp.send('Fetch.getResponseBody', { requestId: request.requestId });
                const delivery = { request: JSON.parse(request.request.postData), source: requestSource, status: request.responseStatusCode, body, materialized, storedBeforeRelease: JSON.parse(readFileSync(bookPath, 'utf8')), characterBeforeRelease: decode(readFileSync(path())) };
                const deliveryPath = testInfo.outputPath('conditional-delete-delivery.json'); writeFileSync(deliveryPath, JSON.stringify(delivery, null, 2)); await testInfo.attach('conditional-delete-delivery', { path: deliveryPath, contentType: 'application/json' });
                await cdp.send('Fetch.continueRequest', { requestId: request.requestId }); paused = null;
            }
            await close; await expect(studio).toBeHidden();
            await expect.poll(() => page.evaluate(() => window.replaceWorldEvents.some(event => event.type === 'replaced'))).toBe(true);
            const expectedBook = change === 'edit' || change === 'during-delete' ? EDITED_BOOK : IMPORTED_BOOK;
            const world = change === 'during-delete' ? OLD : IMPORTED;
            const after = await page.evaluate(({ avatar, book }) => {
                const context = window.Luker.getContext(); const card = context.characters.find(character => character.avatar === avatar);
                return { live: card.data.extensions, json: JSON.parse(card.json_data).data.extensions, editor: JSON.parse(document.querySelector('#character_json_data').value).data.extensions, embedded: card.data.character_book, field: document.querySelector('#character_world').value, bound: document.querySelector('#world_button').classList.contains('world_set'), menuBound: document.querySelector('#set_character_world').classList.contains('world_set'), events: window.replaceWorldEvents, listed: context.getWorldInfoNames().includes(book) };
            }, { avatar: AVATAR, book: IMPORTED });
            const evidence = { change, materialized, after, responses, exists: existsSync(bookPath), stored: existsSync(bookPath) ? JSON.parse(readFileSync(bookPath, 'utf8')) : null, character: decode(readFileSync(path())), other: decode(readFileSync(path(OTHER))) };
            const evidencePath = testInfo.outputPath('cleanup-ownership-outcome.json'); writeFileSync(evidencePath, JSON.stringify(evidence, null, 2)); await testInfo.attach('cleanup-ownership-outcome', { path: evidencePath, contentType: 'application/json' });
            expect(existsSync(bookPath)).toBe(true); expect(JSON.parse(readFileSync(bookPath, 'utf8'))).toEqual(expectedBook);
            expect(readFileSync(resolve(server.dataRoot, 'default-user', 'worlds', OLD + '.json'))).toEqual(oldBytes);
            const expected = { ...EXT, world };
            expect(decode(readFileSync(path())).extensions).toEqual(expected); expect(after.live).toEqual(expected); expect(after.json).toEqual(expected); expect(after.editor).toEqual(expected); expect(after.embedded).toEqual(BOOK);
            expect(after.field).toBe(world); expect(after.bound).toBe(true); expect(after.menuBound).toBe(true);
            expect(after.listed).toBe(true);
            expect(decode(readFileSync(path(OTHER))).extensions).toEqual(change === 'adopt' ? { ...OTHER_EXT, world: IMPORTED } : OTHER_EXT);
            expect(after.events.filter(event => event.type === 'control')).toEqual([{ type: 'control', value: IMPORTED }, ...(change === 'during-delete' ? [{ type: 'control', value: OLD }] : [])]);
            await expect(page.locator('#toast-container')).not.toContainText('Cancelled — restored previous world book');
            const restore = responses.find(response => response.body.data?.extensions?.world === OLD);
            expect(restore.body.ifMatch).toEqual({ characterVersion: binding.characterVersion, world: { name: IMPORTED, version: bookSave.worldVersion } });
            expect(restore.status).toBe(change === 'during-delete' ? 200 : 409);
            const deletions = responses.filter(response => response.url.endsWith('/api/worldinfo/delete'));
            if (change === 'during-delete') {
                expect(deletions).toMatchObject([{ status: 409, body: { name: IMPORTED, expectedVersion: bookSave.worldVersion, onlyIfUnbound: true } }]);
                await expect(page.locator('#toast-container')).toContainText(`Previous binding acknowledged: ${OLD}. Imported world book retained: ${IMPORTED}.`);
            } else {
                expect(deletions).toHaveLength(0);
                await expect(page.locator('#toast-container')).toContainText(`Cleanup stopped before deletion of imported world book: ${IMPORTED}.`);
            }
            const cache = await page.evaluate(name => window.Luker.getContext().loadWorldInfo(name), IMPORTED);
            expect(cache).toEqual(IMPORTED_BOOK);
            const externalCache = await external.evaluate(name => window.Luker.getContext().loadWorldInfo(name), IMPORTED);
            const expectedRuntimeBook = structuredClone(expectedBook);
            if (change === 'edit' || change === 'during-delete') {
                expectedRuntimeBook.originalData.entries[0].character_filter = undefined;
                expectedRuntimeBook.originalData.entries[0].extensions.triggers = [];
            }
            expect(externalCache).toEqual(expectedRuntimeBook);
            const otherExpected = change === 'adopt' ? { ...OTHER_EXT, world: IMPORTED } : OTHER_EXT;
            await selectCharacterByName(page, OTHER_NAME); await expect(page.locator('#character_name_pole')).toHaveValue(OTHER_NAME);
            const otherState = await page.evaluate(avatar => {
                const card = window.Luker.getContext().characters.find(character => character.avatar === avatar);
                return { live: card.data.extensions, json: JSON.parse(card.json_data).data.extensions, editor: JSON.parse(document.querySelector('#character_json_data').value).data.extensions };
            }, OTHER);
            expect(otherState).toEqual({ live: otherExpected, json: otherExpected, editor: otherExpected });
        } finally {
            if (cdp) { if (paused) await cdp.send('Fetch.continueRequest', { requestId: paused.requestId }); cdp.off('Fetch.requestPaused', onPause); await cdp.send('Fetch.disable'); await cdp.detach(); }
            await external.close();
        }
    });
}

test.describe('embedded entries without identifiers', () => {
    const source = { name: IMPORTED, extensions: {}, entries: [{ keys: ['bell'], content: 'The bell marks the fourth watch.', enabled: true, insertion_order: 61, extensions: {} }] };
    test.use({ embeddedBook: source });

    test('untouched merge diff preserves its embedded source and completes conditional cleanup', async ({ page }, testInfo) => {
        const oldPath = resolve(server.dataRoot, 'default-user', 'worlds', OLD + '.json');
        const oldBytes = readFileSync(oldPath);
        const studio = await openOwnedMerge(page);
        const bookPath = resolve(server.dataRoot, 'default-user', 'worlds', IMPORTED + '.json');
        const expectedBook = { originalData: { ...source, entries: [{ ...source.entries[0], id: 0, uid: 0 }] }, entries: { '0': { ...IMPORTED_BOOK.entries['9'], uid: 0 } } };
        expect(JSON.parse(readFileSync(bookPath, 'utf8'))).toEqual(expectedBook);
        expect(decode(readFileSync(path())).character_book).toEqual(source);
        const before = await page.evaluate(avatar => {
            const card = window.Luker.getContext().characters.find(character => character.avatar === avatar);
            return { live: card.data.character_book, json: JSON.parse(card.json_data).data.character_book, editor: JSON.parse(document.querySelector('#character_json_data').value).data.character_book };
        }, AVATAR);
        const evidencePath = testInfo.outputPath('identifier-free-source.json');
        writeFileSync(evidencePath, JSON.stringify({ before, stored: decode(readFileSync(path())), imported: JSON.parse(readFileSync(bookPath, 'utf8')), responses }, null, 2));
        await testInfo.attach('identifier-free-source', { path: evidencePath, contentType: 'application/json' });
        expect(before).toEqual({ live: source, json: source, editor: source });
        await closeWorkbench(page); await expect(studio).toBeHidden();
        await expect.poll(() => page.evaluate(() => window.replaceWorldEvents.some(event => event.type === 'replaced'))).toBe(true);
        expect(existsSync(bookPath)).toBe(false); expect(readFileSync(oldPath)).toEqual(oldBytes);
        const events = [{ type: 'book', name: IMPORTED }, { type: 'control', value: IMPORTED }, { type: 'control', value: OLD }, { type: 'replaced', avatar: AVATAR, world: OLD }];
        await assertSelected(page, { ...EXT, world: OLD }, events, source);
        expect(decode(readFileSync(path())).character_book).toEqual(source);
        expect(decode(readFileSync(path())).extensions).toEqual({ ...EXT, world: OLD });
        await expect(page.locator('#toast-container')).toContainText(`Cancelled — restored previous world book: ${OLD}`);
        await assertOtherAndReturn(page, { ...EXT, world: OLD }, events, source);
    });
});

for (const mode of ['mysql', 'postgres']) {
    test.describe(`${mode} cleanup and reference ordering`, () => {
        test.use({ storageMode: mode });
        for (const reference of ['primary', 'auxiliary']) {
            test(`pending real SQL deletion cannot acknowledge a dangling ${reference} adoption`, async ({ page, context }, testInfo) => {
                const studio = await openOwnedMerge(page);
                const original = decode(readFileSync(path())); const other = decode(readFileSync(path(OTHER)));
                const repo = new WorldInfoRepo({ engine: database.engine });
                const settingsRepo = new SettingsRepo({ engine: database.engine });
                expect(await repo.get('default-user', IMPORTED)).toEqual(IMPORTED_BOOK);
                const old = await repo.get('default-user', OLD);
                const external = await openExternalPage(context);
                const worldDialog = await openWorldDialogForCharacter(external, OTHER_NAME);
                await expect.poll(() => external.evaluate(async () => (await import('/script.js')).settings.accountStorage?.NavOpened)).toBe('true');
                // The selection debounce persists active_character through
                // /api/settings/patch. Holding the world row before that patch
                // lands makes its reference check wait on this test's own
                // lock, so the adoption request would never be sent.
                await expect.poll(() => external.evaluate(async () => (await import('/script.js')).settings.active_character)).toBe(OTHER);
                await expect.poll(async () => (await settingsRepo.get('default-user')).active_character).toBe(OTHER);
                const settings = (await settingsRepo.get('default-user')).world_info_settings.world_info;
                const acknowledgedSettings = await external.evaluate(async () => (await import('/script.js')).settings.world_info_settings.world_info);
                expect(await external.evaluate(async () => Object.is((await import('/scripts/world-info.js')).world_info, (await import('/script.js')).settings.world_info_settings.world_info))).toBe(false);
                const externalResponses = [];
                external.on('response', response => { if (/\/api\/(settings\/(save|patch)|characters\/merge-attributes)$/.test(response.url())) externalResponses.push({ url: response.url(), body: response.request().postDataJSON(), status: response.status() }); });
                expect(await external.evaluate(name => window.Luker.getContext().loadWorldInfo(name), IMPORTED)).toEqual(IMPORTED_BOOK);
                const lock = await holdWorldRow(database, 'default-user', IMPORTED);
                try {
                    const close = closeWorkbench(page);
                    await expect.poll(async () => (await lock.waits()).length).toBe(1);
                    const waitingDelete = await lock.waits();
                    const adoptionRequest = external.waitForRequest(request => reference === 'primary'
                        ? request.url().endsWith('/api/characters/merge-attributes') && request.postDataJSON().avatar === OTHER && request.postDataJSON().data?.extensions?.world === IMPORTED
                        : /\/api\/settings\/(save|patch)$/.test(request.url()) && JSON.stringify(request.postDataJSON()).includes(IMPORTED));
                    const adoptionResponse = external.waitForResponse(response => reference === 'primary'
                        ? response.url().endsWith('/api/characters/merge-attributes') && response.request().postDataJSON().avatar === OTHER && response.request().postDataJSON().data?.extensions?.world === IMPORTED
                        : /\/api\/settings\/(save|patch)$/.test(response.url()) && JSON.stringify(response.request().postDataJSON()).includes(IMPORTED));
                    if (reference === 'primary') {
                        await worldDialog.locator('.character_world_info_selector').selectOption({ label: IMPORTED });
                    } else {
                        await chooseAuxiliary(external, worldDialog);
                    }
                    const requestedAdoption = await adoptionRequest;
                    if (reference === 'primary') expect(requestedAdoption.postDataJSON()).toEqual({ avatar: OTHER, data: { extensions: { world: IMPORTED } }, replacePaths: ['data.extensions.world'] });
                    const during = { waitingDelete, pendingAfterAdoptionRequest: await lock.waits(), other: decode(readFileSync(path(OTHER))), settings: (await settingsRepo.get('default-user')).world_info_settings.world_info };
                    expect(during.pendingAfterAdoptionRequest).toHaveLength(1);
                    await lock.release();
                    await close; await expect(studio).toBeHidden();
                    expect((await adoptionResponse).status()).toBe(409);
                    if (reference === 'primary') {
                        await expect(external.locator('#toast-container')).toContainText('could not be confirmed');
                        await expect(worldDialog.locator('.character_world_info_selector')).toHaveValue('');
                    } else {
                        await expect(external.locator('#toast-container')).toContainText('Settings could not be saved');
                    }
                    await expect.poll(() => page.evaluate(() => window.replaceWorldEvents.some(event => event.type === 'replaced'))).toBe(true);
                    const after = { book: await repo.get('default-user', IMPORTED), other: decode(readFileSync(path(OTHER))), original: decode(readFileSync(path())), settings: (await settingsRepo.get('default-user')).world_info_settings.world_info, adoption: externalResponses.filter(response => JSON.stringify(response.body).includes(IMPORTED)), responses };
                    await testInfo.attach('sql-delete-adoption-interleaving', { body: JSON.stringify({ backend: mode, database: database.dbName || database.schemaName, during, after }, null, 2), contentType: 'application/json' });
                    expect(after.book).toBeNull();
                    expect(after.adoption).toMatchObject([{ status: 409 }]);
                    if (reference === 'auxiliary') {
                        const settingsState = await external.evaluate(async () => ({
                            draft: (await import('/scripts/world-info.js')).world_info,
                            acknowledged: (await import('/script.js')).settings.world_info_settings.world_info,
                            acknowledgedAdoptions: window.worldSettingsAckEvents.filter(settings => settings.charLore?.some(entry => entry.extraBooks.includes('replace-ledger-imported'))),
                            selected: [...document.querySelector('dialog[open] .character_extra_world_info_selector').selectedOptions].map(option => option.textContent),
                        }));
                        expect(settingsState).toEqual({
                            draft: { ...settings, charLore: [{ name: 'replace-world-other', extraBooks: [IMPORTED] }] },
                            acknowledged: acknowledgedSettings, acknowledgedAdoptions: [], selected: [IMPORTED],
                        });
                    }
                    expect(after.other).toEqual(other);
                    const expectedData = { ...original, extensions: { ...EXT, world: OLD } };
                    expect(after.original).toEqual(expectedData);
                    expect(after.settings).toEqual(settings);
                    expect(await repo.get('default-user', OLD)).toEqual(old);
                    expect(responses.filter(response => response.url.endsWith('/api/worldinfo/delete'))).toMatchObject([{ status: 200, body: { name: IMPORTED, onlyIfUnbound: true, expectedVersion: expect.any(String) } }]);
                    const events = [{ type: 'book', name: IMPORTED }, { type: 'control', value: IMPORTED }, { type: 'control', value: OLD }, { type: 'replaced', avatar: AVATAR, world: OLD }];
                    await assertSelected(page, { ...EXT, world: OLD }, events);
                    const originalClient = await cleanupState(page);
                    expect(originalClient.live).toEqual(expectedData); expect(originalClient.json).toEqual(expectedData); expect(originalClient.editor).toEqual(expectedData);
                    const otherLive = await external.evaluate(avatar => {
                        const card = window.Luker.getContext().characters.find(character => character.avatar === avatar);
                        return { live: card.data, json: JSON.parse(card.json_data).data };
                    }, OTHER);
                    expect(otherLive).toEqual({ live: other, json: other });
                    expect(await external.evaluate(name => window.Luker.getContext().loadWorldInfo(name), IMPORTED)).toEqual(IMPORTED_BOOK);
                    await expect(page.locator('#toast-container')).toContainText(`Cancelled — restored previous world book: ${OLD}`);
                    await assertOtherAndReturn(page, { ...EXT, world: OLD }, events);
                    if (reference === 'auxiliary') {
                        expect(externalResponses.filter(response => JSON.stringify(response.body).includes(IMPORTED))).toMatchObject([{ status: 409 }]);
                        expect((await settingsRepo.get('default-user')).world_info_settings.world_info).toEqual(settings);
                    }
                } finally { try { await lock.close(); } finally { await external.close(); } }
            });
        }
    });
}
