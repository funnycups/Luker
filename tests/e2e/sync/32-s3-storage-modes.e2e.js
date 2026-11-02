import { test, expect } from '@playwright/test';
import { makeTempMysqlEngineHarness } from '../../storage/harness/mysql-harness.js';
import { makeTempPgEngineHarness } from '../../storage/harness/pg-harness.js';
import { s3Fixture, createReadyWorldBook, selectReadyWorldBook, reloadS3Page } from '../_lib/sync-s3.js';
import { restoreChatCorpus, editCorpusChat, mountCharacterCorpusChat, deleteCorpusChat, readChat, readChatData, assertCompanions, assertCompanionHistory, assertCommittedCompanions, captureChatEvidence, closeChatPopups as closeAllPopups, INTEGRITY, COMPANIONS, LEGACY_DRIFT } from '../_lib/s3-chat.js';
import fs from 'node:fs';
import { addWorldEntry } from '../_lib/ui-worldinfo.js';
import { addS3Backend, waitForBackendSync, openLanSyncPanel, clickSyncNow, setSyncDeviceLabel,
    waitForSyncPopup, listPopupNotices, listPopupConflicts, openBranchFromNotice, dismissNotice, waitForStatusChecks, syncPopup } from '../_lib/sync.js';

const fixture = s3Fixture(test);
test.use({ actionTimeout: 30_000 });
const databases = [];

test.afterEach(async () => { for (const db of databases.splice(0)) await db.cleanup(); });

test.describe.configure({ timeout: 600_000 });

async function manual(device) {
    await closeAllPopups(device.page); await openLanSyncPanel(device.page);
    expect(await clickSyncNow(device.page, 'Cloud', 120_000)).toBe('success');
    await waitForBackendSync(device.page, { label: 'Cloud' });
    await closeAllPopups(device.page);
}

async function device(browser, mode, label) {
    let extraConfig = { 'storage.mode': mode };
    if (mode !== 'sqlite') {
        const db = await (mode === 'mysql' ? makeTempMysqlEngineHarness() : makeTempPgEngineHarness());
        databases.push(db);
        const root = mode === 'mysql' ? process.env.LUKER_TEST_MYSQL_ROOT_URL || 'mysql://root:root@127.0.0.1:53306' : process.env.LUKER_TEST_POSTGRES_URL || 'postgresql://luker:postgres@127.0.0.1:55432/luker_test';
        const url = mode === 'mysql' ? `${root}/${db.dbName}` : `${root}?options=-csearch_path%3D${encodeURIComponent(db.schemaName)}`;
        extraConfig[`storage.${mode}.url`] = url;
        await db.engine.ping();
    }
    const d = await fixture.device(browser, `sql-${mode}-${label}`, {}, { extraConfig });
    const journal = test.info().outputPath(`selection-${mode}.ndjson`);
    const record = value => fs.appendFileSync(journal, `${JSON.stringify({ at: Date.now(), ...value })}\n`);
    d.page.on('console', message => {
        if (message.text().startsWith('selection-observation ')) record({ type: 'event', value: JSON.parse(message.text().slice('selection-observation '.length)) });
    });
    d.page.on('pageerror', error => record({ type: 'pageerror', message: error.message, stack: error.stack }));
    const readRoute = url => /^\/api\/(characters\/(all|get)|chats\/(get|search|group\/get))$/.test(new URL(url).pathname);
    d.page.on('request', request => {
        if (readRoute(request.url())) record({ type: 'request', path: new URL(request.url()).pathname, body: request.postData() });
    });
    d.page.on('response', response => {
        if (readRoute(response.url())) record({ type: 'response', path: new URL(response.url()).pathname, status: response.status(), body: response.request().postData() });
    });
    await d.page.addInitScript(() => {
        const emit = console.debug.bind(console);
        for (const capture of [true, false]) for (const type of ['pointerdown', 'mousedown', 'mouseup', 'click']) {
            document.addEventListener(type, event => {
                const card = event.target.closest('#rm_print_characters_block .entity_block');
                if (!card && !event.target.closest('#right-nav-panel')) return;
                const ctx = window.Luker.getContext();
                const elementInfo = element => ({ tag: element.tagName, id: element.id, className: element.className });
                emit('selection-observation ' + JSON.stringify({ type, capture, trusted: event.isTrusted,
                    target: elementInfo(event.target), path: event.composedPath().filter(element => element instanceof HTMLElement).map(elementInfo),
                    card: card ? { ...elementInfo(card), chid: card.getAttribute('data-chid'), text: card.querySelector('.ch_name')?.textContent,
                        avatar: card.querySelector('.avatar')?.title, html: card.outerHTML } : null,
                    listClass: document.getElementById('rm_print_characters_block').className,
                    characterId: ctx.characterId, selectedAvatar: ctx.characters[ctx.characterId]?.avatar,
                    groupId: ctx.groupId, chatId: ctx.getCurrentChatId(), chatLength: ctx.chat.length,
                    characters: ctx.characters.map(character => ({ name: character.name, avatar: character.avatar, chat: character.chat })),
                    toasts: [...document.querySelectorAll('.toast-message')].map(element => element.textContent) }));
            }, { capture });
        }
    });
    await setSyncDeviceLabel(d.page, label);
    return d;
}

for (const [source, receiver] of [['sqlite', 'mysql'], ['mysql', 'postgres'], ['postgres', 'sqlite']]) for (const drift of [false, true]) test(`${source} to ${receiver} S3 bridge retains ${drift ? 'legacy drift' : 'canonical graph'} character and group companions through forks and restart`, async ({ browser }, testInfo) => {
    test.setTimeout(600_000);
    const a = await device(browser, source, 'Origin desk'), b = await device(browser, receiver, 'Receiving tablet');
    const stateRequests = [];
    for (const [side, d] of [['source', a], ['receiver', b]]) d.page.on('request', request => {
        if (request.method() === 'POST' && /\/api\/chats\/state\/(patch|delete)$/.test(new URL(request.url()).pathname)) stateRequests.push({ side, path: new URL(request.url()).pathname, body: request.postDataJSON() });
    });
    try {
        await restoreChatCorpus(a, testInfo, { companions: { ...COMPANIONS, memory_graph: drift ? LEGACY_DRIFT : COMPANIONS.memory_graph } });
        const options = await fixture.options(['worlds', 'characters', 'chats']);
        await openLanSyncPanel(a.page); await addS3Backend(a.page, options); await waitForBackendSync(a.page, { label: 'Cloud' });
        await addS3Backend(b.page, options); await waitForBackendSync(b.page, { label: 'Cloud' });
        for (const d of [a, b]) await closeAllPopups(d.page);
        const originals = ['chats/Seraphina/Forest Path.jsonl', 'group chats/gc1.jsonl'];
        for (const d of [a, b]) await assertCompanions(d.page, originals, { drift });
        await createReadyWorldBook(a.page, 'SQL Bridge Grove');
        await addWorldEntry(a.page, { key: 'sql', content: `${source} writes through the DOM` });
        await manual(a); await manual(b);
        await reloadS3Page(b.page); await selectReadyWorldBook(b.page, 'SQL Bridge Grove');
        await expect(b.page.locator('#world_popup_entries_list .world_entry[uid]')).toHaveCount(1);
        const mounted = [];
        for (const rel of originals) {
            await editCorpusChat(a, rel, `Desk version of ${rel}`);
            await editCorpusChat(b, rel, `Tablet version of ${rel}`);
            mounted.push(rel);
            for (const d of [a, b]) {
                await assertCompanions(d.page, mounted, { mounted: true, drift });
                await assertCompanions(d.page, originals.filter(path => !mounted.includes(path)), { drift });
            }
        }
        await manual(a);
        await closeAllPopups(b.page); await openLanSyncPanel(b.page);
        const response = b.page.waitForResponse(r => /\/backends\/[^/]+\/sync$/.test(new URL(r.url()).pathname));
        expect(await clickSyncNow(b.page, 'Cloud', 120_000)).toBe('success');
        const result = await (await response).json();
        fs.writeFileSync(testInfo.outputPath('conflict-operation.json'), JSON.stringify(result, null, 2));
        expect(result).toMatchObject({ ok: true });
        await waitForSyncPopup(b.page);
        expect(await listPopupConflicts(b.page)).toEqual([]);
        const notices = await listPopupNotices(b.page);
        expect(notices).toHaveLength(2);
        const forks = notices.map(n => n.path);
        await assertCompanions(b.page, [...originals, ...forks], { mounted: true, drift });
        await assertCommittedCompanions(b, [...originals, ...forks], { drift });
        for (const notice of notices) {
            expect(notice.text).toMatch(/version from (Origin desk|Receiving tablet) was saved as the branch chat/);
            const original = notice.path.startsWith('group chats/') ? originals[1] : originals[0];
            const branch = notice.path.slice(notice.path.lastIndexOf('/') + 1, -'.jsonl'.length);
            const header = (await readChat(b.page, notice.path))[0];
            expect(header.chat_metadata.main_chat).toBe(original.startsWith('group chats/') ? 'gc1' : 'Forest Path');
            expect(header.chat_metadata.integrity).not.toBe(INTEGRITY);
            expect(header.chat_metadata.integrity).not.toBe((await readChat(b.page, original))[0].chat_metadata.integrity);
            await openBranchFromNotice(b.page, notice.path, branch);
            await expect(b.page.locator('.mes[mesid="2"] .mes_text')).toContainText('version of');
            await reloadS3Page(b.page); await waitForSyncPopup(b.page);
        }
        // The terminal operation, not merely a visible popup, precedes exact checks.
        await assertCompanions(b.page, [...originals, ...forks], { mounted: true, drift });
        await manual(a);
        const expectedChats = new Map();
        for (const rel of [...originals, ...forks]) expectedChats.set(rel, await readChat(b.page, rel));
        const groupFork = forks.find(rel => rel.startsWith('group chats/')).slice('group chats/'.length, -'.jsonl'.length);
        for (const d of [a, b]) {
            await assertCompanions(d.page, [...originals, ...forks], { mounted: true, drift });
            await assertCommittedCompanions(d, [...originals, ...forks], { drift });
            await assertCompanions(d.page, ['chats/Seraphina/River Ford.jsonl'], { drift });
            await assertCompanionHistory(d, originals, drift ? LEGACY_DRIFT : COMPANIONS.memory_graph);
            for (const [rel, expected] of expectedChats) expect(await readChat(d.page, rel)).toEqual(expected);
            const groups = await readChatData(d.page, '/api/groups/all', {});
            expect(groups.find(g => g.id === 'g1').chats).toEqual(['gc1', groupFork]);
            await manual(d);
            await d.server.restart(); await reloadS3Page(d.page); await manual(d);
            await assertCompanions(d.page, [...originals, ...forks], { mounted: true, drift });
            await assertCommittedCompanions(d, [...originals, ...forks], { drift });
            await assertCompanions(d.page, ['chats/Seraphina/River Ford.jsonl'], { drift });
            await assertCompanionHistory(d, originals, drift ? LEGACY_DRIFT : COMPANIONS.memory_graph);
            for (const [rel, expected] of expectedChats) expect(await readChat(d.page, rel)).toEqual(expected);
            expect((await readChatData(d.page, '/api/groups/all', {})).find(g => g.id === 'g1').chats).toEqual(['gc1', groupFork]);
        }
        await reloadS3Page(b.page); await waitForSyncPopup(b.page);
        for (const notice of notices) await dismissNotice(b.page, notice.path);
        await manual(b); await manual(a);
        for (const d of [a, b]) { await reloadS3Page(d.page); await waitForStatusChecks(d.page); await expect(syncPopup(d.page)).toHaveCount(0); }
        if (drift) {
            const restored = ['chats/Seraphina/River Ford.jsonl', 'group chats/gc1.jsonl'];
            const restoredChats = new Map();
            for (const rel of restored) {
                for (const d of [a, b]) {
                    if (rel === restored[0]) await mountCharacterCorpusChat(d, rel, { drift: true });
                    else await assertCompanions(d.page, [rel], { mounted: true, drift: true });
                }
                await editCorpusChat(a, rel, `Restored complete drift for ${rel}`);
                restoredChats.set(rel, await readChat(a.page, rel));
                await deleteCorpusChat(b, rel);
            }
            await manual(b); await manual(a);
            await reloadS3Page(a.page); await waitForSyncPopup(a.page);
            const restoredNotices = await listPopupNotices(a.page);
            expect(restoredNotices.map(notice => notice.path).sort()).toEqual([...restored].sort());
            for (const notice of restoredNotices) expect(notice.text).toBe(`${notice.path === restored[0] ? 'River Ford' : 'gc1'} was deleted on Receiving tablet but kept on Origin desk, so it was restored.`);
            await manual(b);
            for (const rel of restored) {
                // DOM edits rotate integrity. Restoration must retain the
                // complete keeper record captured before the merge.
                expect(await readChat(a.page, rel)).toEqual(restoredChats.get(rel));
                expect(restoredChats.get(rel)[3].mes).toBe(`Restored complete drift for ${rel}`);
            }
            for (const d of [a, b]) {
                await assertCompanions(d.page, [...restored, ...forks, originals[0]], { mounted: true, drift: true });
                await assertCommittedCompanions(d, [...restored, ...forks, originals[0]], { drift: true });
                for (const [rel, expected] of restoredChats) expect(await readChat(d.page, rel)).toEqual(expected);
                expect((await readChatData(d.page, '/api/groups/all', {})).find(group => group.id === 'g1').chats.sort()).toEqual(['gc1', groupFork].sort());
                await manual(d); await d.server.restart(); await reloadS3Page(d.page); await manual(d);
                await assertCompanions(d.page, [...restored, ...forks, originals[0]], { mounted: true, drift: true });
                await assertCommittedCompanions(d, [...restored, ...forks, originals[0]], { drift: true });
                await assertCompanionHistory(d, [...originals, restored[0]], LEGACY_DRIFT);
                for (const [rel, expected] of restoredChats) expect(await readChat(d.page, rel)).toEqual(expected);
            }
            await reloadS3Page(b.page); await waitForSyncPopup(b.page);
            for (const notice of restoredNotices) {
                await openBranchFromNotice(b.page, notice.path, notice.path.slice(notice.path.lastIndexOf('/') + 1, -6));
                await expect(b.page.locator('.mes[mesid="2"] .mes_text')).toHaveText(`Restored complete drift for ${notice.path}`);
                await reloadS3Page(b.page); await waitForSyncPopup(b.page); await dismissNotice(b.page, notice.path);
            }
            await manual(b); await manual(a);
            for (const d of [a, b]) { await reloadS3Page(d.page); await waitForStatusChecks(d.page); await expect(syncPopup(d.page)).toHaveCount(0); }
        }
        for (const side of ['source', 'receiver']) for (const namespace of ['memory_graph', ...(drift ? ['memory_graph__orphans'] : [])]) {
            expect(stateRequests.filter(request => request.side === side && request.body.namespace === namespace).length, `${side} genuine DOM migration ${namespace}`).toBeGreaterThan(0);
        }
        fs.writeFileSync(testInfo.outputPath('chat-state-requests.json'), JSON.stringify(stateRequests, null, 2));
    } catch (error) {
        fs.writeFileSync(testInfo.outputPath('original-failure.txt'), error.stack || String(error));
        const observations = await Promise.allSettled([a, b].map(async d => ({
            state: await d.page.evaluate(() => {
                const ctx = window.Luker.getContext();
                return { characterId: ctx.characterId, selectedAvatar: ctx.characters[ctx.characterId]?.avatar,
                    groupId: ctx.groupId, chatId: ctx.getCurrentChatId(), chat: ctx.chat,
                    characters: ctx.characters.map(character => ({ name: character.name, avatar: character.avatar, chat: character.chat })),
                    cards: [...document.querySelectorAll('#rm_print_characters_block .entity_block')].map(element => element.outerHTML),
                    initialized: performance.getEntriesByName('[init] complete').length,
                    toasts: [...document.querySelectorAll('.toast-message')].map(element => element.textContent) };
            }),
            stored: await readChat(d.page, 'chats/Seraphina/River Ford.jsonl'),
            search: await readChatData(d.page, '/api/chats/search', { avatar_url: 'Seraphina.png', group_id: null, query: '' }),
        })));
        fs.writeFileSync(testInfo.outputPath('selection-failure.json'), JSON.stringify(observations.map(result => result.status === 'fulfilled'
            ? { status: result.status, value: result.value } : { status: result.status, error: result.reason.stack }), null, 2));
        fs.writeFileSync(testInfo.outputPath('chat-state-requests.json'), JSON.stringify(stateRequests, null, 2));
        await captureChatEvidence([a, b], testInfo, { live: false });
        throw error;
    }
});
