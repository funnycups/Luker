// #61 — One turn with multiple var_ops mutations → floor end-state written to sidecar.
//
// The variable-op-log feature scans the AI reply for embedded side-effect
// macros ({{setvar}}, {{incvar}}, {{pushvar}}, {{decvar}}, {{deletevar}},
// {{addvar}}, {{popvar}}), strips them from the visible text, records the
// structured op records onto `chat[messageId].extra.var_ops`, and forward-
// applies each op into `chat_metadata.variables` in source order.
//
// chat_metadata.variables is the materialized "floor end-state" cache; the
// load-bearing persistence record is the per-message `extra.var_ops` array
// which is serialized into the chat JSONL. On chat-load, the rebuilder
// replays surviving ops back into chat_metadata.variables, so even if the
// cached header is stale, the in-memory state reconverges.
//
// This test scripts a single reply containing four mutations (set, set, inc,
// push) and asserts, in order:
//   a) Each op is recorded in extra.var_ops in source order
//   b) The materialized chat_metadata.variables reflects all four mutations
//   c) The literal macro syntax is stripped from the rendered message
//   d) After server restart + reload, in-memory state reconverges to
//      hp=51, tension=high, inventory=["lantern"] via the rebuilder
//   e) The per-message extra.var_ops survives on the chat JSONL across
//      restart (this is the actual durable record).

import { test, expect } from '@playwright/test';
import { readFileSync, readdirSync, existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { startServer, tearDownServer } from '../_lib/server.js';
import { startMockLLM } from '../_lib/mockLLM.js';
import { bootstrapCustomBackend, appendConnectionProfile, markOnboarded } from '../_lib/fixtures.js';
import { awaitMainUI, selectCharacterByName, sendMessageAndAwaitReply, reloadAndAwait } from '../_lib/page.js';

let server, mock;

// Four mutations woven into Seraphina's reply:
//   1. setvar hp = 50           (set; numeric-string)
//   2. setvar tension = high    (set; string)
//   3. incvar hp                (inc by 1 → 51, numeric coercion in apply.js)
//   4. pushvar inventory = lantern   (push onto inventory array; auto-creates)
const RICH_REPLY = [
    '*Seraphina drops to one knee at the lantern base, salt cracking on her cuffs.* ',
    'The wick is fickle tonight. {{setvar::hp::50}}{{setvar::tension::high}}',
    ' She wedges the spyglass under one arm. {{incvar::hp}}',
    ' "Take the lantern," she says, pressing it into your palm. {{pushvar::inventory::lantern}}',
    ' "And keep your eyes on the third breaker — that one has been lying to me all watch."',
].join('');

test.beforeAll(async () => {
    mock = await startMockLLM({ scriptedReplies: [RICH_REPLY] });
    server = await startServer({ batchKey: 'varops', scenarioId: 'multi-ops-per-turn' });
    markOnboarded({ dataRoot: server.dataRoot });
    bootstrapCustomBackend({ dataRoot: server.dataRoot, baseURL: mock.baseURL });
    appendConnectionProfile({ dataRoot: server.dataRoot, baseURL: mock.baseURL });
});

test.afterAll(async () => {
    await tearDownServer(server);
    await mock?.stop();
});

test.describe('#61 — One turn / multiple var_ops mutations → floor end-state', () => {
    test('all four ops land in extra.var_ops in source order; materialized state reflects each; visible text is stripped; persists across restart', async ({ page }) => {
        await awaitMainUI(page, server.baseURL);
        await selectCharacterByName(page, 'Seraphina');

        // Wait for the greeting (Seraphina's first_mes) to land before we
        // send our turn so we can address the assistant reply unambiguously.
        await page.waitForFunction(() => {
            const ctx = window.Luker.getContext();
            return Array.isArray(ctx.chat) && ctx.chat.length >= 1;
        }, { timeout: 10_000 }).catch(() => {});

        await sendMessageAndAwaitReply(page, 'I will hold the lantern. Tell me what the breaker is doing.');

        const observed = await page.evaluate(async () => {
            const ctx = window.Luker.getContext();
            // Locate the most recent assistant message
            let asstId = -1;
            for (let i = ctx.chat.length - 1; i >= 0; i--) {
                if (!ctx.chat[i]?.is_user) { asstId = i; break; }
            }
            const m = ctx.chat[asstId];
            // Force an explicit save so the chat file on disk reflects the
            // post-extract state before we restart the server. saveChatConditional
            // is debounced; an explicit saveChat bypasses that.
            await ctx.saveChat();
            const avatarFolder = (ctx.characters[ctx.characterId]?.avatar || '').replace(/\.png$/, '');
            return {
                asstId,
                mes: m?.mes ?? '',
                ops: m?.extra?.var_ops ?? null,
                variables: ctx.chatMetadata?.variables ?? null,
                avatarFolder,
                chatId: ctx.getCurrentChatId?.() ?? null,
            };
        });

        // The most-recent assistant message is the reply we scripted; the
        // greeting (chat[0]) carries no ops.
        expect(observed.asstId, 'should have an assistant message').toBeGreaterThanOrEqual(0);
        expect(observed.ops, 'extra.var_ops must be populated by extractor').toBeTruthy();
        expect(observed.ops).toEqual([
            { op: 'setvar', key: 'hp', value: '50' },
            { op: 'setvar', key: 'tension', value: 'high' },
            { op: 'incvar', key: 'hp' },
            { op: 'pushvar', key: 'inventory', value: 'lantern' },
        ]);

        // Literal macro syntax must be stripped from the visible mes
        expect(observed.mes).not.toContain('{{setvar');
        expect(observed.mes).not.toContain('{{incvar');
        expect(observed.mes).not.toContain('{{pushvar');
        // Narrative prose remains — this is the "no silent truncation" guarantee
        expect(observed.mes).toContain('third breaker');
        expect(observed.mes).toContain('Seraphina drops to one knee');

        // Materialized state: hp went 50 → 51 (set, then inc), tension=high, inventory=["lantern"]
        // apply.js#addToVariable returns the numeric sum for incvar.
        expect(Number(observed.variables.hp), 'hp incremented after set').toBe(51);
        expect(observed.variables.tension).toBe('high');
        // pushvar stores the array as a JSON-stringified payload
        expect(JSON.parse(observed.variables.inventory)).toEqual(['lantern']);

        // ── Pre-restart on-disk sanity: chat JSONL has the message ops ─
        // The character card embeds a default chat filename ("Seraphina - 2023-5-12
        // …"); ST writes our active chat to that name.
        const chatDir = resolve(server.dataRoot, 'default-user', 'chats', observed.avatarFolder);
        expect(existsSync(chatDir), `chat dir should exist at ${chatDir}`).toBe(true);
        const chatFiles = readdirSync(chatDir).filter(f => f.endsWith('.jsonl'));
        expect(chatFiles.length, 'at least one chat jsonl present').toBeGreaterThanOrEqual(1);
        const targetFile = observed.chatId && chatFiles.includes(`${observed.chatId}.jsonl`)
            ? `${observed.chatId}.jsonl`
            : chatFiles[0];
        const preLines = readFileSync(resolve(chatDir, targetFile), 'utf8').trim().split('\n');
        // Locate the assistant line with var_ops by scanning all message lines.
        const messageLinesPre = preLines.slice(1).map(l => JSON.parse(l));
        const asstLine = [...messageLinesPre].reverse().find(m => !m.is_user && Array.isArray(m?.extra?.var_ops) && m.extra.var_ops.length > 0);
        expect(asstLine, 'assistant line with var_ops present in chat jsonl').toBeTruthy();
        expect(asstLine.extra.var_ops).toEqual([
            { op: 'setvar', key: 'hp', value: '50' },
            { op: 'setvar', key: 'tension', value: 'high' },
            { op: 'incvar', key: 'hp' },
            { op: 'pushvar', key: 'inventory', value: 'lantern' },
        ]);
        // The serialized line text should not contain the stripped macro literals.
        expect(asstLine.mes).not.toContain('{{setvar');
        expect(asstLine.mes).not.toContain('{{incvar');
        expect(asstLine.mes).not.toContain('{{pushvar');

        // ── Persistence: restart server, reload, re-verify ──────────────
        await server.restart();
        await reloadAndAwait(page, server.baseURL);
        await selectCharacterByName(page, 'Seraphina');

        // Wait for the chat to re-hydrate from disk; the CHAT_CHANGED handler
        // will run rebuildVariablesFromChat against the persisted ops, which
        // re-materializes chat_metadata.variables in memory.
        await page.waitForFunction(() => {
            const ctx = window.Luker?.getContext?.();
            return Array.isArray(ctx?.chat) && ctx.chat.length >= 2;
        }, { timeout: 15_000 });

        const afterRestart = await page.evaluate(() => {
            const ctx = window.Luker.getContext();
            let asstId = -1;
            for (let i = ctx.chat.length - 1; i >= 0; i--) {
                if (!ctx.chat[i]?.is_user) { asstId = i; break; }
            }
            const m = ctx.chat[asstId];
            return {
                ops: m?.extra?.var_ops ?? null,
                variables: ctx.chatMetadata?.variables ?? null,
                mes: m?.mes ?? '',
            };
        });

        expect(afterRestart.ops, 'var_ops survive restart').toEqual([
            { op: 'setvar', key: 'hp', value: '50' },
            { op: 'setvar', key: 'tension', value: 'high' },
            { op: 'incvar', key: 'hp' },
            { op: 'pushvar', key: 'inventory', value: 'lantern' },
        ]);
        // In-memory state reconverges via the rebuilder.
        expect(Number(afterRestart.variables.hp), 'hp materialized to 51 after rebuild').toBe(51);
        expect(afterRestart.variables.tension).toBe('high');
        expect(JSON.parse(afterRestart.variables.inventory)).toEqual(['lantern']);
        expect(afterRestart.mes).not.toContain('{{setvar');
        expect(afterRestart.mes).not.toContain('{{incvar');
        expect(afterRestart.mes).not.toContain('{{pushvar');
    });
});
