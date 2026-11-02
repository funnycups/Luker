// Group initialization uses genuine DOM actions and acknowledged server bytes.
// Fault routes retain actual server responses or cancel the actual transport.
/* eslint playwright/no-conditional-expect: off -- Table cases have distinct success and failure contracts. */
import fs from 'node:fs';
import path from 'node:path';
import { randomBytes } from 'node:crypto';
import { isDeepStrictEqual } from 'node:util';
import { test, expect } from '@playwright/test';
import { startServer, tearDownServer } from '../_lib/server.js';
import { onboardS3Page, reloadS3Page, awaitS3Page } from '../_lib/sync-s3.js';
import { openCharacterList } from '../_lib/ui-character.js';
import { closeAnyOpenTopSettingsDrawer, editMessageViaUI, openTopDrawer } from '../_lib/page.js';
import { openChatByName } from '../_lib/sync.js';

const AVATAR = 'default_Seraphina.png';
const TURN = '*I raise the lantern.* "Keep every word: 渡口, 🌙, and \\ reeds."';
const EDIT = 'The lantern shines beyond the reeds. "Follow the moonlit path."';
const IMPORTED = [
    { name: 'Seraphina', is_user: false, is_system: false, mes: 'Original imported greeting.', send_date: '2026-10-26T10:00:00Z', extra: { retained: ['moon', 'reeds'] } },
    { name: 'User', is_user: true, is_system: false, mes: 'Original imported reply: 渡口 🌙.', send_date: '2026-10-26T10:00:01Z', extra: {} },
];
const HEADER = { user_name: 'unused', character_name: 'unused', chat_metadata: { note_prompt: 'Imported metadata stays here', tainted: true } };
test.describe.configure({ timeout: 180_000 });

const observe = promise => promise.then(value => ({ value }), error => ({ error }));
async function observed(promise) {
    const result = await promise;
    if (result.error) throw result.error;
    return result.value;
}
const storedPath = (server, id) => path.join(server.dataRoot, 'default-user', 'group chats', `${id}.jsonl`);
const stored = (server, id) => fs.existsSync(storedPath(server, id)) ? fs.readFileSync(storedPath(server, id), 'utf8') : null;
const file = (server, id) => {
    const bytes = stored(server, id);
    return bytes === null ? null : bytes.trim().split('\n').filter(Boolean).map(line => JSON.parse(line));
};

async function state(page, id = null) {
    return page.evaluate(async id => {
        const context = window.Luker.getContext();
        const mod = await import('/script.js');
        const target = { is_group: true, id: id ?? context.getCurrentChatId() };
        return JSON.parse(JSON.stringify({ groupId: context.groupId, id: context.getCurrentChatId(), metadata: context.chatMetadata,
            messages: context.chat, messageSnapshot: mod.getChatMessageSnapshot(target), metadataSnapshot: mod.getChatMetadataSnapshot(target) }));
    }, id);
}

async function scenario(browser, info, body) {
    const server = await startServer({ batchKey: 'sync', scenarioId: `group-initialization-${randomBytes(6).toString('hex')}` });
    const contexts = [], jobs = [], requiredJobs = [], releases = [], routes = [], records = [], network = [], consoleErrors = [];
    const runtimes = [server.execArgv];
    const pages = [];
    const scope = {
        server, records, network, consoleErrors,
        async page({ onboard = false } = {}) {
            const context = await browser.newContext({ locale: 'en-US', viewport: { width: 1440, height: 1100 } });
            contexts.push(context);
            const page = await context.newPage();
            pages.push(page);
            page.on('console', message => { if (message.type() === 'error' || message.type() === 'warning') consoleErrors.push(message.text()); });
            page.on('pageerror', error => consoleErrors.push(`pageerror: ${error.stack}`));
            page.on('request', request => {
                const pathname = new URL(request.url()).pathname;
                if (/^\/api\/(chats\/group\/|groups\/)/.test(pathname)) network.push({ kind: pathname.startsWith('/api/groups/') ? 'group-request' : 'request', url: request.url(), body: request.postData() });
            });
            page.on('requestfailed', request => network.push({ kind: 'failure', url: request.url(), error: request.failure() }));
            page.on('response', response => {
                const pathname = new URL(response.url()).pathname;
                if (!/^\/api\/(chats\/group\/|groups\/)/.test(pathname)) return;
                const job = observe((async () => network.push({ kind: pathname.startsWith('/api/groups/') ? 'group-response' : 'response', url: response.url(), status: response.status(), body: await response.text() }))());
                jobs.push(job);
            });
            if (onboard) await onboardS3Page(page, server.baseURL);
            else { await page.goto(server.baseURL); await awaitS3Page(page); }
            return page;
        },
        async record(label, page, id) {
            records.push({ label, state: await state(page, id), stored: stored(server, id) });
        },
        response(page, endpoint) {
            const job = observe((async () => await page.waitForResponse(response => new URL(response.url()).pathname === endpoint))());
            jobs.push(job);
            requiredJobs.push(job);
            return job;
        },
        job(promise) {
            const job = observe(promise);
            jobs.push(job);
            requiredJobs.push(job);
            return job;
        },
        async route(page, endpoint, handler) {
            const pattern = `**${endpoint}`;
            const tracked = route => {
                const job = observe(handler(route));
                jobs.push(job);
                requiredJobs.push(job);
                return observed(job);
            };
            await page.route(pattern, tracked);
            routes.push({ page, pattern, tracked });
            return async () => page.unroute(pattern, tracked);
        },
        async hold(page, endpoint, { afterForward = false, requestOverrides = {}, when = () => true } = {}) {
            const entered = Promise.withResolvers(), gate = Promise.withResolvers(), completed = Promise.withResolvers();
            releases.push(gate.resolve);
            let first = true;
            let reached = false;
            const unroute = await scope.route(page, endpoint, async route => {
                if (!first || !when(route.request())) return route.continue();
                first = false;
                try {
                    const overrides = typeof requestOverrides === 'function' ? requestOverrides(route.request()) : requestOverrides;
                    if (Object.keys(overrides).length) network.push({ kind: 'forwarded-request', url: route.request().url(), overrides });
                    const response = afterForward ? await route.fetch(overrides) : null;
                    reached = true;
                    entered.resolve({ request: route.request(), response });
                    await gate.promise;
                    if (response) await route.fulfill({ response });
                    else await route.continue();
                } finally {
                    completed.resolve();
                }
            });
            return {
                async entered() {
                    await expect.poll(() => reached, { timeout: 10_000, message: `The real ${endpoint} request must reach its hold` }).toBe(true);
                    return entered.promise;
                },
                async release() { gate.resolve(); await completed.promise; },
                unroute,
            };
        },
        async restart() { await server.restart(); runtimes.push(server.execArgv); },
    };
    const failures = [];
    try {
        const actual = process.env.LUKER_SYNC_ACCEPTANCE_JITLESS === '1';
        expect(server.execArgv.includes('--jitless')).toBe(actual);
        await body(scope);
    } catch (error) {
        failures.push(error);
    } finally {
        for (const release of releases) release();
        const bodyFailed = failures.length > 0;
        let closed;
        if (bodyFailed) {
            for (const page of pages) {
                if (!page.isClosed()) {
                    try { records.push({ label: 'failure-live-state', state: await state(page) }); } catch (error) { records.push({ label: 'failure-observation-error', error: error.message }); }
                }
            }
            // Closing owned contexts cancels response waiters that the failed body never reached.
            closed = await Promise.allSettled(contexts.map(context => context.close()));
        }
        await Promise.all(requiredJobs);
        for (const { page, pattern, tracked } of routes) {
            if (!page.isClosed()) await page.unroute(pattern, tracked);
        }
        for (const page of pages) {
            if (!page.isClosed()) {
                try { records.push({ label: 'terminal-live-state', state: await state(page) }); } catch (error) { records.push({ label: 'terminal-observation-error', error: error.message }); }
            }
        }
        if (!bodyFailed) closed = await Promise.allSettled(contexts.map(context => context.close()));
        const settled = await Promise.all(jobs);
        failures.push(...(await Promise.all(requiredJobs)).filter(result => result.error).map(result => result.error));
        failures.push(...closed.filter(result => result.status === 'rejected').map(result => result.reason));
        // Closing a browser can end a response body; keep that diagnostic, not a fabricated body.
        network.push(...settled.filter(result => result.error).map(result => ({ kind: 'observer-error', error: result.error.message })));
        const directory = path.join(server.dataRoot, 'default-user', 'group chats');
        const files = fs.existsSync(directory) ? Object.fromEntries(fs.readdirSync(directory).filter(name => name.endsWith('.jsonl')).map(name => [name, fs.readFileSync(path.join(directory, name), 'utf8')])) : {};
        const evidencePath = info.outputPath('group-boundary-evidence.json');
        fs.writeFileSync(evidencePath, JSON.stringify({ runtimes, records, network, consoleErrors, files }, null, 2));
        await info.attach('group-boundary-evidence', { path: evidencePath, contentType: 'application/json' });
        await info.attach('server.log', { body: server.outputEpochs.join('\n'), contentType: 'text/plain' });
        await tearDownServer(server);
    }
    if (failures.length) throw new AggregateError(failures, 'Group boundary scenario failed', { cause: failures[0] });
}

async function command(page, text) {
    await closeAnyOpenTopSettingsDrawer(page);
    await page.locator('#send_textarea').fill(text);
    await page.locator('#send_textarea').press('Enter');
}

async function reloadChat(page) {
    const completed = `Chat reload completed ${randomBytes(6).toString('hex')}`;
    await command(page, `/chat-reload | /echo ${completed}`);
    await expect(page.locator('.toast', { hasText: completed })).toBeVisible();
}

async function createGroup(scope, page, name = 'Lantern Watch', { open = true } = {}) {
    await openCharacterList(page);
    await page.locator('#rm_button_group_chats').click();
    await page.locator('#rm_group_chat_name').fill(name);
    const member = page.locator('#rm_group_add_members .group_member').filter({ has: page.locator(`img[title="${AVATAR}"]`) });
    await expect(member).toHaveCount(1);
    await member.locator('[data-action="add"]').click();
    const created = scope.response(page, '/api/groups/create');
    await page.locator('#rm_group_submit').click();
    const response = await observed(created);
    expect(response.ok()).toBe(true);
    const { id } = await response.json();
    await expect(page.locator('.toast-success', { hasText: 'Group Created' })).toBeVisible();
    if (open) await openGroup(page, id);
    return id;
}

async function openGroup(page, id) {
    await openCharacterList(page);
    await page.locator(`#rm_print_characters_block .group_select[data-grid="${id}"]`).click();
    await page.waitForFunction(id => window.Luker.getContext().groupId === id, id);
    await closeAnyOpenTopSettingsDrawer(page);
}

async function readyGreeting(page) {
    await expect(page.locator('#chat .mes[mesid="0"] .mes_text')).not.toBeEmpty();
    await page.waitForFunction(() => !!window.Luker.getContext().chatMetadata.integrity);
    return state(page);
}

async function assertComplete(scope, page, id, texts) {
    await expect.poll(() => file(scope.server, id)?.slice(1).map(message => message.mes), { timeout: 10_000, message: 'Stored group conversation must retain the complete displayed sequence' }).toEqual(texts);
    await expect.poll(async () => {
        const current = await state(page, id);
        return { messages: current.messageSnapshot, integrity: current.metadata.integrity };
    }).toEqual({ messages: file(scope.server, id).slice(1), integrity: file(scope.server, id)[0].chat_metadata.integrity });
    const current = await state(page, id);
    const persisted = file(scope.server, id);
    expect(persisted.slice(1)).toEqual(current.messages);
    expect(current.messageSnapshot).toEqual(persisted.slice(1));
    expect(current.metadata.integrity).toBe(persisted[0].chat_metadata.integrity);
    await scope.record('complete-conversation', page, id);
    return current;
}

async function manager(page) {
    await closeAnyOpenTopSettingsDrawer(page);
    await page.locator('#options_button').click();
    await page.locator('#option_select_chat').click();
    await expect(page.locator('#shadow_select_chat_popup')).toBeVisible();
}

async function newChat(page) {
    await manager(page);
    await page.locator('#newChatFromManageScreenButton').click();
    await expect(page.locator('#shadow_select_chat_popup')).toBeHidden();
}

async function importChat(scope, page, content = [HEADER, ...IMPORTED]) {
    await manager(page);
    const response = scope.response(page, '/api/chats/group/import');
    await page.locator('#chat_import_file').setInputFiles({ name: 'owned-import.jsonl', mimeType: 'application/octet-stream', buffer: Buffer.from(content.map(value => JSON.stringify(value)).join('\n')) });
    const actual = await observed(response);
    expect(actual.ok()).toBe(true);
    const { res: id } = await actual.json();
    expect(id).toBeTruthy();
    await expect(page.locator('.select_chat_block_filename', { hasText: id })).toHaveCount(1);
    await page.locator('#select_chat_cross').click();
    await openChatByName(page, id);
    await page.waitForFunction(id => window.Luker.getContext().getCurrentChatId() === id && !!window.Luker.getContext().chatMetadata.integrity, id);
    return id;
}

function assertNoUnexpectedConflict(scope) {
    expect(scope.network.filter(row => row.kind === 'response' && row.status === 409)).toEqual([]);
    expect(scope.consoleErrors.filter(text => /ChatWriteConflict|save refused|save aborted|\/0 missing/i.test(text))).toEqual([]);
}

test('fresh group acknowledges its complete greeting before the first real user append', async ({ browser }, info) => {
    await scenario(browser, info, async scope => {
        const page = await scope.page({ onboard: true });
        await createGroup(scope, page);
        const initial = await readyGreeting(page);
        await scope.record('initial-greeting', page, initial.id);
        const acknowledged = await assertComplete(scope, page, initial.id, [initial.messages[0].mes]);
        const initialWrite = scope.network.find(row => row.kind === 'request' && row.url.endsWith('/group/save'));
        expect(initialWrite).toBeTruthy();
        const payload = JSON.parse(initialWrite.body);
        expect(payload.force).toBe(false);
        expect(payload.chat.slice(1)).toEqual(initial.messages);
        expect(acknowledged.metadataSnapshot).toEqual({ ...payload.chat[0].chat_metadata, integrity: acknowledged.metadata.integrity });
        expect(payload.chat[0].chat_metadata.integrity).not.toBe((await state(page)).metadata.integrity);
        await command(page, `/send ${TURN}`);
        await expect(page.locator('#chat .mes[mesid="1"] .mes_text')).toContainText('Keep every word');
        await assertComplete(scope, page, initial.id, [initial.messages[0].mes, TURN]);
        const append = scope.network.find(row => row.kind === 'request' && row.url.endsWith('/group/append'));
        expect(JSON.parse(append.body).integrity).toBe(acknowledged.metadata.integrity);
        await command(page, '/forcesave | /echo Metadata synchronized.');
        await expect(page.locator('.toast', { hasText: 'Metadata synchronized.' })).toBeVisible();
        const beforeNoop = scope.network.filter(row => row.kind === 'request').length;
        const noopBytes = stored(scope.server, initial.id);
        await command(page, '/forcesave | /echo No-op synchronized.');
        await expect(page.locator('.toast', { hasText: 'No-op synchronized.' })).toBeVisible();
        expect(scope.network.filter(row => row.kind === 'request')).toHaveLength(beforeNoop);
        expect(stored(scope.server, initial.id)).toBe(noopBytes);
        assertNoUnexpectedConflict(scope);
    });
});

test('fresh greeting DOM edit preserves its first message instead of patching a nonexistent baseline', async ({ browser }, info) => {
    await scenario(browser, info, async scope => {
        const page = await scope.page({ onboard: true });
        await createGroup(scope, page);
        const initial = await readyGreeting(page);
        await scope.record('before-first-edit', page, initial.id);
        await editMessageViaUI(page, 0, EDIT);
        await assertComplete(scope, page, initial.id, [EDIT]);
        expect((await state(page)).messages[0].mes).toBe(EDIT);
        assertNoUnexpectedConflict(scope);
    });
});

test('another new chat retains complete messages through edit, reopen, reload and server restart', async ({ browser }, info) => {
    await scenario(browser, info, async scope => {
        const page = await scope.page({ onboard: true });
        const group = await createGroup(scope, page);
        const original = await readyGreeting(page);
        await command(page, `/send ${TURN}`);
        await assertComplete(scope, page, original.id, [original.messages[0].mes, TURN]);
        await editMessageViaUI(page, 0, EDIT);
        await assertComplete(scope, page, original.id, [EDIT, TURN]);
        const originalBytes = stored(scope.server, original.id);
        await newChat(page);
        const next = await readyGreeting(page);
        expect(next.id).not.toBe(original.id);
        await assertComplete(scope, page, next.id, [next.messages[0].mes]);
        expect(next.metadata.integrity).not.toBe(original.metadata.integrity);
        await command(page, '/send A new conversation beneath the birches.');
        await assertComplete(scope, page, next.id, [next.messages[0].mes, 'A new conversation beneath the birches.']);
        const nextBytes = stored(scope.server, next.id);
        await openChatByName(page, original.id);
        await assertComplete(scope, page, original.id, [EDIT, TURN]);
        await reloadChat(page);
        await assertComplete(scope, page, original.id, [EDIT, TURN]);
        await scope.restart();
        await reloadS3Page(page);
        await openGroup(page, group);
        await openChatByName(page, original.id);
        await assertComplete(scope, page, original.id, [EDIT, TURN]);
        expect(stored(scope.server, original.id)).toBe(originalBytes);
        expect(stored(scope.server, next.id)).toBe(nextBytes);
        assertNoUnexpectedConflict(scope);
    });
});

for (const kind of ['existing', 'headerless legacy', 'header-only']) {
    test(`imported ${kind} uses original server bytes before rendering and retains metadata`, async ({ browser }, info) => {
        await scenario(browser, info, async scope => {
            const page = await scope.page({ onboard: true });
            await createGroup(scope, page);
            await readyGreeting(page);
            const content = kind === 'headerless legacy' ? IMPORTED : kind === 'header-only' ? [HEADER] : [HEADER, ...IMPORTED];
            const id = await importChat(scope, page, content);
            const loaded = file(scope.server, id);
            const loadedState = await state(page, id);
            expect(loadedState.messageSnapshot).toEqual(loaded.slice(1));
            expect(loadedState.messages.map(message => message.mes)).toEqual(kind === 'header-only' ? [] : IMPORTED.map(message => message.mes));
            await scope.record('imported-before-render-edit', page, id);
            await command(page, '/setvar key=acknowledged_import retained');
            await expect.poll(() => file(scope.server, id)[0].chat_metadata.variables?.acknowledged_import).toBe('retained');
            expect(file(scope.server, id).slice(1)).toEqual(loaded.slice(1));
            if (kind !== 'header-only') {
                await editMessageViaUI(page, 0, EDIT);
                const patches = scope.network.filter(row => row.kind === 'request' && row.url.endsWith('/group/patch')).map(row => JSON.parse(row.body));
                expect(patches.flatMap(payload => payload.operations)).toContainEqual({ op: 'test', path: '/0', value: IMPORTED[0] });
                const after = file(scope.server, id);
                expect(after[1].mes).toBe(EDIT);
                expect(after[2]).toEqual(loaded[2]);
                expect(after[0].chat_metadata.integrity).not.toBe(loaded[0].chat_metadata.integrity);
            }
            if (kind !== 'headerless legacy') expect(file(scope.server, id)[0].chat_metadata.note_prompt).toBe(HEADER.chat_metadata.note_prompt);
            await command(page, '/send Imported follow-up stays last.');
            await expect.poll(() => file(scope.server, id).at(-1).mes).toBe('Imported follow-up stays last.');
            expect(file(scope.server, id).slice(1).map(message => message.mes)).toEqual(kind === 'header-only' ? ['Imported follow-up stays last.'] : [EDIT, IMPORTED[1].mes, 'Imported follow-up stays last.']);
            await reloadChat(page);
            await expect.poll(async () => (await state(page)).messages.map(message => message.mes)).toEqual(file(scope.server, id).slice(1).map(message => message.mes));
            assertNoUnexpectedConflict(scope);
        });
    });
}

async function fault(route, kind, baseURL, network) {
    if (kind === 'network') return route.abort('failed');
    const overrides = kind === 'HTTP' ? { postData: '{}' }
        : kind === 'non-array' ? { url: `${baseURL}/api/chats/group/info` }
            : { url: `${baseURL}/`, method: 'GET', postData: '' };
    network.push({ kind: 'forwarded-request', url: overrides.url ?? route.request().url(), method: overrides.method ?? route.request().method(), body: overrides.postData ?? route.request().postData() });
    return route.continue(overrides);
}

for (const kind of ['HTTP', 'network', 'invalid JSON', 'non-array']) {
    test(`failed ${kind} group reload preserves stored bytes and valid cache without granting write authority`, async ({ browser }, info) => {
        await scenario(browser, info, async scope => {
            const page = await scope.page({ onboard: true });
            await createGroup(scope, page);
            await readyGreeting(page);
            const id = await importChat(scope, page);
            const bytes = stored(scope.server, id);
            const before = await state(page, id);
            const start = scope.network.length;
            const unroute = await scope.route(page, '/api/chats/group/get', route => fault(route, kind, scope.server.baseURL, scope.network));
            await reloadChat(page);
            await expect(page.locator('.toast-error', { hasText: id }), 'Failed load must visibly identify its group chat').toBeVisible({ timeout: 10_000 });
            const failed = await state(page, id);
            await scope.record(`${kind}-load-refused`, page, id);
            expect(failed.metadata.integrity).toBeUndefined();
            expect(failed.messageSnapshot).toEqual(before.messageSnapshot);
            expect(failed.metadataSnapshot).toEqual(before.metadataSnapshot);
            expect(stored(scope.server, id)).toBe(bytes);
            await command(page, '/send Must not overwrite unread server data.');
            await expect(page.locator('.toast-error', { hasText: 'Chat save aborted' })).toBeVisible();
            expect(scope.network.slice(start).filter(row => row.kind === 'request' && /\/(save|patch|append|meta\/patch)$/.test(row.url))).toEqual([]);
            expect(stored(scope.server, id)).toBe(bytes);
            await unroute();
            await reloadChat(page);
            await expect.poll(async () => (await state(page)).messages.map(message => message.mes)).toEqual(IMPORTED.map(message => message.mes));
            expect(stored(scope.server, id)).toBe(bytes);
        });
    });
}

for (const kind of ['HTTP', 'network', 'invalid JSON', 'non-array']) {
    test(`failed ${kind} initial save does not acknowledge its greeting and the next real send recovers both messages`, async ({ browser }, info) => {
        await scenario(browser, info, async scope => {
            const page = await scope.page({ onboard: true });
            const unroute = await scope.route(page, '/api/chats/group/save', route => fault(route, kind, scope.server.baseURL, scope.network));
            const group = await createGroup(scope, page);
            const initial = await readyGreeting(page);
            await expect(page.locator('.toast-error', { hasText: 'could not be saved' })).toBeVisible({ timeout: 10_000 });
            await scope.record(`${kind}-initial-save-refused`, page, initial.id);
            expect(stored(scope.server, initial.id)).toBeNull();
            expect((await state(page)).messageSnapshot).toBeNull();
            expect((await state(page)).metadataSnapshot).toBeNull();
            await unroute();
            const start = scope.network.length;
            await command(page, `/send ${TURN}`);
            await assertComplete(scope, page, initial.id, [initial.messages[0].mes, TURN]);
            expect(scope.network.slice(start).filter(row => row.kind === 'request' && row.url.endsWith('/group/append'))).toEqual([]);
            const recovery = JSON.parse(scope.network.slice(start).find(row => row.kind === 'request' && row.url.endsWith('/group/save')).body);
            expect(recovery.force).toBe(false);
            expect(recovery.chat.slice(1)).toEqual((await state(page)).messages);
            await editMessageViaUI(page, 0, EDIT);
            await assertComplete(scope, page, initial.id, [EDIT, TURN]);
            await reloadChat(page);
            await assertComplete(scope, page, initial.id, [EDIT, TURN]);
            await scope.restart();
            await reloadS3Page(page);
            await openGroup(page, group);
            await expect.poll(async () => (await state(page)).messages.map(message => message.mes)).toEqual([EDIT, TURN]);
        });
    });
}

test('a delayed group load cannot render or initialize over a later real character target', async ({ browser }, info) => {
    await scenario(browser, info, async scope => {
        const page = await scope.page({ onboard: true });
        const group = await createGroup(scope, page, 'Delayed group', { open: false });
        const hold = await scope.hold(page, '/api/chats/group/get');
        await openGroup(page, group);
        const { request } = await hold.entered();
        const { id } = request.postDataJSON();
        await openCharacterList(page);
        await page.locator('#rm_print_characters_block .character_select').filter({ has: page.locator(`img[src*="file=${AVATAR}"]`) }).click();
        await page.waitForFunction(() => !window.Luker.getContext().groupId && window.Luker.getContext().chat.length > 0);
        const before = await state(page, id);
        await hold.release();
        await hold.unroute();
        await command(page, '/send This message belongs to the character chat.');
        await expect(page.locator('#chat .mes[mesid="1"] .mes_text')).toContainText('belongs to the character');
        const after = await state(page, id);
        expect(after.groupId).toBeFalsy();
        expect(after.id).toBe(before.id);
        expect(after.messageSnapshot).toBeNull();
        expect(stored(scope.server, id)).toBeNull();
        expect(scope.network.filter(row => row.kind === 'request' && row.url.endsWith('/group/save'))).toEqual([]);
        await scope.record('late-load-does-not-own-current-target', page, id);
    });
});

test('first-save acknowledgement cannot reseed a live DOM edit made during the network round trip', async ({ browser }, info) => {
    await scenario(browser, info, async scope => {
        const page = await scope.page({ onboard: true });
        const hold = await scope.hold(page, '/api/chats/group/save', { afterForward: true });
        await createGroup(scope, page);
        const { request } = await hold.entered();
        const payload = request.postDataJSON();
        const id = payload.id;
        await expect(page.locator('#chat .mes[mesid="0"]')).toBeVisible();
        const message = page.locator('#chat .mes[mesid="0"]');
        await message.hover();
        await message.locator('.mes_edit').first().click();
        await message.locator('.edit_textarea').fill(EDIT);
        await message.locator('.mes_edit_done').first().click();
        await expect.poll(async () => (await state(page)).messages[0].mes).toBe(EDIT);
        expect(file(scope.server, id).slice(1)).toEqual(payload.chat.slice(1));
        await hold.release();
        await hold.unroute();
        await assertComplete(scope, page, id, [EDIT]);
        await command(page, `/send ${TURN}`);
        await assertComplete(scope, page, id, [EDIT, TURN]);
        assertNoUnexpectedConflict(scope);
    });
});

test('a first save queued across a new-chat transition keeps separate target tokens and full conversations', async ({ browser }, info) => {
    await scenario(browser, info, async scope => {
        const page = await scope.page({ onboard: true });
        const hold = await scope.hold(page, '/api/chats/group/save', { afterForward: true });
        await createGroup(scope, page);
        const { request } = await hold.entered();
        const original = request.postDataJSON();
        const changing = scope.job(newChat(page));
        await page.waitForFunction(id => window.Luker.getContext().getCurrentChatId() !== id && window.Luker.getContext().chat.length > 0, original.id);
        const next = await state(page);
        await hold.release();
        await observed(changing);
        await hold.unroute();
        await assertComplete(scope, page, next.id, [next.messages[0].mes]);
        expect(file(scope.server, original.id).slice(1)).toEqual(original.chat.slice(1));
        expect((await state(page)).metadata.integrity).not.toBe(file(scope.server, original.id)[0].chat_metadata.integrity);
        await command(page, `/send ${TURN}`);
        await assertComplete(scope, page, next.id, [next.messages[0].mes, TURN]);
        expect(file(scope.server, original.id).slice(1)).toEqual(original.chat.slice(1));
        assertNoUnexpectedConflict(scope);
    });
});

for (const retry of ['success', 'failed read', 'exhausted']) {
    test(`real competing group write propagates ${retry} recovery without publishing an unacknowledged snapshot`, async ({ browser }, info) => {
        await scenario(browser, info, async scope => {
            const page = await scope.page({ onboard: true });
            const group = await createGroup(scope, page);
            await readyGreeting(page);
            const id = await importChat(scope, page);
            const other = await scope.page();
            await openGroup(other, group);
            await openChatByName(other, id);
            await editMessageViaUI(other, 0, 'Concurrent server greeting.');
            const concurrent = stored(scope.server, id);
            let unroute;
            if (retry === 'failed read') unroute = await scope.route(page, '/api/chats/group/get', route => route.abort('failed'));
            if (retry === 'exhausted') {
                const stopSave = await scope.route(page, '/api/chats/group/save', route => {
                    const payload = route.request().postDataJSON();
                    payload.chat[0].chat_metadata.integrity = 'owned-stale-integrity';
                    scope.network.push({ kind: 'forwarded-request', url: route.request().url(), body: JSON.stringify(payload) });
                    return route.continue({ postData: JSON.stringify(payload) });
                });
                const stopPatch = await scope.route(page, '/api/chats/group/patch', route => {
                    const payload = route.request().postDataJSON();
                    payload.integrity = 'owned-stale-integrity';
                    scope.network.push({ kind: 'forwarded-request', url: route.request().url(), body: JSON.stringify(payload) });
                    return route.continue({ postData: JSON.stringify(payload) });
                });
                unroute = async () => { await stopSave(); await stopPatch(); };
            }
            // This native command uses the actual serialized group writer.
            // Rendering defaults provide a real local change against the import.
            await command(page, '/forcesave');
            if (retry === 'success') {
                await expect.poll(() => file(scope.server, id).slice(1).map(message => message.mes)).toEqual(IMPORTED.map(message => message.mes));
                await expect.poll(async () => (await state(page)).messageSnapshot).toEqual(file(scope.server, id).slice(1));
                expect((await state(page)).metadata.integrity).toBe(file(scope.server, id)[0].chat_metadata.integrity);
            } else {
                await expect(page.locator('.toast-error', { hasText: 'Group Chat could not be saved' })).toBeVisible({ timeout: 10_000 });
                expect((await state(page)).messageSnapshot).toBeNull();
                expect(stored(scope.server, id)).toBe(concurrent);
                await unroute();
                await command(page, '/send Recovery preserves both local and imported messages.');
                await expect.poll(() => file(scope.server, id).slice(1).map(message => message.mes)).toEqual([...IMPORTED.map(message => message.mes), 'Recovery preserves both local and imported messages.']);
            }
            expect(scope.network.some(row => row.kind === 'response' && row.status === 409)).toBe(true);
            await scope.record(`competing-write-${retry}`, page, id);
        });
    });
}

for (const kind of ['HTTP', 'non-array']) {
    test(`failed ${kind} undo-snapshot read does not delete an existing group conversation`, async ({ browser }, info) => {
        await scenario(browser, info, async scope => {
            const page = await scope.page({ onboard: true });
            await createGroup(scope, page);
            await readyGreeting(page);
            const id = await importChat(scope, page);
            await command(page, '/forcesave | /echo Import settled for deletion.');
            await expect(page.locator('.toast', { hasText: 'Import settled for deletion.' })).toBeVisible();
            const bytes = stored(scope.server, id);
            await scope.route(page, '/api/chats/group/get', route => fault(route, kind, scope.server.baseURL, scope.network));
            const start = scope.network.length;
            await manager(page);
            const row = page.locator('.select_chat_block_wrapper').filter({ has: page.locator('.select_chat_block_filename', { hasText: id }) });
            await row.locator('.PastChat_cross').click();
            await page.locator('dialog.popup[open]', { hasText: 'Delete the Chat File?' }).locator('.popup-button-ok').click();
            await expect(page.locator('.toast-error', { hasText: id })).toBeVisible();
            expect(stored(scope.server, id)).toBe(bytes);
            expect(scope.network.slice(start).filter(row => row.kind === 'request' && row.url.endsWith('/group/delete'))).toEqual([]);
            await scope.record('failed-undo-snapshot-preserves-conversation', page, id);
        });
    });
}

test('a new-chat request completing after a character switch cannot revoke the character metadata', async ({ browser }, info) => {
    await scenario(browser, info, async scope => {
        const page = await scope.page({ onboard: true });
        await createGroup(scope, page);
        const initial = await readyGreeting(page);
        await assertComplete(scope, page, initial.id, [initial.messages[0].mes]);
        const hold = await scope.hold(page, '/api/groups/edit', { afterForward: true });
        const changing = scope.job(newChat(page));
        await hold.entered();
        const pending = await state(page);
        await page.locator('#select_chat_cross').click();
        await openCharacterList(page);
        await page.locator('#rm_print_characters_block .character_select').filter({ has: page.locator(`img[src*="file=${AVATAR}"]`) }).click();
        await page.waitForFunction(() => !window.Luker.getContext().groupId && window.Luker.getContext().chat.length > 0);
        await command(page, '/forcesave | /echo Character selection settled.');
        await expect(page.locator('.toast', { hasText: 'Character selection settled.' })).toBeVisible();
        const before = await state(page, pending.id);
        await hold.release();
        await observed(changing);
        const after = await state(page, pending.id);
        expect(after.groupId).toBeFalsy();
        expect(after.id).toBe(before.id);
        expect(after.metadata).toEqual(before.metadata);
        expect(after.messages).toEqual(before.messages);
        expect(stored(scope.server, pending.id)).toBeNull();
        await scope.record('late-new-chat-entry-does-not-revoke-current-target', page, pending.id);
    });
});

test('metadata-only save recovery retains its complete group context after a real character switch', async ({ browser }, info) => {
    await scenario(browser, info, async scope => {
        const page = await scope.page({ onboard: true });
        await createGroup(scope, page);
        await readyGreeting(page);
        const id = await importChat(scope, page);
        const before = await state(page, id);
        const hold = await scope.hold(page, '/api/chats/group/meta/patch', { afterForward: true, requestOverrides: { postData: '{}' } });
        await command(page, '/setvar key=boundary_marker owned-variable');
        const { response } = await hold.entered();
        expect(response.status()).toBe(400);
        await openCharacterList(page);
        await page.locator('#rm_print_characters_block .character_select').filter({ has: page.locator(`img[src*="file=${AVATAR}"]`) }).click();
        await page.waitForFunction(() => !window.Luker.getContext().groupId && window.Luker.getContext().chat.length > 0);
        await hold.release();
        await hold.unroute();
        await expect.poll(() => file(scope.server, id).slice(1).map(message => message.mes), { message: 'A metadata-only recovery must not replace the original group with the later character conversation' }).toEqual(IMPORTED.map(message => message.mes));
        await expect.poll(() => file(scope.server, id)[0].chat_metadata.variables?.boundary_marker).toBe('owned-variable');
        const recovered = file(scope.server, id);
        expect(recovered.slice(1)).toEqual(before.messages);
        await command(page, '/forcesave | /echo Character write settled after group recovery.');
        await expect(page.locator('.toast', { hasText: 'Character write settled after group recovery.' })).toBeVisible();
        const after = await state(page, id);
        expect(after.groupId).toBeFalsy();
        expect(after.messages).toHaveLength(1);
        expect(after.metadata.variables?.boundary_marker).toBeUndefined();
        expect(after.metadata.integrity).not.toBe(recovered[0].chat_metadata.integrity);
        expect(after.messageSnapshot).toEqual(recovered.slice(1));
        await scope.record('metadata-recovery-owns-original-complete-payload', page, id);
    });
});

test('an acknowledged first save cannot authorize empty live data after a failed same-target reload', async ({ browser }, info) => {
    await scenario(browser, info, async scope => {
        const page = await scope.page({ onboard: true });
        const hold = await scope.hold(page, '/api/chats/group/save', { afterForward: true });
        await createGroup(scope, page);
        const { request, response } = await hold.entered();
        const payload = request.postDataJSON();
        const acknowledgement = await response.json();
        const bytes = stored(scope.server, payload.id);
        const unroute = await scope.route(page, '/api/chats/group/get', route => route.abort('failed'));
        await reloadChat(page);
        await expect(page.locator('.toast-error', { hasText: payload.id })).toBeVisible();
        await hold.release();
        await hold.unroute();
        await expect.poll(async () => (await state(page, payload.id)).metadataSnapshot?.integrity).toBe(acknowledgement.integrity);
        const failed = await state(page, payload.id);
        expect(failed.metadata.integrity).toBeUndefined();
        expect(failed.messages).toEqual([]);
        expect(failed.messageSnapshot).toEqual(payload.chat.slice(1));
        expect(stored(scope.server, payload.id)).toBe(bytes);
        const start = scope.network.length;
        await command(page, '/send A failed reload must not replace the acknowledged conversation.');
        await expect(page.locator('.toast-error', { hasText: 'Chat save aborted' })).toBeVisible();
        expect(scope.network.slice(start).filter(row => row.kind === 'request' && /\/(save|patch|append|meta\/patch)$/.test(row.url))).toEqual([]);
        expect(stored(scope.server, payload.id)).toBe(bytes);
        await unroute();
        await reloadChat(page);
        expect((await state(page)).messages).toEqual(payload.chat.slice(1));
        await scope.record('acknowledged-payload-does-not-authorize-failed-live-load', page, payload.id);
    });
});

test('a failed same-target reload cannot remove a queued write token or accept conflict authority', async ({ browser }, info) => {
    await scenario(browser, info, async scope => {
        const page = await scope.page({ onboard: true });
        const group = await createGroup(scope, page);
        await readyGreeting(page);
        const id = await importChat(scope, page);
        const other = await scope.page();
        await openGroup(other, group);
        await openChatByName(other, id);
        const hold = await scope.hold(page, '/api/chats/group/meta/patch', { afterForward: true, requestOverrides: { postData: '{}' } });
        await command(page, '/setvar key=queued_token protected-token');
        const { request, response } = await hold.entered();
        const capturedIntegrity = request.postDataJSON().integrity;
        expect(capturedIntegrity).toBeTruthy();
        expect(response.status()).toBe(400);
        const unroute = await scope.route(page, '/api/chats/group/get', route => route.abort('failed'));
        await reloadChat(page);
        await expect(page.locator('.toast-error', { hasText: id })).toBeVisible();
        await editMessageViaUI(other, 0, 'The concurrent conversation must survive the failed reload.');
        const concurrent = stored(scope.server, id);
        const start = scope.network.length;
        await hold.release();
        await hold.unroute();
        await expect.poll(() => scope.network.slice(start).filter(row => row.kind === 'request' && row.url.endsWith('/group/save')).length).toBe(1);
        const write = JSON.parse(scope.network.slice(start).find(row => row.kind === 'request' && row.url.endsWith('/group/save')).body);
        expect(write.chat[0].chat_metadata.integrity).toBe(capturedIntegrity);
        await expect(page.locator('.toast-error', { hasText: 'Group Chat could not be saved' })).toBeVisible();
        expect((await state(page)).metadata.integrity).toBeUndefined();
        expect((await state(page)).messageSnapshot).toBeNull();
        expect(stored(scope.server, id)).toBe(concurrent);
        await unroute();
        await reloadChat(page);
        expect((await state(page)).messages.map(message => message.mes)).toEqual(['The concurrent conversation must survive the failed reload.', IMPORTED[1].mes]);
        await scope.record('failed-live-load-retains-captured-write-token', page, id);
    });
});

for (const kind of ['success', 'HTTP', 'network', 'invalid JSON', 'non-array']) {
    test(`group metadata conflict snapshot refresh preserves server bytes after ${kind} reads`, async ({ browser }, info) => {
        await scenario(browser, info, async scope => {
            const page = await scope.page({ onboard: true });
            const group = await createGroup(scope, page);
            await readyGreeting(page);
            const imported = kind === 'success'
                ? [HEADER, { ...IMPORTED[0], extra: { ...IMPORTED[0].extra, image: '/img/user-default.png' } }, IMPORTED[1]]
                : [HEADER, ...IMPORTED];
            const id = await importChat(scope, page, imported);
            const originalMessages = file(scope.server, id).slice(1);
            const other = await scope.page();
            await openGroup(other, group);
            await openChatByName(other, id);
            await command(other, '/setvar key=competing_metadata retained');
            await expect.poll(() => file(scope.server, id)[0].chat_metadata.variables?.competing_metadata).toBe('retained');
            let unroute;
            if (kind !== 'success') unroute = await scope.route(page, '/api/chats/group/get', route => fault(route, kind, scope.server.baseURL, scope.network));
            const start = scope.network.length;
            await command(page, '/setvar key=retry_metadata retained');
            await expect.poll(() => file(scope.server, id)[0].chat_metadata.variables?.retry_metadata).toBe('retained');
            await expect.poll(async () => (await state(page)).metadata.integrity).toBe(file(scope.server, id)[0].chat_metadata.integrity);
            await scope.record(`metadata-conflict-${kind}-read`, page, id);
            expect(scope.network.slice(start).some(row => row.kind === 'response' && row.status === 409)).toBe(true);
            if (kind === 'success') {
                expect(file(scope.server, id).slice(1)).toEqual(originalMessages);
                expect((await state(page)).messageSnapshot).toEqual(originalMessages);
            } else {
                await expect(page.locator('.toast-error', { hasText: id }).filter({ hasText: 'could not be loaded' }).first(), 'A failed group snapshot read must visibly identify its target').toBeVisible();
                expect(file(scope.server, id).slice(1)).toEqual((await state(page)).messages);
                expect((await state(page)).messageSnapshot).toEqual(file(scope.server, id).slice(1));
                await unroute();
            }
            const beforeEdit = file(scope.server, id).slice(1);
            const editStart = scope.network.length;
            await editMessageViaUI(page, 0, EDIT);
            await expect.poll(() => file(scope.server, id)[1].mes).toBe(EDIT);
            const patches = scope.network.slice(editStart).filter(row => row.kind === 'request' && row.url.endsWith('/group/patch')).map(row => JSON.parse(row.body));
            expect(patches.flatMap(payload => payload.operations)).toContainEqual({ op: 'test', path: '/0', value: beforeEdit[0] });
            expect(file(scope.server, id)[2]).toEqual(beforeEdit[1]);
            await reloadChat(page);
            expect((await state(page)).messages.map(message => message.mes)).toEqual([EDIT, IMPORTED[1].mes]);
        });
    });
}

for (const kind of ['success', 'non-array']) {
    test(`group append dedup snapshot refresh retains complete data after ${kind} reads`, async ({ browser }, info) => {
        await scenario(browser, info, async scope => {
            const page = await scope.page({ onboard: true });
            await createGroup(scope, page);
            await readyGreeting(page);
            const id = await importChat(scope, page, [HEADER, { ...IMPORTED[0], extra: { image: '/img/user-default.png' } }, IMPORTED[1]]);
            let unroute;
            if (kind !== 'success') unroute = await scope.route(page, '/api/chats/group/get', route => fault(route, kind, scope.server.baseURL, scope.network));
            await scope.route(page, '/api/chats/group/append', async route => {
                const first = await route.fetch();
                const acknowledgement = await first.json();
                expect(first.ok()).toBe(true);
                expect(acknowledgement.appended).toBe(1);
                const duplicate = route.request().postDataJSON();
                duplicate.integrity = acknowledgement.integrity;
                duplicate.chat_metadata.integrity = acknowledgement.integrity;
                scope.network.push({ kind: 'forwarded-response', url: route.request().url(), status: first.status(), body: JSON.stringify(acknowledgement) });
                scope.network.push({ kind: 'forwarded-request', url: route.request().url(), body: JSON.stringify(duplicate) });
                const repeated = await route.fetch({ postData: JSON.stringify(duplicate) });
                expect(repeated.ok()).toBe(true);
                expect((await repeated.json()).appended).toBe(0);
                await route.fulfill({ response: repeated });
            });
            const start = scope.network.length;
            await command(page, `/send ${TURN} | /echo Duplicate append settled.`);
            await expect(page.locator('.toast', { hasText: 'Duplicate append settled.' })).toBeVisible();
            await scope.record(`append-dedup-${kind}-read`, page, id);
            expect(file(scope.server, id).slice(1).map(message => message.mes)).toEqual([...IMPORTED.map(message => message.mes), TURN]);
            if (kind === 'success') {
                expect((await state(page)).messageSnapshot).toEqual(file(scope.server, id).slice(1));
                expect(scope.network.slice(start).filter(row => row.kind === 'response' && row.status === 409)).toEqual([]);
            } else {
                await expect(page.locator('.toast-error', { hasText: id }).filter({ hasText: 'could not be loaded' }).first()).toBeVisible();
                expect((await state(page)).messageSnapshot).not.toEqual([]);
                await unroute();
            }
            await reloadChat(page);
            expect((await state(page)).messages.map(message => message.mes)).toEqual([...IMPORTED.map(message => message.mes), TURN]);
        });
    });
}

async function nativeDisplayReload(page) {
    await closeAnyOpenTopSettingsDrawer(page);
    await openTopDrawer(page, 'user-settings-button');
    const input = page.locator('#allow_name1_display');
    if (!await input.isVisible()) {
        await input.locator('xpath=ancestor::div[contains(@class,"inline-drawer")][1]').locator('.inline-drawer-toggle').first().click();
    }
    await input.setChecked(!await input.isChecked());
    await closeAnyOpenTopSettingsDrawer(page);
}

async function settleGroup(scope, page, id) {
    const marker = `Group settled ${randomBytes(5).toString('hex')}`;
    const persistedGroup = scope.response(page, '/api/groups/edit');
    await command(page, `/forcesave | /echo ${marker}`);
    await expect(page.locator('.toast', { hasText: marker })).toBeVisible();
    expect((await observed(persistedGroup)).ok()).toBe(true);
    return assertComplete(scope, page, id, (await state(page)).messages.map(message => message.mes));
}

async function rebuildGroupOwner(scope, page, group) {
    await openGroup(page, group);
    if (await page.locator('#rightNavDrawerIcon.closedIcon').count()) await page.locator('#rightNavDrawerIcon').click();
    await expect(page.locator('#rm_group_chat_name')).toBeVisible();
    const prior = await page.evaluateHandle(async id => (await import('/scripts/group-chats.js')).groups.find(group => group.id === id), group);
    try {
        const refreshed = scope.response(page, '/api/groups/all');
        await page.locator('#rm_group_chat_name').fill(`Registry owner ${randomBytes(5).toString('hex')}`);
        expect((await observed(refreshed)).ok()).toBe(true);
        await expect.poll(() => page.evaluate(async ({ prior, group }) => (await import('/scripts/group-chats.js')).groups.find(owner => owner.id === group) !== prior, { prior, group })).toBe(true);
        await closeAnyOpenTopSettingsDrawer(page);
    } finally {
        await prior.dispose();
    }
}

async function admitNativeEdit(page, id, text) {
    const message = page.locator(`#chat .mes[mesid="${id}"]`);
    await message.hover();
    await message.locator('.mes_edit').first().click();
    await message.locator('.edit_textarea').fill(text);
    await message.locator('.mes_edit_done').first().click();
    await expect(message.locator('.edit_textarea')).toHaveCount(0);
}

for (const operation of ['patch', 'append', 'metadata']) {
    for (const outcome of ['acknowledgement', 'integrity conflict']) {
        const destinations = operation === 'metadata' ? ['failed reload'] : ['failed reload', 'later chat'];
        for (const destination of destinations) {
            test(`round1 ${operation} ${outcome} retains originating authority after ${destination}`, async ({ browser }, info) => {
                await scenario(browser, info, async scope => {
                    const page = await scope.page({ onboard: true });
                    await createGroup(scope, page);
                    const first = await readyGreeting(page);
                    await settleGroup(scope, page, first.id);
                    const id = await importChat(scope, page);
                    await settleGroup(scope, page, id);
                    const endpoint = `/api/chats/group/${operation === 'metadata' ? 'meta/patch' : operation}`;
                    const hold = await scope.hold(page, endpoint, {
                        afterForward: true,
                        requestOverrides: request => {
                            if (outcome === 'acknowledgement') return {};
                            const payload = request.postDataJSON();
                            payload.integrity = 'owned-obsolete-incremental-integrity';
                            return { postData: JSON.stringify(payload) };
                        },
                    });
                    const durable = stored(scope.server, id);
                    if (operation === 'patch') await admitNativeEdit(page, 0, EDIT);
                    if (operation === 'append') await command(page, `/send ${TURN} | /echo Originating append completed.`);
                    if (operation === 'metadata') await command(page, '/setvar key=originating_metadata retained');
                    const { response } = await hold.entered();
                    expect(response.status()).toBe(outcome === 'acknowledgement' ? 200 : 409);
                    const admitted = await state(page, id);
                    const acknowledgedMessages = outcome === 'acknowledgement' ? admitted.messages : file(scope.server, id).slice(1);
                    const persistedBeforeRelease = stored(scope.server, id);
                    let unroute;
                    if (destination === 'failed reload') {
                        unroute = await scope.route(page, '/api/chats/group/get', route => route.abort('failed'));
                        if (operation === 'append') await nativeDisplayReload(page);
                        else await reloadChat(page);
                        await expect(page.locator('.toast-error', { hasText: id }).filter({ hasText: 'could not be loaded' }).first()).toBeVisible();
                        expect((await state(page)).metadata.integrity).toBeUndefined();
                        expect((await state(page)).messages).toEqual([]);
                    } else {
                        await openChatByName(page, first.id);
                        const later = await state(page, first.id);
                        await hold.release();
                        await hold.unroute();
                        if (operation === 'append') await expect(page.locator('.toast', { hasText: 'Originating append completed.' })).toBeVisible();
                        await command(page, '/echo Originating response released.');
                        await expect(page.locator('.toast', { hasText: 'Originating response released.' })).toBeVisible();
                        const before = await state(page, later.id);
                        expect(before.metadata).toEqual(later.metadata);
                        expect(before.messages).toEqual(later.messages);
                        expect(before.messageSnapshot).toEqual(later.messageSnapshot);
                        expect(before.metadata.integrity).toBe(file(scope.server, later.id)[0].chat_metadata.integrity);
                        expect(file(scope.server, id).slice(1)).toEqual(acknowledgedMessages);
                        await command(page, '/send The later group chat keeps its own accepted token.');
                        await assertComplete(scope, page, later.id, [...before.messages.map(message => message.mes), 'The later group chat keeps its own accepted token.']);
                        expect(file(scope.server, id).slice(1)).toEqual(acknowledgedMessages);
                        await scope.record('round1-incremental-response-owns-origin', page, id);
                        return;
                    }
                    const start = scope.network.length;
                    await hold.release();
                    await hold.unroute();
                    if (operation === 'append') await expect(page.locator('.toast', { hasText: 'Originating append completed.' })).toBeVisible();
                    const marker = `Unloaded save refused ${randomBytes(5).toString('hex')}`;
                    await command(page, `/forcesave | /echo ${marker}`);
                    await expect(page.locator('.toast', { hasText: marker })).toBeVisible();
                    await scope.record('round1-incremental-response-after-failed-reload', page, id);
                    expect((await state(page)).metadata.integrity).toBeUndefined();
                    expect((await state(page)).messages).toEqual([]);
                    const writes = scope.network.slice(start).filter(row => row.kind === 'request' && /\/(save|patch|append|meta\/patch)$/.test(row.url));
                    for (const write of writes) {
                        const payload = JSON.parse(write.body);
                        if (write.url.endsWith('/group/save')) expect(payload.chat.slice(1)).toEqual(admitted.messages);
                        if (write.url.endsWith('/group/patch')) expect(payload.operations.some(operation => operation.op === 'remove')).toBe(false);
                    }
                    expect(file(scope.server, id).slice(1)).toEqual(acknowledgedMessages);
                    if (outcome === 'acknowledgement') expect(stored(scope.server, id)).toBe(persistedBeforeRelease);
                    else if (operation !== 'metadata') expect(stored(scope.server, id)).toBe(durable);
                    await unroute();
                    await reloadChat(page);
                    expect((await state(page)).messages).toEqual(file(scope.server, id).slice(1));
                    expect((await state(page)).metadata.integrity).toBe(file(scope.server, id)[0].chat_metadata.integrity);
                    await command(page, '/send Recovered authority preserves the complete conversation.');
                    await assertComplete(scope, page, id, [...acknowledgedMessages.map(message => message.mes), 'Recovered authority preserves the complete conversation.']);
                });
            });
        }
    }
}

for (const kind of ['HTTP', 'network', 'invalid JSON', 'non-array']) {
    test(`round1 metadata-first recovery after ${kind} initialization failure persists the complete greeting`, async ({ browser }, info) => {
        await scenario(browser, info, async scope => {
            const page = await scope.page({ onboard: true });
            const unroute = await scope.route(page, '/api/chats/group/save', route => fault(route, kind, scope.server.baseURL, scope.network));
            await createGroup(scope, page);
            const initial = await readyGreeting(page);
            await expect(page.locator('.toast-error', { hasText: 'could not be saved' }).first()).toBeVisible();
            expect(stored(scope.server, initial.id)).toBeNull();
            expect((await state(page)).messageSnapshot).toBeNull();
            await unroute();
            const start = scope.network.length;
            await command(page, '/setvar key=metadata_first complete-greeting');
            await expect.poll(() => stored(scope.server, initial.id)).not.toBeNull();
            await scope.record('round1-metadata-first-durable-conversation', page, initial.id);
            await expect.poll(() => file(scope.server, initial.id).slice(1)).toEqual(initial.messages);
            expect(file(scope.server, initial.id)[0].chat_metadata.variables.metadata_first).toBe('complete-greeting');
            expect(scope.network.slice(start).filter(row => row.kind === 'request' && row.url.endsWith('/group/meta/patch'))).toEqual([]);
            const complete = scope.network.slice(start).find(row => row.kind === 'request' && row.url.endsWith('/group/save'));
            expect(JSON.parse(complete.body).chat.slice(1)).toEqual(initial.messages);
            expect(JSON.parse(complete.body).force).toBe(false);
            await reloadChat(page);
            expect((await state(page)).messages).toEqual(initial.messages);
            expect((await state(page)).metadata.variables.metadata_first).toBe('complete-greeting');
            await command(page, `/send ${TURN}`);
            await assertComplete(scope, page, initial.id, [initial.messages[0].mes, TURN]);
        });
    });
}

for (const entry of ['new chat', 'reopen']) {
    for (const variant of ['later chat', 'replaced registry owner', 'return to original chat']) {
        test(`round1 obsolete ${entry} entry cannot reload a ${variant} in the same group`, async ({ browser }, info) => {
            await scenario(browser, info, async scope => {
                const page = await scope.page({ onboard: true });
                const group = await createGroup(scope, page);
                const first = await readyGreeting(page);
                await settleGroup(scope, page, first.id);
                const other = await importChat(scope, page, [HEADER, { ...IMPORTED[0], extra: { ...IMPORTED[0].extra, bookmark_link: first.id } }, IMPORTED[1]]);
                await settleGroup(scope, page, other);
                const hold = await scope.hold(page, '/api/groups/edit', { afterForward: true,
                    when: request => entry === 'new chat' ? request.postDataJSON().chat_id !== other : request.postDataJSON().chat_id === first.id });
                const completed = `Originating reopen settled ${randomBytes(5).toString('hex')}`;
                const opening = entry === 'new chat' ? scope.job(newChat(page)) : null;
                if (entry === 'reopen') await command(page, `/checkpoint-go 0 | /echo ${completed}`);
                const { request, response } = await hold.entered();
                expect(response.ok()).toBe(true);
                const origin = request.postDataJSON().chat_id;
                await scope.record('round1-originating-entry-awaits-edit', page, origin);
                if (opening) {
                    await page.locator('#select_chat_cross').click();
                    await observed(opening);
                    if (variant === 'return to original chat') {
                        await nativeDisplayReload(page);
                        await readyGreeting(page);
                        await assertComplete(scope, page, origin, (await state(page)).messages.map(message => message.mes));
                    }
                }
                if (variant === 'replaced registry owner') await rebuildGroupOwner(scope, page, group);
                await openChatByName(page, other);
                await assertComplete(scope, page, other, IMPORTED.map(message => message.mes));
                if (variant === 'return to original chat') {
                    await openChatByName(page, origin);
                    await assertComplete(scope, page, origin, [first.messages[0].mes]);
                }
                await expect.poll(async () => {
                    const current = await state(page);
                    return isDeepStrictEqual(current.metadata, current.metadataSnapshot);
                }).toBe(true);
                const current = await state(page);
                const bytes = stored(scope.server, current.id);
                const unroute = await scope.route(page, '/api/chats/group/get', route => route.abort('failed'));
                const start = scope.network.length;
                await hold.release();
                await hold.unroute();
                if (entry === 'reopen') await expect(page.locator('.toast', { hasText: completed })).toBeVisible();
                const marker = `Obsolete entry released ${randomBytes(5).toString('hex')}`;
                await command(page, `/echo ${marker}`);
                await expect(page.locator('.toast', { hasText: marker })).toBeVisible();
                const retained = await state(page);
                await scope.record('round1-obsolete-entry-preserves-current-chat', page, current.id);
                expect(retained.id).toBe(current.id);
                expect(retained.messages).toEqual(current.messages);
                expect(retained.metadata).toEqual(current.metadata);
                expect(retained.messageSnapshot).toEqual(current.messageSnapshot);
                expect(retained.metadataSnapshot).toEqual(current.metadataSnapshot);
                expect(stored(scope.server, current.id)).toBe(bytes);
                await command(page, `/send ${TURN}`);
                await assertComplete(scope, page, current.id, [...current.messages.map(message => message.mes), TURN]);
                expect(scope.network.slice(start).filter(row => row.kind === 'request' && row.url.endsWith('/group/get'))).toEqual([]);
                await unroute();
            });
        });
    }
}

test('round1 legitimate reopen survives registry replacement for its unchanged originating chat', async ({ browser }, info) => {
    await scenario(browser, info, async scope => {
        const page = await scope.page({ onboard: true });
        const group = await createGroup(scope, page);
        const first = await readyGreeting(page);
        await settleGroup(scope, page, first.id);
        const id = await importChat(scope, page, [HEADER, { ...IMPORTED[0], extra: { ...IMPORTED[0].extra, bookmark_link: first.id } }, IMPORTED[1]]);
        await settleGroup(scope, page, id);
        const hold = await scope.hold(page, '/api/groups/edit', { afterForward: true, when: request => request.postDataJSON().chat_id === first.id });
        const completed = `Legitimate reopen settled ${randomBytes(5).toString('hex')}`;
        await command(page, `/checkpoint-go 0 | /echo ${completed}`);
        await hold.entered();
        await rebuildGroupOwner(scope, page, group);
        await hold.release();
        await hold.unroute();
        await expect(page.locator('.toast', { hasText: completed })).toBeVisible();
        await expect.poll(async () => (await state(page)).metadata.integrity).toBe(file(scope.server, first.id)[0].chat_metadata.integrity);
        expect((await state(page)).messages).toEqual(file(scope.server, first.id).slice(1));
        await command(page, `/send ${TURN}`);
        await assertComplete(scope, page, first.id, [first.messages[0].mes, TURN]);
    });
});

for (const destination of ['failed reload', 'later chat']) {
    test(`round1 queued native group edits and complete no-op retain accepted origin tokens after ${destination}`, async ({ browser }, info) => {
        await scenario(browser, info, async scope => {
            const page = await scope.page({ onboard: true });
            await createGroup(scope, page);
            const first = await readyGreeting(page);
            await settleGroup(scope, page, first.id);
            const id = await importChat(scope, page);
            await settleGroup(scope, page, id);
            const hold = await scope.hold(page, '/api/chats/group/patch', { afterForward: true });
            const start = scope.network.length;
            await admitNativeEdit(page, 0, EDIT);
            const { response } = await hold.entered();
            expect(response.ok()).toBe(true);
            const accepted = await response.json();
            const queuedText = 'The queued User edit retains its original group and complete bytes: 渡口 🌙.';
            await admitNativeEdit(page, 1, queuedText);
            const admitted = await state(page, id);
            // Export synchronously admits the existing complete writer before awaiting it.
            // Its captured token predates both accepted incremental responses.
            await manager(page);
            const exporting = scope.job((async () => await page.waitForEvent('download'))());
            await page.locator('.select_chat_block_wrapper', { has: page.locator('.select_chat_block_filename', { hasText: `${id}.jsonl` }) })
                .locator('.exportRawChatButton').click();
            await page.locator('#select_chat_cross').click();
            await expect(page.locator('#shadow_select_chat_popup')).toBeHidden();
            let unroute;
            let later;
            if (destination === 'failed reload') {
                unroute = await scope.route(page, '/api/chats/group/get', route => route.abort('failed'));
                await reloadChat(page);
                await expect(page.locator('.toast-error', { hasText: id }).filter({ hasText: 'could not be loaded' }).first()).toBeVisible();
            } else {
                await openChatByName(page, first.id);
                later = await state(page, first.id);
            }
            await hold.release();
            await hold.unroute();
            const download = await observed(exporting);
            const exportedPath = info.outputPath('queued-origin-export.jsonl');
            await download.saveAs(exportedPath);
            expect(fs.readFileSync(exportedPath, 'utf8').trim().split('\n').map(line => JSON.parse(line)).slice(1)).toEqual(admitted.messages);
            const marker = `Queued edits settled ${randomBytes(5).toString('hex')}`;
            await command(page, `/forcesave | /echo ${marker}`);
            await expect(page.locator('.toast', { hasText: marker })).toBeVisible();
            await scope.record('round1-queued-origin-token-and-complete-wire-data', page, id);
            const queued = scope.network.slice(start).filter(row => row.kind === 'request' && row.url.endsWith('/group/patch'))
                .map(row => JSON.parse(row.body)).find(payload => payload.operations.some(operation => operation.op === 'replace' && operation.value?.mes === queuedText));
            expect(queued.id).toBe(id);
            expect(queued.integrity).toBe(accepted.integrity);
            expect(file(scope.server, id).slice(1)).toEqual(admitted.messages);
            expect((await state(page, id)).messageSnapshot).toEqual(admitted.messages);
            expect((await state(page, id)).metadataSnapshot.integrity).toBe(file(scope.server, id)[0].chat_metadata.integrity);
            expect(scope.network.slice(start).filter(row => row.kind === 'response' && row.status === 409)).toEqual([]);
            if (destination === 'failed reload') {
                expect((await state(page)).metadata.integrity).toBeUndefined();
                expect((await state(page)).messages).toEqual([]);
                await unroute();
                await reloadChat(page);
            } else {
                const retained = await state(page);
                expect(retained.id).toBe(later.id);
                expect(retained.metadata).toEqual(later.metadata);
                expect(retained.messages).toEqual(later.messages);
                expect(retained.messageSnapshot).toEqual(later.messageSnapshot);
                await openChatByName(page, id);
            }
            expect((await state(page)).messages).toEqual(admitted.messages);
            await command(page, `/send ${TURN}`);
            await assertComplete(scope, page, id, [EDIT, queuedText, TURN]);
        });
    });
}
