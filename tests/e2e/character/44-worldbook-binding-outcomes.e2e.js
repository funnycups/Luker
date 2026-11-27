import { test, expect } from '../../harness/playwright.js';
import { observeOperations } from '../../harness/observations.js';
import { existsSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { startServer } from '../../harness/server.js';
import { markOnboarded, writeWorldBook } from '../_lib/fixtures.js';
import { awaitMainUI, selectCharacterByName, closeAnyOpenTopSettingsDrawer } from '../_lib/page.js';
import { writeEmbeddedCharacter } from './_helpers.js';
import { read as readPngCard, write as writePngCard } from '../../../src/character-card-parser.js';

const AVATAR = 'world-ledger.png';
const OTHER = 'other-world-ledger.png';
const NAME = 'Keeper of the World Ledger';
const OTHER_NAME = 'Keeper of the Other Ledger';
const OLD = 'ledger-old';
const NEXT = 'ledger-next';
const EMBEDDED = 'ledger-embedded';
const BOOK = { name: EMBEDDED, extensions: { retained: 'book sibling' }, entries: [
    { id: 7, uid: 7, keys: ['lantern'], secondary_keys: ['tide'], content: 'The lantern marks the changing tide.', comment: 'Tide lantern', enabled: true, insertion_order: 37, extensions: { depth: 3, retained: 'entry sibling' } },
] };
const IMPORTED_BOOK = { originalData: BOOK, entries: { '7': {
    uid: 7, key: ['lantern'], keysecondary: ['tide'], comment: 'Tide lantern', content: 'The lantern marks the changing tide.',
    constant: false, vectorized: false, selective: false, selectiveLogic: 0, addMemo: true, order: 37, position: 1,
    disable: false, ignoreBudget: false, excludeRecursion: false, preventRecursion: false,
    matchPersonaDescription: false, matchCharacterDescription: false, matchCharacterPersonality: false, matchCharacterDepthPrompt: false, matchScenario: false, matchCreatorNotes: false,
    delayUntilRecursion: false, probability: 100, useProbability: true, depth: 3, outletName: '', group: '', groupOverride: false, groupWeight: 100,
    scanDepth: null, caseSensitive: null, matchWholeWords: null, useGroupScoring: null, automationId: '', role: 0, sticky: null, cooldown: null, delay: null,
    triggers: [], displayIndex: 0, extensions: { depth: 3, retained: 'entry sibling' },
} } };
const INITIAL_EXT = { world: OLD, retained: { nested: ['keep', { enabled: false }] } };
const OTHER_EXT = { world: '', retained: { other: ['untouched'] } };
let server;
let observations;
const cardPath = (avatar = AVATAR) => resolve(server.dataRoot, 'default-user', 'characters', avatar);
const disk = (avatar = AVATAR) => JSON.parse(readPngCard(readFileSync(cardPath(avatar)))).data;

test.beforeEach(async ({ resources, page }) => {
    observations = [];
    page.on('console', message => observations.push({ type: message.type(), text: message.text() }));
    page.on('pageerror', error => observations.push({ type: 'pageerror', text: error.message }));
    page.on('request', r => { if (/\/api\/(characters|worldinfo)\//.test(r.url())) observations.push({ type: 'request', url: r.url(), body: r.postData() }); });
    page.on('response', r => { if (/\/api\/(characters|worldinfo)\//.test(r.url())) observations.push({ type: 'response', url: r.url(), status: r.status() }); });
    page.on('requestfailed', r => observations.push({ type: 'requestfailed', url: r.url(), failure: r.failure() }));
    server = await startServer({ scope: resources, batchKey: 'character', scenarioId: '44-world-binding', extraConfig: { storage: { mode: 'fs' } } });
    markOnboarded({ dataRoot: server.dataRoot });
    writeWorldBook({ dataRoot: server.dataRoot, name: OLD, entries: [{ key: ['old'], content: 'The old tide ledger.' }] });
    writeWorldBook({ dataRoot: server.dataRoot, name: NEXT, entries: [{ key: ['next'], content: 'The next tide ledger.' }] });
    writeEmbeddedCharacter({ dataRoot: server.dataRoot, avatarFile: AVATAR, overrides: { name: NAME, extensions: INITIAL_EXT } });
    const card = JSON.parse(readPngCard(readFileSync(cardPath()))); card.data.character_book = BOOK;
    writeFileSync(cardPath(), writePngCard(readFileSync(cardPath()), JSON.stringify(card)));
    writeEmbeddedCharacter({ dataRoot: server.dataRoot, avatarFile: OTHER, overrides: { name: OTHER_NAME, extensions: OTHER_EXT } });
    await page.addInitScript(() => {
        const events = []; window.worldBindingEvents = events;
        document.addEventListener('DOMContentLoaded', () => {
            import('/scripts/events.js').then(({ eventSource, event_types }) => {
                eventSource.on(event_types.APP_READY, () => {
                    window.jQuery(document).on('change.worldBindingProbe', '#character_world', () => events.push({ type: 'control', value: document.querySelector('#character_world').value }));
                    eventSource.on(event_types.CHARACTER_EDITED, () => events.push({ type: 'edited' }));
                    eventSource.on(event_types.CHARACTER_FIELDS_UPDATED, value => events.push({ type: 'fields', value }));
                    eventSource.on(event_types.WORLDINFO_UPDATED, name => events.push({ type: 'book', name }));
                });
            });
        });
    });
    await awaitMainUI(page, server.baseURL);
    await selectCharacterByName(page, OTHER_NAME); await expect(page.locator('#character_name_pole')).toHaveValue(OTHER_NAME);
    await selectCharacterByName(page, NAME); await expect(page.locator('#character_name_pole')).toHaveValue(NAME);
    await page.locator('#rightNavDrawerIcon').click();
    await expect(page.locator('#description_textarea')).toBeVisible();
});
test.afterEach(async ({}, testInfo) => {
    { const path = testInfo.outputPath('browser-observations.json'); writeFileSync(path, JSON.stringify(observations, null, 2)); await testInfo.attach('browser-observations', { path, contentType: 'application/json' }); }
});

async function menu(page, id) {
    const drawer = page.locator('#rightNavDrawerIcon');
    if (await drawer.evaluate(element => element.classList.contains('closedIcon'))) await drawer.click();
    await expect(page.locator('#char-management-dropdown')).toBeVisible();
    const index = await page.locator('#char-management-dropdown option').evaluateAll((options, id) => options.findIndex(o => o.id === id), id);
    expect(index).toBeGreaterThanOrEqual(0);
    await page.locator('#char-management-dropdown').selectOption({ index });
}
async function popup(page) {
    await menu(page, 'set_character_world');
    const select = page.locator('dialog[open] .character_world_info_selector'); await expect(select).toBeVisible();
    await expect.poll(() => select.evaluate(el => window.jQuery._data(el, 'events')?.change?.length || 0)).toBe(1);
    return select;
}
async function choose(select, book) { await select.selectOption(book ? { label: book } : ''); }
async function openCreation(page, name) {
    await page.locator('#rm_button_characters').click();
    await page.locator('#rm_button_create').click();
    await expect(page.locator('#character_name_pole')).toBeVisible();
    await page.locator('#character_name_pole').fill(name);
}
async function mirrors(page) {
    return page.evaluate(({ avatar, other }) => {
        const ctx = window.Luker.getContext(); const a = ctx.characters.find(c => c.avatar === avatar); const b = ctx.characters.find(c => c.avatar === other);
        return { live: a.data.extensions, json: JSON.parse(a.json_data).data.extensions, jsonBook: JSON.parse(a.json_data).data.character_book, embedded: a.data.character_book, other: b.data.extensions, otherJson: JSON.parse(b.json_data).data.extensions, editor: JSON.parse(document.querySelector('#character_json_data').value).data.extensions, editorBook: JSON.parse(document.querySelector('#character_json_data').value).data.character_book, selected: ctx.characters[ctx.characterId].avatar, control: document.querySelector('#character_world').value, bound: document.querySelector('#world_button').classList.contains('world_set'), menuBound: document.querySelector('#set_character_world').classList.contains('world_set'), events: window.worldBindingEvents };
    }, { avatar: AVATAR, other: OTHER });
}
async function assertState(page, world, { selected = AVATAR, events = [] } = {}) {
    const expected = { ...INITIAL_EXT, world };
    expect(disk().extensions).toEqual(expected); expect(disk(OTHER).extensions).toEqual(OTHER_EXT);
    const state = await mirrors(page);
    expect(state.live).toEqual(expected); expect(state.json).toEqual(expected); expect(state.embedded).toEqual(BOOK);
    expect(state.other).toEqual(OTHER_EXT); expect(state.otherJson).toEqual(OTHER_EXT);
    expect(state.editor).toEqual(selected === AVATAR ? expected : OTHER_EXT);
    expect(state.selected).toBe(selected); expect(state.control).toBe(selected === AVATAR ? world : ''); expect(state.bound).toBe(selected === AVATAR && !!world);
    expect(state.menuBound).toBe(selected === AVATAR && !!world);
    expect(state.events).toEqual(events);
}

for (const failure of ['http', 'network']) {
    for (const unbind of [false, true]) {
        test(`${failure} refused manual ${unbind ? 'unbind' : 'bind'} retains acknowledged controls and supports retry`, async ({ page, context }) => {
            const select = await popup(page); const wanted = unbind ? '' : NEXT;
            const original = readFileSync(cardPath()); const held = cardPath() + '.held';
            if (failure === 'http') renameSync(cardPath(), held); else await context.setOffline(true);
            try {
                await choose(select, wanted);
                await expect.poll(() => observations.filter(e => e.url?.endsWith('/api/characters/merge-attributes') && e.type === (failure === 'http' ? 'response' : 'requestfailed')).length).toBe(1);
                if (failure === 'http') expect(observations.find(e => e.type === 'response' && e.url.endsWith('/api/characters/merge-attributes')).status).toBe(500);
                await expect(select.locator('option:checked')).toHaveText(OLD);
                const state = await mirrors(page); expect(state.live).toEqual(INITIAL_EXT); expect(state.json).toEqual(INITIAL_EXT); expect(state.editor).toEqual(INITIAL_EXT); expect(state.control).toBe(OLD); expect(state.bound).toBe(true); expect(state.events).toEqual([]);
                expect(readFileSync(failure === 'http' ? held : cardPath())).toEqual(original);
                expect(disk(OTHER).extensions).toEqual(OTHER_EXT);
                await expect(page.locator('#toast-container .toast-error, #toast-container .toast-warning').first()).toBeVisible();
                await expect(page.locator('#toast-container .toast-success')).toHaveCount(0);
            } finally { if (failure === 'http') renameSync(held, cardPath()); else await context.setOffline(false); }
            await choose(select, wanted);
            await expect.poll(async () => (await mirrors(page)).control).toBe(wanted);
            await assertState(page, wanted, { events: [{ type: 'control', value: wanted }] });
        });
    }
}

test('embedded import retains the created book but never publishes a refused binding', async ({ page }) => {
    await menu(page, 'import_character_info');
    const confirm = page.locator('dialog[open]').last(); await expect(confirm).toContainText(EMBEDDED);
    const bytes = readFileSync(cardPath()); const held = cardPath() + '.held'; renameSync(cardPath(), held);
    const writes = []; const observe = r => { if (r.url().endsWith('/api/characters/merge-attributes') || r.url().endsWith('/api/characters/edit')) writes.push(r); }; page.on('request', observe);
    try {
        const failed = page.waitForResponse(r => r.url().endsWith('/api/characters/merge-attributes'));
        await confirm.locator('.popup-button-ok').click(); expect((await failed).status()).toBe(500);
        const state = await mirrors(page); expect(state.live).toEqual(INITIAL_EXT); expect(state.json).toEqual(INITIAL_EXT); expect(state.editor).toEqual(INITIAL_EXT); expect(state.control).toBe(OLD); expect(state.bound).toBe(true);
        await expect(page.locator('#toast-container .toast-warning .toast-message')).toContainText(EMBEDDED);
        expect(writes.map(r => r.url().split('/').at(-1))).toEqual(['merge-attributes']);
        expect(state.events).toEqual([{ type: 'book', name: EMBEDDED }]);
        expect(readFileSync(held)).toEqual(bytes);
        const imported = JSON.parse(readFileSync(resolve(server.dataRoot, 'default-user', 'worlds', EMBEDDED + '.json'), 'utf8'));
        expect(imported).toEqual(IMPORTED_BOOK);
        expect(disk(OTHER).extensions).toEqual(OTHER_EXT);
        await expect(page.locator('#toast-container .toast-success')).toHaveCount(0);
    } finally { renameSync(held, cardPath()); page.off('request', observe); }
    await closeAnyOpenTopSettingsDrawer(page);
    const select = await popup(page); await choose(select, EMBEDDED);
    await expect.poll(async () => (await mirrors(page)).control).toBe(EMBEDDED);
    await assertState(page, EMBEDDED, { events: [{ type: 'book', name: EMBEDDED }, { type: 'control', value: EMBEDDED }] });
});

// Managed observation adapter captures complete real source/body/storage and controls only delivery.
// No response bytes are manufactured and every pending response is released.
async function holdResponses(page, scope, suffix, testInfo, stored = () => {
    if (!suffix.includes('/worldinfo/')) return disk();
    const name = suffix.endsWith('/edit') ? EMBEDDED : NEXT;
    const path = resolve(server.dataRoot, 'default-user', 'worlds', name + '.json');
    return { character: disk(), book: existsSync(path) ? JSON.parse(readFileSync(path, 'utf8')) : null };
}) {
    const records = [];
    const waiting = [];
    const ready = [];
    const observer = await observeOperations({
        page,
        scope,
        baseURL: server.baseURL,
        patterns: ['Request', 'Response'].map(requestStage => ({ urlPattern: '*' + suffix + '*', requestStage })),
        networkFilter: e => new URL(e.request.url).pathname.endsWith(suffix),
        readStored: stored,
        recordBodies: true,
        enableDebugger: false,
        onFetchPaused: async ({ event, response, row, stored: snapshot }) => {
            if (!response) {
                records.push({
                    id: event.networkId,
                    body: event.request.postData ? JSON.parse(event.request.postData) : null,
                    before: snapshot,
                });
                return false;
            }
            const record = records.find(r => r.id === event.networkId);
            Object.assign(record, {
                status: event.responseStatusCode,
                response: row.responseBody,
                stored: snapshot,
                deliveryId: event.requestId,
                pausedEvent: event,
                released: false,
            });
            if (suffix.endsWith('/worldinfo/edit') && record.status === 200) expect(record.stored.book).toEqual(record.body.data);
            return false;
        },
    });
    observer.hold(`world-binding-${suffix}`, ({ response, event }) => {
        if (!response) return false;
        const record = records.find(r => r.id === event.networkId);
        if (record) {
            record.pausedEvent = event;
            if (waiting.length) waiting.shift()(record);
            else ready.push(record);
        }
        return true;
    }, { repeat: true });
    let closed = false;
    return {
        next: () => ready.length ? Promise.resolve(ready.shift()) : new Promise(resolve => waiting.push(resolve)),
        release: async (record, drop = false) => {
            await observer.release(record.pausedEvent, { failReason: drop ? 'ConnectionReset' : null });
            record.released = true;
        },
        close: async () => {
            if (closed) return;
            closed = true;
            await observer.close();
            for (const record of records) {
                const net = observer.getNetworkRecord(record.id);
                record.request = { body: net?.postData ? JSON.parse(net.postData) : null, source: net?.initiator };
                expect(record.request.body).toEqual(record.body);
                expect(record.request.source.stack.callFrames.length).toBeGreaterThan(0);
            }
            const path = testInfo.outputPath('world-binding-deliveries.json');
            writeFileSync(path, JSON.stringify(records, null, 2));
            await testInfo.attach('world-binding-deliveries', { path, contentType: 'application/json' });
        },
    };
}

test('pending manual binding cannot publish into a newly selected character', async ({ page, resources }, testInfo) => {
    const gate = await holdResponses(page, resources, '/api/characters/merge-attributes', testInfo);
    try {
        const select = await popup(page); await choose(select, ''); const pending = await gate.next();
        expect(pending.status).toBe(200); expect(pending.body).toEqual({ avatar: AVATAR, data: { extensions: { world: '' } }, replacePaths: ['data.extensions.world'] });
        expect(pending.before.extensions).toEqual(INITIAL_EXT); expect(pending.stored.extensions).toEqual({ ...INITIAL_EXT, world: '' });
        await page.keyboard.press('Escape'); await expect(select).toHaveCount(0);
        await selectCharacterByName(page, OTHER_NAME); await expect(page.locator('#character_name_pole')).toHaveValue(OTHER_NAME);
        expect(pending.released).toBe(false);
        await gate.release(pending);
        await expect.poll(async () => (await mirrors(page)).live.world).toBe('');
        await assertState(page, '', { selected: OTHER });
        expect(disk().extensions).toEqual({ ...INITIAL_EXT, world: '' }); expect(disk(OTHER).extensions).toEqual(OTHER_EXT);
    } finally { await gate.close(); }
});

test('failed first binding cannot restore the control over an identical pending retry', async ({ page, resources }, testInfo) => {
    const select = await popup(page); const held = cardPath() + '.held'; renameSync(cardPath(), held); let restored = false;
    const gate = await holdResponses(page, resources, '/api/characters/merge-attributes', testInfo, () => JSON.parse(readPngCard(readFileSync(restored ? cardPath() : held))).data);
    try {
        await choose(select, NEXT); const first = await gate.next(); expect(first.status).toBe(500);
        renameSync(held, cardPath()); restored = true;
        await choose(select, NEXT);
        await gate.release(first);
        const retry = await gate.next(); expect(retry.status).toBe(200);
        await expect(select.locator('option:checked')).toHaveText(NEXT);
        const beforeRetry = await mirrors(page); expect(beforeRetry.control).toBe(OLD); expect(beforeRetry.events).toEqual([]);
        await gate.release(retry);
        await expect.poll(async () => (await mirrors(page)).control).toBe(NEXT);
        await assertState(page, NEXT, { events: [{ type: 'control', value: NEXT }] });
    } finally { if (!restored) renameSync(held, cardPath()); await gate.close(); }
});

test('a later unbind owns the source while embedded book creation is pending', async ({ page, resources }, testInfo) => {
    const gate = await holdResponses(page, resources, '/api/worldinfo/edit', testInfo);
    try {
        await menu(page, 'import_character_info'); await page.locator('dialog[open] .popup-button-ok').click();
        const created = await gate.next(); expect(created.status).toBe(200);
        const select = await popup(page); await choose(select, '');
        await expect(select).toHaveValue('');
        await page.keyboard.press('Escape');
        await gate.release(created);
        await expect(page.locator('#toast-container .toast-warning .toast-message')).toContainText(EMBEDDED);
        await expect.poll(async () => (await mirrors(page)).control).toBe('');
        await assertState(page, '', { events: [{ type: 'book', name: EMBEDDED }, { type: 'control', value: '' }] });
        expect(JSON.parse(readFileSync(resolve(server.dataRoot, 'default-user', 'worlds', EMBEDDED + '.json'), 'utf8')).originalData).toEqual(BOOK);
    } finally { await gate.close(); }
});

test('embedded import retains its original target across a pending character switch', async ({ page, resources }, testInfo) => {
    const gate = await holdResponses(page, resources, '/api/worldinfo/edit', testInfo);
    try {
        await menu(page, 'import_character_info'); await page.locator('dialog[open] .popup-button-ok').click();
        const pending = await gate.next(); expect(pending.status).toBe(200);
        expect(JSON.parse(readFileSync(resolve(server.dataRoot, 'default-user', 'worlds', EMBEDDED + '.json'), 'utf8'))).toEqual(IMPORTED_BOOK);
        await selectCharacterByName(page, OTHER_NAME); await expect(page.locator('#character_name_pole')).toHaveValue(OTHER_NAME);
        expect(pending.released).toBe(false); await gate.release(pending);
        await expect.poll(() => disk().extensions.world).toBe(EMBEDDED);
        await expect.poll(async () => (await mirrors(page)).live.world).toBe(EMBEDDED);
        await assertState(page, EMBEDDED, { selected: OTHER, events: [{ type: 'book', name: EMBEDDED }] });
    } finally { await gate.close(); }
});

test('acknowledged bindings mirror the form without replacing a later popup intent', async ({ page, resources }, testInfo) => {
    const gate = await holdResponses(page, resources, '/api/characters/merge-attributes', testInfo);
    try {
        const select = await popup(page); await choose(select, NEXT); const first = await gate.next(); expect(first.status).toBe(200);
        await choose(select, ''); await gate.release(first);
        const last = await gate.next(); expect(last.status).toBe(200);
        const pending = await mirrors(page); expect(pending.control).toBe(NEXT); expect(pending.events).toEqual([{ type: 'control', value: NEXT }]);
        await expect(select).toHaveValue(''); await gate.release(last);
        await expect.poll(async () => (await mirrors(page)).control).toBe('');
        await assertState(page, '', { events: [{ type: 'control', value: NEXT }, { type: 'control', value: '' }] });
    } finally { await gate.close(); }
});

test('a lost real binding response retains the imported book without claiming acknowledgement', async ({ page, resources }, testInfo) => {
    const gate = await holdResponses(page, resources, '/api/characters/merge-attributes', testInfo);
    try {
        await menu(page, 'import_character_info');
        await page.locator('dialog[open] .popup-button-ok').click();
        const pending = await gate.next();
        expect(pending.status).toBe(200); expect(pending.before.extensions).toEqual(INITIAL_EXT); expect(pending.stored.extensions).toEqual({ ...INITIAL_EXT, world: EMBEDDED });
        expect(pending.body).toEqual({ avatar: AVATAR, data: { extensions: { world: EMBEDDED } }, replacePaths: ['data.extensions.world'] });
        await gate.release(pending, true);
        await expect(page.locator('#toast-container .toast-warning .toast-message')).toContainText(EMBEDDED);
        await expect(page.locator('#toast-container .toast-success')).toHaveCount(0);
        const state = await mirrors(page); expect(state.live).toEqual(INITIAL_EXT); expect(state.json).toEqual(INITIAL_EXT); expect(state.editor).toEqual(INITIAL_EXT); expect(state.control).toBe(OLD); expect(state.events).toEqual([{ type: 'book', name: EMBEDDED }]);
        expect(disk().extensions).toEqual({ ...INITIAL_EXT, world: EMBEDDED }); expect(disk(OTHER).extensions).toEqual(OTHER_EXT);
        expect(JSON.parse(readFileSync(resolve(server.dataRoot, 'default-user', 'worlds', EMBEDDED + '.json'), 'utf8'))).toEqual(IMPORTED_BOOK);
        await closeAnyOpenTopSettingsDrawer(page);
        const select = await popup(page); await choose(select, EMBEDDED); const retry = await gate.next(); expect(retry.status).toBe(200); await gate.release(retry);
        await expect.poll(async () => (await mirrors(page)).control).toBe(EMBEDDED);
        await assertState(page, EMBEDDED, { events: [{ type: 'book', name: EMBEDDED }, { type: 'control', value: EMBEDDED }] });
    } finally { await gate.close(); }
});

test('creation buffers its world book until the actual card is created', async ({ page }) => {
    await openCreation(page, 'Keeper of the New World');
    const writes = []; const observe = r => { if (r.url().endsWith('/api/characters/merge-attributes')) writes.push(r); }; page.on('request', observe);
    try {
        const select = await popup(page); await choose(select, NEXT);
        await expect(page.locator('#character_world')).toHaveValue(NEXT);
        await page.locator('dialog[open] .select2-selection--multiple').click();
        await page.locator('.select2-results__option', { hasText: new RegExp('^' + OLD + '$') }).click();
        await page.locator('dialog[open] .character_name').click();
        expect(await page.evaluate(async () => (await import('/script.js')).create_save.extra_books)).toEqual([OLD]);
        expect(writes).toEqual([]); expect(disk().extensions).toEqual(INITIAL_EXT); expect(disk(OTHER).extensions).toEqual(OTHER_EXT);
        expect(await page.evaluate(async () => (await import('/script.js')).create_save.world)).toBe(NEXT);
        await page.keyboard.press('Escape');
        const created = page.waitForResponse(r => r.url().endsWith('/api/characters/create'));
        await page.locator('#create_button_label').click(); const response = await created; expect(response.ok()).toBe(true);
        const avatar = await response.text(); const card = disk(avatar);
        expect(card.extensions).toEqual({ talkativeness: '0.5', fav: false, world: NEXT, depth_prompt: { prompt: '', depth: 4, role: 'system' } });
        expect(writes).toEqual([]); expect(disk().extensions).toEqual(INITIAL_EXT); expect(disk(OTHER).extensions).toEqual(OTHER_EXT);
    } finally { page.off('request', observe); }
});

test('a refused later intent retains the earlier acknowledged binding in every mirror', async ({ page, resources }, testInfo) => {
    const held = cardPath() + '.held'; let holding = false;
    const gate = await holdResponses(page, resources, '/api/characters/merge-attributes', testInfo, () => JSON.parse(readPngCard(readFileSync(holding ? held : cardPath()))).data);
    try {
        const select = await popup(page); await choose(select, NEXT); const accepted = await gate.next();
        expect(accepted.status).toBe(200); expect(accepted.stored.extensions).toEqual({ ...INITIAL_EXT, world: NEXT });
        renameSync(cardPath(), held); holding = true;
        await choose(select, ''); await gate.release(accepted);
        const refused = await gate.next(); expect(refused.status).toBe(500); expect(refused.before.extensions).toEqual({ ...INITIAL_EXT, world: NEXT });
        renameSync(held, cardPath()); holding = false;
        await gate.release(refused);
        await expect(page.locator('#toast-container .toast-error, #toast-container .toast-warning').first()).toBeVisible();
        await expect(select.locator('option:checked')).toHaveText(NEXT);
        await assertState(page, NEXT, { events: [{ type: 'control', value: NEXT }] });
    } finally { if (holding) renameSync(held, cardPath()); await gate.close(); }
});

test('a pending card binding cannot populate the character creation JSON buffer', async ({ page, resources }, testInfo) => {
    const gate = await holdResponses(page, resources, '/api/characters/merge-attributes', testInfo);
    try {
        const selected = await popup(page); await choose(selected, NEXT); const pending = await gate.next(); expect(pending.status).toBe(200);
        await page.keyboard.press('Escape');
        await openCreation(page, 'Keeper of the Independent New Ledger');
        const creation = await popup(page); await choose(creation, OLD); await expect(page.locator('#character_world')).toHaveValue(OLD);
        await page.keyboard.press('Escape'); await expect(page.locator('#character_json_data')).toHaveValue('');
        await gate.release(pending);
        await expect.poll(() => page.evaluate(avatar => window.Luker.getContext().characters.find(c => c.avatar === avatar).data.extensions.world, AVATAR)).toBe(NEXT);
        await expect(page.locator('#character_json_data')).toHaveValue('');
        await expect(page.locator('#character_world')).toHaveValue(OLD);
        expect(await page.evaluate(async () => (await import('/script.js')).create_save.world)).toBe(OLD);
        const created = page.waitForResponse(r => r.url().endsWith('/api/characters/create'));
        await page.locator('#create_button_label').click(); const response = await created; expect(response.ok()).toBe(true);
        const avatar = await response.text();
        expect(disk(avatar).extensions).toEqual({ talkativeness: '0.5', fav: false, world: OLD, depth_prompt: { prompt: '', depth: 4, role: 'system' } });
        expect(disk().extensions).toEqual({ ...INITIAL_EXT, world: NEXT }); expect(disk(OTHER).extensions).toEqual(OTHER_EXT);
    } finally { await gate.close(); }
});

for (const locale of ['zh-cn', 'zh-tw']) {
    test(`${locale} partial import feedback retains the saved book name`, async ({ page }, testInfo) => {
        await page.locator('#user-settings-button .drawer-toggle').click();
        const loaded = page.waitForEvent('load');
        await page.locator('#ui_language_select').selectOption(locale);
        await loaded;
        await page.waitForFunction(() => document.getElementById('preloader') === null && !!window.Luker?.getContext);
        await expect(page.locator('html')).toHaveAttribute('lang', locale);
        await closeAnyOpenTopSettingsDrawer(page);
        await selectCharacterByName(page, OTHER_NAME); await expect(page.locator('#character_name_pole')).toHaveValue(OTHER_NAME);
        await selectCharacterByName(page, NAME); await expect(page.locator('#character_name_pole')).toHaveValue(NAME);
        await menu(page, 'import_character_info');
        const confirm = page.locator('dialog[open]').last(); await expect(confirm).toContainText(EMBEDDED);
        const bytes = readFileSync(cardPath()); const held = cardPath() + '.held'; renameSync(cardPath(), held);
        try {
            const refused = page.waitForResponse(response => response.url().endsWith('/api/characters/merge-attributes'));
            await confirm.locator('.popup-button-ok').click(); expect((await refused).status()).toBe(500);
            const feedback = page.locator('#toast-container .toast-warning .toast-message');
            await expect(feedback).toBeVisible();
            const feedbackText = (await feedback.innerText()).trim();
            await testInfo.attach('localized-import-feedback', { body: JSON.stringify({ locale, bookName: EMBEDDED, text: feedbackText }), contentType: 'application/json' });
            expect(feedbackText).toContain(EMBEDDED);
            expect(feedbackText).toMatch(/[\u4e00-\u9fff]/);
            await expect(page.locator('#toast-container .toast-success')).toHaveCount(0);
            expect(readFileSync(held)).toEqual(bytes);
            expect(JSON.parse(readFileSync(resolve(server.dataRoot, 'default-user', 'worlds', EMBEDDED + '.json'), 'utf8'))).toEqual(IMPORTED_BOOK);
        } finally { renameSync(held, cardPath()); }
        await assertState(page, OLD, { events: [{ type: 'book', name: EMBEDDED }] });
    });
}
