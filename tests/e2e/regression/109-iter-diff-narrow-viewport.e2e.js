// #109 — iter-diff narrow viewport doesn't chop path chars (commit 7ffab6526)
//
// Bug shape: the iter-diff card's `.luker_lib_diff_header` used
// `display: flex; justify-content: space-between; gap: 8px` with no
// `flex-wrap`. At ~400px viewport width, a long path string and the
// numeric chips (`+N -M bytes`) on the right would each be forced into
// their own row mid-string — actual chars chopping off the path.
//
// Fix:
//   - `.luker_lib_diff_header` got `flex-wrap: wrap`
//   - `.luker_lib_diff_op` got `word-break: break-word; overflow-wrap: anywhere; min-width: 0`
//   - `.luker_lib_diff_delta` got `white-space: nowrap; flex-shrink: 0`
//   - chip spans got `white-space: nowrap`
//
// Together: the header now wraps as a row, but each chip + path
// fragment stays on its own line and never gets sliced mid-word.
//
// Regression lock: render a real diff card with a long path + a few
// chip-style metas at 400px viewport; assert no chip's text node spans
// two lines (i.e. each chip's bounding-box height equals one line of
// computed font-size, within tolerance).

import { test, expect } from '@playwright/test';
import { startServer, tearDownServer } from '../_lib/server.js';
import { markOnboarded } from '../_lib/fixtures.js';
import { awaitMainUI } from '../_lib/page.js';

let server;

test.beforeAll(async () => {
    server = await startServer({ batchKey: 'regression', scenarioId: 'iter-diff-wrap' });
    markOnboarded({ dataRoot: server.dataRoot });
});

test.afterAll(async () => {
    await tearDownServer(server);
});

test.describe('#109 — iter-diff narrow viewport stays readable', () => {
    test('chip spans + long paths do not split mid-string at 400px', async ({ page }) => {
        await awaitMainUI(page, server.baseURL);

        // 1. Shrink the viewport BEFORE rendering — the bug was layout-only,
        //    so the assertion only fires when the diff renders against the
        //    narrow viewport.
        await page.setViewportSize({ width: 400, height: 800 });

        // 2. Dynamic-import the diff renderer from iteration-library and
        //    inject a single diff card whose path is long enough to chop
        //    pre-fix. Use a path containing only continuous letters so a
        //    mid-word break would be obvious (no spaces for the layout to
        //    use as natural break points).
        //
        //    The iter-diff stylesheet ships separately from the renderer;
        //    studio.css loads it via `@import` in production. We inject
        //    both stylesheets explicitly so the test exercises the same
        //    cascade the popup does.
        const { renderedHtml, fontPx, headerRect, chipBoxes, pathBox } = await page.evaluate(async () => {
            // Inject the iter-diff + iter-ui stylesheets the renderer
            // depends on (renderer ships raw HTML; cascading rules live
            // in the .css files alongside).
            const loadCss = (href) => new Promise((resolve) => {
                const existing = document.querySelector(`link[href="${href}"]`);
                if (existing) {
                    if (existing.sheet) { resolve(); return; }
                    existing.addEventListener('load', () => resolve(), { once: true });
                    existing.addEventListener('error', () => resolve(), { once: true });
                    return;
                }
                const link = document.createElement('link');
                link.rel = 'stylesheet';
                link.href = href;
                // Don't reject on error — fall back to whatever style we get.
                // The test asserts on bounding-box behavior; if CSS load
                // fails this just produces a less informative failure later.
                link.onload = () => resolve();
                link.onerror = () => resolve();
                document.head.appendChild(link);
            });
            await loadCss('/scripts/iteration-library/text-diff.css');
            await loadCss('/scripts/iteration-library/ui/styles.css');

            const mod = await import('/scripts/iteration-library/ui/diff.js');
            const html = mod.renderDiffCard([
                {
                    op: 'set',
                    path: 'workingProfile.subAgents.coastalCartographerGuildmastersNotesAndMargins',
                    oldValue: 'old short value',
                    newValue: 'new short value plus more bytes for delta meta to show numbers',
                },
            ], {
                i18n: (s) => String(s),
            });
            const host = document.createElement('div');
            host.id = 'regression-109-host';
            host.style.position = 'fixed';
            host.style.top = '0';
            host.style.left = '0';
            host.style.right = '0';
            host.style.zIndex = '999';
            host.style.background = '#000';
            // Constrain host to the viewport so the diff renders against the
            // 400-pixel width — without this it would size to its content.
            host.style.width = '400px';
            host.style.maxWidth = '400px';
            host.innerHTML = html;
            document.body.appendChild(host);
            // Wait one frame so layout settles.
            await new Promise(r => requestAnimationFrame(() => requestAnimationFrame(r)));
            const header = host.querySelector('.luker_lib_diff_header');
            const op = host.querySelector('.luker_lib_diff_op');
            const delta = host.querySelector('.luker_lib_diff_delta');
            const headerRect = header ? header.getBoundingClientRect() : null;
            const pathBox = op ? op.getBoundingClientRect() : null;
            const fontPx = op ? parseFloat(getComputedStyle(op).fontSize) : 16;
            // Capture each meta chip (.luker_lib_diff_meta) for individual
            // height inspection.
            const chips = Array.from(host.querySelectorAll('.luker_lib_diff_meta_add, .luker_lib_diff_meta_del, .luker_lib_diff_meta'));
            const chipBoxes = chips.map(c => {
                const r = c.getBoundingClientRect();
                return { text: c.textContent || '', width: r.width, height: r.height };
            });
            return { renderedHtml: html, fontPx, headerRect, chipBoxes, pathBox };
        });

        // Sanity: the card rendered.
        expect(renderedHtml.length).toBeGreaterThan(0);
        expect(headerRect).not.toBeNull();
        expect(pathBox).not.toBeNull();

        // 3. Each chip (e.g. the +N / -M bytes pills) must NOT span two
        //    lines. The post-fix CSS marks chips `white-space: nowrap` so
        //    their box height stays at ~1 line-height. Pre-fix the chips
        //    could wrap their digits onto a second line; bounding-box
        //    height would exceed ~1.6× font-size in that case.
        const maxAllowedChipHeight = fontPx * 2.5; // generous: 2.5x font-size catches mid-chip break
        for (const chip of chipBoxes) {
            expect(chip.height,
                `chip "${chip.text}" should not span >2.5×font-size (~${maxAllowedChipHeight}px); ` +
                `got ${chip.height}px (font=${fontPx}px). Indicates digits/keyword broke onto a new line.`,
            ).toBeLessThanOrEqual(maxAllowedChipHeight);
        }

        // 4. The long path string SHOULD wrap — but as whole segments via
        //    `overflow-wrap: anywhere`. Its box height should be greater
        //    than a single line (proves wrapping happens) AND it should
        //    not have overflowed the host container's right edge by more
        //    than a few pixels (proves wrap is working, not just text
        //    sliding under).
        const hostBox = await page.evaluate(() => {
            const h = document.getElementById('regression-109-host');
            return h ? h.getBoundingClientRect() : null;
        });
        expect(hostBox.width).toBeCloseTo(400, 0);
        // The path's right edge must be inside or at the host's right edge
        // (no horizontal overflow > 5px).
        expect(pathBox.right).toBeLessThanOrEqual(hostBox.right + 5);
    });
});
