// Real DOM rename consumers, durable full-payload snapshots and LAN propagation.
import fs from 'node:fs';
import path from 'node:path';
import { randomBytes } from 'node:crypto';
import { test, expect } from '@playwright/test';
import { startServer, tearDownServer } from '../_lib/server.js';
import { onboardS3Page, reloadS3Page } from '../_lib/sync-s3.js';
import { openCharacterList } from '../_lib/ui-character.js';
import { closeAnyOpenTopSettingsDrawer, editMessageViaUI } from '../_lib/page.js';
import { openChatByName, openLanSyncPanel, generatePairingLink, acceptPairingLink, waitForBackendSync, clickSyncNow, setSyncSchedule, setSyncDeviceLabel, closeAllPopups } from '../_lib/sync.js';

test.describe.configure({ timeout: 240_000 });
const AVATAR = 'default_Seraphina.png';
const HEADER = { user_name: 'Archivist', character_name: '', unknown_header: { retained: ['渡口', { exact: true }] }, chat_metadata: { note_prompt: 'Moonlit reeds', unknown: { nested: [null, false, '🌙'] } } };
const IMPORTED = [
    { name: 'Seraphina', is_user: false, is_system: false, mes: 'Across the ford: 渡口 🌙 \\ reeds.', send_date: '2026-01-02T03:04:06Z', extra: { unknown: { a: [1, null, false] } }, unknown_message: ['kept'] },
    { name: 'User', is_user: true, is_system: false, mes: 'Keep "every" word.\nAnd this line.', send_date: '2026-01-02T03:04:07Z', extra: { retained: { b: 2 } } },
];
const observe = promise => promise.then(value => ({ value }), error => ({ error }));
async function observed(promise) { const result = await promise; if (result.error) throw result.error; return result.value; }
const bytes = (server, relative) => { const file = path.join(server.dataRoot, 'default-user', relative); return fs.existsSync(file) ? fs.readFileSync(file, 'utf8') : null; };
const stored = (server, id) => { const raw = bytes(server, `group chats/${id}.jsonl`); return raw === null ? null : raw.trim().split('\n').filter(Boolean).map(line => JSON.parse(line)); };
const definition = (server, id) => JSON.parse(bytes(server, `groups/${id}.json`));
const storedPins = server => {
    const value = JSON.parse(bytes(server, 'settings.json')).accountStorage?.pinnedChats;
    return value === undefined ? null : JSON.parse(value);
};
const welcomeRow = (page, id) => page.locator(`.recentChat.group[data-file="${id}"]`);
const row = (page, id) => page.locator('.select_chat_block_wrapper').filter({ has: page.locator('.select_chat_block_filename', { hasText: new RegExp(`^\\s*${RegExp.escape(id)}(\\.jsonl)?\\s*$`) }) });

async function live(page, id = null) {
    return page.evaluate(async id => {
        const context = window.Luker.getContext(), script = await import('/script.js');
        const target = { is_group: true, id: id ?? context.getCurrentChatId() };
        return JSON.parse(JSON.stringify({ groupId: context.groupId, owner: context.groups.find(group => group.id === context.groupId), id: context.getCurrentChatId(), messages: context.chat, metadata: context.chatMetadata,
            messageSnapshot: script.getChatMessageSnapshot(target), metadataSnapshot: script.getChatMetadataSnapshot(target) }));
    }, id);
}

async function pins(page) {
    return page.evaluate(async () => {
        const { accountStorage } = await import('/scripts/util/AccountStorage.js');
        const value = accountStorage.getItem('pinnedChats');
        return value === null ? null : JSON.parse(value);
    });
}

async function scenario(browser, info, body) {
    const devices = [], jobs = [], network = [], records = [], failures = [];
    const scope = {
        records,
        response(page, endpoint) { const job = observe((async () => await page.waitForResponse(response => new URL(response.url()).pathname === endpoint))()); jobs.push(job); return job; },
        async device(label) {
            const server = await startServer({ batchKey: 'sync', scenarioId: `rename-${label}-${randomBytes(6).toString('hex')}`, extraConfig: { listen: true, securityOverride: true, whitelistMode: false } });
            const device = { server, label, runtimes: [server.execArgv] }; devices.push(device);
            device.context = await browser.newContext({ locale: 'en-US', viewport: { width: 1440, height: 1100 } });
            device.page = await device.context.newPage();
            device.page.on('response', response => {
                if (!/^\/api\/(chats|groups|sync|settings)\//.test(new URL(response.url()).pathname)) return;
                const job = observe((async () => network.push({ label, url: response.url(), status: response.status(), request: response.request().postData(), body: await response.text() }))()); jobs.push(job);
            });
            expect(server.execArgv.includes('--jitless')).toBe(process.env.LUKER_SYNC_ACCEPTANCE_JITLESS === '1');
            await onboardS3Page(device.page, server.baseURL);
            return device;
        },
        async record(label, device, id) { records.push({ label, live: await live(device.page, id), stored: stored(device.server, id), owner: definition(device.server, (await live(device.page)).groupId) }); },
    };
    try { await body(scope); } catch (error) { failures.push(error); }
    finally {
        const closed = await Promise.allSettled(devices.filter(d => d.context).map(d => d.context.close()));
        const settled = await Promise.all(jobs);
        const files = devices.map(d => {
            const directory = path.join(d.server.dataRoot, 'default-user', 'group chats');
            return { label: d.label, runtimes: d.runtimes, pins: storedPins(d.server), files: fs.existsSync(directory) ? Object.fromEntries(fs.readdirSync(directory).filter(n => n.endsWith('.jsonl')).map(n => [n, fs.readFileSync(path.join(directory, n), 'utf8')])) : {} };
        });
        const evidence = info.outputPath('rename-evidence.json'); fs.writeFileSync(evidence, JSON.stringify({ files, records, network, failures: failures.map(e => e.stack), observerErrors: settled.filter(r => r.error).map(r => r.error.message) }, null, 2));
        await info.attach('rename-evidence', { path: evidence, contentType: 'application/json' });
        await Promise.all(devices.map(d => info.attach(`${d.label}.log`, { body: d.server.outputEpochs.join('\n'), contentType: 'text/plain' })));
        const stopped = await Promise.allSettled(devices.map(d => tearDownServer(d.server, { removeData: failures.length === 0 })));
        failures.push(...[...closed, ...stopped].filter(r => r.status === 'rejected').map(r => r.reason));
    }
    if (failures.length) throw new AggregateError(failures, 'Rename scenario failed', { cause: failures[0] });
}

async function command(page, text) {
    await closeAnyOpenTopSettingsDrawer(page); await page.locator('#send_textarea').fill(text); await page.locator('#send_textarea').press('Enter');
}
async function flush(page) {
    const completed = `Rename baseline saved ${randomBytes(6).toString('hex')}`;
    await command(page, `/forcesave | /echo ${completed}`);
    await expect(page.locator('.toast', { hasText: completed })).toBeVisible();
}
async function manager(page) {
    await closeAnyOpenTopSettingsDrawer(page); await page.locator('#options_button').click(); await page.locator('#option_select_chat').click(); await expect(page.locator('#shadow_select_chat_popup')).toBeVisible();
}
async function closeManager(page) { await page.locator('#select_chat_cross').click(); await expect(page.locator('#shadow_select_chat_popup')).toBeHidden(); }
async function selectGroup(page, id) {
    await openCharacterList(page); await page.locator(`#rm_print_characters_block .group_select[data-grid="${id}"]`).click();
    await page.waitForFunction(id => window.Luker.getContext().groupId === id && !!window.Luker.getContext().chatMetadata.integrity, id); await closeAnyOpenTopSettingsDrawer(page);
}
async function createGroup(scope, device) {
    const page = device.page;
    await openCharacterList(page); await page.locator('#rm_button_group_chats').click(); await page.locator('#rm_group_chat_name').fill('Ford Watch');
    await page.locator('#rm_group_add_members .group_member').filter({ has: page.locator(`img[title="${AVATAR}"]`) }).locator('[data-action="add"]').click();
    const created = scope.response(page, '/api/groups/create'); await page.locator('#rm_group_submit').click(); const response = await observed(created); expect(response.ok()).toBe(true);
    const { id } = await response.json(); await expect(page.locator('.toast-success', { hasText: 'Group Created' })).toBeVisible(); await selectGroup(page, id);
    await expect(page.locator('#chat .mes[mesid="0"] .mes_text')).not.toBeEmpty(); return id;
}
async function importChat(scope, page) {
    await manager(page); const response = scope.response(page, '/api/chats/group/import');
    await page.locator('#chat_import_file').setInputFiles({ name: 'full-rename-import.jsonl', mimeType: 'application/octet-stream', buffer: Buffer.from([HEADER, ...IMPORTED].map(v => JSON.stringify(v)).join('\n')) });
    const actual = await observed(response); expect(actual.ok()).toBe(true); const { res: id } = await actual.json();
    await expect(row(page, id)).toHaveCount(1); await closeManager(page); await openChatByName(page, id); return id;
}
async function rename(scope, device, from, to, { conflict = false } = {}) {
    const page = device.page; await manager(page); await row(page, from).locator('.renameChatButton').click();
    const dialog = page.locator('dialog.popup[open]').last(); await dialog.locator('.popup-input').fill(to);
    const response = scope.response(page, '/api/chats/rename'); await dialog.locator('.popup-button-ok').click(); const actual = await observed(response);
    if (conflict) {
        expect(actual.status()).toBe(400);
        const error = page.locator('dialog.popup[open]', { hasText: 'Chat was not renamed' }); await expect(error).toBeVisible(); await error.locator('.popup-button-ok').click();
    } else {
        expect(actual.ok()).toBe(true); const acknowledged = await actual.json(); expect(acknowledged.sanitizedFileName).toBe(to.replaceAll('?', ''));
    }
    await expect(page.locator('#shadow_select_chat_popup')).toBeVisible(); await closeManager(page); return actual;
}

async function renameWelcome(scope, device, from, to, { conflict = false } = {}) {
    const page = device.page;
    await welcomeRow(page, from).locator('.renameChat').click();
    const dialog = page.locator('dialog.popup[open]').last(); await dialog.locator('.popup-input').fill(to);
    const response = scope.response(page, '/api/chats/rename'); await dialog.locator('.popup-button-ok').click();
    const actual = await observed(response);
    if (conflict) {
        expect(actual.status()).toBe(400);
        const error = page.locator('dialog.popup[open]', { hasText: 'Chat was not renamed' });
        await expect(error).toBeVisible(); await error.locator('.popup-button-ok').click();
    } else {
        expect(actual.ok()).toBe(true);
        expect(await actual.json()).toEqual({ ok: true, sanitizedFileName: 'PinnedFord' });
        await expect(welcomeRow(page, 'PinnedFord')).toBeVisible();
    }
}
async function complete(scope, device, id) {
    await expect.poll(async () => (await live(device.page, id)).messageSnapshot).toEqual(stored(device.server, id).slice(1));
    await scope.record('before-metadata-synchronization', device, id);
    await flush(device.page);
    await expect.poll(async () => definition(device.server, (await live(device.page)).groupId).date_last_chat).toBe((await live(device.page)).owner.date_last_chat);
    const actual = await live(device.page, id), file = stored(device.server, id);
    expect(actual.messages).toEqual(file.slice(1)); expect(actual.metadataSnapshot).toEqual(file[0].chat_metadata); expect(actual.metadata.integrity).toBe(file[0].chat_metadata.integrity);
    await scope.record('complete', device, id); return file;
}

test('fresh group rename retains greeting through edit append history recent and restart', async ({ browser }, info) => {
    await scenario(browser, info, async scope => {
        const device = await scope.device('Fresh'), page = device.page, group = await createGroup(scope, device), old = (await live(page)).id;
        await flush(page); await complete(scope, device, old); const original = stored(device.server, old);
        await rename(scope, device, old, 'Ford?Path'); const id = 'FordPath';
        expect(stored(device.server, old)).toBeNull(); expect(stored(device.server, id)).toEqual(original);
        expect(definition(device.server, group)).toMatchObject({ id: group, chats: [id], chat_id: id }); await complete(scope, device, id);
        await editMessageViaUI(page, 0, 'Edited greeting: 渡口 🌙.'); await command(page, '/send Keep the complete new-address reply.');
        await expect.poll(() => stored(device.server, id).at(-1).mes).toBe('Keep the complete new-address reply.');
        const edited = await complete(scope, device, id);
        expect(edited.slice(1).map(m => m.mes)).toEqual(['Edited greeting: 渡口 🌙.', 'Keep the complete new-address reply.']); expect(edited[0].chat_metadata.integrity).not.toBe(original[0].chat_metadata.integrity);
        await openChatByName(page, id); expect(await complete(scope, device, id)).toEqual(edited);
        await command(page, '/closechat');
        // The welcome entry carries both its owning group and conversation identity.
        await expect(page.locator(`.recentChat.group[data-file="${id}"]`)).toHaveCount(1);
        await page.locator(`.recentChat.group[data-file="${id}"]`).click();
        await page.waitForFunction(id => window.Luker.getContext().getCurrentChatId() === id, id); expect(await complete(scope, device, id)).toEqual(edited);
        await device.server.restart(); device.runtimes.push(device.server.execArgv); await reloadS3Page(page); await selectGroup(page, group);
        expect(await complete(scope, device, id)).toEqual(edited);
    });
});

test('imported rename preserves unknown fields and propagates the complete new identity over real LAN sync', async ({ browser }, info) => {
    await scenario(browser, info, async scope => {
        const a = await scope.device('Desk'), b = await scope.device('Tablet'), group = await createGroup(scope, a), old = await importChat(scope, a.page);
        const imported = stored(a.server, old); expect(imported[0].unknown_header).toEqual(HEADER.unknown_header); expect(imported.slice(1)).toEqual(IMPORTED);
        await flush(a.page); const original = await complete(scope, a, old);
        for (const device of [a, b]) { await openLanSyncPanel(device.page); await setSyncSchedule(device.page, { idleSeconds: 3600, pollSeconds: 3600 }); await setSyncDeviceLabel(device.page, device.label); }
        const link = await generatePairingLink(a.page, { label: 'Tablet', categories: ['characters', 'chats'] }); const since = Date.now();
        expect(await acceptPairingLink(b.page, link, { categories: ['characters', 'chats'], localLabel: 'Desk' })).toBe('success');
        await waitForBackendSync(a.page, { label: 'Tablet', since }); await waitForBackendSync(b.page, { label: 'Desk', since });
        await closeAllPopups(a.page); await closeAnyOpenTopSettingsDrawer(a.page); await reloadS3Page(a.page); await selectGroup(a.page, group); await openChatByName(a.page, old);
        await rename(scope, a, old, 'Imported Ford'); expect(stored(a.server, 'Imported Ford')).toEqual(original); await complete(scope, a, 'Imported Ford');
        await editMessageViaUI(a.page, 0, 'Edited imported greeting: 渡口 🌙.'); await command(a.page, '/send Imported follow-up at the new address.');
        await expect.poll(() => stored(a.server, 'Imported Ford').at(-1).mes).toBe('Imported follow-up at the new address.'); const after = await complete(scope, a, 'Imported Ford');
        expect(after[0].unknown_header).toEqual(HEADER.unknown_header); expect(after[0].chat_metadata.unknown).toEqual(HEADER.chat_metadata.unknown); expect(after[2]).toEqual(IMPORTED[1]);
        await openLanSyncPanel(a.page); expect(await clickSyncNow(a.page, 'Tablet')).toBe('success');
        await expect.poll(() => stored(b.server, 'Imported Ford'), { timeout: 60_000 }).toEqual(after); expect(stored(b.server, old)).toBeNull();
        expect(definition(b.server, group).chats).toContain('Imported Ford'); expect(definition(b.server, group).chats).not.toContain(old);
        await reloadS3Page(b.page); await selectGroup(b.page, group); await openChatByName(b.page, 'Imported Ford'); expect(await complete(scope, b, 'Imported Ford')).toEqual(after);
        await b.server.restart(); b.runtimes.push(b.server.execArgv); await reloadS3Page(b.page); await selectGroup(b.page, group); expect(await complete(scope, b, 'Imported Ford')).toEqual(after);
    });
});

test('genuine occupied destination retains both conversations and current group identity', async ({ browser }, info) => {
    await scenario(browser, info, async scope => {
        const device = await scope.device('Collision'), page = device.page, group = await createGroup(scope, device), first = (await live(page)).id;
        await rename(scope, device, first, 'Occupied Ford');
        const source = await importChat(scope, page); await complete(scope, device, source);
        const beforeSource = stored(device.server, source), beforeTarget = stored(device.server, 'Occupied Ford'), owner = definition(device.server, group), current = await live(page);
        await rename(scope, device, source, 'Occupied Ford', { conflict: true });
        expect(stored(device.server, source)).toEqual(beforeSource); expect(stored(device.server, 'Occupied Ford')).toEqual(beforeTarget); expect(definition(device.server, group)).toEqual(owner);
        expect((await live(page)).id).toBe(current.id); expect((await live(page)).messages).toEqual(current.messages); await complete(scope, device, source);
    });
});

test('welcome pin follows sanitized inactive rename without changing owner current pointer and survives collision history recent and restart', async ({ browser }, info) => {
    await scenario(browser, info, async scope => {
        const device = await scope.device('Pinned'), page = device.page, group = await createGroup(scope, device);
        const source = (await live(page)).id;
        const sourcePayload = await complete(scope, device, source);
        const current = await importChat(scope, page), currentPayload = await complete(scope, device, current);
        await command(page, '/closechat');
        await expect(welcomeRow(page, source)).toBeVisible();
        await welcomeRow(page, source).locator('.pinChat').click();
        await expect(welcomeRow(page, source).locator('.pinChat')).toHaveClass(/active/);
        const pinBefore = await pins(page);
        const oldKey = `group_${group}_${source}.jsonl`, newKey = `group_${group}_PinnedFord.jsonl`;
        expect(pinBefore[oldKey]).toMatchObject({ group, file_name: `${source}.jsonl` });
        await expect.poll(() => storedPins(device.server)).toEqual(pinBefore);
        const ownerBefore = definition(device.server, group);
        expect(ownerBefore.chat_id).toBe(current);
        expect(ownerBefore.chats).toContain(source);
        scope.records.push({ label: 'welcome-pinned-before', pins: pinBefore, owner: ownerBefore, source: sourcePayload, current: currentPayload });

        await renameWelcome(scope, device, source, 'Pinned?Ford');
        const expectedPins = { ...pinBefore, [newKey]: { group, file_name: 'PinnedFord.jsonl' } }; delete expectedPins[oldKey];
        const expectedOwner = { ...ownerBefore, chats: [...ownerBefore.chats.filter(id => id !== source), 'PinnedFord'] };
        await expect.poll(async () => pins(page)).toEqual(expectedPins);
        await expect.poll(() => storedPins(device.server)).toEqual(expectedPins);
        await expect(welcomeRow(page, 'PinnedFord').locator('.pinChat')).toHaveClass(/active/);
        expect(definition(device.server, group)).toEqual(expectedOwner);
        expect(stored(device.server, source)).toBeNull(); expect(stored(device.server, 'PinnedFord')).toEqual(sourcePayload);
        expect(stored(device.server, current)).toEqual(currentPayload);
        scope.records.push({ label: 'welcome-pinned-renamed', pins: await pins(page), storedPins: storedPins(device.server), owner: definition(device.server, group), source: stored(device.server, 'PinnedFord'), current: stored(device.server, current) });

        await renameWelcome(scope, device, 'PinnedFord', current, { conflict: true });
        expect(await pins(page)).toEqual(expectedPins); expect(storedPins(device.server)).toEqual(expectedPins);
        expect(definition(device.server, group)).toEqual(expectedOwner);
        expect(stored(device.server, 'PinnedFord')).toEqual(sourcePayload); expect(stored(device.server, current)).toEqual(currentPayload);

        await device.server.restart(); device.runtimes.push(device.server.execArgv); await reloadS3Page(page);
        await expect(welcomeRow(page, 'PinnedFord').locator('.pinChat')).toHaveClass(/active/);
        expect(await pins(page)).toEqual(expectedPins); expect(storedPins(device.server)).toEqual(expectedPins);
        expect(definition(device.server, group)).toEqual(expectedOwner);
        await welcomeRow(page, 'PinnedFord').click();
        await page.waitForFunction(() => window.Luker.getContext().getCurrentChatId() === 'PinnedFord');
        expect(await complete(scope, device, 'PinnedFord')).toEqual(sourcePayload);
        await openChatByName(page, current); expect(await complete(scope, device, current)).toEqual(currentPayload);
        await openChatByName(page, 'PinnedFord'); expect(await complete(scope, device, 'PinnedFord')).toEqual(sourcePayload);
        await command(page, '/closechat');
        await expect(welcomeRow(page, 'PinnedFord').locator('.pinChat')).toHaveClass(/active/);
        scope.records.push({ label: 'welcome-pinned-restarted', pins: await pins(page), storedPins: storedPins(device.server), owner: definition(device.server, group), source: stored(device.server, 'PinnedFord'), current: stored(device.server, current) });
    });
});
