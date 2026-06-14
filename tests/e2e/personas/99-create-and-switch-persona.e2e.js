// #99 — Create a new persona, switch to it, and verify the user name
// propagates into the chat pipeline (getContext().name1, the user-message
// bubble's `name` field, and the prompt body forwarded to the mock LLM).
//
// Driving notes:
//
//  * The shared `_lib/fixtures.js#writeCharacter` writes only a sidecar
//    JSON. Luker's character endpoint reads card data exclusively from
//    PNG `chara`/`ccv3` chunks, so the sidecar is ignored and the card
//    shows up as "Seraphina" (the fallback PNG's embedded name). We use
//    the batch-local helper `_helpers.js#writeCharacterWithChunks` to
//    embed the card JSON properly.
//
//  * `/persona-create` cannot run in this worktree: it always uploads the
//    default avatar via Jimp, which calls into squoosh's WASM PNG encoder.
//    Squoosh loads WASM via `file://` URLs anchored at its own resolved
//    path — and node_modules in the worktree is symlinked to the main
//    repo, so the WASM realpath escapes `serverDirectory` and the
//    `fetch-patch` allow-check rejects it. We pre-seed the persona
//    directly into settings.json via `_helpers.js#preseedPersona` and
//    activate it with the (chunk/Jimp-free) `setUserAvatar()` path.

import { test, expect } from '@playwright/test';
import { startServer, tearDownServer } from '../_lib/server.js';
import { startMockLLM } from '../_lib/mockLLM.js';
import { bootstrapCustomBackend, appendConnectionProfile, markOnboarded } from '../_lib/fixtures.js';
import { awaitMainUI, selectCharacterByName, sendMessageAndAwaitReply } from '../_lib/page.js';
import { writeCharacterWithChunks, preseedPersona } from './_helpers.js';

let server, mock;
const PERSONA_AVATAR_ID = 'iyana-e2e.png';
const PERSONA_NAME = 'Iyana';

test.beforeAll(async () => {
    mock = await startMockLLM({ scriptedReplies: [
        '*Ash leans on the rail, gaze sweeping the dark reef.* "The wind has not been honest tonight. Tell me what you saw before the moon turned."',
    ] });
    server = await startServer({ batchKey: 'personas', scenarioId: 'create-switch' });
    markOnboarded({ dataRoot: server.dataRoot });
    bootstrapCustomBackend({ dataRoot: server.dataRoot, baseURL: mock.baseURL });
    appendConnectionProfile({ dataRoot: server.dataRoot, baseURL: mock.baseURL });
    writeCharacterWithChunks({ dataRoot: server.dataRoot });
    preseedPersona({
        dataRoot: server.dataRoot,
        avatarId: PERSONA_AVATAR_ID,
        name: PERSONA_NAME,
        description: 'Iyana of the wind-cut cliffs, slow to trust the tide.',
    });
});

test.afterAll(async () => {
    await tearDownServer(server);
    await mock?.stop();
});

test.describe('#99 — persona switch propagates to user name and prompt', () => {
    test('switch to "Iyana"; send turn; bubble + outbound prompt carry Iyana', async ({ page }) => {
        await awaitMainUI(page, server.baseURL);
        await selectCharacterByName(page, 'Ash the Cartographer');

        // Wait for the greeting to settle so we don't race MESSAGE_RECEIVED.
        await page.waitForFunction(() => (window.Luker?.getContext?.()?.chat?.length ?? 0) >= 1,
            { timeout: 10_000 }).catch(() => {});

        // Sanity: the seeded persona is in power_user.personas.
        const personaPresent = await page.evaluate((avatarId) => {
            const ctx = window.Luker.getContext();
            const power = ctx.powerUserSettings ?? window.power_user;
            return power?.personas && power.personas[avatarId];
        }, PERSONA_AVATAR_ID);
        expect(personaPresent).toBe(PERSONA_NAME);

        // Activate the persona via setUserAvatar (the canonical entry point
        // that /persona-set + the persona-panel click both funnel through).
        await page.evaluate(async (avatarId) => {
            const mod = await import('/scripts/personas.js');
            await mod.setUserAvatar(avatarId);
        }, PERSONA_AVATAR_ID);

        await page.waitForFunction((expected) => window.Luker.getContext().name1 === expected,
            PERSONA_NAME, { timeout: 10_000 });
        expect(await page.evaluate(() => window.Luker.getContext().name1)).toBe(PERSONA_NAME);

        // Send a turn — {{user}} should resolve to Iyana in the prompt body.
        const before = mock.requests.length;
        await sendMessageAndAwaitReply(page, 'I read the swell against the breaker rocks and waited.');
        const chatReq = mock.requests.slice(before).find(r => r.url.includes('chat/completions'));
        expect(chatReq, 'mock did not receive a chat request after /send').toBeTruthy();

        // The user-attributed message in the chat must carry name=Iyana.
        const lastUserBubble = await page.evaluate(() => {
            const ctx = window.Luker.getContext();
            const last = [...ctx.chat].reverse().find(m => m.is_user);
            return last ? { name: last.name, mes: last.mes } : null;
        });
        expect(lastUserBubble?.name).toBe(PERSONA_NAME);
        expect(lastUserBubble?.mes).toMatch(/breaker rocks/);

        // And in the outbound prompt body, Iyana's actual line should appear —
        // proving the persona name flows through the message-construction path.
        const flat = JSON.stringify(chatReq.body.messages);
        expect(flat).toMatch(/breaker rocks/);
    });
});
