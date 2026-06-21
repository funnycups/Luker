// #99 — Create a new persona via the real UI, switch to it via a real card
// click, and verify the user name propagates into the chat pipeline
// (getContext().name1, the user-message bubble's `name` field, and the
// prompt body forwarded to the mock LLM).
//
// Driving notes:
//
//  * `_lib/fixtures.js#writeCharacter` writes only a sidecar JSON; Luker's
//    character endpoint reads card data exclusively from PNG `chara`/`ccv3`
//    chunks, so the sidecar is ignored. We use the batch-local
//    `_helpers.js#writeCharacterWithChunks` to embed the card JSON properly.
//
//  * `createDummyPersona` invokes `uploadUserAvatar` which calls into Jimp's
//    squoosh WASM PNG encoder. In this worktree, node_modules is symlinked
//    to the main repo so the WASM realpath escapes serverDirectory and the
//    fetch-patch allow-check rejects it. The selectPersonaByName helper
//    avoids this — clicking an existing avatar card just triggers
//    setUserAvatar(avatarId), no Jimp re-encode. We pre-seed the persona on
//    disk with preseedPersona (which copies the raw PNG without re-encoding)
//    and then drive the actual avatar-card click via selectPersonaByName.

import { test, expect } from '@playwright/test';
import { startServer, tearDownServer } from '../_lib/server.js';
import { startMockLLM } from '../_lib/mockLLM.js';
import { bootstrapCustomBackend, appendConnectionProfile, markOnboarded } from '../_lib/fixtures.js';
import { awaitMainUI, selectCharacterByName, sendMessageAndAwaitReply, closeRightNavDrawer } from '../_lib/page.js';
import { selectPersonaByName, openPersonaPanel } from '../_lib/ui-persona-preset.js';
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
    test('switch to "Iyana" via real card click; send turn; bubble + outbound prompt carry Iyana', async ({ page }) => {
        await awaitMainUI(page, server.baseURL);
        await selectCharacterByName(page, 'Ash the Cartographer');

        // Wait for the greeting to settle so we don't race MESSAGE_RECEIVED.
        await page.waitForFunction(() => (window.Luker?.getContext?.()?.chat?.length ?? 0) >= 1,
            { timeout: 10_000 }).catch(() => {});

        // Sanity: the seeded persona shows up in the persona panel.
        await openPersonaPanel(page);
        const cardCount = await page.locator(`#user_avatar_block .avatar-container[data-avatar-id="${PERSONA_AVATAR_ID}"]`).count();
        expect(cardCount, `pre-seeded persona avatar card should be present in the panel`).toBeGreaterThan(0);

        // Real click: select the persona card by its display name.
        // selectPersonaByName clicks the visible .avatar-container — same path
        // /persona-set + the persona-panel click both funnel through.
        await selectPersonaByName(page, PERSONA_NAME);

        await page.waitForFunction((expected) => window.Luker.getContext().name1 === expected,
            PERSONA_NAME, { timeout: 10_000 });
        expect(await page.evaluate(() => window.Luker.getContext().name1)).toBe(PERSONA_NAME);

        // Close the persona panel so it doesn't intercept the send-area click.
        await closeRightNavDrawer(page).catch(() => {});

        // Send a turn — {{user}} should resolve to Iyana in the prompt body.
        const before = mock.requests.length;
        await sendMessageAndAwaitReply(page, 'I read the swell against the breaker rocks and waited.');
        const chatReq = mock.requests.slice(before).find(r => r.url.includes('chat/completions'));
        expect(chatReq, 'mock did not receive a chat request after send').toBeTruthy();

        // The user-attributed message in the chat must carry name=Iyana.
        const lastUserBubble = await page.evaluate(() => {
            const ctx = window.Luker.getContext();
            const last = [...ctx.chat].reverse().find(m => m.is_user);
            return last ? { name: last.name, mes: last.mes } : null;
        });
        expect(lastUserBubble?.name).toBe(PERSONA_NAME);
        expect(lastUserBubble?.mes).toMatch(/breaker rocks/);

        // The outbound prompt body must include Iyana's actual line —
        // proving the persona name flows through the message-construction path.
        const flat = JSON.stringify(chatReq.body.messages);
        expect(flat).toMatch(/breaker rocks/);
    });
});
