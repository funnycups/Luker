/**
 * Live-LLM Run Panel e2e — Stage 6 of the orchestrator Run Panel refactor.
 *
 * Drives a real director-mode dispatch through the production send button
 * with a real LLM and watches the Run Panel as it streams. Verifies:
 *   - the panel auto-opens on RUN_STARTED,
 *   - section <pre>s grow incrementally as the stream lands,
 *   - the run reaches `committed` and the final text byte-equals the chat
 *     bubble that was inserted into #chat,
 *   - no `### [main-N]` reasoning-fold heading leaks into the bubble
 *     (i.e. the reasoning is kept inside the panel section, not pasted
 *     into the user-visible message),
 *   - on a narrow viewport the panel mounts with data-layout="drawer".
 *
 * Why real LLM (not mock):
 *   The contract under test is "the panel reflects what the runner emits
 *   during a real generation and the committed text matches the bubble".
 *   Stubbing the runner / chunk stream would assert on synthetic
 *   behavior — the same behavior the unit tests already cover. The point
 *   of this spec is to catch the cases where the runner's writes to the
 *   store no longer line up with the production send flow.
 *
 * Environment requirements (mirror critic-regex-search.spec.js):
 *   - dev server running with a real connection profile reachable
 *     (online_status flips off `no_connection`),
 *   - data dir has at least one selectable character card.
 *   When either is missing the test skips with a precise reason.
 *
 * Screenshots land in docs/public/_screenshots/run-panel/ —
 * documentation-grade captures for the run-panel docs page.
 */

import { test, expect } from '@playwright/test';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { awaitMainUI } from './helpers.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, '..', '..', '..');
const RUN_PANEL_SCREENSHOTS = path.join(REPO_ROOT, 'docs', 'public', '_screenshots', 'run-panel');

// RP-immersive prompt. Per `feedback_docs_conventions`: doc-grade specs
// use scene-grounded, character-immersive content, NOT "say hi" / "test
// message" inputs. The line below establishes a quiet antechamber scene
// + a specific question the model has to address — natural fodder for
// director-mode reasoning and possibly a tool call.
const RP_PROMPT = '*She steps into the dim antechamber, voice barely above a whisper.* "Did the courier bring word of the northern garrison yet?"';

test.describe.configure({ retries: 0, mode: 'serial' });

test.describe('Orchestrator Run Panel — live LLM', () => {
    test.setTimeout(600_000);

    test.beforeAll(async () => {
        await fs.mkdir(RUN_PANEL_SCREENSHOTS, { recursive: true });
    });

    test('panel streams progress, commits final text 1:1 to chat bubble', async ({ page }) => {
        page.on('pageerror', err => console.warn(`[browser:error] ${err.message}`));

        await awaitMainUI(page);
        // First-run user dirs surface a blocking "Welcome to Luker!"
        // dialog with a "Save" button that locks the persona name. Any
        // /profile slash command issued behind that dialog hangs because
        // the executor's parser is gated by the modal. Dismiss it once.
        await dismissWelcomeDialogIfPresent(page);

        // ── 1. LLM connection gate ──────────────────────────────────────
        // PW_INCLUDE_INTEGRATION specs require a real LLM in the data
        // dir. Missing profile = setup bug, not a silent skip.
        const profile = await activateConnectionProfile(page);
        expect(profile, 'no usable connection profile reachable as online (configure one in Connection Manager or set LUKER_PLAYWRIGHT_PROFILE)').toBeTruthy();

        const llmReady = await page.evaluate(() => {
            const ctx = window.Luker?.getContext?.();
            const v = ctx?.onlineStatus ?? null;
            return Boolean(v) && String(v).toLowerCase() !== 'no_connection';
        });
        expect(llmReady, `connection profile "${profile}" activated but online_status is still no_connection`).toBe(true);

        // ── 2. Character gate ───────────────────────────────────────────
        const avatar = await ensureCharacterLoaded(page);
        expect(avatar, 'no loadable character in this data dir (need at least one card)').toBeTruthy();

        // ── 3. Orchestrator gate: enabled + director mode ───────────────
        await ensureOrchestratorEnabledDirectorMode(page);

        // ── 4. Clear store so we don't observe a stale run from a prior test
        await page.evaluate(async () => {
            const m = await import('/scripts/extensions/orchestrator/run-state/store.js');
            m.clearCurrentRun?.();
        });

        // ── 5. Send the RP prompt through the production input ─────────
        // Direct DOM mutation matches the path other live-LLM specs use
        // (top-bar widgets sometimes overlap the click region in
        // headless Chromium; dispatch is reliable in either case).
        await page.evaluate(async (prompt) => {
            const ta = document.getElementById('send_textarea');
            if (!ta) throw new Error('send_textarea not present in DOM');
            ta.value = prompt;
            ta.dispatchEvent(new Event('input', { bubbles: true }));
            ta.dispatchEvent(new Event('change', { bubbles: true }));
            const btn = document.getElementById('send_but');
            if (!btn) throw new Error('send_but not present in DOM');
            btn.click();
        }, RP_PROMPT);

        // ── 6. Panel auto-opens on RUN_STARTED ─────────────────────────
        const panel = page.locator('#luker-orch-run-panel');
        await expect(panel).toHaveAttribute('data-state', 'open', { timeout: 30_000 });
        await clearToasts(page);
        await page.screenshot({
            path: path.join(RUN_PANEL_SCREENSHOTS, '01-panel-initial.png'),
            fullPage: false,
        });

        // ── 7. Panel streaming — wait for ANY section <pre> to be
        //   non-empty, then confirm the total streamed bytes grow on a
        //   follow-up sample. We sum all <pre> lengths because the
        //   "first" section may legitimately be a Reasoning section the
        //   provider didn't populate (Anthropic doesn't always emit
        //   thinking tokens). What we assert is "the runner is writing
        //   to the panel" not "the literal first section has bytes".
        const totalPreBytes = async () => {
            const lens = await panel.locator('.section pre').evaluateAll(
                els => els.map(e => (e.textContent || '').length),
            );
            return lens.reduce((s, n) => s + n, 0);
        };
        await expect.poll(
            totalPreBytes,
            { timeout: 60_000, message: 'no section <pre> received a delta — runner never wrote to any section' },
        ).toBeGreaterThan(0);
        const len1 = await totalPreBytes();
        // Sample twice with a small gap to prove the stream grows (or at
        // least stays put — a non-streaming transport returns all bytes
        // at once so len2 == len1 is acceptable; what we reject is
        // "total length shrinks" which would mean sections were reset).
        await page.waitForTimeout(2_500);
        const len2 = await totalPreBytes();
        expect(len2, 'total section <pre> length must not shrink between samples (would indicate a reset)').toBeGreaterThanOrEqual(len1);
        await clearToasts(page);
        await page.screenshot({
            path: path.join(RUN_PANEL_SCREENSHOTS, '02-panel-streaming.png'),
            fullPage: false,
        });

        // ── 8. Wait for run to finish ─────────────────────────────────
        const finalState = await page.evaluate(async () => {
            const m = await import('/scripts/extensions/orchestrator/run-state/store.js');
            const settled = new Set(['committed', 'aborted', 'error']);
            const start = Date.now();
            const deadline = 540_000;
            while (Date.now() - start < deadline) {
                const s = m.getCurrentRun();
                if (s && settled.has(String(s.status || ''))) {
                    return JSON.parse(JSON.stringify(s, (k, v) => (k === 'abortFn' ? undefined : v)));
                }
                await new Promise(r => setTimeout(r, 1000));
            }
            return null;
        });

        expect(finalState, 'run never reached a terminal status before deadline').toBeTruthy();
        expect(finalState.status, 'run committed (no abort, no error)').toBe('committed');
        expect(typeof finalState.finalText === 'string' && finalState.finalText.length > 0, 'committed run wrote a non-empty finalText').toBe(true);

        // ── 8a. Auto-fold sanity: every completed round/section <details>
        //   must end up collapsed unless the user manually expanded it.
        //   Regression guard for the toggle-event race where programmatic
        //   `.open = true` during initial render fired toggle handlers
        //   that flagged every fresh round/section as "user-pinned",
        //   silently disabling auto-fold on terminal status.
        //   We didn't click anything in this test, so 0 open is expected.
        const openRoundCount = await panel.locator('.round > details[open]').count();
        expect(openRoundCount, 'no completed round <details> should remain open after a committed run').toBe(0);
        const openSectionCount = await panel.locator('.section > details[open]').count();
        expect(openSectionCount, 'no completed section <details> should remain open after a committed run').toBe(0);

        // ── 9. Chat bubble byte-equality with finalText ───────────────
        // The last assistant bubble's visible text must equal the
        // committed finalText. Both are .trim()ed to absorb trailing
        // newlines the renderer may strip.
        const lastBubble = page.locator('#chat .mes').last();
        const bubbleText = (await lastBubble.locator('.mes_text').innerText()).trim();
        expect(
            bubbleText,
            'last chat bubble text must equal state.finalText (1:1) — reasoning fold should not be pasted into the message body',
        ).toBe(String(finalState.finalText).trim());

        // ── 10. No `### [main-N]` reasoning heading leakage ───────────
        // The legacy reasoning-fold appended these inside the message.
        // The store-based panel keeps reasoning in its own section.
        const reasoningLeakCount = await lastBubble.locator('text=/### \\[main-/').count();
        expect(reasoningLeakCount, 'no `### [main-N]` reasoning-fold heading in the chat bubble (panel owns reasoning)').toBe(0);

        // ── 11. Screenshot 3: a tool call expanded if any was emitted ─
        const toolCalls = panel.locator('.section[data-kind="tool_call"]');
        if (await toolCalls.count() > 0) {
            // Ensure the first tool_call's <details> is open before the
            // screenshot. Each section's details is initially open per
            // render-incremental.js, but a manual collapse-all click
            // would close them — be explicit.
            const firstTool = toolCalls.first();
            const isOpen = await firstTool.locator('details').first().evaluate(el => el.open).catch(() => false);
            if (!isOpen) {
                await firstTool.locator('summary').first().click();
            }
            // Scroll the panel body so the expanded tool_call (with its
            // <pre> of args) is centered in the screenshot — otherwise 03
            // shows the same final-output frame as 04 and the two are
            // byte-identical.
            await firstTool.scrollIntoViewIfNeeded();
            await page.waitForTimeout(150);
            await clearToasts(page);
            await page.screenshot({
                path: path.join(RUN_PANEL_SCREENSHOTS, '03-panel-tool-expanded.png'),
                fullPage: false,
            });
        } else {
            // eslint-disable-next-line no-console
            console.log('[run-panel-live] no tool_call sections in this run; skipping screenshot 03');
        }

        // ── 12. Screenshot 4: final state ────────────────────────────
        // Scroll to the bottom so the final-output panel is visible — this
        // is the differentiator between 03 (tool call expanded mid-panel)
        // and 04 (final committed text at the bottom).
        await panel.locator('.panel-body').evaluate(el => { el.scrollTop = el.scrollHeight; });
        await page.waitForTimeout(150);
        await clearToasts(page);
        await page.screenshot({
            path: path.join(RUN_PANEL_SCREENSHOTS, '04-panel-final.png'),
            fullPage: false,
        });
    });

    test('drawer layout on narrow viewport', async ({ browser }) => {
        const context = await browser.newContext({ viewport: { width: 375, height: 812 } });
        const page = await context.newPage();
        try {
            await awaitMainUI(page);
            await dismissWelcomeDialogIfPresent(page);

            const profile = await activateConnectionProfile(page);
            expect(profile, 'no usable connection profile (setup integration env first)').toBeTruthy();
            const llmReady = await page.evaluate(() => {
                const ctx = window.Luker?.getContext?.();
                const v = ctx?.onlineStatus ?? null;
                return Boolean(v) && String(v).toLowerCase() !== 'no_connection';
            });
            expect(llmReady, 'connection profile activated but online_status no_connection').toBe(true);
            const avatar = await ensureCharacterLoaded(page);
            expect(avatar, 'no character available').toBeTruthy();
            await ensureOrchestratorEnabledDirectorMode(page);
            await page.evaluate(async () => {
                const m = await import('/scripts/extensions/orchestrator/run-state/store.js');
                m.clearCurrentRun?.();
            });
            await page.evaluate(async (prompt) => {
                const ta = document.getElementById('send_textarea');
                if (!ta) throw new Error('send_textarea not present in DOM');
                ta.value = prompt;
                ta.dispatchEvent(new Event('input', { bubbles: true }));
                ta.dispatchEvent(new Event('change', { bubbles: true }));
                const btn = document.getElementById('send_but');
                if (!btn) throw new Error('send_but not present in DOM');
                btn.click();
            }, RP_PROMPT);

            const panel = page.locator('#luker-orch-run-panel');
            await expect(panel).toHaveAttribute('data-state', 'open', { timeout: 30_000 });
            // On a 375-wide viewport (mobile-class), panel.js sets
            // data-layout="drawer" via matchMedia('(min-width: 1024px)').
            await expect(panel).toHaveAttribute('data-layout', 'drawer');
            // Wait for the runner to put at least one round + a section
            // <pre> with bytes into the drawer so the screenshot shows
            // actual content, not just the empty shell. Sum across all
            // <pre>s — the very first section may legitimately be empty
            // (Reasoning section that the provider didn't populate).
            await expect.poll(async () => {
                const lens = await panel.locator('.section pre').evaluateAll(
                    els => els.map(e => (e.textContent || '').length),
                );
                return lens.reduce((s, n) => s + n, 0);
            }, { timeout: 60_000, message: 'drawer never received streamed bytes' }).toBeGreaterThan(0);
            await clearToasts(page);
            // fullPage: false so the screenshot is anchored to the
            // viewport — fullPage: true would extend the capture past
            // the bottom-fixed drawer and leave it offscreen.
            await page.screenshot({
                path: path.join(RUN_PANEL_SCREENSHOTS, '05-panel-drawer.png'),
                fullPage: false,
            });
        } finally {
            await context.close();
        }
    });
});

// ─── Helpers (inlined; mirrors critic-regex-search.spec.js shape) ────────

/**
 * Dismiss any toastr notifications that may overlay the chat region.
 * Luker's chat-sync watchdog occasionally fires an "integrity drift,
 * auto-recovering" toast when a test rapidly clobbers chat state across
 * runs — harmless but it occludes the panel in screenshots. Best-effort:
 * if toastr isn't loaded or the toasts already cleared, this is a no-op.
 */
async function clearToasts(page) {
    await page.evaluate(() => {
        try { window.toastr?.clear?.(); } catch { /* ignore */ }
        document.querySelectorAll('#toast-container .toast').forEach(el => el.remove());
    }).catch(() => null);
}


/**
 * Dismiss the "Welcome to Luker!" first-run modal if it's present. The
 * modal blocks pointer events for everything behind it AND the slash-
 * command parser, so /profile activation hangs until the user clicks
 * the Save button (or the dialog is removed from the DOM).
 *
 * Idempotent: returns immediately if the dialog isn't there.
 */
async function dismissWelcomeDialogIfPresent(page) {
    const welcomeSave = page.locator('dialog:has(h3:has-text("Welcome to Luker!")) button:has-text("Save"), dialog:has(h3:has-text("Welcome to SillyTavern!")) button:has-text("Save")');
    try {
        await welcomeSave.first().waitFor({ state: 'visible', timeout: 2000 });
    } catch {
        return; // not present — nothing to dismiss
    }
    await welcomeSave.first().click({ force: true }).catch(() => null);
    // Wait for the dialog to detach so subsequent slash commands aren't
    // gated by its event lock.
    await page.waitForFunction(
        () => !document.querySelector('dialog:has(h3) [class*="popup-button"]')
            || !document.querySelector('dialog:has(h3:has-text("Welcome"))'),
        null,
        { timeout: 5000 },
    ).catch(() => null);
}

/**
 * Activate a real connection profile if one is configured. Returns the
 * profile name on success or '' when none usable. Verbatim copy of the
 * helper in critic-regex-search.spec.js to keep behavior identical.
 */
async function activateConnectionProfile(page) {
    // Short-circuit: if there are no connection-manager profiles in
    // settings at all, the dropdown waitForFunction below will burn
    // 30s for nothing. Probe the settings shape first (no DOM access).
    const hasAnyProfile = await page.evaluate(() => {
        const ctx = window.Luker?.getContext?.();
        const profiles = ctx?.extensionSettings?.connectionManager?.profiles;
        return Array.isArray(profiles) && profiles.length > 0;
    }).catch(() => false);
    if (!hasAnyProfile) return '';

    // The connection-manager extension initializes asynchronously after
    // awaitMainUI returns. Without this wait, the /profile activation
    // would operate on an empty dropdown and never trigger the load.
    try {
        await page.waitForFunction(
            () => Boolean(document.getElementById('connection_profiles')?.options?.length),
            { timeout: 30000 },
        );
    } catch {
        // Extension didn't initialize — fall through; the next probe
        // returns '' which the caller treats as "skip".
    }
    return await page.evaluate(async () => {
        const ctx = window.Luker?.getContext?.();
        if (!ctx) return '';
        const profiles = ctx.extensionSettings?.connectionManager?.profiles;
        if (!Array.isArray(profiles) || !profiles.length) return '';
        const pinned = (
            (typeof process !== 'undefined' && process.env?.LUKER_PLAYWRIGHT_PROFILE)
            || ''
        ).toLowerCase();
        const pick = profiles.find(p => pinned && String(p.name || '').toLowerCase() === pinned)
            || profiles.find(p => /claude|openai|gpt|gemini|anthropic/i.test(String(p.name || '')))
            || profiles[0];
        if (!pick?.name) return '';
        try {
            await ctx.SlashCommandParser.commands.profile?.callback?.({}, pick.name);
        } catch {
            await ctx.executeSlashCommandsWithOptions?.(`/profile ${pick.name}`).catch(() => null);
        }
        await new Promise(r => setTimeout(r, 1000));
        const ok = String(ctx.onlineStatus || '').toLowerCase();
        return (ok && ok !== 'no_connection') ? pick.name : '';
    });
}

/**
 * Ensure a character card is loaded. If one is already selected we
 * return its avatar; otherwise we activate the first available
 * character via the `/char <name>` slash command. Verbatim copy of the
 * helper in critic-regex-search.spec.js.
 */
async function ensureCharacterLoaded(page) {
    return await page.evaluate(async () => {
        const ctx = window.Luker?.getContext?.();
        if (!ctx) return '';
        const cur = ctx.characters?.[ctx.characterId];
        if (cur?.avatar) return String(cur.avatar);
        const list = Array.isArray(ctx.characters) ? ctx.characters : [];
        if (!list.length) return '';
        const first = list.find(c => c?.name && c?.avatar) || list.find(c => c?.avatar) || list[0];
        if (!first?.name) return '';
        try {
            await ctx.executeSlashCommandsWithOptions(`/char ${first.name}`);
            await new Promise(r => setTimeout(r, 500));
        } catch {
            const tile = document.querySelector(`#rm_print_characters_block [chid][bogus_folder='false']`)
                || document.querySelector(`#rm_print_characters_block [chid]`);
            if (tile && typeof tile.click === 'function') {
                tile.click();
                await new Promise(r => setTimeout(r, 250));
            }
        }
        const reload = ctx.characters?.[ctx.characterId];
        return String(reload?.avatar || first.avatar || '');
    });
}

/**
 * Ensure the orchestrator extension is enabled AND its executionMode is
 * 'director'. The main settings live at
 * `extension_settings.orchestrator` (the iter-studio bucket at
 * `extension_settings.luker_orchestrator` is unrelated). Without
 * `enabled: true`, the dispatch hook at main.js's GENERATE_TAKEOVER_DISPATCH
 * early-returns; without executionMode === 'director', a different
 * runner branches off and the panel never mounts.
 */
async function ensureOrchestratorEnabledDirectorMode(page) {
    await page.evaluate(() => {
        const ctx = window.Luker?.getContext?.();
        const settings = ctx?.extensionSettings?.orchestrator;
        if (!settings) throw new Error('orchestrator settings missing — extension not mounted (check that the extension is enabled in this build)');
        settings.enabled = true;
        settings.executionMode = 'director';
        // Some preset libraries may not have a director preset wired by
        // default. The director-runtime fails open in that case (it
        // builds a synthetic profile with no sub-agents), but the
        // executionMode flag must be set or the dispatcher routes to a
        // different runner.
        if (typeof ctx?.saveSettingsDebounced === 'function') {
            ctx.saveSettingsDebounced();
        }
    });
}
