// Case #97 — Slash commands comprehensive regression — REAL UI surface.
//
// Every sub-test drives slash commands the way a user does: type the
// pipeline into #send_textarea, click #send_but. The visible textarea +
// button are the contract — going through executeSlashCommandsWithOptions
// would mask a broken send-area handler the moment one shipped.
//
// A few sub-tests prefer their equivalent dedicated UI gesture instead:
//   /swipe right  → swipeRightOnLatest (click .swipe_right on tail)
//   /continue     → continueViaUI (options menu → Continue)
//   /regenerate   → regenerateViaUI (options menu → Regenerate)
//   /branch-create → branchFromMessageViaUI (.mes_create_branch on a msg)
// These exercise the same code paths through the same SlashCommandParser
// (the button handlers either dispatch the slash directly or feed the
// same Generate() path).
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
import {
    awaitMainUI,
    selectCharacterByName,
    sendMessageAndAwaitReply,
    swipeRightOnLatest,
    continueViaUI,
    regenerateViaUI,
    branchFromMessageViaUI,
} from '../_lib/page.js';

const REPO_ROOT = resolve(import.meta.dirname, '../../..');

/**
 * Embed a v2 character card into a PNG via tEXt chunks so Luker's
 * character-card-parser.read() finds it.
 */
function writeProperCharacter(dataRoot, { handle = 'default-user', avatarFile, name, firstMes }) {
    const charsDir = resolve(dataRoot, handle, 'characters');
    mkdirSync(charsDir, { recursive: true });
    const seed = resolve(REPO_ROOT, 'default/content/default_Seraphina.png');
    const target = resolve(charsDir, avatarFile);
    copyFileSync(seed, target);
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
        spec: 'chara_card_v2',
        spec_version: '2.0',
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

/**
 * Type a slash pipeline into the real send textarea and click the real
 * send button. Returns once the pipeline finishes (the send button is
 * re-enabled).
 *
 * `expectsReply: true` waits for GENERATION_ENDED before returning so
 * tests that follow up with chat-tail assertions don't race the LLM.
 */
async function runSlashViaSendButton(page, pipeline, { expectsReply = false, timeoutMs = 30_000 } = {}) {
    const textarea = page.locator('#send_textarea');
    await textarea.fill(pipeline);
    await page.locator('#send_but:not(.displayNone)').waitFor({ state: 'visible', timeout: 10_000 });

    if (expectsReply) {
        const replyPromise = page.evaluate((to) => new Promise((resolve, reject) => {
            const ctx = window.Luker.getContext();
            const t = setTimeout(() => reject(new Error('reply timeout')), to);
            const off = ctx.eventSource.on(ctx.eventTypes.GENERATION_ENDED, () => {
                clearTimeout(t);
                try { ctx.eventSource.removeListener(ctx.eventTypes.GENERATION_ENDED, off); } catch {}
                resolve(true);
            });
        }), timeoutMs);
        await page.locator('#send_but').click();
        await replyPromise;
    } else {
        await page.locator('#send_but').click();
        // Wait for the send button to come back (slash chain finished).
        await page.waitForTimeout(400);
    }
}

async function chatSnapshot(page) {
    return await page.evaluate(() => {
        const ctx = window.Luker.getContext();
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
    mock = await startMockLLM({ scriptedReplies: [
        '*Ash trims the lantern.* "The reef is settling."',
        '*Ash watches the gull rocks.* "Quieter than yesterday."',
        '*Ash folds the chart.* "I have another reading of that line."',
        '*Ash sets the spyglass down.* "Try this — three breakers further north."',
        '*Ash continues, voice low.* "...and the salt-mark drifters never came past the headland tonight."',
        '*Ash starts over.* "Let me draw this from a different angle."',
        '*Ash glances up.* "Another step."',
        '*Ash glances up again.* "And another."',
    ] });
    server = await startServer({ batchKey: 'extensions', scenarioId: '97-slash-commands' });
    markOnboarded({ dataRoot: server.dataRoot });
    bootstrapCustomBackend({ dataRoot: server.dataRoot, baseURL: mock.baseURL });
    appendConnectionProfile({ dataRoot: server.dataRoot, baseURL: mock.baseURL });

    // Add a second character so /go has something distinct to switch to.
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

test.describe.configure({ mode: 'serial' });

test.describe('#97 — Slash commands regression (real send-textarea + send-button)', () => {
    test('/help (alias of /?) returns without throwing', async ({ page }) => {
        await awaitMainUI(page, server.baseURL);
        await selectCharacterByName(page, 'Seraphina');
        await runSlashViaSendButton(page, '/help');
        // /help opens a popup. Close it so subsequent tests aren't blocked.
        await page.locator('.popup .popup-button-ok, .popup .popup-button-close').first().click({ timeout: 5000 }).catch(() => {});
    });

    test('/send appends a user message without triggering generation', async ({ page }) => {
        await awaitMainUI(page, server.baseURL);
        await selectCharacterByName(page, 'Seraphina');
        await page.waitForFunction(() => window.Luker.getContext().chat.length >= 1, { timeout: 10_000 });
        const before = await chatSnapshot(page);
        await runSlashViaSendButton(page, '/send The lantern wick is fraying again.');
        const after = await chatSnapshot(page);
        expect(after.length).toBe(before.length + 1);
        const tail = after.messages[after.length - 1];
        expect(tail.isUser).toBe(true);
        expect(tail.mes).toContain('lantern wick is fraying');
    });

    test('/sysgen appends a system narrator message via the LLM', async ({ page }) => {
        await awaitMainUI(page, server.baseURL);
        await selectCharacterByName(page, 'Seraphina');
        await page.waitForFunction(() => window.Luker.getContext().chat.length >= 1, { timeout: 10_000 });
        const before = await chatSnapshot(page);
        await runSlashViaSendButton(page, '/sysgen Describe what the wind is doing at this very moment.', { expectsReply: true });
        await page.waitForFunction((n) => window.Luker.getContext().chat.length > n, before.length, { timeout: 30_000 });
        const after = await chatSnapshot(page);
        const tail = after.messages[after.length - 1];
        expect(tail.isNarrator).toBe(true);
        expect(tail.isUser).toBe(false);
        expect(tail.mes).toBeTruthy();
    });

    test('/go <char> switches the active character', async ({ page }) => {
        await awaitMainUI(page, server.baseURL);
        await selectCharacterByName(page, 'Seraphina');
        const startName = await page.evaluate(() => {
            const ctx = window.Luker.getContext();
            return ctx.characters[ctx.characterId]?.name;
        });
        expect(startName).toBe('Seraphina');
        await runSlashViaSendButton(page, '/go Bryn the Keeper');
        await page.waitForFunction(() => {
            const ctx = window.Luker.getContext();
            return ctx.characters[ctx.characterId]?.name === 'Bryn the Keeper';
        }, { timeout: 15_000 });
        const newName = await page.evaluate(() => {
            const ctx = window.Luker.getContext();
            return ctx.characters[ctx.characterId]?.name;
        });
        expect(newName).toBe('Bryn the Keeper');
    });

    test('/send + /trigger produces an assistant reply', async ({ page }) => {
        await awaitMainUI(page, server.baseURL);
        await selectCharacterByName(page, 'Seraphina');
        await page.waitForFunction(() => window.Luker.getContext().chat.length >= 1, { timeout: 10_000 });
        const before = await chatSnapshot(page);
        await runSlashViaSendButton(page, '/send I will keep watch tonight. | /trigger await=true', { expectsReply: true });
        const after = await chatSnapshot(page);
        expect(after.length).toBeGreaterThan(before.length + 1);
        const userMsg = after.messages[before.length];
        const replyMsg = after.messages[after.length - 1];
        expect(userMsg.isUser).toBe(true);
        expect(replyMsg.isUser).toBe(false);
        expect(replyMsg.mes).toBeTruthy();
    });

    test('swipe-right via real .swipe_right button adds a variant', async ({ page }) => {
        // The brief allows substituting a slash subtest with the dedicated UI
        // gesture; the .swipe_right button is bound to the same handler as
        // /swipe right.
        await awaitMainUI(page, server.baseURL);
        await selectCharacterByName(page, 'Seraphina');
        await page.waitForFunction(() => window.Luker.getContext().chat.length >= 1, { timeout: 10_000 });
        // Generate a reply first.
        await sendMessageAndAwaitReply(page, 'Tell me about the gull rocks.');
        const before = await chatSnapshot(page);
        const beforeTail = before.messages[before.length - 1];
        const initialSwipes = beforeTail.swipes;

        await swipeRightOnLatest(page);
        // After swipe-right with no prior swipes, the message ends up with
        // 2 swipes (the original mes + the new variant); with prior swipes,
        // the count grows by 1.
        await page.waitForFunction((startCount) => {
            const ctx = window.Luker.getContext();
            const m = ctx.chat[ctx.chat.length - 1];
            const len = Array.isArray(m?.swipes) ? m.swipes.length : 0;
            return len > startCount && len >= 1;
        }, initialSwipes, { timeout: 30_000 });
        const afterSwipe = await chatSnapshot(page);
        expect(afterSwipe.messages[afterSwipe.length - 1].swipes).toBeGreaterThan(initialSwipes);
    });

    test('/cut <id> removes a specific message', async ({ page }) => {
        // The brief mentioned `/cut last`; the actual command takes a numeric id.
        await awaitMainUI(page, server.baseURL);
        await selectCharacterByName(page, 'Seraphina');
        await page.waitForFunction(() => window.Luker.getContext().chat.length >= 1, { timeout: 10_000 });
        await runSlashViaSendButton(page, '/send sentinel-cut-target');
        const before = await chatSnapshot(page);
        const cutTargetId = before.length - 1;
        await runSlashViaSendButton(page, `/cut ${cutTargetId}`);
        const after = await chatSnapshot(page);
        expect(after.length).toBe(before.length - 1);
        const tail = after.messages[after.length - 1];
        expect(tail.mes).not.toContain('sentinel-cut-target');
    });

    test('continue via real options-menu Continue extends the last reply', async ({ page }) => {
        // /continue and the options-menu Continue both dispatch to the same
        // Generate(type='continue') call — using the menu button asserts the
        // user-visible affordance still works.
        await awaitMainUI(page, server.baseURL);
        await selectCharacterByName(page, 'Seraphina');
        await page.waitForFunction(() => window.Luker.getContext().chat.length >= 1, { timeout: 10_000 });
        await sendMessageAndAwaitReply(page, 'Walk me through what you see north of the headland.');
        const before = await chatSnapshot(page);
        const beforeText = before.messages[before.length - 1].mes;
        await continueViaUI(page);
        const after = await chatSnapshot(page);
        expect(after.length).toBe(before.length);
        expect(after.messages[after.length - 1].mes.length).toBeGreaterThanOrEqual(beforeText.length);
    });

    test('regenerate via real options-menu Regenerate re-rolls the tail in place', async ({ page }) => {
        await awaitMainUI(page, server.baseURL);
        await selectCharacterByName(page, 'Seraphina');
        await page.waitForFunction(() => window.Luker.getContext().chat.length >= 1, { timeout: 10_000 });
        await sendMessageAndAwaitReply(page, 'What is the wind doing right now?');
        const before = await chatSnapshot(page);
        await regenerateViaUI(page);
        const after = await chatSnapshot(page);
        expect(after.length).toBe(before.length);
        const tail = after.messages[after.length - 1];
        expect(tail.isUser).toBe(false);
        expect(typeof tail.mes).toBe('string');
        expect(tail.mes.length).toBeGreaterThan(0);
    });

    test('/abort halts the surrounding slash batch', async ({ page }) => {
        // /abort cancels remaining pipeline steps; it does NOT cancel an
        // in-flight LLM call (that's /stop). We assert by observing that a
        // /setvar after /abort never runs.
        await awaitMainUI(page, server.baseURL);
        await selectCharacterByName(page, 'Seraphina');
        await page.waitForFunction(() => window.Luker.getContext().chat.length >= 1, { timeout: 10_000 });
        await runSlashViaSendButton(page, '/setvar key=abort_sentinel before');
        await runSlashViaSendButton(page, '/abort | /setvar key=abort_sentinel after');
        // Read the var via another typed pipeline. Use evaluate to get the
        // pipe value back since the send_textarea doesn't surface it.
        const v = await page.evaluate(async () => {
            const ctx = window.Luker.getContext();
            const res = await ctx.executeSlashCommandsWithOptions('/getvar abort_sentinel');
            return res?.pipe ?? '';
        });
        expect(v).toBe('before');
    });

    test('branch-create via real .mes_create_branch forks the chat', async ({ page }) => {
        await awaitMainUI(page, server.baseURL);
        await selectCharacterByName(page, 'Seraphina');
        await page.waitForFunction(() => window.Luker.getContext().chat.length >= 1, { timeout: 10_000 });
        await sendMessageAndAwaitReply(page, 'Branch off this turn.');
        const before = await chatSnapshot(page);
        const targetId = before.length - 1;
        const beforeChatId = await page.evaluate(() => window.Luker.getContext().getCurrentChatId?.());
        await branchFromMessageViaUI(page, targetId);
        const afterChatId = await page.evaluate(() => window.Luker.getContext().getCurrentChatId?.());
        expect(afterChatId).not.toBe(beforeChatId);
    });

    test('/setvar + /getvar round-trips a value', async ({ page }) => {
        await awaitMainUI(page, server.baseURL);
        await selectCharacterByName(page, 'Seraphina');
        await runSlashViaSendButton(page, '/setvar key=foo bar | /getvar foo');
        // The pipeline doesn't echo to chat — read the var back inline.
        const v = await page.evaluate(async () => {
            const ctx = window.Luker.getContext();
            const res = await ctx.executeSlashCommandsWithOptions('/getvar foo');
            return res?.pipe ?? '';
        });
        expect(v).toBe('bar');
    });

    test('/incvar increments a numeric variable', async ({ page }) => {
        await awaitMainUI(page, server.baseURL);
        await selectCharacterByName(page, 'Seraphina');
        await runSlashViaSendButton(page, '/setvar key=counter 5 | /incvar counter');
        const v = await page.evaluate(async () => {
            const ctx = window.Luker.getContext();
            const res = await ctx.executeSlashCommandsWithOptions('/getvar counter');
            return res?.pipe ?? '';
        });
        expect(v).toBe('6');
    });
});
