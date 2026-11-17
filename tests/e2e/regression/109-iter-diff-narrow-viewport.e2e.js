// #109 — iter-diff card stays readable at 400px viewport (commit 7ffab6526)
//
// Bug shape: at narrow viewports the iter-diff header used flex with no
// wrap; long path strings and the +N/-M chips would each be forced onto
// their own row mid-string, chopping chars off the path.
//
// Fix: `.luker_lib_diff_header` got `flex-wrap: wrap`; chip spans got
// `white-space: nowrap`; path text got `overflow-wrap: anywhere`.
//
// REAL USER FLOW: open the orchestrator iter-studio popup at 400px
// viewport, script the LLM to emit a profile-edit tool call (the kind
// the runtime renders via `renderDiffCard`), and assert the diff card
// fits inside the 400-pixel popup body without horizontal overflow and
// without any chip splitting onto two lines.

import { test, expect } from '@playwright/test';
import { startServer, tearDownServer } from '../_lib/server.js';
import { startMockLLM } from '../_lib/mockLLM.js';
import { bootstrapCustomBackend, appendConnectionProfile, markOnboarded } from '../_lib/fixtures.js';
import { awaitMainUI } from '../_lib/page.js';
import { openIterStudio, sendIterPrompt } from '../_lib/ui-iter-studio.js';
import { setOrchMode, setOrchEnabled } from '../_lib/ui-workbench.js';

let server, mock;

const VERY_LONG_PROMPT = '*You are Ash, cartographer of the Bryn headland, a brine-bitten coast keeper who reads the reef like a slow ledger.* '
    + 'Hold an immersive register and close every turn with a tactile sense beat — the verdigris on the spyglass, the cold of the lantern bezel, the salt-grit of the rail under a palm.';

test.beforeAll(async () => {
    mock = await startMockLLM();
    server = await startServer({ batchKey: 'regression', scenarioId: '109-iter-diff-narrow', extraConfig: { 'storage.mode': 'fs' } });
    markOnboarded({ dataRoot: server.dataRoot });
    bootstrapCustomBackend({ dataRoot: server.dataRoot, baseURL: mock.baseURL });
    appendConnectionProfile({ dataRoot: server.dataRoot, baseURL: mock.baseURL });
});

test.afterAll(async () => {
    await tearDownServer(server);
    await mock?.stop();
});

async function setOrchModeToDirector(page) {
    await setOrchMode(page, 'director');
    await setOrchEnabled(page, true);
}

async function openOrchIterStudio(page) {
    await openIterStudio(page, 'orch', { scope: 'global' });
}

async function sendOrchIterPromptAndAwaitProposal(page, text) {
    await sendIterPrompt(page, 'orch', text);
}

test.describe('#109 — iter-diff card stays readable at narrow viewport', () => {
    test('diff card chips and label do not overflow a 400px viewport Workbench window', async ({ page }) => {
        await awaitMainUI(page, server.baseURL);
        await setOrchModeToDirector(page);

        await page.setViewportSize({ width: 400, height: 800 });

        mock.scriptToolCall({
            name: 'luker_orch_set_director_main_agent',
            arguments: { systemPrompt: VERY_LONG_PROMPT },
        });

        await openOrchIterStudio(page);
        await sendOrchIterPromptAndAwaitProposal(page, 'Update the director main agent to take the voice of Ash.');

        const win = page.locator('.wbench .wb-win').first();
        const card = win.locator('.wb-chg.is-pending').first();
        await card.waitFor({ state: 'visible', timeout: 15_000 });

        await page.evaluate(async () => {
            await new Promise(r => requestAnimationFrame(() => requestAnimationFrame(r)));
        });

        const measurements = await win.evaluate((root) => {
            const container = root.querySelector('.wb-chat-body') || root;
            const cardEl = root.querySelector('.wb-chg.is-pending');
            const op = cardEl?.querySelector('.wb-chg-label');
            const chips = Array.from(cardEl?.querySelectorAll('.wb-chg-tag') || []);
            const fontPx = op ? parseFloat(getComputedStyle(op).fontSize) : 13;
            const winRect = container.getBoundingClientRect();
            const cardRect = cardEl?.getBoundingClientRect();
            const opRect = op?.getBoundingClientRect();
            return {
                popup: winRect ? { left: winRect.left, right: winRect.right, width: winRect.width } : null,
                card: cardRect ? { left: cardRect.left, right: cardRect.right, width: cardRect.width } : null,
                op: opRect ? { left: opRect.left, right: opRect.right, height: opRect.height } : null,
                chips: chips.map(c => {
                    const r = c.getBoundingClientRect();
                    return { text: c.textContent || '', width: r.width, height: r.height, right: r.right };
                }),
                fontPx,
            };
        });

        expect(measurements.card, 'diff card must mount in Workbench').not.toBeNull();
        expect(measurements.op, 'diff label must render').not.toBeNull();

        const maxChipHeight = measurements.fontPx * 2.5;
        for (const chip of measurements.chips) {
            expect(chip.height,
                `chip "${chip.text}" should not exceed ${maxChipHeight}px (~2.5×font); got ${chip.height}px at font=${measurements.fontPx}px`,
            ).toBeLessThanOrEqual(maxChipHeight);
        }

        expect(measurements.card.right,
            `diff card right=${measurements.card.right} must be inside Workbench chat body right=${measurements.popup.right} at 400px viewport`,
        ).toBeLessThanOrEqual(measurements.popup.right + 6);
    });
});
