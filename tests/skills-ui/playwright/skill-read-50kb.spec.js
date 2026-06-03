/**
 * Plan 3 Unit 7 — skill_read 50KB cap + offset continuation (#13).
 *
 * Scope:
 *   - Install a synthetic skill whose SKILL.md body is >50 KB. Each line is
 *     a distinct marker so we can verify all of them are retrievable across
 *     multiple offset reads.
 *   - Invoke the `skill_read` agent tool via ToolManager (the same entry the
 *     orchestrator runtime / sub-agents use). Verify the first response has
 *     `truncated: true` AND the content length is ≤ READ_HARD_CAP (50 KB).
 *   - Use the line-offset mechanism to continue reading the remainder.
 *     Concatenate the slices and verify EVERY marker line appears, proving
 *     no content was lost in the multi-read sequence.
 *
 * Tool contract (skill_read):
 *   - Args: { name, path?, offset?, limit? }. offset is a 1-based line
 *     number; limit is a line count.
 *   - Returns: { content, totalLines, truncated }. truncated=true means
 *     the slice was cut to fit READ_HARD_CAP; caller advances offset by
 *     the number of lines read and re-requests.
 *
 * Prerequisites:
 *   - Luker dev server running.
 *
 * Screenshots: docs/public/_screenshots/skills/skill-read-50kb-*.png.
 *
 * No LLM — purely tool invocation + content reassembly.
 */

import { test, expect } from '@playwright/test';
import fs from 'node:fs/promises';
import {
    SCREENSHOTS_DIR,
    screenshotPath,
    awaitMainUI,
    ensureSkillsApiAvailable,
    openSkillManagerPanel,
    buildSyntheticEmbed,
    cleanupSkill,
} from './helpers.js';

const FIXTURE_SKILL_NAME = 'pw-skill-read-50kb-fixture';
// Hard cap mirrored from src/skills/repository.js (READ_HARD_CAP = 50 KB).
// The spec is the contract test that says "the API obeys this cap" — pinning
// the number here surfaces accidental cap changes as a failed assertion.
const HARD_CAP = 50 * 1024;
// Body sizing: we want comfortably >50 KB so the first read clearly truncates,
// but small enough that the test stays fast (the multi-read loop is bounded
// by total content length). 200 KB → about 4 reads, each well-aligned to
// distinct marker lines.
const TARGET_BODY_BYTES = 200 * 1024;

test.describe('Skills: skill_read 50KB cap + offset continuation', () => {
    test.setTimeout(120_000);

    test.beforeAll(async () => {
        await fs.mkdir(SCREENSHOTS_DIR, { recursive: true });
    });

    test('First read truncates at 50KB; offset continuation retrieves every marker', async ({ page }) => {
        await awaitMainUI(page);
        await ensureSkillsApiAvailable(page);

        // Pre-clean residue from prior runs. The fixture lives in global
        // scope (skill_read's fallback resolver walks character → preset →
        // global, picking the first match — installing in global keeps the
        // spec independent of any active character).
        const targetScope = { kind: 'global' };
        await cleanupSkill(page, targetScope, FIXTURE_SKILL_NAME);

        // ── 1. Build a >50KB body with distinct marker lines ────────────
        // Each line: `MARKER-<padded-line-index> <padding to ~100 chars>`.
        // Total ≈ 200KB so the read pump must continue ≥3 more times after
        // the first truncated response. Padding keeps line lengths uniform
        // which makes the offset-arithmetic story easier to follow in docs.
        const lineWidth = 100;
        const lineCount = Math.ceil(TARGET_BODY_BYTES / (lineWidth + 1)); // +1 for \n
        const lines = [];
        for (let i = 0; i < lineCount; i++) {
            const marker = `MARKER-${String(i).padStart(6, '0')}`;
            const padding = '.'.repeat(Math.max(0, lineWidth - marker.length));
            lines.push(`${marker}${padding}`);
        }
        const body = lines.join('\n');
        // eslint-disable-next-line no-console
        console.log(`[skill-read-50kb] body bytes = ${Buffer.byteLength(body, 'utf8')}, lines = ${lineCount}`);
        expect(Buffer.byteLength(body, 'utf8'), 'body exceeds the 50KB cap').toBeGreaterThan(HARD_CAP);

        const payload = buildSyntheticEmbed({
            name: FIXTURE_SKILL_NAME,
            description: 'Large-body fixture (>50KB) exercising skill_read truncation + offset continuation.',
            bodyTail: body,
        });

        // Install the fixture.
        await page.evaluate(async ({ payload, scope }) => {
            const ctx = window.SillyTavern.getContext();
            await ctx.skills.executeExtractEmbed({
                payload, targetScope: scope, conflictStrategies: {},
            });
        }, { payload, scope: targetScope });

        // Screenshot 1: manager panel showing the fixture row (the size
        // column won't render the full >50KB number but the row is visible
        // proof the install landed).
        const panel = await openSkillManagerPanel(page);
        await page.screenshot({
            path: screenshotPath('skill-read-50kb', '1-fixture-installed'),
            fullPage: false,
        });
        await page.keyboard.press('Escape');
        await panel.waitFor({ state: 'detached', timeout: 5_000 }).catch(() => {});

        // ── 2. Direct first read via skill_read tool — expect truncated ─
        // `registerSkillAgentTools(ToolManager)` runs at script.js boot, so the
        // tool is on ToolManager's static registry. ToolManager itself isn't on
        // `window` (it's an ES-module export), so dynamic-import it inside the
        // page context. The tool returns the response payload as a JSON string;
        // parse it back.
        const firstReadRaw = await page.evaluate(async (name) => {
            const mod = await import('/scripts/tool-calling.js');
            const result = await mod.ToolManager.invokeFunctionTool('skill_read', { name });
            return typeof result === 'string' ? result : JSON.stringify(result);
        }, FIXTURE_SKILL_NAME);
        const firstRead = JSON.parse(firstReadRaw);
        expect(firstRead.truncated, 'first read truncated=true').toBe(true);
        expect(firstRead.content.length, 'first read content fits within 50KB cap')
            .toBeLessThanOrEqual(HARD_CAP);
        expect(typeof firstRead.totalLines, 'first read reports totalLines').toBe('number');
        // The frontmatter (---\nname:...) prepends 4-5 lines before the body
        // starts; the totalLines count should be at least our generated
        // line count.
        expect(firstRead.totalLines, 'totalLines covers the full file').toBeGreaterThanOrEqual(lineCount);

        // ── 3. Offset continuation — read in slices until every marker
        //      we expected to find is accounted for. ─────────────────────
        //
        // Strategy: use a fixed line-count limit per read so the slice
        // arithmetic is deterministic. The truncation cap may still cut
        // a single slice short (200 lines * 101 bytes ≈ 20 KB per slice,
        // which fits comfortably under the 50KB cap), but the guard below
        // tolerates that too.
        const sliceLines = 200;
        const collectedMarkers = new Set();
        let offset = 1;
        let readsPerformed = 0;
        const maxReads = 30; // safety guard — should never approach this for a 200KB body
        while (offset <= firstRead.totalLines && readsPerformed < maxReads) {
            const sliceRaw = await page.evaluate(async ({ name, offset, sliceLines }) => {
                const mod = await import('/scripts/tool-calling.js');
                const result = await mod.ToolManager.invokeFunctionTool('skill_read', {
                    name, offset, limit: sliceLines,
                });
                return typeof result === 'string' ? result : JSON.stringify(result);
            }, { name: FIXTURE_SKILL_NAME, offset, sliceLines });
            const slice = JSON.parse(sliceRaw);

            // Bookkeeping — collect MARKER-NNNNNN tokens from this slice.
            const matches = String(slice.content || '').match(/MARKER-\d{6}/g) || [];
            for (const m of matches) collectedMarkers.add(m);

            // Advance offset by either the requested line count (when the
            // slice was untruncated) or by a conservative estimate when
            // truncated. For our sizing the slice fits, so the simple
            // path holds.
            offset += sliceLines;
            readsPerformed += 1;
        }
        // eslint-disable-next-line no-console
        console.log(`[skill-read-50kb] reads performed = ${readsPerformed}, markers collected = ${collectedMarkers.size}`);

        // Sanity: didn't hit the safety guard.
        expect(readsPerformed, 'multi-read loop converged below the safety cap').toBeLessThan(maxReads);

        // ── 4. Every marker must appear in the assembled set ───────────
        // Spot-check the first, middle, and last marker. Asserting on all
        // `lineCount` keys directly would explode the test runner's diff
        // when a single marker is missing — sampled checks plus the count
        // assertion give a clean, actionable error.
        const expectedFirst = `MARKER-${String(0).padStart(6, '0')}`;
        const expectedMiddle = `MARKER-${String(Math.floor(lineCount / 2)).padStart(6, '0')}`;
        const expectedLast = `MARKER-${String(lineCount - 1).padStart(6, '0')}`;
        expect(collectedMarkers.has(expectedFirst), `first marker (${expectedFirst}) retrieved`).toBe(true);
        expect(collectedMarkers.has(expectedMiddle), `middle marker (${expectedMiddle}) retrieved`).toBe(true);
        expect(collectedMarkers.has(expectedLast), `last marker (${expectedLast}) retrieved`).toBe(true);

        // Count-level assertion: every marker we generated must surface in
        // the collected set. A missing marker indicates a gap in the
        // offset-continuation arithmetic — the spec catches that, not the
        // sampled-three assertions above (which only catch the trivial
        // first/middle/last edge cases).
        const missingMarkers = [];
        for (let i = 0; i < lineCount; i++) {
            const m = `MARKER-${String(i).padStart(6, '0')}`;
            if (!collectedMarkers.has(m)) missingMarkers.push(m);
        }
        expect(missingMarkers, 'every marker line retrieved across multi-read').toHaveLength(0);

        // Visual proof: re-open the manager panel after the multi-read
        // sequence to confirm no UI mutation (read is non-destructive).
        const panel2 = await openSkillManagerPanel(page);
        await page.screenshot({
            path: screenshotPath('skill-read-50kb', '2-post-multi-read'),
            fullPage: false,
        });
        await page.keyboard.press('Escape');
        await panel2.waitFor({ state: 'detached', timeout: 5_000 }).catch(() => {});

        // ── 5. Teardown ─────────────────────────────────────────────────
        await cleanupSkill(page, targetScope, FIXTURE_SKILL_NAME);
    });
});
