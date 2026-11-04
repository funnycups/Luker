// Chat conflicts: a chat edited on both devices keeps one version and
// saves the other as a branch chat, for a character and for a group; a
// chat deleted on one device and edited on the other is restored; the
// Sync issues page of the Account window lists each with a button that
// opens the chat.
//
// Two real servers seeded with the same character, chats and group on
// disk. Edits and deletions go through the chat UI. Device labels are set
// through Account → Device settings before pairing. No current version writes a restored notice
// without the deleting device; the last test commits one into A's sync
// history the way an older version would have, and B receives it by sync.

import { test, expect } from '@playwright/test';
import fs from 'node:fs';
import path from 'node:path';
import git from 'isomorphic-git';

import { startServer, tearDownServer } from '../_lib/server.js';
import { awaitMainUI, reloadAndAwait, selectCharacterByName, editMessageViaUI } from '../_lib/page.js';
import { writeCharacterPng } from '../groups/_helpers.js';
import {
    openLanSyncPanel, generatePairingLink, acceptPairingLink, clickSyncNow, setSyncSchedule, closeAllPopups, waitForSyncPopup,
    waitForBackgroundSync, waitForStatusChecks, syncPopup, listPopupNotices, listPopupConflicts, openBranchFromNotice, dismissNotice,
    openChatByName, readUserFile, userRootOf, backendIdOf, shadowMain, setSyncDeviceLabel,
} from '../_lib/sync.js';

const LABELS = { A: 'Glade desk', B: 'Fen tablet' };
const INTEGRITY = '7d6b3c9e-1f2a-4b5c-8d9e-0a1b2c3d4e5f';
const header = { user_name: 'User', character_name: 'Seraphina', create_date: '2026-10-01@10h00m00s', chat_metadata: { integrity: INTEGRITY } };
const messages = [
    { name: 'Seraphina', is_user: false, mes: 'Welcome back to the glade, traveler.', send_date: '2026-10-01@10h00m01s' },
    { name: 'User', is_user: true, mes: 'Which path leads to the spring?', send_date: '2026-10-01@10h00m02s' },
    { name: 'Seraphina', is_user: false, mes: 'Follow the birches; the path bends near the stones.', send_date: '2026-10-01@10h00m03s' },
];
const jsonl = (head, lines) => [head, ...lines].map(line => JSON.stringify(line)).join('\n');
const CHATS = ['Forest Path', 'River Ford'];

function seed(server) {
    const root = userRootOf(server);
    writeCharacterPng({ dataRoot: server.dataRoot, avatarFile: 'Seraphina.png', card: { name: 'Seraphina', first_mes: messages[0].mes } });
    fs.mkdirSync(path.join(root, 'chats', 'Seraphina'), { recursive: true });
    for (const chat of CHATS) {
        fs.writeFileSync(path.join(root, 'chats', 'Seraphina', `${chat}.jsonl`), jsonl(header, messages));
        fs.writeFileSync(path.join(root, 'chats', 'Seraphina', `${chat}.luker-state.memory_graph.json`), JSON.stringify({ nodes: [{ id: 'spring' }] }));
    }
    fs.mkdirSync(path.join(root, 'groups'), { recursive: true });
    fs.mkdirSync(path.join(root, 'group chats'), { recursive: true });
    fs.writeFileSync(path.join(root, 'groups', 'g1.json'), JSON.stringify({ id: 'g1', name: 'Glade Watch', members: ['Seraphina.png'], avatar_url: '', allow_self_responses: false,
        activation_strategy: 1, generation_mode: 0, disabled_members: [], chat_metadata: {}, fav: false, chat_id: 'gc1', chats: ['gc1'], auto_mode_delay: 5 }, null, 4));
    fs.writeFileSync(path.join(root, 'group chats', 'gc1.jsonl'), jsonl({ user_name: 'unused', character_name: 'unused', chat_metadata: { integrity: INTEGRITY } }, messages));
}

let A;
let B;
let contexts = [];

test.beforeEach(async ({}, testInfo) => {
    A = await startServer({ batchKey: 'sync', scenarioId: `fork-${testInfo.testId}-A` });
    B = await startServer({ batchKey: 'sync', scenarioId: `fork-${testInfo.testId}-B` });
    for (const server of [A, B]) {
        seed(server);
    }
});

test.afterEach(async () => {
    for (const ctx of contexts) await ctx.close();
    contexts = [];
    await tearDownServer(A);
    await tearDownServer(B);
});

async function pairedPages(browser) {
    const ctxA = await browser.newContext();
    const ctxB = await browser.newContext();
    contexts = [ctxA, ctxB];
    const pageA = await ctxA.newPage();
    const pageB = await ctxB.newPage();
    await awaitMainUI(pageA, A.baseURL);
    await awaitMainUI(pageB, B.baseURL);
    const pairedSince = Date.now();
    await openLanSyncPanel(pageA);
    await setSyncDeviceLabel(pageA, LABELS.A);
    const link = await generatePairingLink(pageA, { label: 'B device', categories: ['characters', 'chats'] });
    await openLanSyncPanel(pageB);
    await setSyncDeviceLabel(pageB, LABELS.B);
    expect(await acceptPairingLink(pageB, link, { categories: ['characters', 'chats'], localLabel: 'A device' })).toBe('success');
    await setSyncSchedule(pageB, { idleSeconds: 3600, pollSeconds: 3600 });
    await closeAllPopups(pageA);
    await openLanSyncPanel(pageA);
    await setSyncSchedule(pageA, { idleSeconds: 3600, pollSeconds: 3600 });
    await closeAllPopups(pageA);
    await closeAllPopups(pageB);
    // A syncs in the background on B's notify; edit only after both
    // devices finished their runs.
    await waitForBackgroundSync(pageA, { since: pairedSince });
    await waitForBackgroundSync(pageB, { since: pairedSince });
    // Closes the User Settings drawer the Account window was opened from.
    await reloadAndAwait(pageA, A.baseURL);
    await reloadAndAwait(pageB, B.baseURL);
    return { pageA, pageB };
}

async function openGroup(page) {
    if (await page.locator('#rightNavDrawerIcon.closedIcon').count() > 0) await page.locator('#rightNavDrawerIcon').click();
    await page.locator('#rm_print_characters_block .group_select', { hasText: 'Glade Watch' }).click();
    await page.waitForFunction(() => window.Luker.getContext().getCurrentChatId() === 'gc1', null, { timeout: 30_000 });
}

/** Delete a chat of the selected character through Manage chat files. */
async function deleteChatByName(page, server, name) {
    await page.locator('#options_button').click();
    await page.locator('#option_select_chat').click();
    const row = page.locator('.select_chat_block_wrapper', { has: page.locator('.select_chat_block_filename', { hasText: new RegExp(`^\\s*${RegExp.escape(name)}(\\.jsonl)?\\s*$`) }) }).first();
    await row.locator('.PastChat_cross').click();
    const confirm = page.locator('dialog.popup[open]', { hasText: 'Delete the Chat File?' });
    await confirm.locator('.popup-button-ok').click();
    await expect.poll(() => readUserFile(server, `chats/Seraphina/${name}.jsonl`), { timeout: 30_000 }).toBeNull();
}

const readHeader = (server, rel) => JSON.parse(readUserFile(server, rel).split('\n')[0]);
const fileText = (server, rel) => readUserFile(server, rel) ?? '';
const cardBytes = server => fs.readFileSync(path.join(userRootOf(server), 'characters', 'Seraphina.png'));
const otherSide = side => (side === 'A' ? 'B' : 'A');

/**
 * The branch name of a fork notice and the device whose label it carries,
 * which is the device whose version went into the branch.
 */
function forkOf(notice, dir, chat) {
    const branch = notice.path.slice(`${dir}/`.length, -'.jsonl'.length);
    const branched = Object.keys(LABELS).find(side => branch.startsWith(`${chat} - Sync conflict ${LABELS[side]} `));
    return { branch, branched, kept: otherSide(branched) };
}

/** Commit `notices` as the notices file onto the shadow main of `server`. */
async function commitNoticesOnMain(server, notices) {
    const id = backendIdOf(server);
    const gitdir = path.join(userRootOf(server), '.sync', id, 'repo.git');
    const parent = await shadowMain(server, id);
    const { commit } = await git.readCommit({ fs, gitdir, oid: parent });
    const root = (await git.readTree({ fs, gitdir, oid: commit.tree })).tree;
    const metaEntry = root.find(entry => entry.path === '.luker-sync');
    const meta = metaEntry ? (await git.readTree({ fs, gitdir, oid: metaEntry.oid })).tree.filter(entry => entry.path !== 'notices.json') : [];
    const blob = await git.writeBlob({ fs, gitdir, blob: Buffer.from(`${JSON.stringify(notices, null, 2)}\n`) });
    const metaTree = await git.writeTree({ fs, gitdir, tree: [...meta, { mode: '100644', path: 'notices.json', oid: blob, type: 'blob' }] });
    const tree = await git.writeTree({ fs, gitdir, tree: [...root.filter(entry => entry.path !== '.luker-sync'), { mode: '040000', path: '.luker-sync', oid: metaTree, type: 'tree' }] });
    const author = { name: 'Luker Sync', email: 'sync@luker.local' };
    await git.commit({ fs, gitdir, message: 'sync notice from an older version', author, tree, parent: [parent], ref: 'refs/heads/main' });
}

test.describe('LAN Sync — chat conflicts', () => {
    test.describe.configure({ timeout: 240_000 });

    test('a character chat conflict saves the other version as a branch chat on both devices', async ({ browser }) => {
        const { pageA, pageB } = await pairedPages(browser);
        const texts = { A: 'A: the path bends north at the birches.', B: 'B: the path bends south past the stones.' };
        for (const [page, server, side] of [[pageA, A, 'A'], [pageB, B, 'B']]) {
            await selectCharacterByName(page, 'Seraphina');
            await openChatByName(page, 'Forest Path');
            await editMessageViaUI(page, 2, texts[side]);
            await expect.poll(() => fileText(server, 'chats/Seraphina/Forest Path.jsonl'), { timeout: 30_000 }).toContain(texts[side]);
        }
        await openLanSyncPanel(pageB);
        expect(await clickSyncNow(pageB, 'A device')).toBe('success');
        await waitForSyncPopup(pageB);
        expect(await listPopupConflicts(pageB)).toEqual([]);
        const notices = await listPopupNotices(pageB);
        expect(notices).toHaveLength(1);
        const [notice] = notices;
        const { branch, branched, kept } = forkOf(notice, 'chats/Seraphina', 'Forest Path');
        expect(['A', 'B']).toContain(branched);
        expect(notice.text).toBe(`chats/Seraphina/Forest Path.jsonl was edited on two devices. The version from ${LABELS[branched]} was saved as the branch chat ${branch}.`);
        const mainText = readUserFile(B, 'chats/Seraphina/Forest Path.jsonl');
        const branchText = readUserFile(B, notice.path);
        expect(mainText).toContain(texts[kept]);
        expect(mainText).not.toContain(texts[branched]);
        expect(branchText).toContain(texts[branched]);
        expect(branchText).not.toContain(texts[kept]);
        const branchHeader = readHeader(B, notice.path);
        expect(branchHeader.chat_metadata.main_chat).toBe('Forest Path');
        expect(branchHeader.chat_metadata.integrity).not.toBe(INTEGRITY);
        expect(branchHeader.chat_metadata.integrity).not.toBe(readHeader(B, 'chats/Seraphina/Forest Path.jsonl').chat_metadata.integrity);
        expect(readUserFile(B, `chats/Seraphina/${branch}.luker-state.memory_graph.json`)).toBe(JSON.stringify({ nodes: [{ id: 'spring' }] }));
        await expect.poll(() => readUserFile(A, notice.path), { timeout: 60_000 }).toBe(branchText);
        await expect.poll(() => readUserFile(A, 'chats/Seraphina/Forest Path.jsonl'), { timeout: 60_000 }).toBe(mainText);
        await openBranchFromNotice(pageB, notice.path, branch);
        await expect(pageB.locator('.mes[mesid="2"] .mes_text')).toContainText(texts[branched]);
        await reloadAndAwait(pageB, B.baseURL);
        await waitForSyncPopup(pageB);
        await dismissNotice(pageB, notice.path);
        // A's Sync issues page shows the notice until B's dismissal reaches it.
        for (const [page, server] of [[pageA, A], [pageB, B]]) {
            await expect.poll(async () => {
                await reloadAndAwait(page, server.baseURL);
                await waitForStatusChecks(page, 1);
                return syncPopup(page).count();
            }, { timeout: 60_000 }).toBe(0);
        }
    });

    test('a group chat conflict adds the branch to the group on both devices', async ({ browser }) => {
        const { pageA, pageB } = await pairedPages(browser);
        const texts = { A: 'A: the watch gathers at the north stones.', B: 'B: the watch waits by the spring.' };
        for (const [page, server, side] of [[pageA, A, 'A'], [pageB, B, 'B']]) {
            await openGroup(page);
            await editMessageViaUI(page, 2, texts[side]);
            await expect.poll(() => fileText(server, 'group chats/gc1.jsonl'), { timeout: 30_000 }).toContain(texts[side]);
        }
        await openLanSyncPanel(pageB);
        // Both saves also rewrote the group file; its bookkeeping merges.
        expect(await clickSyncNow(pageB, 'A device')).toBe('success');
        await waitForSyncPopup(pageB);
        expect(await listPopupConflicts(pageB)).toEqual([]);
        const notices = await listPopupNotices(pageB);
        expect(notices).toHaveLength(1);
        const [notice] = notices;
        const { branch, branched, kept } = forkOf(notice, 'group chats', 'gc1');
        expect(['A', 'B']).toContain(branched);
        expect(notice.text).toBe(`group chats/gc1.jsonl was edited on two devices. The version from ${LABELS[branched]} was saved as the branch chat ${branch}.`);
        expect(readUserFile(B, notice.path)).toContain(texts[branched]);
        expect(readUserFile(B, 'group chats/gc1.jsonl')).toContain(texts[kept]);
        expect(JSON.parse(readUserFile(B, 'groups/g1.json')).chats).toEqual(['gc1', branch]);
        await expect.poll(() => readUserFile(A, 'groups/g1.json'), { timeout: 60_000 }).toBe(readUserFile(B, 'groups/g1.json'));
        await reloadAndAwait(pageB, B.baseURL);
        await waitForSyncPopup(pageB);
        await openBranchFromNotice(pageB, notice.path, branch);
        await expect(pageB.locator('.mes[mesid="2"] .mes_text')).toContainText(texts[branched]);
    });

    test('a chat deleted on one device and edited on the other is restored with a notice naming both devices', async ({ browser }) => {
        const { pageA, pageB } = await pairedPages(browser);
        // Each device edits the chat the other deletes, so whichever device
        // is ours in the merge, one restored chat came from each side.
        const plan = { A: { edit: 'River Ford', remove: 'Forest Path' }, B: { edit: 'Forest Path', remove: 'River Ford' } };
        const texts = { A: 'A: the ford runs shallow at dawn.', B: 'B: the path bends south past the stones.' };
        for (const [page, server, side] of [[pageA, A, 'A'], [pageB, B, 'B']]) {
            await selectCharacterByName(page, 'Seraphina');
            await openChatByName(page, plan[side].edit);
            await editMessageViaUI(page, 2, texts[side]);
            await expect.poll(() => fileText(server, `chats/Seraphina/${plan[side].edit}.jsonl`), { timeout: 30_000 }).toContain(texts[side]);
            await deleteChatByName(page, server, plan[side].remove);
            await reloadAndAwait(page, server.baseURL);
        }
        await openLanSyncPanel(pageB);
        // The character card's last chat differs on the two devices; it merges too.
        expect(await clickSyncNow(pageB, 'A device')).toBe('success');
        await waitForSyncPopup(pageB);
        expect(await listPopupConflicts(pageB)).toEqual([]);
        expect(await listPopupNotices(pageB)).toEqual([
            { path: 'chats/Seraphina/Forest Path.jsonl', text: `Forest Path was deleted on ${LABELS.A} but kept on ${LABELS.B}, so it was restored.` },
            { path: 'chats/Seraphina/River Ford.jsonl', text: `River Ford was deleted on ${LABELS.B} but kept on ${LABELS.A}, so it was restored.` },
        ]);
        await expect(syncPopup(pageB).locator('[data-act="notice-open"]')).toHaveText(['Open chat', 'Open chat']);
        for (const server of [A, B]) {
            for (const side of ['A', 'B']) {
                await expect.poll(() => fileText(server, `chats/Seraphina/${plan[side].edit}.jsonl`), { timeout: 60_000 }).toContain(texts[side]);
            }
        }
        await expect.poll(() => Buffer.compare(cardBytes(A), cardBytes(B)), { timeout: 60_000 }).toBe(0);
        for (const side of ['A', 'B']) {
            await openBranchFromNotice(pageB, `chats/Seraphina/${plan[side].edit}.jsonl`, plan[side].edit);
            await expect(pageB.locator('.mes[mesid="2"] .mes_text')).toContainText(texts[side]);
            await reloadAndAwait(pageB, B.baseURL);
            await waitForSyncPopup(pageB);
        }
    });

    test('a restored notice from an older version without the deleting device names only the keeping device', async ({ browser }) => {
        const { pageB } = await pairedPages(browser);
        // An older version wrote restored notices without `deletedBy`.
        // Commit one onto A's sync history; A is idle, so nothing races it.
        const rel = 'chats/Seraphina/Forest Path.jsonl';
        const notices = { entries: { [rel]: { kind: 'restored', device: LABELS.A, createdAt: new Date().toISOString(), target: { kind: 'character', avatar: 'Seraphina.png', name: 'Forest Path' } } } };
        await commitNoticesOnMain(A, notices);

        await openLanSyncPanel(pageB);
        expect(await clickSyncNow(pageB, 'A device')).toBe('success');
        await waitForSyncPopup(pageB);
        const [notice, ...rest] = await listPopupNotices(pageB);
        expect(rest).toEqual([]);
        expect(notice).toEqual({ path: rel, text: `Forest Path was deleted on one device but kept on ${LABELS.A}, so it was restored.` });
        await expect(syncPopup(pageB).locator('[data-act="notice-open"]')).toHaveText('Open chat');
        await openBranchFromNotice(pageB, rel, 'Forest Path');
    });
});
