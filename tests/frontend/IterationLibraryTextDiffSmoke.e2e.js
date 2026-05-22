// tests/frontend/IterationLibraryTextDiffSmoke.e2e.js
//
// Verifies the iteration-library text-diff renderer works end-to-end in
// the real browser against the real lazy-loaded stylesheet:
//
//   1. `str_replace`-style diff against a Seraphina-length description
//      — mirrors the path CEA Character's renderPendingEditCard takes
//      when the live snapshot is primed.
//   2. JSON before/after diff for an orchestrator-style bulk set edit
//      — mirrors the path orchestrator's renderPendingEditCard takes.
//
// Assertions cover the contract the four plugin popups rely on
// (stylesheet lazy-injection works, rendered HTML carries the
// luker_lib_diff_* classes, mod rows + word-level highlights surface
// for the long-string path, EQ rows preserve surrounding context).
//
// When DIFF_DEMO_SCREENSHOT_DIR is set, also drops a full-page
// screenshot per case — used by the spec's "verify the new diff shows
// context surrounding the find/replace" check.

import { test, expect } from '@playwright/test';

const SERAPHINA_DESCRIPTION = `Seraphina is the ancient guardian of the Whispering Woods. Her long flowing emerald hair cascades down her shoulders, framing a face of ethereal beauty. Eyes like liquid gold shine with wisdom and warmth, mirroring the dappled sunlight filtering through the leaves. Adorned in flowing white silken robes, intricately embroidered with silver leaves and vines, she carries an aura of grace and serenity. She is barefoot, and beautiful jewelry adorns her neck and arms.

Seraphina is a gentle and nurturing soul. She possesses a deep connection to nature, understanding the language of plants and animals. Wise and compassionate, she offers guidance and solace to those who seek her, often speaking in riddles and metaphors drawn from the natural world. Though kind, she is fiercely protective of her forest and its inhabitants, and will not hesitate to defend them.`;

const SCREENSHOT_DIR = process.env.DIFF_DEMO_SCREENSHOT_DIR || '';

async function awaitMainUI(page) {
    // Mirror the user-select / preloader gate from
    // IterationLibraryExposure.e2e.js — handles both the "click to
    // choose user" path and the auto-login path.
    const gate = page.locator('#userList .userSelect:last-child');
    try {
        await gate.waitFor({ state: 'visible', timeout: 2000 });
        await gate.click();
    } catch { /* auto-login path */ }
    await page.waitForFunction('document.getElementById("preloader") === null', { timeout: 0 });
    await page.waitForFunction(() => Boolean(window.SillyTavern?.getContext), { timeout: 30000 });
}

test.describe('iteration-library text-diff renderer — real-browser smoke', () => {
    test('str_replace on a long field surfaces a side-by-side diff with context', async ({ page }) => {
        await page.goto('/', { waitUntil: 'domcontentloaded' });
        await awaitMainUI(page);

        // Render the library diff into a host element. This exercises the
        // same renderer the four popups invoke (CEA Character / CPA /
        // MG Schema / Orchestrator), in the real browser, with the real
        // stylesheet — but without spinning up a fake LLM round-trip.
        const result = await page.evaluate(async ({ description }) => {
            const lib = window.SillyTavern.getContext().iterationLibrary;
            if (!lib?.textDiff?.renderInlineTextDiffHtml) {
                return { error: 'textDiff namespace missing from iterationLibrary' };
            }
            const findText = 'long flowing emerald hair';
            const replaceText = 'short cropped silver hair';
            const before = description;
            const after = before.replace(findText, replaceText);
            const html = lib.textDiff.renderInlineTextDiffHtml(before, after, {
                fileLabel: 'card.description (str_replace)',
                i18n: (s) => s,
            });

            const host = document.createElement('div');
            host.id = 'luker_lib_diff_demo_host';
            host.style.cssText = 'position:fixed; top:20px; left:20px; right:20px; bottom:20px; background:#1a1a1a; padding:32px; overflow:auto; z-index:99999;';
            host.innerHTML = html;
            const cover = document.createElement('div');
            cover.style.cssText = 'position:fixed; inset:0; background:#0a0a0a; z-index:99998;';
            document.body.appendChild(cover);
            document.body.appendChild(host);

            return {
                hasDetails: !!host.querySelector('details.luker_lib_diff'),
                modRowCount: host.querySelectorAll('.luker_lib_diff_row_mod').length,
                eqRowCount: host.querySelectorAll('.luker_lib_diff_row_eq').length,
                wordAdds: host.querySelectorAll('.luker_lib_diff_word_add').length,
                wordDels: host.querySelectorAll('.luker_lib_diff_word_del').length,
                stylesheetInjected: !!document.getElementById('luker_lib_diff_stylesheet'),
                stylesheetHref: document.getElementById('luker_lib_diff_stylesheet')?.getAttribute('href') || null,
            };
        }, { description: SERAPHINA_DESCRIPTION });

        expect(result.error).toBeUndefined();
        expect(result.stylesheetInjected).toBe(true);
        expect(result.stylesheetHref).toBe('/scripts/iteration-library/text-diff.css');
        expect(result.hasDetails).toBe(true);
        // At least one mod row (the line containing the hair color change).
        expect(result.modRowCount).toBeGreaterThanOrEqual(1);
        // Both word-level highlights present.
        expect(result.wordAdds).toBeGreaterThanOrEqual(1);
        expect(result.wordDels).toBeGreaterThanOrEqual(1);
        // Unchanged lines surrounding the change render as EQ rows —
        // this is the whole point of the IDE-style diff: the user sees
        // *where* in the description the change happens.
        expect(result.eqRowCount).toBeGreaterThanOrEqual(2);

        if (SCREENSHOT_DIR) {
            await page.waitForFunction(() => {
                const link = document.getElementById('luker_lib_diff_stylesheet');
                return link && link.sheet;
            }, { timeout: 10000 });
            await page.waitForTimeout(200);
            await page.screenshot({ path: `${SCREENSHOT_DIR}/str-replace-diff.png`, fullPage: true });
        }
    });

    test('orchestrator-style JSON profile bulk-set surfaces a multi-line LCS diff', async ({ page }) => {
        await page.goto('/', { waitUntil: 'domcontentloaded' });
        await awaitMainUI(page);

        const result = await page.evaluate(async () => {
            const lib = window.SillyTavern.getContext().iterationLibrary;
            const before = {
                modules: ['greet', 'memory', 'world'],
                params: { temperature: 0.7, top_p: 0.95 },
                system_prompt: 'You are a thoughtful narrator. Stay in character.',
            };
            const after = {
                modules: ['greet', 'world', 'reflection'],
                params: { temperature: 0.85, top_p: 0.95 },
                system_prompt: 'You are a thoughtful narrator. Stay in character and lean into sensory detail.',
            };
            const html = lib.textDiff.renderInlineTextDiffHtml(
                JSON.stringify(before, null, 2),
                JSON.stringify(after, null, 2),
                { fileLabel: 'working profile', i18n: (s) => s },
            );
            const host = document.createElement('div');
            host.id = 'luker_lib_diff_demo_host';
            host.style.cssText = 'position:fixed; top:20px; left:20px; right:20px; bottom:20px; background:#1a1a1a; padding:32px; overflow:auto; z-index:99999;';
            host.innerHTML = html;
            const cover = document.createElement('div');
            cover.style.cssText = 'position:fixed; inset:0; background:#0a0a0a; z-index:99998;';
            document.body.appendChild(cover);
            document.body.appendChild(host);
            return {
                modRowCount: host.querySelectorAll('.luker_lib_diff_row_mod').length,
                addRowCount: host.querySelectorAll('.luker_lib_diff_row_add').length,
                delRowCount: host.querySelectorAll('.luker_lib_diff_row_del').length,
                eqRowCount: host.querySelectorAll('.luker_lib_diff_row_eq').length,
            };
        });

        // Multiple changes across the JSON — exactly which combination
        // is mod vs add vs del depends on the LCS coalesce. What matters
        // is the renderer surfaces changes AND keeps untouched lines
        // (closing braces, unchanged keys) as eq rows for context.
        expect(result.modRowCount + result.addRowCount + result.delRowCount).toBeGreaterThanOrEqual(2);
        expect(result.eqRowCount).toBeGreaterThanOrEqual(2);

        if (SCREENSHOT_DIR) {
            await page.waitForFunction(() => {
                const link = document.getElementById('luker_lib_diff_stylesheet');
                return link && link.sheet;
            }, { timeout: 10000 });
            await page.waitForTimeout(200);
            await page.screenshot({ path: `${SCREENSHOT_DIR}/json-profile-diff.png`, fullPage: true });
        }
    });
});
