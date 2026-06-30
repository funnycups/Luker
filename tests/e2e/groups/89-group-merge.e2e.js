// #89 — Merge two group chats via the real Past Chats Merge dialog.
//
// Real-user gesture:
//   1. Seed two character PNGs (Ash + Rhonin) and create a 2-member LIST
//      group via the REST API (drag-and-drop builder is overkill for this).
//   2. Open the seeded first chat (chat A) via openGroupForChat.
//   3. Drive 2 user turns into chat A. With LIST activation each turn
//      fires both members → 4 assistant replies + 2 user msgs +
//      2 greetings = 8 entries on disk.
//   4. option_start_new_chat → confirm the popup → ST creates chat B
//      under the same group; drive 2 more user turns.
//   5. Open the merge dialog via the past-chats #merge_chats_button. T10
//      wires the click handler to detect ctx.groupId and route to
//      openMergeDialog({isGroup: true, groupId}) — confirmed in
//      public/scripts/chat-merge-split.js:629-644.
//   6. Pick A then B, type the merged name, submit.
//
// Asserts: CHAT_MERGED payload carries (target, isGroup=true, groupId),
// the merged jsonl appears on disk in "<dataRoot>/default-user/group chats"
// alongside both source files, and the merged body is A's whole slice then
// B's whole slice byte-for-byte. The matching db-mode test
// (tests/e2e/chat/23-merge-db-mode.e2e.js) exercises the character path
// against the SQLite backend.

import { test, expect } from '@playwright/test';
import { resolve } from 'node:path';
import { readdirSync, readFileSync } from 'node:fs';
import { startServer, tearDownServer } from '../_lib/server.js';
import { startMockLLM } from '../_lib/mockLLM.js';
import { markOnboarded, bootstrapCustomBackend, appendConnectionProfile } from '../_lib/fixtures.js';
import { awaitMainUI, createNewChatViaUI } from '../_lib/page.js';
import {
    openMergeDialogViaUI,
    addSourceToMerge,
    submitMergeDialog,
    takeStepScreenshot,
} from '../_lib/ui-chat-merge-split.js';
import {
    writeCharacterPng,
    createGroupViaApi,
    openGroupForChat,
    sendUserAndAwaitGroupTurn,
    readGroupChatOnDisk,
} from './_helpers.js';

let server, mock, members;

// 2 turns × 2 chats × 2 members = 8 assistant replies. Each anchored to
// a recognizable RP phrase so we can assert order across the merge.
const REPLIES = [
    // Chat A — turn 1.
    '*Ash steadies the chart against the breeze.* "Reply A1-Ash: the swell is reading two and a half."',
    '*Rhonin sets the lantern bracket back into its groove.* "Reply A1-Rhonin: inner cove is quiet."',
    // Chat A — turn 2.
    '*Ash chalks a tally beside the south flare count.* "Reply A2-Ash: that holds for the second bell."',
    '*Rhonin closes the night ledger over a damp page.* "Reply A2-Rhonin: I will sign for the watch."',
    // Chat B — turn 1.
    '*Ash unrolls the outer chart and weighs its corners.* "Reply B1-Ash: pilot signals are steady."',
    '*Rhonin pours a careful measure of oil into the lantern.* "Reply B1-Rhonin: oil holds for six more hours."',
    // Chat B — turn 2.
    '*Ash sets the brass spyglass back beside the rail.* "Reply B2-Ash: three skiffs north of the gulls."',
    '*Rhonin folds the ledger and tucks it under the coat.* "Reply B2-Rhonin: hold the watch through the fifth bell."',
];

test.beforeAll(async () => {
    mock = await startMockLLM({ scriptedReplies: REPLIES });
    server = await startServer({ batchKey: 'groups', scenarioId: 'group-merge' });
    markOnboarded({ dataRoot: server.dataRoot });
    bootstrapCustomBackend({ dataRoot: server.dataRoot, baseURL: mock.baseURL });
    appendConnectionProfile({ dataRoot: server.dataRoot, baseURL: mock.baseURL });
    // Two distinct characters embedded in real V2 PNGs so they actually
    // show up in ctx.characters under the names we expect (the shared
    // writeCharacter() sidecar JSON does not survive the server's PNG
    // chunk read).
    members = [
        {
            avatar: 'ash-merge.png',
            name: 'Ash Cartographer',
            description: 'Wind-bitten cartographer who has spent twelve seasons mapping the Bryn reefs.',
            personality: 'Observant, dry-witted, slow to anger.',
            scenario: 'Two watchers share the Bryn headland lantern through the long autumn nights.',
            first_mes: '*Ash unrolls the chart with a knuckle and weighs the corner with a brass spyglass.* "The reef is still settling. Sit — there will be plenty to read before dawn."',
            system_prompt: 'You are Ash Cartographer. Stay in scene. One to three paragraphs. Sign nothing.',
        },
        {
            avatar: 'rhonin-merge.png',
            name: 'Rhonin Warden',
            description: 'Coastal warden of the inner cove. Late forties, greying beard.',
            personality: 'Quiet, exacting. Never raises his voice.',
            scenario: 'Two watchers share the Bryn headland lantern through the long autumn nights.',
            first_mes: '*Rhonin stamps the salt from his boots at the threshold and nods without breaking stride.* "Inner cove was unsettled at the third bell. I would value the chart\'s opinion before I write the night log."',
            system_prompt: 'You are Rhonin Warden. Stay in scene. One to three paragraphs. Sign nothing.',
        },
    ];
    for (const m of members) {
        writeCharacterPng({
            dataRoot: server.dataRoot,
            avatarFile: m.avatar,
            card: m,
        });
    }
});

test.afterAll(async () => {
    await tearDownServer(server);
    await mock?.stop();
});

test.describe('#89 — group chats merge in chosen order', () => {
    test('two group chats concatenate A then B with all messages preserved', async ({ page }) => {
        await awaitMainUI(page, server.baseURL);

        // Create the 2-member LIST-rotation group. createGroupViaApi
        // seeds an initial chat under the group whose name it returns.
        const group = await createGroupViaApi(page, {
            name: 'Bryn Headland Watch (merge)',
            members: members.map(m => m.avatar),
            activation_strategy: 1, // LIST → deterministic per-member rotation
            generation_mode: 0,     // SWAP per-member request
        });
        expect(group.id, 'group should be created').toBeTruthy();
        const groupId = group.id;
        const chatAId = group.chat_id;
        await openGroupForChat(page, groupId);

        // Wait for the seeded greetings to render (one per member).
        await page.waitForFunction(
            (n) => document.querySelectorAll('#chat .mes').length >= n,
            members.length,
            { timeout: 15_000 },
        );

        // Chat A: 2 user turns. LIST fires both members per turn →
        // 4 assistant replies + 2 user msgs + 2 greetings = 8 entries.
        await sendUserAndAwaitGroupTurn(page, 'Turn A1: hold the lantern through the first watch.');
        await sendUserAndAwaitGroupTurn(page, 'Turn A2: what shall we mark for the second bell?');

        const aLen = await page.evaluate(() => window.Luker.getContext().chat?.length || 0);
        expect(aLen, `chat A should hold greetings+user+replies; got ${aLen}`).toBe(8);

        // Chat B via option_start_new_chat. Works for both characters
        // and groups; the option handler in public/script.js routes to
        // doNewChat → createNewGroupChat when selected_group is set.
        await createNewChatViaUI(page);
        const chatBId = await page.evaluate(() => window.Luker.getContext().getCurrentChatId());
        expect(chatBId, 'chat B should have a fresh chat id').toBeTruthy();
        expect(chatBId).not.toBe(chatAId);
        await page.waitForFunction(
            (n) => document.querySelectorAll('#chat .mes').length >= n,
            members.length,
            { timeout: 15_000 },
        );

        await sendUserAndAwaitGroupTurn(page, 'Turn B1: read the south flares while I trim the wick.');
        await sendUserAndAwaitGroupTurn(page, 'Turn B2: log the skiffs north of the gull rocks.');

        const bLen = await page.evaluate(() => window.Luker.getContext().chat?.length || 0);
        expect(bLen, `chat B should hold greetings+user+replies; got ${bLen}`).toBe(8);
        await takeStepScreenshot(page, '20-group-two-chats-ready');

        // Capture the disk bodies of A and B BEFORE merging so we can
        // compare against the merged body slice-by-slice — this catches
        // any silent re-ordering or field stripping the merge might
        // introduce on the group path.
        const aDisk = readGroupChatOnDisk(server.dataRoot, chatAId);
        const bDisk = readGroupChatOnDisk(server.dataRoot, chatBId);
        expect(aDisk.messages.length, `disk A should have ${aLen} messages`).toBe(aLen);
        expect(bDisk.messages.length, `disk B should have ${bLen} messages`).toBe(bLen);

        // Listen for CHAT_MERGED instead of CHAT_CHANGED — the merge
        // module always emits CHAT_MERGED right after the server write
        // succeeds (chat-merge-split.js:375), so this signal is decoupled
        // from the post-merge navigation step. CHAT_MERGED is the
        // canonical "merge happened" signal for downstream listeners
        // regardless of whether the dialog also opens the new chat.
        await page.evaluate(() => {
            const ctx = window.Luker.getContext();
            window.__mergedSignal = { resolved: false, payload: null };
            const handler = (data) => {
                try { ctx.eventSource.removeListener(ctx.eventTypes.CHAT_MERGED, handler); } catch {}
                window.__mergedSignal.resolved = true;
                window.__mergedSignal.payload = data || null;
            };
            ctx.eventSource.on(ctx.eventTypes.CHAT_MERGED, handler);
        });

        // Open the merge dialog via the real entry: option_select_chat
        // → #merge_chats_button. T10's wireEntryPoints dispatches to
        // openMergeDialog({isGroup: true, groupId}) when ctx.groupId is set.
        const dialog = await openMergeDialogViaUI(page);
        await addSourceToMerge(page, dialog, chatAId);
        await addSourceToMerge(page, dialog, chatBId);
        await takeStepScreenshot(page, '21-group-merge-dialog-two-sources');

        const mergedName = 'group-merged';
        // awaitNavigation: false — we drive the wait via the CHAT_MERGED
        // listener installed above (decoupled from the post-merge
        // openGroupChat navigation step, so a slow nav cannot make this
        // test flake).
        await submitMergeDialog(page, dialog, mergedName, { awaitNavigation: false });
        await page.waitForFunction(() => window.__mergedSignal?.resolved === true, null, { timeout: 30_000 });
        const mergedPayload = await page.evaluate(() => window.__mergedSignal?.payload || null);
        expect(mergedPayload?.target, 'CHAT_MERGED payload should carry the new chat id').toBe(mergedName);
        expect(mergedPayload?.isGroup, 'CHAT_MERGED payload should mark this as a group merge').toBe(true);
        expect(mergedPayload?.groupId, 'CHAT_MERGED payload should echo the source group id').toBe(groupId);
        await takeStepScreenshot(page, '22-group-merged-event-fired');

        // Disk-side: merged jsonl lives under "<dataRoot>/default-user/group chats"
        // (note literal SPACE) and contains every message from A then B
        // byte-for-byte, in order.
        const groupChatsDir = resolve(server.dataRoot, 'default-user', 'group chats');
        const files = readdirSync(groupChatsDir).filter(f => f.endsWith('.jsonl'));
        expect(files, `expected source A still present; got ${JSON.stringify(files)}`)
            .toContain(`${chatAId}.jsonl`);
        expect(files, `expected source B still present; got ${JSON.stringify(files)}`)
            .toContain(`${chatBId}.jsonl`);
        expect(files, `expected merged file written; got ${JSON.stringify(files)}`)
            .toContain(`${mergedName}.jsonl`);

        const mergedRaw = readFileSync(resolve(groupChatsDir, `${mergedName}.jsonl`), 'utf-8');
        const mergedLines = mergedRaw.trim().split('\n');
        expect(
            mergedLines.length,
            `expected 1 header + ${aLen + bLen} messages; got ${mergedLines.length}`,
        ).toBe(1 + aLen + bLen);
        const mergedBody = mergedLines.slice(1).map(l => JSON.parse(l));

        // A's whole slice lives at [0..aLen); B's whole slice at [aLen..end).
        for (let i = 0; i < aLen; i++) {
            expect(mergedBody[i].mes, `merged[${i}].mes should equal disk A[${i}].mes`)
                .toBe(aDisk.messages[i].mes);
            expect(mergedBody[i].is_user, `merged[${i}].is_user should equal disk A[${i}].is_user`)
                .toBe(!!aDisk.messages[i].is_user);
        }
        for (let i = 0; i < bLen; i++) {
            expect(mergedBody[aLen + i].mes, `merged[${aLen + i}].mes should equal disk B[${i}].mes`)
                .toBe(bDisk.messages[i].mes);
            expect(mergedBody[aLen + i].is_user, `merged[${aLen + i}].is_user should equal disk B[${i}].is_user`)
                .toBe(!!bDisk.messages[i].is_user);
        }

        // Spot-check that all four user prompts and all eight scripted
        // replies survived the merge — independent of position math.
        const mergedMesBodies = new Set(mergedBody.map(m => m.mes));
        for (const prompt of [
            'Turn A1: hold the lantern through the first watch.',
            'Turn A2: what shall we mark for the second bell?',
            'Turn B1: read the south flares while I trim the wick.',
            'Turn B2: log the skiffs north of the gull rocks.',
        ]) {
            expect(mergedMesBodies.has(prompt), `merged body should carry user prompt "${prompt}"`).toBe(true);
        }
        for (const reply of REPLIES) {
            expect(
                mergedMesBodies.has(reply),
                `merged body should carry scripted reply ${reply.slice(0, 40)}…`,
            ).toBe(true);
        }
    });
});
