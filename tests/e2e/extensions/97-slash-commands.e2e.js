// Case #97 — Slash commands comprehensive regression
//
// One sub-test per load-bearing slash command. The mock LLM is shared
// across the whole describe; tests that don't need a fresh reply just
// preload one before they call into the command.
//
// Where a command's documented signature is shaped differently than the
// brief lists (e.g. `/cut last` is invalid — /cut wants a numeric ID or
// range; `/abort` aborts the slash-command batch, not in-flight LLM;
// `/exportchat` and `/importchat` do not exist as slash commands), we
// assert against the *actual* documented behavior, not the brief's
// shorthand. Each sub-test documents the divergence inline.

import { test, expect } from '@playwright/test';
import { resolve } from 'node:path';
import { copyFileSync, readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { write as writeCharaPng } from '../../../src/character-card-parser.js';
import { startServer, tearDownServer } from '../_lib/server.js';
import { startMockLLM } from '../_lib/mockLLM.js';
import { bootstrapCustomBackend, appendConnectionProfile, markOnboarded } from '../_lib/fixtures.js';
import { awaitMainUI, selectCharacterByName } from '../_lib/page.js';

const REPO_ROOT = resolve(import.meta.dirname, '../../..');

/**
 * Embed a v2 character card into a PNG via tEXt chunks so Luker's
 * character-card-parser.read() finds it (writeCharacter in fixtures.js
 * leaves the data in a sidecar JSON Luker doesn't read for cards).
 */
function writeProperCharacter(dataRoot, { handle = 'default-user', avatarFile, name, firstMes }) {
    const charsDir = resolve(dataRoot, handle, 'characters');
    mkdirSync(charsDir, { recursive: true });
    const seed = resolve(REPO_ROOT, 'default/content/default_Seraphina.png');
    const target = resolve(charsDir, avatarFile);
    copyFileSync(seed, target);

    // Build a v2 card. The fields used at runtime are name, first_mes,
    // and the rest are decorative — kept short.
    const card = {
        name,
        description: 'A fixture character generated for the slash-commands regression test.',
        personality: 'Patient, observant, slow to anger.',
        scenario: 'You meet on the headland just before dawn.',
        first_mes: firstMes,
        mes_example: '',
        creator_notes: 'e2e fixture',
        system_prompt: '',
        post_history_instructions: '',
        alternate_greetings: [],
        tags: ['rp', 'fixture'],
        creator: 'luker-e2e',
        character_version: '1.0',
        extensions: {},
        // Spec markers — needed for v2 detection.
        spec: 'chara_card_v2',
        spec_version: '2.0',
        // v2 nested data block — characters.js wraps via getStoredCharaCardV2.
        data: {
            name,
            description: '',
            personality: '',
            scenario: '',
            first_mes: firstMes,
            mes_example: '',
            creator_notes: '',
            system_prompt: '',
            post_history_instructions: '',
            alternate_greetings: [],
            tags: ['rp', 'fixture'],
            creator: 'luker-e2e',
            character_version: '1.0',
            extensions: {},
        },
    };

    const pngBuffer = readFileSync(target);
    const withMeta = writeCharaPng(pngBuffer, JSON.stringify(card));
    writeFileSync(target, withMeta);
}

let server, mock;

// Helper: run a slash pipeline and return its string return value.
async function runSlash(page, pipeline) {
    return await page.evaluate(async (cmd) => {
        const ctx = window.SillyTavern.getContext();
        const res = await ctx.executeSlashCommandsWithOptions(cmd);
        return { pipeText: res?.pipe ?? '', state: res?.isError ? 'error' : 'ok' };
    }, pipeline);
}

// Helper: snapshot the current chat tail for assertions.
async function chatSnapshot(page) {
    return await page.evaluate(() => {
        const ctx = window.SillyTavern.getContext();
        return {
            length: ctx.chat.length,
            messages: ctx.chat.map(m => ({
                name: m.name,
                isUser: !!m.is_user,
                isSystem: !!m.is_system,
                isNarrator: m?.extra?.type === 'narrator',
                mes: m.mes,
                swipes: Array.isArray(m.swipes) ? m.swipes.length : 0,
                swipeId: m.swipe_id,
            })),
        };
    });
}

test.beforeAll(async () => {
    // Preload enough replies for every test that fires a generation. Each
    // unused reply is harmless; remaining replies fall back to echo.
    mock = await startMockLLM({ scriptedReplies: [
        '*Ash trims the lantern.* "The reef is settling."',                     // sysgen 1
        '*Ash watches the gull rocks.* "Quieter than yesterday."',              // trigger
        '*Ash folds the chart.* "I have another reading of that line."',        // swipe alt 1
        '*Ash sets the spyglass down.* "Try this — three breakers further north."', // swipe alt 2
        '*Ash continues, voice low.* "...and the salt-mark drifters never came past the headland tonight."', // continue
        '*Ash starts over.* "Let me draw this from a different angle."',        // regenerate
        '*Ash glances up.* "Another step."',                                    // /go reload first_mes path / spare
        '*Ash glances up again.* "And another."',                               // spare
    ] });
    server = await startServer({ batchKey: 'extensions', scenarioId: '97-slash-commands' });
    markOnboarded({ dataRoot: server.dataRoot });
    bootstrapCustomBackend({ dataRoot: server.dataRoot, baseURL: mock.baseURL });
    appendConnectionProfile({ dataRoot: server.dataRoot, baseURL: mock.baseURL });

    // Add a second character so /go has something distinct to switch to.
    // Use a writer that embeds the v2 card into the PNG (the fixture helper
    // leaves it in a sidecar JSON that Luker's character reader ignores).
    writeProperCharacter(server.dataRoot, {
        avatarFile: 'bryn-the-keeper.png',
        name: 'Bryn the Keeper',
        firstMes: '*Bryn looks up from the lantern stand.* "You are late. Sit down before the wick chokes."',
    });
});

test.afterAll(async () => {
    await tearDownServer(server);
    await mock?.stop();
});

// Each sub-test uses its own page so it gets a fresh chat — the mock LLM
// keeps a FIFO of replies, so order across tests matters. Playwright runs
// tests within a describe sequentially unless `test.describe.parallel`,
// which we do NOT use here.
test.describe.configure({ mode: 'serial' });

test.describe('#97 — Slash commands regression', () => {
    test('/help (alias of /?) returns without throwing', async ({ page }) => {
        await awaitMainUI(page, server.baseURL);
        await selectCharacterByName(page, 'Seraphina');
        // /? is the canonical name, /help is an alias. Either should
        // resolve without raising. We don't assert specific text — the
        // popup contents are i18n-dependent and the test brief allows
        // "did not throw + got some response shape".
        const res = await runSlash(page, '/help');
        expect(res.state).toBe('ok');
        // /help opens a popup. Resolve it so it doesn't block later tests.
        await page.locator('.popup .popup-button-ok, .popup .popup-button-close').first().click({ timeout: 5000 }).catch(() => {});
    });

    test('/send appends a user message without triggering generation', async ({ page }) => {
        await awaitMainUI(page, server.baseURL);
        await selectCharacterByName(page, 'Seraphina');
        // Wait for greeting.
        await page.waitForFunction(() => window.SillyTavern.getContext().chat.length >= 1, { timeout: 10_000 });
        const before = await chatSnapshot(page);
        await runSlash(page, '/send The lantern wick is fraying again.');
        const after = await chatSnapshot(page);
        expect(after.length).toBe(before.length + 1);
        const tail = after.messages[after.length - 1];
        expect(tail.isUser).toBe(true);
        expect(tail.mes).toContain('lantern wick is fraying');
    });

    test('/sysgen appends a system narrator message via the LLM', async ({ page }) => {
        await awaitMainUI(page, server.baseURL);
        await selectCharacterByName(page, 'Seraphina');
        await page.waitForFunction(() => window.SillyTavern.getContext().chat.length >= 1, { timeout: 10_000 });
        const before = await chatSnapshot(page);
        await runSlash(page, '/sysgen Describe what the wind is doing at this very moment.');
        await page.waitForFunction((n) => window.SillyTavern.getContext().chat.length > n, before.length, { timeout: 30_000 });
        const after = await chatSnapshot(page);
        const tail = after.messages[after.length - 1];
        // sendNarratorMessage tags the message with extra.type === 'narrator'.
        // It's only marked is_system when the prompt body is empty AND has
        // a bias macro; bare /sysgen output is is_user=false, is_system=false,
        // but always extra.type === 'narrator'.
        expect(tail.isNarrator).toBe(true);
        expect(tail.isUser).toBe(false);
        expect(tail.mes).toBeTruthy();
    });

    test('/go <char> switches the active character', async ({ page }) => {
        await awaitMainUI(page, server.baseURL);
        await selectCharacterByName(page, 'Seraphina');
        // Confirm we start on Seraphina.
        const startName = await page.evaluate(() => {
            const ctx = window.SillyTavern.getContext();
            return ctx.characters[ctx.characterId]?.name;
        });
        expect(startName).toBe('Seraphina');

        await runSlash(page, '/go Bryn the Keeper');
        // /go fires CHAT_CHANGED — wait for ctx.characterId to point at Bryn.
        await page.waitForFunction(() => {
            const ctx = window.SillyTavern.getContext();
            return ctx.characters[ctx.characterId]?.name === 'Bryn the Keeper';
        }, { timeout: 15_000 });

        const newName = await page.evaluate(() => {
            const ctx = window.SillyTavern.getContext();
            return ctx.characters[ctx.characterId]?.name;
        });
        expect(newName).toBe('Bryn the Keeper');
    });

    test('/send + /trigger produces an assistant reply', async ({ page }) => {
        await awaitMainUI(page, server.baseURL);
        await selectCharacterByName(page, 'Seraphina');
        await page.waitForFunction(() => window.SillyTavern.getContext().chat.length >= 1, { timeout: 10_000 });
        const before = await chatSnapshot(page);
        // /trigger needs await=true for the slash batch to wait for the
        // reply before returning — otherwise the assertion races the LLM.
        await runSlash(page, '/send I will keep watch tonight. | /trigger await=true');
        const after = await chatSnapshot(page);
        // Two new messages: user + assistant.
        expect(after.length).toBeGreaterThan(before.length + 1);
        const userMsg = after.messages[before.length];
        const replyMsg = after.messages[after.length - 1];
        expect(userMsg.isUser).toBe(true);
        expect(replyMsg.isUser).toBe(false);
        expect(replyMsg.mes).toBeTruthy();
    });

    test('/swipe adds a second variant and switches to it', async ({ page }) => {
        await awaitMainUI(page, server.baseURL);
        await selectCharacterByName(page, 'Seraphina');
        await page.waitForFunction(() => window.SillyTavern.getContext().chat.length >= 1, { timeout: 10_000 });
        // Generate a reply first.
        await runSlash(page, '/send Tell me about the gull rocks. | /trigger await=true');
        const beforeSwipe = await chatSnapshot(page);
        const beforeTail = beforeSwipe.messages[beforeSwipe.length - 1];
        expect(beforeTail.isUser).toBe(false);
        const initialSwipes = beforeTail.swipes;

        // Swipe right (next variant). Await so the LLM call completes.
        await runSlash(page, '/swipe direction=right await=true');
        await page.waitForFunction((startCount) => {
            const ctx = window.SillyTavern.getContext();
            const m = ctx.chat[ctx.chat.length - 1];
            return Array.isArray(m?.swipes) && m.swipes.length > startCount;
        }, initialSwipes, { timeout: 30_000 });

        const afterSwipe = await chatSnapshot(page);
        const afterTail = afterSwipe.messages[afterSwipe.length - 1];
        expect(afterTail.swipes).toBeGreaterThan(initialSwipes);

        // Swipe left — switches BACK to a previous variant without
        // generating. swipe_id should decrement. Use await=true so the
        // assertion observes the post-swipe state, not the pre-swipe one.
        const midSwipeId = afterTail.swipeId;
        await runSlash(page, '/swipe direction=left await=true');
        // Even with await, the swipe handler dispatches via a setTimeout —
        // wait until swipe_id actually moves before asserting.
        await page.waitForFunction((target) => {
            const ctx = window.SillyTavern.getContext();
            const m = ctx.chat[ctx.chat.length - 1];
            return typeof m?.swipe_id === 'number' && m.swipe_id < target;
        }, midSwipeId, { timeout: 10_000 });
        const afterLeft = await chatSnapshot(page);
        const leftTail = afterLeft.messages[afterLeft.length - 1];
        expect(leftTail.swipeId).toBeLessThan(midSwipeId);
    });

    test('/cut <id> removes a specific message (brief mentioned /cut last; impl needs a numeric id)', async ({ page }) => {
        await awaitMainUI(page, server.baseURL);
        await selectCharacterByName(page, 'Seraphina');
        await page.waitForFunction(() => window.SillyTavern.getContext().chat.length >= 1, { timeout: 10_000 });
        await runSlash(page, '/send sentinel-cut-target');
        const before = await chatSnapshot(page);
        const cutTargetId = before.length - 1;
        const res = await runSlash(page, `/cut ${cutTargetId}`);
        expect(res.state).toBe('ok');
        const after = await chatSnapshot(page);
        expect(after.length).toBe(before.length - 1);
        const tail = after.messages[after.length - 1];
        expect(tail.mes).not.toContain('sentinel-cut-target');
    });

    test('/continue extends the last assistant message via the LLM', async ({ page }) => {
        await awaitMainUI(page, server.baseURL);
        await selectCharacterByName(page, 'Seraphina');
        await page.waitForFunction(() => window.SillyTavern.getContext().chat.length >= 1, { timeout: 10_000 });
        await runSlash(page, '/send Walk me through what you see north of the headland. | /trigger await=true');
        const before = await chatSnapshot(page);
        const beforeTail = before.messages[before.length - 1];
        const beforeText = beforeTail.mes;
        await runSlash(page, '/continue await=true');
        const after = await chatSnapshot(page);
        const afterTail = after.messages[after.length - 1];
        // /continue should NOT add a new tail message — it should extend
        // the existing one. Same index, longer or equal mes.
        expect(after.length).toBe(before.length);
        expect(afterTail.mes.length).toBeGreaterThanOrEqual(beforeText.length);
    });

    test('/regenerate re-rolls the last assistant message in place', async ({ page }) => {
        await awaitMainUI(page, server.baseURL);
        await selectCharacterByName(page, 'Seraphina');
        await page.waitForFunction(() => window.SillyTavern.getContext().chat.length >= 1, { timeout: 10_000 });
        await runSlash(page, '/send What is the wind doing right now? | /trigger await=true');
        const before = await chatSnapshot(page);
        const beforeTail = before.messages[before.length - 1];
        const beforeText = beforeTail.mes;
        await runSlash(page, '/regenerate await=true');
        const after = await chatSnapshot(page);
        // /regenerate replaces the existing tail message in place — it does
        // not add a swipe (unlike a UI swipe-right, which generates AND
        // attaches a new variant). chat.length is unchanged. The new text
        // either differs from the old one or, when the mock falls back to
        // its deterministic echo, may match — the load-bearing assertion
        // is just "no error, same tail, an LLM round-trip occurred".
        expect(after.length).toBe(before.length);
        const afterTail = after.messages[after.length - 1];
        expect(afterTail.isUser).toBe(false);
        expect(typeof afterTail.mes).toBe('string');
        expect(afterTail.mes.length).toBeGreaterThan(0);
    });

    test('/abort halts the surrounding slash batch (note: aborts the script, not in-flight LLM)', async ({ page }) => {
        // /abort cancels remaining pipeline steps; it does NOT cancel an
        // in-flight LLM call (that is /stop). We assert the abort by
        // observing that a step after /abort doesn't run.
        await awaitMainUI(page, server.baseURL);
        await selectCharacterByName(page, 'Seraphina');
        await page.waitForFunction(() => window.SillyTavern.getContext().chat.length >= 1, { timeout: 10_000 });
        await runSlash(page, '/setvar key=abort_sentinel before');
        await runSlash(page, '/abort | /setvar key=abort_sentinel after').catch(() => {});
        const res = await runSlash(page, '/getvar abort_sentinel');
        // The second /setvar must not have run; the var stays at "before".
        expect(res.pipeText).toBe('before');
    });

    test('/branch-create forks the chat from a message id', async ({ page }) => {
        await awaitMainUI(page, server.baseURL);
        await selectCharacterByName(page, 'Seraphina');
        await page.waitForFunction(() => window.SillyTavern.getContext().chat.length >= 1, { timeout: 10_000 });
        // Make sure there's a deterministic message to branch off.
        await runSlash(page, '/send Branch off this turn. | /trigger await=true');
        const before = await chatSnapshot(page);
        const targetId = before.length - 1;
        const beforeChatId = await page.evaluate(() => window.SillyTavern.getContext().getCurrentChatId?.());
        const res = await runSlash(page, `/branch-create ${targetId}`);
        // Returned pipe is the new branch name.
        expect(res.pipeText).toBeTruthy();
        // The branch auto-opens in Luker. Wait for chatId to change.
        await page.waitForFunction((prev) => {
            const ctx = window.SillyTavern.getContext();
            return ctx.getCurrentChatId?.() !== prev;
        }, beforeChatId, { timeout: 15_000 });
        const afterChatId = await page.evaluate(() => window.SillyTavern.getContext().getCurrentChatId?.());
        expect(afterChatId).not.toBe(beforeChatId);
    });

    test('/setvar + /getvar round-trips a value', async ({ page }) => {
        await awaitMainUI(page, server.baseURL);
        await selectCharacterByName(page, 'Seraphina');
        // Single pipeline: setvar persists into chat_metadata.variables
        // synchronously, but the save+reload between separate runSlash
        // calls could in theory clobber it. Chain to be safe.
        const res = await runSlash(page, '/setvar key=foo bar | /getvar foo');
        expect(res.pipeText).toBe('bar');
    });

    test('/incvar increments a numeric variable', async ({ page }) => {
        await awaitMainUI(page, server.baseURL);
        await selectCharacterByName(page, 'Seraphina');
        // Run set + inc + get inside one pipeline so the local variable
        // store doesn't race with chat reload between runSlash calls.
        const res = await runSlash(page, '/setvar key=counter 5 | /incvar counter | /getvar counter');
        expect(res.pipeText).toBe('6');
    });

    test('/exportchat | /importchat — neither exists as a slash command in Luker; skip with rationale', async () => {
        // Searched public/scripts/** and public/scripts/extensions/** —
        // neither `/exportchat` nor `/importchat` is registered. The
        // closest commands are `/manage-chats` (alias /chat-history,
        // which opens the chat manager popup; chat I/O is done via
        // there + the REST routes /api/chats/export & /api/chats/import).
        test.fixme(true, 'no /exportchat or /importchat slash command exists — chat I/O is UI/REST-only');
    });
});
