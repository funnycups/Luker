import { test as base, expect } from '../../harness/playwright.js';
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { resolve } from 'node:path';
import { createHash } from 'node:crypto';
import { startServer } from '../../harness/server.js';
import { markOnboarded, writeWorldBook } from '../_lib/fixtures.js';
import { awaitMainUI, selectCharacterByName } from '../_lib/page.js';
import { writeEmbeddedCharacter } from './_helpers.js';
import { read } from '../../../src/character-card-parser.js';
import { makeTempMysqlEngineHarness } from '../../storage/harness/mysql-harness.js';
import { makeTempPgEngineHarness } from '../../storage/harness/pg-harness.js';
import { WorldInfoRepo } from '../../../src/storage/repositories/world-info-repo.js';
import { SettingsRepo } from '../../../src/storage/repositories/settings-repo.js';
import { holdWorldRow } from '../../storage/harness/world-row-lock.js';
import { createDatabaseCommitFault } from '../../storage/harness/database-commit-fault.js';
import { holdCharacterCacheRead } from '../_lib/owned-character-read.js';

const AVATAR = 'lifetime-keeper.png', OTHER = 'lifetime-other.png';
const NAME = 'Keeper of the Archive', OTHER_NAME = 'Keeper of the Unchanged Archive';
const OWNED = 'lifetime-owned', KEEP = 'lifetime-keep';
const BOOK = { entries: { '7': { uid: 7, key: ['archive'], content: 'The archive retains the northern chart.' } }, extensions: { retained: ['book sibling'] } };
const EXT = { world: KEEP, retained: { ledger: ['primary'] }, card_app: { enabled: true, entry: 'index.js' } };
const OTHER_EXT = { world: '', retained: { ledger: ['other'] } };
const test = base.extend({ storageMode: ['mysql', { option: true }], commitFault: [false, { option: true }] });
let server, database, worlds, settingsRepo, fault, requests, pendingFaults;
const png = (avatar = AVATAR) => resolve(server.dataRoot, 'default-user', 'characters', avatar);
const data = bytes => JSON.parse(read(bytes)).data;
const hash = bytes => createHash('sha256').update(bytes).digest('hex');
const fileState = bytes => ({ png: bytes.toString('base64'), sha256: hash(bytes), card: JSON.parse(read(bytes)) });

function entry(version) { return `import * as core from '/script.js';
import { charSetAuxWorlds } from '/scripts/world-info.js';
export function init(ctx) {
 const live = ctx.lukerContext; const out = document.createElement('pre'); out.id = 'lifetime-output';
 const history = []; const input = document.createElement('input'); input.id = 'lifetime-draft';
 const sync = () => { input.value = live.extensionSettings.lifetime_draft?.value || ''; };
 input.oninput = () => { live.extensionSettings.lifetime_draft = { value: input.value, retained: ['draft sibling'] }; };
 const add = (name, action) => { const button = document.createElement('button'); button.id = 'lifetime-' + name; button.textContent = name;
 button.onclick = async () => { try { const value = await action(); history.push({ name, value }); } catch (error) { history.push({ name, error: error.message, code: error.code, resourceState: error.resourceState }); } out.textContent = JSON.stringify(history); out.dataset.last = name; }; ctx.container.append(button); };
 add('bind', () => live.charUpdatePrimaryWorld('${OWNED}', live.characters.find(card => card.avatar === '${OTHER}')));
 add('delete', () => live.deleteWorldBook('${OWNED}', { expectedVersion: '${version}', onlyIfUnbound: true }));
 add('save', () => live.saveSettings(0, { asyncDiff: false }));
 add('load', async () => { await live.loadWorldInfo('${OWNED}'); await live.loadWorldInfo('${KEEP}'); return { loaded: true }; });
 add('raw', async () => { const response = await fetch('/api/settings/get', { method: 'POST', headers: live.getRequestHeaders(), body: '{}' }); return response.json(); });
 add('read', async () => { await core.getSettings(); return { completed: true }; });
 add('recover', async () => {
  const acknowledged = new Promise(resolve => live.eventSource.once(live.eventTypes.SETTINGS_UPDATED, resolve));
  charSetAuxWorlds('lifetime-keeper', []); await acknowledged; return { acknowledged: true };
 });
 live.eventSource.on(live.eventTypes.SETTINGS_LOADED, sync); sync(); ctx.container.append(input, out);
}`; }

async function observe(testInfo, name, value) {
    const path = testInfo.outputPath(name + '.json'); writeFileSync(path, JSON.stringify(value, null, 2)); await testInfo.attach(name, { path, contentType: 'application/json' });
}

test.beforeEach(async ({ resources, page, context, storageMode, commitFault }) => {
    requests = []; pendingFaults = []; server = null; database = null; fault = null;
    database = storageMode === 'mysql' ? await makeTempMysqlEngineHarness({ scope: resources }) : await makeTempPgEngineHarness({ scope: resources });
    await database.engine.ping(database.handle);
    const url = storageMode === 'mysql' ? database.url : database.engine._pool.options.connectionString;
    fault = commitFault ? await createDatabaseCommitFault(storageMode, url) : null;
    server = await startServer({ scope: resources, batchKey: 'character', scenarioId: '47-world-reference-lifetime', extraConfig: { storage: { mode: storageMode, [storageMode]: { url: fault ? fault.url : url } } } });
    markOnboarded({ dataRoot: server.dataRoot });
    worlds = new WorldInfoRepo({ engine: database.engine }); settingsRepo = new SettingsRepo({ engine: database.engine });
    const settingsPath = resolve(server.dataRoot, 'default-user', 'settings.json'); const settings = JSON.parse(readFileSync(settingsPath, 'utf8'));
    settings.world_info_settings = { ...settings.world_info_settings, world_info: { globalSelect: [], charLore: [], retained: { sibling: ['settings'] } } };
    await settingsRepo.save('default-user', settings);
    writeWorldBook({ dataRoot: server.dataRoot, name: KEEP, entries: [{ key: ['kept'], content: 'The previous chart is unchanged.' }] });
    await worlds.save('default-user', KEEP, JSON.parse(readFileSync(resolve(server.dataRoot, 'default-user', 'worlds', KEEP + '.json'), 'utf8')));
    const version = await worlds.save('default-user', OWNED, BOOK);
    writeEmbeddedCharacter({ dataRoot: server.dataRoot, avatarFile: AVATAR, overrides: { name: NAME, extensions: EXT } });
    writeEmbeddedCharacter({ dataRoot: server.dataRoot, avatarFile: OTHER, overrides: { name: OTHER_NAME, extensions: OTHER_EXT } });
    const app = resolve(server.dataRoot, 'default-user', 'card-apps', 'lifetime-keeper'); mkdirSync(app, { recursive: true }); writeFileSync(resolve(app, 'index.js'), entry(version));
    await context.addInitScript(() => {
        window.lifetimeEvents = [];
        document.addEventListener('DOMContentLoaded', () => Promise.all([import('/scripts/events.js'), import('/script.js')]).then(([{ eventSource, event_types }, core]) => {
            // The settings snapshot is read synchronously: an awaited dynamic
            // import inside the handler records events out of emission order
            // and can push an earlier event after a later test snapshot.
            for (const name of ['SETTINGS_LOADED', 'SETTINGS_UPDATED']) eventSource.on(event_types[name], () => {
                window.lifetimeEvents.push({ name, settings: JSON.parse(JSON.stringify(core.settings)), stack: new Error().stack });
            });
            eventSource.on(event_types.APP_READY, () => window.jQuery(document).on('change.lifetimeProbe', '#character_world', () => window.lifetimeEvents.push({ name: 'binding', value: document.querySelector('#character_world').value })));
        }));
    });
    page.on('response', response => { if (/^\/api\/(characters\/merge-attributes|settings\/(get|fields|field|save|patch)|worldinfo\/delete)$/.test(new URL(response.url()).pathname)) requests.push({ url: response.url(), body: response.request().postDataJSON(), status: response.status() }); });
    await awaitMainUI(page, server.baseURL);
    await selectCharacterByName(page, OTHER_NAME); await expect(page.locator('#character_name_pole')).toHaveValue(OTHER_NAME);
    await selectCharacterByName(page, NAME); await expect(page.locator('#character_name_pole')).toHaveValue(NAME);
    await expect(page.locator('#lifetime-bind')).toBeVisible();
    await page.locator('#lifetime-load').click(); await expect(page.locator('#lifetime-output')).toHaveAttribute('data-last', 'load');
});

test.afterEach(async ({}, testInfo) => {
    await observe(testInfo, 'lifetime-http-responses', requests);
    if (fault) await observe(testInfo, 'database-fault-protocol', { database: database.dbName || database.schemaName, observations: fault.observations, errors: fault.errors });
    try { for (const pending of pendingFaults.reverse()) await pending.close(); }
    finally { try { if (fault) await fault.close(); } finally { if (database) await database.cleanup(); } }
});

async function state(page) {
    return page.evaluate(async () => {
        const ctx = window.Luker.getContext(); const core = await import('/script.js'); const wi = await import('/scripts/world-info.js');
        const selected = ctx.characters[ctx.characterId];
        return { acknowledged: core.settings, extensions: ctx.extensionSettings, world: wi.world_info, cards: ctx.characters.filter(card => ['lifetime-keeper.png', 'lifetime-other.png'].includes(card.avatar)).map(card => ({ avatar: card.avatar, live: card.data, json: JSON.parse(card.json_data).data })), selected: selected.avatar,
            editor: JSON.parse(document.querySelector('#character_json_data').value).data, form: document.querySelector('#character_world').value, bound: document.querySelector('#world_button').classList.contains('world_set'), menuBound: document.querySelector('#set_character_world').classList.contains('world_set'), draftControl: document.querySelector('#lifetime-draft').value, cache: Object.fromEntries(wi.worldInfoCache), events: window.lifetimeEvents };
    });
}
async function outcome(page, name) { return page.locator('#lifetime-output').evaluate((element, name) => JSON.parse(element.textContent).filter(item => item.name === name).at(-1), name); }
async function externalPage(context) { const page = await context.newPage(); await awaitMainUI(page, server.baseURL); await selectCharacterByName(page, OTHER_NAME); await expect(page.locator('#character_name_pole')).toHaveValue(OTHER_NAME); await selectCharacterByName(page, NAME); await expect(page.locator('#lifetime-delete')).toBeVisible(); return page; }
async function auxiliary(page) {
    const drawer = page.locator('#rightNavDrawerIcon'); if (await drawer.evaluate(element => element.classList.contains('closedIcon'))) await drawer.click();
    await page.locator('#world_button').click({ modifiers: ['Shift'] }); const dialog = page.locator('dialog[open]', { has: page.locator('.character_extra_world_info_selector') }); await expect(dialog).toBeVisible(); return dialog;
}
async function chooseAuxiliary(page, dialog) {
    await dialog.locator('.character_extra_world_info_selector + .select2 .select2-selection').click(); await page.locator('.select2-results__option', { hasText: OWNED }).click(); await dialog.locator('.character_name').click();
}

async function settleNavigation(page) {
    await expect.poll(() => page.evaluate(() => window.Luker.getContext().extensionSettings.quickReplyV2.characterConfigs['lifetime-keeper.png']?.setList)).toEqual([]);
    const drawer = page.locator('#rightNavDrawerIcon');
    if (await drawer.evaluate(element => element.classList.contains('closedIcon'))) await drawer.click();
    // Hydrate the acknowledged navigation snapshot before the competing read.
    await expect.poll(() => page.evaluate(async () => {
        const { settings } = await import('/script.js');
        return {
            nav: settings.accountStorage?.NavOpened,
            selected: settings.extension_settings?.quickReplyV2?.characterConfigs?.['lifetime-keeper.png']?.setList,
        };
    })).toEqual({ nav: 'true', selected: [] });
    await page.locator('#lifetime-read').click();
    await expect(page.locator('#lifetime-output')).toHaveAttribute('data-last', 'read');
    await expect.poll(() => page.evaluate(async () => {
        const { settings } = await import('/script.js');
        return {
            nav: settings.accountStorage?.NavOpened,
            persona: settings.accountStorage?.Personas_LastGlobalAvatar,
            selected: settings.extension_settings?.quickReplyV2?.characterConfigs?.['lifetime-keeper.png']?.setList,
        };
    })).toEqual({ nav: 'true', persona: 'user-default.png', selected: [] });
    await page.locator('#lifetime-load').click();
    await expect(page.locator('#lifetime-output')).toHaveAttribute('data-last', 'load');
}

for (const mode of ['mysql', 'postgres']) test.describe(mode, () => {
    test.use({ storageMode: mode });
    for (const order of ['deletion-before-source', 'source-before-deletion']) test(`${order} retains real delayed-source ownership`, async ({ page, context }, testInfo) => {
        const source = await state(page); const original = readFileSync(png()); const other = readFileSync(png(OTHER)); const keep = await worlds.get('default-user', KEEP);
        const external = await externalPage(context); const cache = holdCharacterCacheRead(server.dataRoot, png(OTHER)); pendingFaults.push(cache);
        const lock = await holdWorldRow(database, 'default-user', OWNED); pendingFaults.push(lock);
        try {
            let deletion;
            if (order === 'deletion-before-source') { deletion = external.locator('#lifetime-delete').click(); await expect.poll(async () => (await lock.waits()).length).toBe(1); }
            await page.locator('#lifetime-bind').click(); const sourceOpened = await cache.opened;
            if (order === 'source-before-deletion') { deletion = external.locator('#lifetime-delete').click(); await expect.poll(async () => (await lock.waits()).length).toBe(1); }
            const waiting = await lock.waits(); await lock.release(); await deletion;
            await expect(external.locator('#lifetime-output')).toHaveAttribute('data-last', 'delete');
            const absentBeforeSourceRelease = await worlds.get('default-user', OWNED); expect(absentBeforeSourceRelease).toBeNull();
            await cache.release(); await expect(page.locator('#lifetime-output')).toHaveAttribute('data-last', 'bind');
            const actual = { state: await state(page), original: data(readFileSync(png())), other: data(readFileSync(png(OTHER))), settings: await settingsRepo.get('default-user'), binding: await outcome(page, 'bind'), deletion: await outcome(external, 'delete'), keep: await worlds.get('default-user', KEEP) };
            await observe(testInfo, 'delayed-source-lifetime', { mode, order, source, expectedOriginal: fileState(original), expectedOther: fileState(other), original: fileState(readFileSync(png())), other: fileState(readFileSync(png(OTHER))), sourceOpened, waiting, absentBeforeSourceRelease, cacheDatum: cache.datum, actual, requests });
            expect(actual.binding).toEqual({ name: 'bind', value: false });
            expect(hash(readFileSync(png()))).toBe(hash(original)); expect(hash(readFileSync(png(OTHER)))).toBe(hash(other));
            expect(actual.state.cards).toEqual(source.cards); expect(actual.state.editor).toEqual(source.editor); expect(actual.state.form).toBe(KEEP); expect(actual.state.events.filter(event => event.name === 'binding')).toEqual([]);
            expect(actual.state.cache).toEqual(source.cache); expect(actual.state.bound).toBe(source.bound); expect(actual.state.menuBound).toBe(source.menuBound);
            expect(actual.keep).toEqual(keep);
        } finally { await external.close(); }
    });

    test('typed refusal expires an older read without discarding acknowledged authority', async ({ page, context }, testInfo) => {
        const external = await externalPage(context);
        await settleNavigation(external);
        await settleNavigation(page);
        await page.locator('#lifetime-draft').fill('before'); await page.locator('#lifetime-save').click(); await expect(page.locator('#lifetime-output')).toHaveAttribute('data-last', 'save');
        const baseline = (await outcome(page, 'save')).value.payload; expect(await settingsRepo.get('default-user')).toEqual(baseline);
        const before = await state(page); const original = readFileSync(png()); const other = readFileSync(png(OTHER));
        const cdp = await context.newCDPSession(page); let held; let resolveHeld; const readHeld = new Promise(resolve => { resolveHeld = resolve; });
        const network = [];
        const statuses = new Map();
        const headers = new Map();
        cdp.on('Network.requestWillBeSent', event => { if (/^\/api\/settings\/(get|fields|field|save|patch)$/.test(new URL(event.request.url).pathname)) network.push({ id: event.requestId, url: event.request.url, body: event.request.postData ? JSON.parse(event.request.postData) : null, source: event.initiator }); });
        cdp.on('Network.responseReceivedExtraInfo', event => statuses.set(event.requestId, event.statusCode));
        cdp.on('Network.requestWillBeSentExtraInfo', event => headers.set(event.requestId, Object.fromEntries(Object.entries(event.headers).map(([key, value]) => [key.toLowerCase(), value]))));
        await cdp.send('Network.enable');
        const onPause = event => { held = event; resolveHeld(event); }; cdp.on('Fetch.requestPaused', onPause);
        await cdp.send('Fetch.enable', { patterns: [{ urlPattern: '*/api/settings/fields?*', requestStage: 'Response' }] });
        const lock = await holdWorldRow(database, 'default-user', OWNED); pendingFaults.push(lock);
        try {
            await page.locator('#lifetime-read').click(); const response = await readHeld; expect(response.responseStatusCode).toBe(200);
            const raw = await cdp.send('Fetch.getResponseBody', { requestId: response.requestId });
            const directory = JSON.parse(raw.base64Encoded ? Buffer.from(raw.body, 'base64').toString('utf8') : raw.body);
            expect(directory.fields).toContainEqual(expect.objectContaining({ path: '/extension_settings/lifetime_draft' }));
            const directoryEtag = response.responseHeaders.find(header => header.name.toLowerCase() === 'etag')?.value;
            expect(directoryEtag).toMatch(/^W\//);
            const readSource = baseline;
            const deleting = external.locator('#lifetime-delete').click(); await expect.poll(async () => (await lock.waits()).length).toBe(1);
            const dialog = await auxiliary(page); const saved = page.waitForResponse(response => /\/api\/settings\/(save|patch)$/.test(response.url()) && JSON.stringify(response.request().postDataJSON()).includes(OWNED));
            const writing = page.waitForRequest(request => /\/api\/settings\/(save|patch)$/.test(request.url()) && JSON.stringify(request.postDataJSON()).includes(OWNED));
            await chooseAuxiliary(page, dialog); await writing; await lock.release(); await deleting;
            expect((await saved).status()).toBe(409); await expect(page.locator('#toast-container')).toContainText('Settings could not be saved');
            await dialog.locator('.popup-button-ok').click(); await expect(dialog).toHaveCount(0);
            await page.locator('#lifetime-draft').fill('after'); const intended = await state(page);
            expect(intended.extensions).toEqual({ ...before.extensions, lifetime_draft: { value: 'after', retained: ['draft sibling'] } });
            expect(intended.world).toEqual({ ...before.world, charLore: [{ name: 'lifetime-keeper', extraBooks: [OWNED] }] });
            await cdp.send('Fetch.continueResponse', { requestId: response.requestId }); held = null;
            await expect(page.locator('#lifetime-output')).toHaveAttribute('data-last', 'read');
            await cdp.send('Fetch.disable');
            const actual = await state(page); const stored = await settingsRepo.get('default-user');
            await observe(testInfo, 'held-read-after-refusal', { mode, before, baseline, readSource, directory, response, intended, actual, stored, expectedOriginal: fileState(original), expectedOther: fileState(other), original: fileState(readFileSync(png())), other: fileState(readFileSync(png(OTHER))), requests });
            expect(actual.extensions).toEqual(intended.extensions); expect(actual.world).toEqual(intended.world); expect(actual.draftControl).toBe('after');
            expect(actual.acknowledged).toEqual(intended.acknowledged); expect(stored).toEqual(baseline);
            expect(actual.events.filter(event => event.name === 'SETTINGS_LOADED')).toEqual(intended.events.filter(event => event.name === 'SETTINGS_LOADED'));
            expect(actual.events.filter(event => event.name === 'SETTINGS_UPDATED' && event.settings.world_info_settings.world_info.charLore?.some(entry => entry.extraBooks.includes(OWNED)))).toEqual([]);
            expect(actual.cards).toEqual(before.cards); expect(actual.editor).toEqual(before.editor); expect(hash(readFileSync(png()))).toBe(hash(original)); expect(hash(readFileSync(png(OTHER)))).toBe(hash(other));
            expect(actual.form).toBe(before.form); expect(actual.bound).toBe(before.bound); expect(actual.menuBound).toBe(before.menuBound); expect(actual.cache).toEqual(intended.cache);
            const readCount = network.length;
            await page.locator('#lifetime-raw').click(); await expect(page.locator('#lifetime-output')).toHaveAttribute('data-last', 'raw');
            const cachedRead = JSON.parse((await outcome(page, 'raw')).value.settings);
            await observe(testInfo, 'raw-cache-after-refusal', { readSource, cachedRead, before: actual, after: await state(page), requests, network });
            expect(cachedRead).toEqual(readSource);
            const cachedRequests = network.slice(readCount).filter(request => /^\/api\/settings\/fields?$/.test(new URL(request.url).pathname));
            expect(cachedRequests.map(request => new URL(request.url).searchParams.get('path') || '').sort()).toEqual(['', ...directory.fields.map(field => field.path)].sort());
            await expect.poll(() => cachedRequests.map(request => statuses.get(request.id))).toEqual(cachedRequests.map(() => 304));
            const validators = new Map(directory.fields.map(field => [field.path, field.etag]));
            validators.set('', directoryEtag);
            for (const request of cachedRequests) {
                expect(headers.get(request.id)?.['if-none-match']).toBe(validators.get(new URL(request.url).searchParams.get('path') || ''));
            }
            expect(requests.filter(request => new URL(request.url).pathname === '/api/settings/get')).toEqual([]);
            const recovered = page.waitForResponse(response => {
                if (!/\/api\/settings\/(save|patch)$/.test(response.url())) return false;
                const body = response.request().postDataJSON();
                return body.operations?.some(operation => operation.op === 'replace' && operation.path === '/extension_settings/lifetime_draft/value' && operation.value === 'after') || body.extension_settings?.lifetime_draft?.value === 'after';
            });
            await page.locator('#lifetime-recover').click(); const recoveryResponse = await recovered; expect(recoveryResponse.ok()).toBe(true);
            await expect(page.locator('#lifetime-output')).toHaveAttribute('data-last', 'recover');
            await expect.poll(async () => (await state(page)).acknowledged.world_info_settings.world_info.charLore).toEqual([]);
            const acknowledged = await state(page); expect(acknowledged.extensions.lifetime_draft).toEqual({ value: 'after', retained: ['draft sibling'] }); expect(acknowledged.world.charLore).toEqual([]);
            const loading = page.waitForResponse(response => new URL(response.url()).pathname === '/api/settings/fields'); await page.locator('#lifetime-read').click(); expect((await loading).ok()).toBe(true);
            await expect.poll(async () => (await state(page)).events.filter(event => event.name === 'SETTINGS_LOADED').length).toBe(acknowledged.events.filter(event => event.name === 'SETTINGS_LOADED').length + 1);
            const final = await state(page); expect(final.extensions.lifetime_draft).toEqual({ value: 'after', retained: ['draft sibling'] }); expect(final.world.charLore).toEqual([]);
            await observe(testInfo, 'refusal-recovery', { cachedRead, acknowledged, final, recoveryRequest: recoveryResponse.request().postDataJSON(), stored: await settingsRepo.get('default-user'), requests });
        } finally { if (held) await cdp.send('Fetch.continueResponse', { requestId: held.requestId }); cdp.off('Fetch.requestPaused', onPause); await cdp.send('Fetch.disable'); await cdp.detach(); await external.close(); }
    });

    test.describe('database acknowledgement loss', () => {
        test.use({ commitFault: true });

        test('unknown deletion terminates an auxiliary settings attempt without a full-save retry', async ({ page }, testInfo) => {
            await settleNavigation(page);
            await page.locator('#lifetime-save').click(); await expect(page.locator('#lifetime-output')).toHaveAttribute('data-last', 'save');
            const source = await state(page); const stored = await settingsRepo.get('default-user');
            const held = fault.arm(); await page.locator('#lifetime-delete').click(); const acknowledgement = await held;
            expect(await worlds.get('default-user', OWNED)).toBeNull();
            const dialog = await auxiliary(page);
            const writing = page.waitForRequest(request => /\/api\/settings\/(save|patch)$/.test(request.url()) && JSON.stringify(request.postDataJSON()).includes(OWNED));
            const response = page.waitForResponse(response => /\/api\/settings\/(save|patch)$/.test(response.url()) && JSON.stringify(response.request().postDataJSON()).includes(OWNED));
            await chooseAuxiliary(page, dialog); await writing; await fault.drop();
            const refused = await response; expect(refused.status()).toBe(409); const refusal = await refused.json();
            await expect(page.locator('#toast-container')).toContainText('Settings could not be saved');
            const actual = { state: await state(page), stored: await settingsRepo.get('default-user'), refusal, requests: requests.filter(request => /\/api\/settings\/(save|patch)$/.test(request.url) && JSON.stringify(request.body).includes(OWNED)), observations: fault.observations, errors: fault.errors };
            await observe(testInfo, 'auxiliary-commit-acknowledgement-loss', { acknowledgement, source, stored, actual });
            expect(refusal.code).toBe('world_deletion_unknown'); expect(actual.stored).toEqual(stored);
            expect(actual.state.world).toEqual({ ...source.world, charLore: [{ name: 'lifetime-keeper', extraBooks: [OWNED] }] });
            expect(actual.state.acknowledged).toEqual(source.acknowledged); expect(actual.requests).toMatchObject([{ status: 409 }]);
            expect(actual.state.cache).toEqual(source.cache); expect(actual.state.cards).toEqual(source.cards); expect(actual.state.editor).toEqual(source.editor);
            expect(actual.state.events.filter(event => event.name === 'SETTINGS_UPDATED'
                && event.settings.world_info_settings.world_info.charLore?.some(entry => entry.extraBooks?.includes(OWNED)))).toEqual([]);
        });

        test('unknown database commit cannot acknowledge a primary reference', async ({ page }, testInfo) => {
            const source = await state(page); const original = readFileSync(png(OTHER));
            const cache = holdCharacterCacheRead(server.dataRoot, png(OTHER)); pendingFaults.push(cache);
            const held = fault.arm(); await page.locator('#lifetime-delete').click(); const acknowledgement = await held;
            expect(await worlds.get('default-user', OWNED)).toBeNull();
            const writing = page.waitForRequest(request => request.url().endsWith('/api/characters/merge-attributes') && request.postDataJSON().avatar === OTHER);
            await page.locator('#lifetime-bind').click(); await writing; const sourceOpened = await cache.opened; await fault.drop();
            await expect.poll(async () => { const history = await page.locator('#lifetime-output').innerText(); return history && JSON.parse(history).some(item => item.name === 'delete'); }).toBe(true);
            await cache.release();
            await expect.poll(async () => { const history = await page.locator('#lifetime-output').innerText(); return history && JSON.parse(history).some(item => item.name === 'bind'); }).toBe(true);
            const actual = { state: await state(page), binding: await outcome(page, 'bind'), original: data(readFileSync(png(OTHER))), book: await worlds.get('default-user', OWNED), requests, observations: fault.observations, errors: fault.errors };
            await observe(testInfo, 'primary-commit-acknowledgement-loss', { acknowledgement, sourceOpened, source, expected: fileState(original), original: fileState(readFileSync(png(OTHER))), actual });
            expect(actual.binding).toEqual({ name: 'bind', value: false }); expect(hash(readFileSync(png(OTHER)))).toBe(hash(original)); expect(actual.state.cards).toEqual(source.cards); expect(actual.book).toBeNull();
        });
    });
});
