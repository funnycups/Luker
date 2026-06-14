// #31 — Recursive activation boundaries
//
// Recursion: when WI activates entry A whose CONTENT contains the key
// of entry B, on the next scan pass B activates from A's content. Cap
// is controlled by world_info_max_recursion_steps (0 = unlimited).
//
// Scenarios:
//   (a) chain A → B: user mentions "ocean", A keys "ocean" and its content
//       mentions "tide", entry B keys "tide". Recursion enabled → both fire.
//   (b) recursion off (world_info_recursive=false): only A fires.
//   (c) max_recursion_steps=1 (or equivalent): only A fires (recursion
//       loop terminates after the initial pass).
//   (d) mutual A↔B (preventRecursion or cycle): no infinite loop, scan
//       terminates deterministically.

import { test, expect } from '@playwright/test';
import { startMockLLM } from '../_lib/mockLLM.js';
import { bootstrapCustomBackend, appendConnectionProfile, markOnboarded, writeWorldBook } from '../_lib/fixtures.js';
import { awaitMainUI, selectCharacterByName, sendMessageAndAwaitReply } from '../_lib/page.js';
import { writeCharacterWithBinding, startWorldInfoServer, tearDownWorldInfoServer } from './_helpers.js';

test.describe.configure({ mode: 'serial' });

let server, mock;

// A keys "ocean", content references "tide" so B can recurse off it
// B keys "tide" with distinct content marker
// C keys "lantern" (unused — proves untriggered entries stay out)
const RECURSION_ENTRIES = [
    {
        key: ['ocean'],
        comment: 'A-ocean-entry',
        content: 'RECURSION_A: The ocean off Bryn turns black on tide nights when the harbor bell rings hollow.',
        order: 100,
    },
    {
        key: ['tide'],
        comment: 'B-tide-entry',
        content: 'RECURSION_B: Tides in the eastern bay run a 19-day cycle; mariners track them by the carving on the harbor post.',
        order: 110,
    },
    {
        key: ['lantern'],
        comment: 'C-lantern-entry',
        content: 'RECURSION_C: Lantern oil for the Bryn light is rationed to one cask per fortnight.',
        order: 120,
    },
];

// Mutual cycle: A keys "alpha", content references "beta"; B keys "beta",
// content references "alpha". With recursion on, this should activate
// both but TERMINATE (no infinite loop).
const CYCLE_ENTRIES = [
    {
        key: ['alpha'],
        comment: 'cycle-alpha',
        content: 'CYCLE_ALPHA: Alpha leads to beta, the chart says.',
        order: 100,
    },
    {
        key: ['beta'],
        comment: 'cycle-beta',
        content: 'CYCLE_BETA: Beta leads to alpha, the chart says.',
        order: 110,
    },
];

test.beforeAll(async () => {
    mock = await startMockLLM({
        scriptedReplies: Array.from({ length: 12 }, (_, i) =>
            `*A reply, mapping winds against the dark.* Acknowledged (${i + 1}).`,
        ),
    });
    server = await startWorldInfoServer({ specBaseName: '31-recursive-activation', scenarioId: 'recursion-bounds' });
    markOnboarded({ dataRoot: server.dataRoot });
    bootstrapCustomBackend({ dataRoot: server.dataRoot, baseURL: mock.baseURL });
    appendConnectionProfile({ dataRoot: server.dataRoot, baseURL: mock.baseURL });

    writeWorldBook({ dataRoot: server.dataRoot, name: 'recursion-chain-book', entries: RECURSION_ENTRIES });
    writeWorldBook({ dataRoot: server.dataRoot, name: 'recursion-cycle-book', entries: CYCLE_ENTRIES });

    writeCharacterWithBinding({
        dataRoot: server.dataRoot,
        avatarFile: 'ash-recursion.png',
        name: 'Ash Recursion',
        worldBook: 'recursion-chain-book',
    });
    writeCharacterWithBinding({
        dataRoot: server.dataRoot,
        avatarFile: 'ash-cycle.png',
        name: 'Ash Cycle',
        worldBook: 'recursion-cycle-book',
    });
});

test.afterAll(async () => {
    await tearDownWorldInfoServer(server);
    await mock?.stop();
});

async function sendAndCaptureBody(page, text) {
    const before = mock.requests.length;
    await sendMessageAndAwaitReply(page, text);
    const newReqs = mock.requests.slice(before);
    const chatReq = newReqs.find(r => r.url.includes('chat/completions'));
    expect(chatReq, 'expected a chat-completion request after sending').toBeTruthy();
    return JSON.stringify(chatReq.body.messages);
}

async function settleFirstMes(page) {
    await page.waitForFunction(() => {
        const ctx = window.Luker.getContext();
        return Array.isArray(ctx.chat) && ctx.chat.length >= 1;
    }, { timeout: 10_000 }).catch(() => {});
}

test.describe('#31 — Recursive activation boundaries', () => {
    test('recursion on: A → B chain fires both entries', async ({ page }) => {
        await awaitMainUI(page, server.baseURL);
        await selectCharacterByName(page, 'Ash Recursion');
        await settleFirstMes(page);

        // Flip WI recursion on, no step cap. This mirrors the global
        // toggle the user clicks in the WI settings drawer.
        await page.evaluate(async () => {
            // Settings live on `power_user`/world-info module exports.
            const mod = await import('/scripts/world-info.js');
            const ctx = window.Luker.getContext();
            // Patch settings.json's world-info module by editing the
            // live setting (the values are stored in the module's let bindings,
            // updated via the settings drawer events).
            const settings = ctx.extensionSettings || {};
            // The recursion toggle is exposed on the window via the worldInfo settings binder;
            // do a runtime mutation by triggering the input.
            const recursiveInput = document.querySelector('#world_info_recursive');
            if (recursiveInput) {
                recursiveInput.checked = true;
                recursiveInput.dispatchEvent(new Event('input'));
            }
            const stepsInput = document.querySelector('#world_info_max_recursion_steps');
            if (stepsInput) {
                stepsInput.value = '0';
                stepsInput.dispatchEvent(new Event('input'));
            }
        });

        const body = await sendAndCaptureBody(page, 'I watched the ocean from the cliff path until first light.');
        expect(body, 'A fires off "ocean" key').toContain('RECURSION_A');
        expect(body, 'B should recurse off A\'s content mentioning "tide"').toContain('RECURSION_B');
        expect(body, 'C should NOT fire — no lantern mention in user msg or A/B content').not.toContain('RECURSION_C');
    });

    test('recursion off: A fires but B does not', async ({ page }) => {
        await awaitMainUI(page, server.baseURL);
        await selectCharacterByName(page, 'Ash Recursion');
        await settleFirstMes(page);

        await page.evaluate(async () => {
            const recursiveInput = document.querySelector('#world_info_recursive');
            if (recursiveInput) {
                recursiveInput.checked = false;
                recursiveInput.dispatchEvent(new Event('input'));
            }
        });

        const body = await sendAndCaptureBody(page, 'I watched the ocean again, eyes still on the horizon line.');
        expect(body).toContain('RECURSION_A');
        expect(body, 'B should NOT fire — recursion is off, user msg does not contain "tide"').not.toContain('RECURSION_B');
    });

    test('max_recursion_steps=1 stops the chain after the initial pass', async ({ page }) => {
        await awaitMainUI(page, server.baseURL);
        await selectCharacterByName(page, 'Ash Recursion');
        await settleFirstMes(page);

        await page.evaluate(async () => {
            const recursiveInput = document.querySelector('#world_info_recursive');
            if (recursiveInput) {
                recursiveInput.checked = true;
                recursiveInput.dispatchEvent(new Event('input'));
            }
            const stepsInput = document.querySelector('#world_info_max_recursion_steps');
            if (stepsInput) {
                stepsInput.value = '1';
                stepsInput.dispatchEvent(new Event('input'));
            }
        });

        const body = await sendAndCaptureBody(page, 'I watched the ocean one more time, hoping to spot the southern sails.');
        expect(body).toContain('RECURSION_A');
        // max_recursion_steps=1 caps the recursion loop count at 1. The
        // initial scan (count=0) runs first, then if a recursion pass
        // is requested AND world_info_max_recursion_steps <= count, the
        // loop breaks. So with steps=1, after the first pass with
        // count incremented to 1, the recursion is gated off.
        expect(body, 'B should NOT recurse when max_recursion_steps=1 gates further recursion').not.toContain('RECURSION_B');
    });

    test('mutual cycle: terminates deterministically with both entries', async ({ page }) => {
        await awaitMainUI(page, server.baseURL);
        await selectCharacterByName(page, 'Ash Cycle');
        await settleFirstMes(page);

        await page.evaluate(async () => {
            const recursiveInput = document.querySelector('#world_info_recursive');
            if (recursiveInput) {
                recursiveInput.checked = true;
                recursiveInput.dispatchEvent(new Event('input'));
            }
            const stepsInput = document.querySelector('#world_info_max_recursion_steps');
            if (stepsInput) {
                stepsInput.value = '0'; // unlimited; entries-already-activated guard should still terminate
                stepsInput.dispatchEvent(new Event('input'));
            }
        });

        // Race a deterministic termination: the test should complete in
        // well under 60s. If it hangs, the cycle protection regressed.
        const body = await sendAndCaptureBody(page, 'The chart begins at alpha, which is what the keeper said to study first.');
        expect(body).toContain('CYCLE_ALPHA');
        expect(body, 'beta should activate via recursion from alpha\'s content').toContain('CYCLE_BETA');
        // Because both entries activate exactly once and stay in
        // allActivatedEntries, the recursion loop terminates without
        // re-triggering the same entries — the cycle is safe.
    });
});
