import fs from 'node:fs';
import path from 'node:path';
import http from 'node:http';
import { createHash } from 'node:crypto';
import git from 'isomorphic-git';
import { expect } from '@playwright/test';
import { readCommitFiles, readBlobBytes } from '../../../src/sync/pipeline/git-tree.js';
import { writeMergeCommit } from '../../../src/sync/pipeline/merge.js';
import { listObjectsChildrenFirst } from '../../../src/sync/objects.js';
import { startHttpFixture } from '../../sync/_lib/network-fixtures.js';
import { restoreChatCorpus, editCorpusChat, readChat, readChatData, COMPANIONS, closeChatPopups as closeAllPopups } from './s3-chat.js';
import { createReadyWorldBook, selectReadyWorldBook, reloadS3Page, registryOf } from './sync-s3.js';
import { entryOf, pathsOf, remoteHead, publishedHead } from './s3-races.js';
import { addWorldEntry } from './ui-worldinfo.js';
import { openLanSyncPanel, addS3Backend, waitForBackendSync, setSyncDeviceLabel, generatePairingLink, acceptPairingLink,
    clickSyncNow, clickForgetPeer, waitForBackgroundSync, shadowMain, userRootOf, readUserFile, waitForSyncPopup, listPopupNotices, listPopupConflicts } from './sync.js';

const WORLD = 'worlds/Inherited Grove.json';
const chats = ['chats/Seraphina/Forest Path.jsonl', 'group chats/gc1.jsonl'];
const point = 'after-remote-head';
const lanEntry = d => Object.entries(registryOf(d.server).backends).find(([, entry]) => entry.kind === 'lan');
const lanGit = d => path.join(userRootOf(d.server), '.sync', lanEntry(d)[0], 'repo.git');

async function snapshot(gitdir, oid) {
    const { commit } = await git.readCommit({ fs, gitdir, oid });
    const files = await readCommitFiles({ gitdir, commitOid: oid });
    const bytes = {};
    for (const [name, file] of files) bytes[name] = (await readBlobBytes({ gitdir, oid: file.oid })).toString('base64');
    return { oid, tree: commit.tree, parents: commit.parent, commit, files: Object.fromEntries(files), bytes };
}

async function readHistory(gitdir, oid) {
    return Promise.all((await listObjectsChildrenFirst({ gitdir, headOid: oid, skip: new Set() })).map(async object => {
        const value = await git.readObject({ fs, gitdir, oid: object, format: 'content' });
        return { oid: object, type: value.type, object: value.object };
    }));
}

async function transplantStoppedHistory(device, oid, objects) {
    // Narrow stopped-server history fixture. Only Git objects and main move:
    // backend settings, registry, live records and operation responses do not.
    const to = pathsOf(device).gitDir;
    for (const value of objects) {
        expect(await git.writeObject({ fs, gitdir: to, type: value.type, object: value.object, format: 'content' })).toBe(value.oid);
    }
    await git.writeRef({ fs, gitdir: to, ref: 'refs/heads/main', value: oid, force: true });
}

export async function inheritedEpoch(fixture, browser, testInfo, kind) {
    const roots = ['a', 'c'].map(name => testInfo.outputPath(`pause-${name}`));
    roots.forEach(root => fs.mkdirSync(root, { recursive: true }));
    const a = await fixture.device(browser, 'inherited-a', { LUKER_SYNC_PAUSEPOINT: point, LUKER_SYNC_PAUSE_DIR: roots[0] });
    const b = await fixture.device(browser, 'inherited-b');
    const c = await fixture.device(browser, 'inherited-c', { LUKER_SYNC_PAUSEPOINT: point, LUKER_SYNC_PAUSE_DIR: roots[1] });
    for (const [d, label] of [[a, 'Original A'], [b, 'Original B'], [c, 'Inheritor C']]) await setSyncDeviceLabel(d.page, label);
    for (const [index, d] of [a, b].entries()) {
        await restoreChatCorpus(d, testInfo, { companions: { iter_studio: COMPANIONS.iter_studio }, artifactPrefix: `${index}-` });
        await closeAllPopups(d.page); await createReadyWorldBook(d.page, 'Inherited Grove');
    }
    const options = await fixture.options(['worlds', 'characters', 'chats']);
    const proxies = [await fixture.proxy(), await fixture.proxy()];
    await closeAllPopups(b.page); await openLanSyncPanel(b.page);
    await addS3Backend(b.page, options); await waitForBackendSync(b.page, { label: 'Cloud' });
    const lanProxy = await startHttpFixture((req, res) => {
        const upstream = http.request(`${a.server.baseURL}${req.url}`, { method: req.method, headers: req.headers }, response => { res.writeHead(response.statusCode, response.headers); response.pipe(res); });
        upstream.on('error', error => res.destroy(error)); req.pipe(upstream);
    });
    const gates = [];
    try {
        await closeAllPopups(a.page); await openLanSyncPanel(a.page);
        const since = Date.now(), link = new URL(await generatePairingLink(a.page, { label: 'LAN inheritor', categories: options.categories }));
        link.searchParams.set('base', lanProxy.url);
        expect(await acceptPairingLink(c.page, link.toString(), { localLabel: 'LAN origin', categories: options.categories })).toBe('success');
        await waitForBackgroundSync(a.page, { since }); await waitForBackgroundSync(c.page, { since });
        for (const [d, letter] of [[a, 'X'], [b, 'Y']]) {
            await closeAllPopups(d.page); await reloadS3Page(d.page); await selectReadyWorldBook(d.page, 'Inherited Grove');
            await addWorldEntry(d.page, { key: letter, content: `${letter} immutable origin` });
            // The editor saves after its debounce; the chat helper reloads.
            await expect.poll(() => readUserFile(d.server, WORLD)).toContain(`${letter} immutable origin`);
            for (const rel of chats) {
                const traffic = [];
                const reads = url => /^\/api\/(chats\/(get|search|group\/get)|characters\/get)$/.test(new URL(url).pathname);
                const requested = request => {
                    if (reads(request.url())) traffic.push({ phase: 'request', at: Date.now(), path: new URL(request.url()).pathname, body: request.postData() });
                };
                const responded = response => {
                    if (reads(response.url())) traffic.push({ phase: 'response', at: Date.now(), path: new URL(response.url()).pathname,
                        body: response.request().postData(), status: response.status() });
                };
                d.page.on('request', requested); d.page.on('response', responded);
                try {
                    await editCorpusChat(d, rel, `${letter} complete inherited chat`);
                } catch (error) {
                    const failedAt = Date.now();
                    const target = rel.startsWith('group chats/') ? { avatar_url: null, group_id: 'g1', query: '' } : { avatar_url: 'Seraphina.png', group_id: null, query: '' };
                    const observations = await Promise.allSettled([
                        d.page.evaluate(() => {
                            const ctx = window.Luker.getContext();
                            return { characterId: ctx.characterId, avatar: ctx.characters[ctx.characterId]?.avatar, groupId: ctx.groupId,
                                chatId: ctx.getCurrentChatId(), chat: ctx.chat, initialized: performance.getEntriesByName('[init] complete').length,
                                historyDisplay: getComputedStyle(document.getElementById('shadow_select_chat_popup')).display,
                                rows: [...document.querySelectorAll('#select_chat_div .select_chat_block_filename')].map(element => element.textContent),
                                settingsDrawer: document.querySelector('#user-settings-button .drawer-content').className,
                                characterDrawer: document.getElementById('rightNavDrawerIcon').className };
                        }),
                        readChat(d.page, rel),
                        readChatData(d.page, '/api/chats/search', target),
                    ]);
                    fs.writeFileSync(testInfo.outputPath('inherited-chat-selection-error.json'), JSON.stringify({ rel, letter, failedAt,
                        error: { message: error.message, stack: error.stack }, traffic, file: readUserFile(d.server, rel), searchTarget: target,
                        observations: observations.map((result, index) => ({ source: ['client', 'stored', 'search'][index], ...(result.status === 'fulfilled'
                            ? { status: result.status, value: result.value } : { status: result.status, error: result.reason.message }) })) }, null, 2));
                    throw error;
                } finally {
                    d.page.off('request', requested); d.page.off('response', responded);
                    fs.appendFileSync(testInfo.outputPath('inherited-chat-reads.ndjson'), `${JSON.stringify({ rel, letter, traffic })}\n`);
                }
            }
            // Finish through the real Close chat action before constructing
            // the epoch, so a later restart does not mount a persisted chat.
            await d.page.locator('#options_button').click(); await d.page.locator('#option_close_chat:visible').click();
            await d.page.waitForFunction(() => window.Luker.getContext().getCurrentChatId() == null);
            if (await d.page.locator('#user-settings-button .drawer-content').evaluate(element => element.classList.contains('closedDrawer'))) await d.page.locator('#user-settings-button .drawer-toggle').click();
            // Selecting the current value saves the closed-chat selection
            // through ordinary settings DOM, without changing its value.
            const enter = d.page.locator('#send_on_enter'), value = await enter.inputValue();
            const [saved] = await Promise.all([
                d.page.waitForResponse(response => /\/api\/settings\/(save|patch)$/.test(new URL(response.url()).pathname) && response.request().method() === 'POST', { timeout: 60_000 }),
                enter.selectOption(value),
            ]);
            expect(saved.ok()).toBe(true);
        }
        await closeAllPopups(c.page); await openLanSyncPanel(c.page);
        expect(await clickSyncNow(c.page, 'LAN origin', 120_000)).toBe('success');
        await waitForBackgroundSync(a.page); await waitForBackgroundSync(c.page);
        let x = await shadowMain(a.server, lanEntry(a)[0]);
        fs.writeFileSync(testInfo.outputPath('inherited-lan-heads.json'), JSON.stringify({ x,
            expected: await snapshot(lanGit(a), x),
            current: await Promise.all([a, c].map(async d => ({ ...(await snapshot(lanGit(d), await shadowMain(d.server, lanEntry(d)[0]))),
                registry: { device: registryOf(d.server).device, lastSync: lanEntry(d)[1].lastSync } }))) }, null, 2));
        expect(await shadowMain(c.server, lanEntry(c)[0])).toBe(x);
        if (kind !== 'device') {
            // Historical/generic heads are compatibility fixtures, written
            // only while the source server is stopped, before LAN transfer.
            await a.server.stop();
            const { commit } = await git.readCommit({ fs, gitdir: lanGit(a), oid: x });
            if (kind === 'historical') x = await git.commit({ fs, gitdir: lanGit(a), tree: commit.tree, parent: [x], message: 'historical sync snapshot',
                author: { name: 'Historical writer', email: 'old@sync.invalid', timestamp: commit.committer.timestamp, timezoneOffset: 0 }, ref: 'refs/heads/main' });
            else {
                x = await writeMergeCommit({ gitdir: lanGit(a), files: await readCommitFiles({ gitdir: lanGit(a), commitOid: x }), parents: [x, commit.parent[0]] });
                await git.writeRef({ fs, gitdir: lanGit(a), ref: 'refs/heads/main', value: x, force: true });
            }
            await a.server.restart(); await reloadS3Page(a.page);
            expect(await clickSyncNow(c.page, 'LAN origin', 120_000)).toBe('success');
            await waitForBackgroundSync(a.page); await waitForBackgroundSync(c.page);
        }
        fs.writeFileSync(testInfo.outputPath('inherited-lan-compatible-heads.json'), JSON.stringify({ x,
            expected: await snapshot(lanGit(a), x),
            current: await Promise.all([a, c].map(async d => ({ ...(await snapshot(lanGit(d), await shadowMain(d.server, lanEntry(d)[0]))),
                registry: { device: registryOf(d.server).device, lastSync: lanEntry(d)[1].lastSync } }))) }, null, 2));
        expect(await shadowMain(c.server, lanEntry(c)[0])).toBe(x);
        const origin = await snapshot(lanGit(a), x), copied = await snapshot(lanGit(c), x);
        expect(copied).toEqual(origin);
        expect(lanProxy.hits.some(hit => hit.url.startsWith('/api/sync/v1/session/object/'))).toBe(true);
        const histories = await Promise.all([a, c].map(d => readHistory(lanGit(d), x)));
        expect(histories[1]).toEqual(histories[0]);
        // Keep only S3 registered during the final restart. Startup genuinely
        // triggers all backends, and an unrelated LAN run must not consume
        // the single-use after-remote-head barrier for the S3 epoch.
        for (const [d, label] of [[a, 'LAN inheritor'], [c, 'LAN origin']]) {
            await closeAllPopups(d.page); await openLanSyncPanel(d.page); await clickForgetPeer(d.page, label);
            expect(registryOf(d.server).backends).toEqual({});
        }
        await closeAllPopups(b.page); await openLanSyncPanel(b.page);
        expect(await clickSyncNow(b.page, 'Cloud', 120_000)).toBe('success');
        const y = (await remoteHead(fixture, options, b)).head.commit;
        expect(y).not.toBe(x);
        for (const [index, d] of [a, c].entries()) {
            // DOM registration starts a real cycle. Pause it before merging,
            // then adopt only the transported history with the server stopped.
            fs.writeFileSync(path.join(roots[index], `${point}.arm`), '');
            await addS3Backend(d.page, { ...options, endpoint: proxies[index].endpoint });
            await expect.poll(() => fs.existsSync(path.join(roots[index], `${point}.reached`)), { timeout: 60_000 }).toBe(true);
            await d.server.stop(); fs.rmSync(path.join(roots[index], `${point}.reached`));
            await transplantStoppedHistory(d, x, histories[index]);
            // Arm before restart: the existing startup trigger is the run
            // under test, not an unobserved merge before a later manual click.
            fs.writeFileSync(path.join(roots[index], `${point}.arm`), '');
            await d.server.restart(); await reloadS3Page(d.page); await closeAllPopups(d.page); await openLanSyncPanel(d.page);
        }
        for (const root of roots) await expect.poll(() => fs.existsSync(path.join(root, `${point}.reached`)), { timeout: 60_000 }).toBe(true);
        const pinnedCopies = await Promise.all([a, c].map(async d => snapshot(pathsOf(d).gitDir, await shadowMain(d.server, entryOf(d)[0]))));
        fs.writeFileSync(testInfo.outputPath('inherited-pinned-inputs.json'), JSON.stringify({ x: origin, y, copies: pinnedCopies }, null, 2));
        for (const d of [a, c]) {
            expect(await shadowMain(d.server, entryOf(d)[0])).toBe(x);
            expect(await snapshot(pathsOf(d).gitDir, y)).toEqual(await snapshot(pathsOf(b).gitDir, y));
        }
        const pinned = await remoteHead(fixture, options, b);
        expect(pinned.head.commit).toBe(y); expect(Object.keys(pinned.head).sort()).toEqual(['commit', 'compactedFrom', 'packs', 'v']);
        const liveBytes = d => Object.fromEntries(Object.keys(origin.files).filter(rel => !rel.startsWith('.luker-sync/'))
            .map(rel => [rel, fs.readFileSync(path.join(userRootOf(d.server), rel)).toString('base64')]));
        const beforeLabels = [a, c].map(liveBytes);
        await setSyncDeviceLabel(a.page, 'Relabeled A'); await setSyncDeviceLabel(c.page, 'Relabeled C');
        for (const d of [a, c]) expect(await shadowMain(d.server, entryOf(d)[0])).toBe(x);
        expect([a, c].map(liveBytes)).toEqual(beforeLabels);
        for (const proxy of proxies) gates.push(proxy.addFault({ match: { method: 'PUT', keySuffix: '/head' }, hold: 'after-upstream-response' }));
        roots.forEach(root => fs.writeFileSync(path.join(root, `${point}.release`), ''));
        const attempts = await Promise.all(gates.map(gate => gate.reached));
        const heads = attempts.map((attempt, index) => publishedHead([a, c][index], attempt.body));
        const merged = await snapshot(pathsOf(a).gitDir, heads[0].commit);
        fs.writeFileSync(testInfo.outputPath('inherited-first-merges.json'), JSON.stringify({ x, y, heads, merged,
            ySnapshot: await snapshot(pathsOf(a).gitDir, y) }, null, 2));
        expect(attempts.map(attempt => attempt.upstreamStatus).sort()).toEqual([200, 412]);
        expect(heads[0].commit).toBe(heads[1].commit);
        expect(await snapshot(pathsOf(c).gitDir, heads[1].commit)).toEqual(merged);
        const parents = [x, y].sort(); expect(merged.parents).toEqual(parents);
        const sides = await Promise.all(parents.map(oid => readCommitFiles({ gitdir: pathsOf(a).gitDir, commitOid: oid })));
        const signatures = await Promise.all(parents.map(oid => git.readCommit({ fs, gitdir: pathsOf(a).gitDir, oid })));
        const date = new Date(Math.max(...signatures.map(value => value.commit.committer.timestamp)) * 1000);
        const labels = Object.fromEntries([[x, kind === 'device' ? 'Original A' : 'Luker Sync'], [y, 'Original B']]);
        const bytes = name => Buffer.from(merged.bytes[name], 'base64').toString();
        expect(bytes(WORLD)).toBe((await readBlobBytes({ gitdir: pathsOf(a).gitDir, oid: sides[0].get(WORLD).oid })).toString());
        expect(JSON.parse(bytes('.luker-sync/conflicts.json'))).toEqual({ entries: { [WORLD]: { kept: sides[0].get(WORLD).oid, ours: sides[0].get(WORLD).oid,
            theirs: sides[1].get(WORLD).oid, oursDevice: labels[parents[0]], theirsDevice: labels[parents[1]], mergeParents: parents, createdAt: date.toISOString() } } });
        const stamp = date.toISOString().slice(0, 16).replace('T', ' ').replace(':', '.');
        const expectedNotices = {};
        for (const rel of chats) {
            expect(bytes(rel)).toBe((await readBlobBytes({ gitdir: pathsOf(a).gitDir, oid: sides[0].get(rel).oid })).toString());
            expect(JSON.parse(bytes(rel.replace('.jsonl', '.luker-state.iter_studio.json')))).toEqual(COMPANIONS.iter_studio);
            const base = rel.slice(rel.lastIndexOf('/') + 1, -6), branch = `${base} - Sync conflict ${labels[parents[1]]} ${stamp}`;
            const fork = `${rel.slice(0, rel.lastIndexOf('/') + 1)}${branch}.jsonl`;
            expectedNotices[fork] = { kind: 'fork', chat: rel, device: labels[parents[1]], createdAt: date.toISOString(), target: rel.startsWith('group chats/')
                ? { kind: 'group', groupId: 'g1', name: branch } : { kind: 'character', avatar: 'Seraphina.png', name: branch } };
            const from = (await readBlobBytes({ gitdir: pathsOf(a).gitDir, oid: sides[1].get(rel).oid })).toString().trim().split('\n').map(JSON.parse);
            const hex = createHash('sha256').update(`${sides[1].get(rel).oid}\0${branch}`).digest('hex');
            from[0].chat_metadata = { ...from[0].chat_metadata, main_chat: base, integrity: `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20, 32)}` };
            expect(bytes(fork).trim().split('\n').map(JSON.parse)).toEqual(from);
            expect(JSON.parse(bytes(fork.replace('.jsonl', '.luker-state.iter_studio.json')))).toEqual(COMPANIONS.iter_studio);
        }
        expect(JSON.parse(bytes('.luker-sync/notices.json'))).toEqual({ entries: expectedNotices });
        expect(JSON.parse(bytes('groups/g1.json')).chats).toEqual(['gc1', Object.values(expectedNotices).find(notice => notice.target.kind === 'group').target.name]);
        expect(JSON.stringify(expectedNotices)).not.toMatch(/Relabeled|Inheritor/);
        fs.writeFileSync(testInfo.outputPath(`inherited-${kind}-epoch.json`), JSON.stringify({ x, y, pinned: pinned.head, attempts: heads, merged, expectedNotices }, null, 2));
        gates.forEach(gate => gate.release());
        for (const d of [a, c]) {
            await waitForBackendSync(d.page, { label: 'Cloud' });
            expect(await shadowMain(d.server, entryOf(d)[0])).toBe(merged.oid);
            await reloadS3Page(d.page); await waitForSyncPopup(d.page);
            expect(await listPopupConflicts(d.page)).toEqual([{ path: WORLD, stale: false }]);
            expect((await listPopupNotices(d.page)).map(notice => notice.path).sort()).toEqual(Object.keys(expectedNotices).sort());
        }
    } finally {
        gates.forEach(gate => gate.release());
        roots.forEach(root => fs.writeFileSync(path.join(root, `${point}.release`), ''));
        await lanProxy.close();
    }
}
