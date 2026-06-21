// #88 — Group chat persistence: 5 turns + restart, branch, export/import
//
// Three concerns, one spec:
//   1. Persistence — drive 5 user turns through a 3-member LIST-rotation
//      group (each turn produces 3 assistant messages, one per member);
//      stop the server, restart, re-open the same group + chat, and
//      assert every persisted message survives byte-for-byte.
//   2. Branch — click the .mes_create_branch button on the middle
//      assistant message; verify a brand-new group chat is created with
//      the same members and the first N persisted messages copied;
//      verify the original group chat is left intact.
//   3. Export/Import — click the .exportRawChatButton[data-format="jsonl"]
//      on the source chat's past-chats row, capture the download; click
//      the #chat_import_button (which triggers the hidden file chooser),
//      feed the JSONL back, and verify byte-for-byte equivalence of every
//      message after the chat_metadata header.
//
// All three sections assert on the on-disk `group chats/<chatId>.jsonl`
// files as the source of truth (per repo convention e2e_real_user_flow:
// in-memory snapshots aren't enough for persistence claims).
//
// Lessons baked in: selectCharacterByName desyncs in group context, so
// re-open the group via openGroupById (mirrors what the existing batch
// _helpers.js does); /cut last needs a tick — we never use it here so
// no shrink-poll concern.

import { test, expect } from '@playwright/test';
import { readFileSync, existsSync, readdirSync } from 'node:fs';
import { resolve } from 'node:path';
import { startServer, tearDownServer } from '../_lib/server.js';
import { startMockLLM } from '../_lib/mockLLM.js';
import { bootstrapCustomBackend, appendConnectionProfile, markOnboarded } from '../_lib/fixtures.js';
import { awaitMainUI, reloadAndAwait, branchFromMessageViaUI } from '../_lib/page.js';
import {
    seedThreeCartographers,
    createGroupViaApi,
    openGroupForChat,
    sendUserAndAwaitGroupTurn,
    readGroupChatOnDisk,
    listGroupsOnDisk,
    switchGroupChatViaUI,
    exportGroupChatViaUI,
    importGroupChatViaUI,
    closePastChatsPopup,
    ensureMessageInView,
} from './_helpers.js';

let server, mock, trio, groupId, chatId;

// 5 turns * 3 members = 15 scripted replies, each anchored to a
// recognizable RP phrase so we can assert byte-for-byte equivalence
// across restart / branch / export-import roundtrips.
const REPLIES = [
    // Turn 1 — initial bell sweep.
    '*Ash sets the chart flat and traces an arc from the gull rocks inward.* "First bell came in clean. The breakers are reading as they should for the first half of the swallow."',
    '*Rhonin stamps the rime off the door-sill and crosses to the rail.* "Inner cove is quiet — the gate watchmen sent no runner; I would call it nominal."',
    '*Kestrel uncoils a fresh stub of charcoal and squints south.* "Two flares from the south pier, both steady. No third — pilot is keeping his line."',
    // Turn 2 — second bell, shape forming.
    '*Ash adjusts the lantern wick a quarter turn.* "The second bell shifted earlier than last week — I will note the offset on the chart."',
    '*Rhonin grunts and writes a single mark in his night ledger.* "Mark the wind too; it is dropping to a half-cant on the seaward side."',
    '*Kestrel sketches a quick line under her flare count.* "Pilot just put up a fourth flare — that is not the steady-two pattern. He is asking for confirmation."',
    // Turn 3 — third bell, the slow swallow.
    '*Ash flattens the outer chart beside the inner.* "Third bell. The amplitude is past five but the period is holding — slow swallow, not surge."',
    '*Rhonin opens the spare oil flask and tops the lantern without looking.* "Then we hold the watch. I would not pull anyone from the cove for a five."',
    '*Kestrel rises onto the balls of her feet, charcoal still in her teeth.* "Fourth flare returned the steady-two. He is satisfied — for now."',
    // Turn 4 — fourth bell, drifters returning.
    '*Ash sets a second knuckle on the chart, holding a faint pencil arc in place.* "Fourth bell — three shadows past the gull rocks, north-running."',
    '*Rhonin lowers his voice without lowering his head.* "Drifters, then. Skiffs. They came earlier than last cycle by a half-hour."',
    '*Kestrel uncrosses her arms and picks up the brass spyglass.* "I count three small hulls — no escort. They are running blind under the slow swallow."',
    // Turn 5 — final bell, decision logged.
    '*Ash closes the chart, folding it twice along the well-worn crease.* "We log the count and the bell offsets. The cove gate has them; let the morning shift walk the inner ring."',
    '*Rhonin signs the night ledger with a small triangle, his standard mark for nominal-with-drifters.* "Walked. Lantern stays trimmed; oil is good for another six hours."',
    '*Kestrel folds her charcoal sketch into her coat and lets out a slow breath.* "Then the watch is held. I would like a cup of something hot before the fifth bell."',
];

test.beforeAll(async () => {
    mock = await startMockLLM({ scriptedReplies: REPLIES });
    server = await startServer({ batchKey: 'groups', scenarioId: 'persist-branch' });
    markOnboarded({ dataRoot: server.dataRoot });
    bootstrapCustomBackend({ dataRoot: server.dataRoot, baseURL: mock.baseURL });
    appendConnectionProfile({ dataRoot: server.dataRoot, baseURL: mock.baseURL });
    trio = seedThreeCartographers(server.dataRoot);
});

test.afterAll(async () => {
    await tearDownServer(server);
    await mock?.stop();
});

test.describe('#88 — group chat persistence + branch + export', () => {
    test('5 turns persist across restart, branch copies a prefix, export/import round-trips', async ({ page }) => {
        // ============================================================
        // Setup: 3-member LIST-rotation group, 5 turns × 3 = 15 asst msgs.
        // ============================================================
        await awaitMainUI(page, server.baseURL);
        const group = await createGroupViaApi(page, {
            name: 'Bryn Headland Watch',
            members: trio.map(c => c.avatar),
            activation_strategy: 1,   // LIST → deterministic per-member rotation
            generation_mode: 0,        // SWAP
        });
        groupId = group.id;
        chatId = group.chat_id;
        expect(groupId, 'group should have been created via /api/groups/create').toBeTruthy();
        await openGroupForChat(page, groupId);

        const turnPrompts = [
            'The first bell has rung. Status across the cove?',
            'Second bell — any shift in wind or pier signals?',
            'Third bell. Read me the chart against what the south reports.',
            'Fourth bell. Movement north of the gull rocks; identify if you can.',
            'Fifth bell. We need a clean log before the morning shift.',
        ];
        for (const p of turnPrompts) {
            await sendUserAndAwaitGroupTurn(page, p);
        }

        const inMemoryBefore = await page.evaluate(() => {
            const ctx = window.Luker.getContext();
            return {
                chatId: ctx.getCurrentChatId?.(),
                length: ctx.chat?.length,
                messages: ctx.chat?.map(m => ({
                    name: m.name,
                    is_user: !!m.is_user,
                    is_system: !!m.is_system,
                    mes: m.mes,
                })),
            };
        });
        // 5 turns of (1 user + 3 assistant) = 20 messages plus the
        // 3 first_mes greetings the group seeded on open (one per member).
        const userCountBefore = inMemoryBefore.messages.filter(m => m.is_user && !m.is_system).length;
        const asstCountBefore = inMemoryBefore.messages.filter(m => !m.is_user && !m.is_system).length;
        expect(userCountBefore, 'should have 5 user turns').toBe(5);
        // 5 turns × 3 members = 15 generated replies; plus 3 seeded greetings = 18 total.
        const expectedAsstBefore = 5 * trio.length + trio.length;
        expect(
            asstCountBefore,
            `should have ${expectedAsstBefore} assistant turns (5 × ${trio.length} from LIST-rotation + ${trio.length} seeded greetings)`,
        ).toBe(expectedAsstBefore);

        // ============================================================
        // Section 1: Persistence across server restart.
        // ============================================================
        const diskBefore = readGroupChatOnDisk(server.dataRoot, chatId);
        expect(diskBefore.header, 'group chat jsonl should begin with the chat_metadata header').toBeTruthy();
        // The persisted log should contain the same 5 user + 15 assistant
        // messages we saw in memory (plus the initial first_mes greetings).
        const diskUsersBefore = diskBefore.messages.filter(m => m.is_user && !m.is_system);
        const diskAsstsBefore = diskBefore.messages.filter(m => !m.is_user && !m.is_system);
        expect(diskUsersBefore.length, 'persisted user-message count should match in-memory before restart').toBe(userCountBefore);
        expect(diskAsstsBefore.length, 'persisted assistant-message count should match in-memory before restart').toBe(15 + /* one greeting per member */ trio.length);

        await server.restart();
        await reloadAndAwait(page, server.baseURL);

        // After restart the previously-selected group should still exist
        // on disk (the .json file in `<dataRoot>/<handle>/groups`).
        const groupsOnDiskAfter = listGroupsOnDisk(server.dataRoot);
        expect(groupsOnDiskAfter, 'the group json file should survive server restart').toContain(`${groupId}.json`);

        await openGroupForChat(page, groupId);
        await page.waitForFunction((wantLen) => {
            const ctx = window.Luker.getContext();
            return ctx.chat?.length >= wantLen;
        }, inMemoryBefore.length, { timeout: 15_000 });

        const inMemoryAfter = await page.evaluate(() => {
            const ctx = window.Luker.getContext();
            return {
                chatId: ctx.getCurrentChatId?.(),
                length: ctx.chat?.length,
                messages: ctx.chat?.map(m => ({
                    name: m.name,
                    is_user: !!m.is_user,
                    is_system: !!m.is_system,
                    mes: m.mes,
                })),
            };
        });
        expect(inMemoryAfter.chatId, 'post-restart group chat id should match the pre-restart chat').toBe(chatId);
        expect(inMemoryAfter.length, 'post-restart chat length must match pre-restart chat length').toBe(inMemoryBefore.length);
        // Byte-for-byte equivalence on every message.
        for (let i = 0; i < inMemoryBefore.length; i++) {
            const before = inMemoryBefore.messages[i];
            const after = inMemoryAfter.messages[i];
            expect(after.name, `message ${i} speaker should match across restart`).toBe(before.name);
            expect(after.is_user, `message ${i} is_user flag should match across restart`).toBe(before.is_user);
            expect(after.mes, `message ${i} body should be preserved verbatim across restart`).toBe(before.mes);
        }

        // ============================================================
        // Section 2: Branch via the real .mes_create_branch button.
        // ============================================================
        // Branch at the middle assistant message — the 2nd member of
        // turn 3 (= Rhonin's third bell line). Slice up to and
        // including that message should land in the new group chat.
        const asstIndices = inMemoryAfter.messages
            .map((m, i) => ({ i, m }))
            .filter(({ m }) => !m.is_user && !m.is_system)
            .map(({ i }) => i);
        // Pick the assistant message that is roughly the middle of the
        // run — `Math.floor(asstIndices.length / 2)`. With greetings +
        // 15 asst msgs this falls inside turn 3.
        const branchAt = asstIndices[Math.floor(asstIndices.length / 2)];
        expect(typeof branchAt, 'branch anchor must be a real message index').toBe('number');
        const branchAtMes = inMemoryAfter.messages[branchAt].mes;

        const groupChatsBefore = readdirSync(
            resolve(server.dataRoot, 'default-user', 'group chats'),
        ).filter(f => f.endsWith('.jsonl'));
        // Subscribe to CHAT_BRANCH_CREATED BEFORE the click so the branch
        // signal isn't dropped (branchChat fires it synchronously
        // before navigating). Park the result on window for waitFor.
        await page.evaluate(() => {
            const ctx = window.Luker.getContext();
            window.__branchSignal = { resolved: false, payload: null };
            const handler = (data) => {
                try { ctx.eventSource.removeListener(ctx.eventTypes.CHAT_BRANCH_CREATED, handler); } catch {}
                window.__branchSignal.resolved = true;
                window.__branchSignal.payload = data ?? 'event';
            };
            ctx.eventSource.on(ctx.eventTypes.CHAT_BRANCH_CREATED, handler);
        });
        // Click the real .mes_create_branch button on the chosen bubble.
        // The chat lazy-loads only the most recent N messages; ensure the
        // target message is in DOM (and scrolled into view) first.
        await ensureMessageInView(page, branchAt);
        await branchFromMessageViaUI(page, branchAt, { timeoutMs: 30_000 });
        await page.waitForFunction(() => window.__branchSignal?.resolved === true, null, { timeout: 30_000 });

        // Wait for the chat to switch into the new branch.
        await page.waitForFunction((origChat) => {
            const ctx = window.Luker.getContext();
            const cur = ctx.getCurrentChatId?.();
            return cur && cur !== origChat;
        }, chatId, { timeout: 15_000 });
        await page.waitForTimeout(500);

        const branchSnap = await page.evaluate(() => {
            const ctx = window.Luker.getContext();
            return {
                chatId: ctx.getCurrentChatId?.(),
                length: ctx.chat?.length,
                messages: ctx.chat?.map(m => ({
                    name: m.name,
                    is_user: !!m.is_user,
                    is_system: !!m.is_system,
                    mes: m.mes,
                })),
                metadata: ctx.chatMetadata,
            };
        });
        const branchChatId = branchSnap.chatId;
        expect(branchChatId, 'branch chat id must be different from the source chat id').not.toBe(chatId);
        expect(branchSnap.metadata?.main_chat, 'branch chat_metadata.main_chat must point back at the source chat').toBe(chatId);
        // Branch is prefix up to and including branchAt: length = branchAt + 1.
        expect(
            branchSnap.length,
            `branch should hold prefix [0..${branchAt}]; got msgs=${JSON.stringify(branchSnap.messages.map(m => m.mes?.slice(0, 30)))}`,
        ).toBe(branchAt + 1);
        // The branch-anchor message must be present byte-for-byte.
        expect(branchSnap.messages[branchAt].mes, 'branch anchor body must equal the source anchor body').toBe(branchAtMes);

        // The group json file on disk must list both chats as members.
        const groupOnDisk = JSON.parse(
            readFileSync(resolve(server.dataRoot, 'default-user', 'groups', `${groupId}.json`), 'utf8'),
        );
        expect(groupOnDisk.members, 'branch must not change the member list of the group').toEqual(trio.map(c => c.avatar));
        expect(groupOnDisk.chats, 'branch must register a second chat id under the group').toContain(branchChatId);
        expect(groupOnDisk.chats, 'branch must leave the original chat id registered under the group').toContain(chatId);

        // Source chat file untouched.
        const groupChatsAfter = readdirSync(
            resolve(server.dataRoot, 'default-user', 'group chats'),
        ).filter(f => f.endsWith('.jsonl'));
        expect(groupChatsAfter.length, 'a branch must produce a brand-new group chat jsonl on disk').toBe(groupChatsBefore.length + 1);
        expect(groupChatsAfter, 'the original group chat jsonl must survive branch creation').toContain(`${chatId}.jsonl`);

        const sourceDiskAfterBranch = readGroupChatOnDisk(server.dataRoot, chatId);
        expect(
            sourceDiskAfterBranch.messages.length,
            'source group chat must NOT be truncated by the branch operation',
        ).toBe(diskBefore.messages.length);

        // ============================================================
        // Section 3: Export → Import roundtrip via the real past-chats UI.
        // ============================================================
        // Switch back to the source chat by clicking its row in the
        // past-chats popup (option_select_chat → .select_chat_block).
        await switchGroupChatViaUI(page, chatId);

        // Click .exportRawChatButton[data-format="jsonl"] on the source
        // chat's row in the past-chats popup; capture the download.
        const exportedJsonl = await exportGroupChatViaUI(page, chatId);
        expect(typeof exportedJsonl, 'JSONL export download should produce a string body').toBe('string');

        // Parse the exported JSONL: first line is the chat_metadata
        // header; subsequent lines are message objects. Asserting on
        // parsed `.mes` fields avoids spurious mismatches from
        // JSON-escape ordering in the raw payload.
        const exportedLines = exportedJsonl.split('\n').filter(l => l.trim());
        expect(exportedLines.length, 'export should contain at least header + all messages').toBeGreaterThan(diskBefore.messages.length);
        const exportedParsed = exportedLines.map(l => JSON.parse(l));
        const exportedHeader = exportedParsed[0];
        const exportedMessages = exportedParsed.slice(1);
        expect(exportedHeader?.chat_metadata, 'exported JSONL must begin with the chat_metadata header').toBeTruthy();
        // Every scripted reply must appear as `.mes` in the parsed
        // exported messages.
        const exportedMesBodies = new Set(exportedMessages.map(m => m.mes));
        for (const reply of REPLIES) {
            expect(
                exportedMesBodies.has(reply),
                `exported jsonl should contain scripted reply ${reply.slice(0, 40)}…`,
            ).toBe(true);
        }
        // The 5 user prompts must also appear verbatim.
        for (const prompt of turnPrompts) {
            expect(
                exportedMesBodies.has(prompt),
                `exported jsonl should contain the user prompt "${prompt}"`,
            ).toBe(true);
        }

        // Import a fresh group chat by clicking #chat_import_button and
        // feeding the JSONL payload through the file chooser. The
        // popup is still open from exportGroupChatViaUI.
        const importedChatId = await importGroupChatViaUI(page, exportedJsonl, 'group-roundtrip.jsonl');
        expect(importedChatId, 'import must return the new chat id').toBeTruthy();

        // Close the past-chats popup so any subsequent test gestures
        // aren't blocked by its modal shadow.
        await closePastChatsPopup(page);

        // The new chat jsonl must be on disk.
        const importedPath = resolve(server.dataRoot, 'default-user', 'group chats', `${importedChatId}.jsonl`);
        expect(existsSync(importedPath), 'imported group chat jsonl must land on disk').toBe(true);

        // Byte-for-byte: every assistant reply + every user prompt must
        // appear in the imported jsonl, and the message count after the
        // header must equal the source message count.
        const importedDisk = readGroupChatOnDisk(server.dataRoot, importedChatId);
        expect(
            importedDisk.messages.length,
            'imported jsonl message count must equal the source jsonl message count',
        ).toBe(diskBefore.messages.length);
        // Member names of the assistant turns must be the same set as
        // the source — the import does not re-resolve speakers (the
        // jsonl carries them).
        const importedSpeakers = new Set(
            importedDisk.messages.filter(m => !m.is_user && !m.is_system).map(m => m.name),
        );
        for (const c of trio) {
            expect(importedSpeakers, `imported chat must preserve speaker name "${c.name}"`).toContain(c.name);
        }
        // The persisted body of every assistant reply must round-trip.
        for (const reply of REPLIES) {
            const found = importedDisk.messages.find(m => m.mes === reply);
            expect(
                found,
                `imported jsonl should contain reply byte-for-byte: ${reply.slice(0, 40)}…`,
            ).toBeTruthy();
        }
    });
});
