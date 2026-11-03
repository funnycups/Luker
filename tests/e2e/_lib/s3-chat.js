// Real backup ingestion and DOM chat editing shared by S3 acceptance specs.
import fs from 'node:fs';
import path from 'node:path';
import git from 'isomorphic-git';
import archiver from 'archiver';
import { expect } from '@playwright/test';
import { write as writeCardToPng } from '../../../src/character-card-parser.js';
import { awaitS3Page, reloadS3Page } from './sync-s3.js';
import { closeAllPopups, openChatByName, waitForStatusChecks, userRootOf } from './sync.js';
import { accountWindow, answerWindowConfirm, openAccountTab } from './account-window.js';
import { registryOf } from './sync-s3.js';
import { readCommitFiles, readBlobBytes } from '../../../src/sync/pipeline/git-tree.js';
import { normalizeLog, computeTargetState, buildSwipeMapFromChat } from '../../../public/scripts/floor-state/core.js';
import { buildRuntimeStoreFromGraphPayloadAndMeta } from '../../../public/scripts/extensions/memory-graph/persistence.js';

export const INTEGRITY = '7d6b3c9e-1f2a-4b5c-8d9e-0a1b2c3d4e5f';
export const GRAPH = { nodes: { n_1: { id: 'n_1', level: 'semantic', type: 'semantic', title: 'Silver spring', seqTo: 1, fields: { remembered: ['birches', 'stones'] },
    semanticDepth: 0, semanticRollup: false, childrenIds: [], parentId: '', archived: false } }, edges: [], nodeSeq: 1, seqCounter: 1, appliedSeqTo: 1, loggedSeqTo: 1,
coveredAssistantSeq: 1 };
export const LEGACY_DRIFT = { ...GRAPH, legacyNote: { complete: ['silver spring', 'before dawn'], revision: 7 } };
export const EXPECTED_RUNTIME = { nodes: GRAPH.nodes, edges: [], nodeSeq: 1, seqCounter: 1, appliedSeqTo: 1, loggedSeqTo: 1,
    sourceMessageCount: 3, lastRecallTrace: [{ query: 'spring', selected: ['n_1'] }], lastRecallProjection: { retained: ['n_1'] } };
export const COMPANIONS = {
    memory_graph: GRAPH,
    memory_graph__floor_log: { version: 1, commits: [
        { floor: 0, swipeId: 0, patches: [{ op: 'add', path: '/discardedBranch', value: { complete: ['unselected', 'greeting'] } }] },
        { floor: 0, swipeId: 1, patches: Object.entries(GRAPH).map(([key, value]) => ({ op: 'add', path: `/${key}`, value })) },
    ] },
    memory_graph__meta: { schemaVersion: 2, sourceMessageCount: 3, lastRecallTrace: [{ query: 'spring', selected: ['n_1'] }], lastRecallProjection: { retained: ['n_1'] } },
    iter_studio: { sessions: [{ id: 'draft', label: 'Before dawn', messages: ['north', 'south'] }], selected: 'draft' },
};
const seedLines = text => [
    { user_name: 'User', character_name: 'Seraphina', create_date: '2026-10-01@10h00m00s', chat_metadata: { integrity: INTEGRITY } },
    { name: 'Seraphina', is_user: false, mes: text, send_date: '2026-10-01@10h00m01s', swipe_id: 1, swipes: ['The glade before dawn.', text] },
    { name: 'User', is_user: true, mes: 'Which path leads to the spring?', send_date: '2026-10-01@10h00m02s' },
    { name: 'Seraphina', is_user: false, mes: 'Follow the birches.', send_date: '2026-10-01@10h00m03s' },
];
const jsonl = text => seedLines(text).map(line => JSON.stringify(line)).join('\n') + '\n';

export async function restoreChatCorpus(device, testInfo, { companions = COMPANIONS, artifactPrefix = '' } = {}) {
    const outputPath = name => testInfo.outputPath(`${artifactPrefix}${name}`);
    if (companions.memory_graph__floor_log) {
        const replay = computeTargetState(normalizeLog(companions.memory_graph__floor_log).commits, buildSwipeMapFromChat(seedLines('Welcome back to the glade.').slice(1)));
        expect(replay, 'the real floor-state algorithm must replay the complete fixture').toEqual(GRAPH);
    }
    const root = outputPath('corpus');
    fs.mkdirSync(root, { recursive: true });
    const png = writeCardToPng(Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII=', 'base64'),
        JSON.stringify({ name: 'Seraphina', first_mes: 'Welcome back to the glade.', chat: 'Forest Path' }));
    const file = outputPath('corpus.zip');
    // Store already-compressed PNG bytes verbatim. Both ZIP and the restore
    // remain genuine; this fixture is not a ZIP-deflate acceptance test.
    const zip = archiver('zip', { store: true });
    const output = fs.createWriteStream(file);
    const completed = new Promise((resolve, reject) => { output.on('close', resolve); zip.on('error', reject); output.on('error', reject); });
    zip.pipe(output);
    const add = (name, content) => zip.append(content, { name });
    add('manifest.json', Buffer.from(JSON.stringify({ schemaVersion: 1, handle: 'default-user', selection: { characters: true, chats: true } })));
    add('characters/Seraphina.png', png);
    add('groups/g1.json', Buffer.from(JSON.stringify({ id: 'g1', name: 'Glade Watch', date_added: 1700000000000, members: ['Seraphina.png'], avatar_url: '', allow_self_responses: false,
        activation_strategy: 1, generation_mode: 0, disabled_members: [], fav: false, chat_id: 'gc1', chats: ['gc1'], auto_mode_delay: 5 }, null, 4)));
    for (const rel of ['chats/Seraphina/Forest Path', 'chats/Seraphina/River Ford', 'group chats/gc1']) {
        add(`${rel}.jsonl`, Buffer.from(jsonl('Welcome back to the glade.')));
        for (const [namespace, content] of Object.entries(companions)) add(`${rel}.luker-state.${namespace}.json`, Buffer.from(JSON.stringify(content)));
    }
    await zip.finalize(); await completed;
    await closeAllPopups(device.page);
    const page = device.page;
    await openAccountTab(page, 'restore');
    const win = accountWindow(page);
    await win.locator('[data-act="bsel"][data-mode="none"]').click();
    for (const category of ['characters', 'chats']) {
        const chip = win.locator(`[data-act="bcat"][data-id="${category}"]`);
        await chip.click();
        await expect(chip).toHaveClass(/\bon\b/);
    }
    await win.locator('[data-role="file"]').setInputFiles(file);
    // Forward the genuine response unchanged and observe its streamed result
    // before the successful UI callback reloads the page and discards it.
    let body;
    const observeRestore = async route => {
        const response = await route.fetch();
        body = await response.text();
        await route.fulfill({ response });
    };
    await page.route('**/api/users/restore-backup', observeRestore);
    const response = page.waitForResponse(r => new URL(r.url()).pathname === '/api/users/restore-backup' && r.request().method() === 'POST');
    const navigated = page.waitForEvent('load', { timeout: 60_000 });
    navigated.catch(() => {});
    try {
        await win.locator('[data-act="restore-go"]').click();
        await answerWindowConfirm(page);
        expect((await response).ok()).toBe(true);
        fs.writeFileSync(outputPath('restore-operation.ndjson'), body);
        const events = body.trim().split('\n').map(line => JSON.parse(line));
        expect(events.filter(event => event.type === 'error')).toEqual([]);
        const result = events.find(event => event.type === 'result');
        expect(result).toBeTruthy();
        expect(result.failedCount ?? 0).toBe(0);
        expect(result.rejectedCount ?? 0).toBe(0);
        await navigated;
        await awaitS3Page(page);
    } finally {
        await page.unroute('**/api/users/restore-backup', observeRestore);
        fs.writeFileSync(outputPath('restore-server-output.txt'), device.server.output);
        await testInfo.attach('restore-server-output', { body: device.server.output, contentType: 'text/plain' });
    }
}

export async function readChatData(page, route, body) {
    // Only repository read endpoints are called here; no runtime action/configuration.
    return page.evaluate(async ({ route, body }) => {
        const { token } = await (await fetch('/csrf-token')).json();
        const response = await fetch(route, { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-CSRF-Token': token }, body: JSON.stringify(body) });
        if (!response.ok) throw new Error(`Read ${route}: HTTP ${response.status}`);
        return response.json();
    }, { route, body });
}

export function chatTarget(rel) {
    return rel.startsWith('group chats/') ? { is_group: true, id: rel.slice('group chats/'.length, -'.jsonl'.length) }
        : { avatar_url: 'Seraphina.png', file_name: rel.slice('chats/Seraphina/'.length, -'.jsonl'.length) };
}

export async function readChat(page, rel) {
    const target = chatTarget(rel);
    return readChatData(page, target.is_group ? '/api/chats/group/get' : '/api/chats/get', target);
}

export async function assertCompanions(page, paths, { mounted = false, drift = false } = {}) {
    for (const rel of paths) {
        const stored = {};
        for (const [namespace, expected] of Object.entries(COMPANIONS)) {
            const result = await readChatData(page, '/api/chats/state/get', { ...chatTarget(rel), namespace });
            stored[namespace] = result.data;
            const wanted = namespace === 'memory_graph' ? mounted ? null : drift ? LEGACY_DRIFT : GRAPH : expected;
            expect(result, `${rel} complete ${namespace}`).toEqual({ ok: true, data: wanted });
        }
        const chat = await readChat(page, rel);
        expect(Array.isArray(chat)).toBe(true);
        expect(chat).toHaveLength(4);
        expect(chat.slice(1, 3), `${rel} complete untouched chat records`).toEqual(seedLines('Welcome back to the glade.').slice(1, 3));
        const replay = computeTargetState(normalizeLog(stored.memory_graph__floor_log).commits, buildSwipeMapFromChat(chat.slice(1)));
        expect(replay, `${rel} exact graph replay using live floors/swipes`).toEqual(GRAPH);
        expect(buildRuntimeStoreFromGraphPayloadAndMeta(replay, stored.memory_graph__meta)).toEqual(EXPECTED_RUNTIME);
        const orphans = await readChatData(page, '/api/chats/state/get', { ...chatTarget(rel), namespace: 'memory_graph__orphans' });
        expect(orphans).toEqual({ ok: true, data: mounted && drift ? { dataPayload: LEGACY_DRIFT, replayPayload: GRAPH,
            diff: [{ op: 'add', path: '/legacyNote', value: LEGACY_DRIFT.legacyNote }] } : null });
    }
}

export async function assertCompanionHistory(device, paths, expected = GRAPH) {
    for (const id of Object.keys(registryOf(device.server).backends)) {
        const gitdir = path.join(userRootOf(device.server), '.sync', id, 'repo.git');
        const log = await git.log({ fs, gitdir, ref: 'refs/heads/main' });
        for (const rel of paths) {
            const filepath = rel.replace(/\.jsonl$/, '.luker-state.memory_graph.json');
            const versions = await Promise.all(log.map(async ({ oid }) => {
                try {
                    const file = (await readCommitFiles({ gitdir, commitOid: oid })).get(filepath);
                    return file ? JSON.parse((await readBlobBytes({ gitdir, oid: file.oid })).toString()) : null;
                } catch (error) {
                    throw new Error(`Historical companion read at commit ${oid} path ${filepath}: ${error.message}`, { cause: error });
                }
            }));
            expect(versions, `${rel} complete legacy payload remains reachable`).toContainEqual(expected);
        }
    }
}

export async function assertCommittedCompanions(device, paths, { drift = false, mounted = true } = {}) {
    for (const id of Object.keys(registryOf(device.server).backends)) {
        const gitdir = path.join(userRootOf(device.server), '.sync', id, 'repo.git');
        const head = await git.resolveRef({ fs, gitdir, ref: 'refs/heads/main' });
        const files = await readCommitFiles({ gitdir, commitOid: head });
        for (const rel of paths) {
            for (const [namespace, expected] of Object.entries(COMPANIONS).filter(([ns]) => ns !== 'memory_graph')) {
                const entry = files.get(rel.replace(/\.jsonl$/, `.luker-state.${namespace}.json`));
                expect(entry, `${rel} committed ${namespace}`).toBeTruthy();
                expect(JSON.parse((await readBlobBytes({ gitdir, oid: entry.oid })).toString())).toEqual(expected);
            }
            if (drift && mounted) {
                const entry = files.get(rel.replace(/\.jsonl$/, '.luker-state.memory_graph__orphans.json'));
                expect(entry, `${rel} committed complete drift backup`).toBeTruthy();
                expect(JSON.parse((await readBlobBytes({ gitdir, oid: entry.oid })).toString())).toEqual({ dataPayload: LEGACY_DRIFT, replayPayload: GRAPH,
                    diff: [{ op: 'add', path: '/legacyNote', value: LEGACY_DRIFT.legacyNote }] });
            }
        }
    }
}

export async function deleteCorpusChat(device, rel) {
    await reloadS3Page(device.page); await waitForStatusChecks(device.page); await openCorpusChat(device.page, rel);
    await device.page.locator('#options_button').click(); await device.page.locator('#option_select_chat').click();
    const name = rel.slice(rel.lastIndexOf('/') + 1, -'.jsonl'.length);
    const row = device.page.locator('.select_chat_block_wrapper', { has: device.page.locator('.select_chat_block_filename', { hasText: new RegExp(`^\\s*${RegExp.escape(name)}(\\.jsonl)?\\s*$`) }) }).first();
    await row.locator('.PastChat_cross').click();
    await device.page.locator('dialog.popup[open]', { hasText: 'Delete the Chat File?' }).locator('.popup-button-ok').click();
    await expect.poll(() => readChat(device.page, rel)).toEqual(rel.startsWith('group chats/') ? [] : { new_chat: true });
    await closeChatPopups(device.page);
}

export async function closeChatPopups(page) {
    const historyClose = page.locator('#select_chat_cross:visible');
    const open = page.locator('dialog.popup[open]');
    while (await open.count() || await historyClose.count()) {
        if (await open.count()) {
            const id = await open.last().getAttribute('data-id');
            const dialog = page.locator(`dialog.popup[data-id="${id}"]`);
            // Pin the selected DOM Close action; a newly delivered notice
            // must not redirect it to another dialog or overlay.
            await dialog.locator('.popup-button-ok').dispatchEvent('click');
            await expect(dialog).toHaveCount(0);
        } else {
            await historyClose.dispatchEvent('click');
            await expect(page.locator('#shadow_select_chat_popup')).toBeHidden();
        }
    }
}

export async function captureChatEvidence(devices, testInfo, { live = true } = {}) {
    for (const [index, device] of devices.entries()) {
        const evidence = { live: {}, shadows: {} };
        const paths = new Set(['chats/Seraphina/Forest Path.jsonl', 'group chats/gc1.jsonl']);
        for (const id of Object.keys(registryOf(device.server).backends)) {
            const gitdir = path.join(userRootOf(device.server), '.sync', id, 'repo.git');
            const head = await git.resolveRef({ fs, gitdir, ref: 'refs/heads/main' });
            const files = await readCommitFiles({ gitdir, commitOid: head });
            const contents = {};
            for (const [rel, file] of files) if (rel.startsWith('.luker-sync/') || rel.startsWith('chats/Seraphina/') || rel.startsWith('group chats/') || rel === 'groups/g1.json') {
                contents[rel] = { oid: file.oid, bytes: (await readBlobBytes({ gitdir, oid: file.oid })).toString() };
                if (rel.endsWith('.jsonl')) paths.add(rel);
            }
            evidence.shadows[id] = { head, commit: (await git.readCommit({ fs, gitdir, oid: head })).commit, contents };
        }
        for (const rel of live ? paths : []) {
            evidence.live[rel] = { chat: await readChat(device.page, rel), companions: {} };
            for (const namespace of [...Object.keys(COMPANIONS), 'memory_graph__orphans']) evidence.live[rel].companions[namespace] = await readChatData(device.page, '/api/chats/state/get', { ...chatTarget(rel), namespace });
        }
        fs.writeFileSync(testInfo.outputPath(`chat-evidence-${index}.json`), JSON.stringify(evidence, null, 2));
        fs.writeFileSync(testInfo.outputPath(`chat-server-${index}.log`), device.server.output);
    }
}

export async function openCorpusChat(page, rel) {
    await closeAllPopups(page);
    if (await page.locator('#user-settings-button .drawer-content').evaluate(el => el.classList.contains('openDrawer'))) await page.locator('#user-settings-button .drawer-toggle').click();
    if (await page.locator('#rightNavDrawerIcon').evaluate(el => el.classList.contains('closedIcon'))) await page.locator('#rightNavDrawerIcon').click();
    if (!await page.locator('#rm_print_characters_block').isVisible()) await page.locator('#rm_button_characters').click();
    if (rel.startsWith('group chats/')) {
        await page.locator('#rm_print_characters_block .group_select', { hasText: 'Glade Watch' }).click();
        await page.waitForFunction(() => window.Luker.getContext().groupId === 'g1' && window.Luker.getContext().chat.length >= 3);
    } else {
        const card = page.locator('#rm_print_characters_block .character_select').filter({ has: page.locator('.avatar[title$="File: Seraphina.png"]') });
        await card.click();
        // A click does not await the asynchronous character/chat transition.
        // Manage chat files must observe the selected character, not welcome.
        await page.waitForFunction(() => {
            const ctx = window.Luker.getContext();
            return ctx.groupId == null && ctx.characters[ctx.characterId]?.avatar === 'Seraphina.png' && ctx.chat.length >= 3;
        });
        await expect(page.locator('.mes[mesid="2"] .mes_text')).toBeVisible();
    }
    if (await page.locator('#rightNavDrawerIcon').evaluate(el => el.classList.contains('openIcon'))) await page.locator('#rightNavDrawerIcon').click();
    const name = rel.startsWith('group chats/') ? chatTarget(rel).id : chatTarget(rel).file_name;
    await openChatByName(page, name);
    await expect(page.locator('.mes[mesid="2"] .mes_text')).toBeVisible();
}

export async function mountCharacterCorpusChat(device, rel, { drift = false } = {}) {
    await reloadS3Page(device.page); await waitForStatusChecks(device.page); await openCorpusChat(device.page, rel);
    if (await device.page.locator('#user-settings-button .drawer-content').evaluate(element => element.classList.contains('closedDrawer'))) await device.page.locator('#user-settings-button .drawer-toggle').click();
    const autoLoad = device.page.locator('#auto-load-chat-checkbox');
    if (!await autoLoad.isChecked()) {
        const [saved] = await Promise.all([
            device.page.waitForResponse(response => /\/api\/settings\/(save|patch)$/.test(new URL(response.url()).pathname) && response.request().method() === 'POST', { timeout: 60_000 }),
            autoLoad.check(),
        ]);
        expect(saved.ok()).toBe(true);
    }
    await expect.poll(async () => {
        const settings = JSON.parse((await readChatData(device.page, '/api/settings/get', {})).settings);
        return { selected: settings.active_character, autoLoad: settings.power_user.auto_load_chat };
    }, { timeout: 30_000 }).toEqual({ selected: 'Seraphina.png', autoLoad: true });
    // Migration is per mounted floor-state instance. Reload the selected chat
    // through its persisted DOM selection instead of assuming a later switch
    // resets that instance's migration latch.
    await reloadS3Page(device.page); await waitForStatusChecks(device.page);
    const name = chatTarget(rel).file_name;
    await device.page.waitForFunction(wanted => window.Luker.getContext().getCurrentChatId() === wanted && window.Luker.getContext().chat.length === 3, name);
    await expect.poll(() => readChatData(device.page, '/api/chats/state/get', { ...chatTarget(rel), namespace: 'memory_graph' }), { timeout: 30_000 }).toEqual({ ok: true, data: null });
    await assertCompanions(device.page, [rel], { mounted: true, drift });
}

export async function editCorpusChat(device, rel, text) {
    await reloadS3Page(device.page); await waitForStatusChecks(device.page); await openCorpusChat(device.page, rel);
    const before = { stored: await readChat(device.page, rel), client: await device.page.evaluate(() => window.Luker.getContext().chat) };
    const mes = device.page.locator('.mes[mesid="2"]');
    await mes.locator('.mes_edit').first().click();
    await mes.locator('.edit_textarea').fill(text);
    const saved = device.page.waitForResponse(r => /\/api\/chats\/(group\/)?(save|patch|append)$/.test(new URL(r.url()).pathname) && r.request().method() === 'POST');
    await mes.locator('.mes_edit_done').click();
    const response = await saved;
    expect(response.ok(), `${response.status()} ${response.url()} ${await response.text()}\n${JSON.stringify({ before, request: response.request().postDataJSON() })}`).toBe(true);
    await expect.poll(async () => JSON.stringify(await readChat(device.page, rel))).toContain(text);
    const after = await readChat(device.page, rel);
    expect(after).toHaveLength(before.stored.length);
    expect(after.slice(1, 3)).toEqual(before.stored.slice(1, 3));
    expect(after[3].mes).toBe(text);
}
