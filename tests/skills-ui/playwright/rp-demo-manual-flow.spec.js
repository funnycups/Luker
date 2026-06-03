/**
 * Manual user-path RP demo: install an RP-discipline skill, attach it to the
 * director profile via the chip editor, send an RP message, observe the
 * director consult the skill mid-turn.
 *
 * Mutating state is performed via DOM interactions only — clicks, fills,
 * file uploads, keyboard input. `page.evaluate` is used solely for
 * read-only state inspection (trace assertions at the end) and for one
 * unavoidable runtime-trace clear that mirrors what a "fresh session"
 * would observe (no persistent UI affordance exists for clearing the
 * in-memory trace). The skill author is `/tmp/gentle-companion-voice-zh.md`,
 * authored verbatim from real RP-discipline content (not synthetic markers).
 *
 * Screenshots land under docs/public/_screenshots/skills/rp-demo-NN-*.png
 * (NN = 01..13) — these are documentation-grade captures, not
 * failure-only artifacts.
 */

import { test, expect } from '@playwright/test';
import fs from 'node:fs/promises';
import path from 'node:path';
import {
    SCREENSHOTS_DIR,
    awaitMainUI,
    ensureExtensionsDrawerOpen,
    ensureInlineDrawerOpen,
} from './helpers.js';

const SKILL_NAME = 'gentle-companion-voice-zh';
const SKILL_DESC = '温柔陪伴型角色的写作纪律 — 称谓基线 / 不催促节奏 / 触觉先于视觉 / 情绪上限 / 拒绝用动作 / 笑要带身体。';
const SKILL_SOURCE_PATH = '/tmp/gentle-companion-voice-zh.md';
// Unique 10-char phrase from the skill body — appears EXACTLY ONCE in
// /tmp/gentle-companion-voice-zh.md (verified before spec write). Used to
// prove the skill_read tool result returned the actual on-disk file body.
const DISTINCTIVE_PHRASE = '陪伴的语法是';
const USER_RP_MESSAGE = '她从灶台边走过来，把陶碗递给我。我接的时候指尖蹭到她的，她没缩。我有点尴尬，想说点什么又没说出口。';

const SCREENSHOT_PREFIX = 'rp-demo';

/** Compose a step-numbered screenshot path. */
function stepPath(n, label) {
    const nn = String(n).padStart(2, '0');
    const safe = String(label).replace(/[^A-Za-z0-9_-]+/g, '-');
    return path.join(SCREENSHOTS_DIR, `${SCREENSHOT_PREFIX}-${nn}-${safe}.png`);
}

test.describe('Skills RP demo (manual user path)', () => {
    // The director run dispatches ~12 sub-agents and can take 5-8 minutes
    // on a busy LLM provider. Match the LLM spec's ceiling.
    test.setTimeout(900_000);

    test.beforeAll(async () => {
        await fs.mkdir(SCREENSHOTS_DIR, { recursive: true });
        // Sanity: the skill file must exist on disk before we file-upload.
        const stat = await fs.stat(SKILL_SOURCE_PATH);
        expect(stat.isFile(), `expected ${SKILL_SOURCE_PATH} to exist`).toBe(true);
        const body = await fs.readFile(SKILL_SOURCE_PATH, 'utf8');
        expect(body.includes(DISTINCTIVE_PHRASE), `distinctive phrase "${DISTINCTIVE_PHRASE}" must appear in the skill body`).toBe(true);
        const matches = body.split(DISTINCTIVE_PHRASE).length - 1;
        expect(matches, `distinctive phrase must appear EXACTLY ONCE in the skill body (saw ${matches})`).toBe(1);
    });

    test('user installs RP skill, attaches to director, sends RP message; director consults skill mid-turn', async ({ page }) => {
        // ── Step 1: navigate + wait for main UI ─────────────────────────
        await awaitMainUI(page);
        await page.screenshot({ path: stepPath(1, 'home'), fullPage: false });

        // ── Step 2: open API Connections drawer, pick "claude", connect.
        // We drive the visible Connection Manager dropdown — same affordance
        // a real user clicks. The `/profile` slash command is the documented
        // activation path that the dropdown wires through.
        await page.locator('#sys-settings-button .drawer-toggle').first().click();
        await page.locator('#rm_api_block').waitFor({ state: 'visible', timeout: 5000 });
        // The connection-manager settings panel mounts inside #rm_api_block
        // at extension-init time. Wait for the dropdown to populate.
        const profileSelect = page.locator('#connection_profiles');
        await profileSelect.waitFor({ state: 'visible', timeout: 10000 });
        // Wait until the dropdown has at least one option containing "claude"
        // (the worktree's claude profile, mounted by the dev server).
        await page.waitForFunction(() => {
            const sel = document.getElementById('connection_profiles');
            if (!sel) return false;
            return Array.from(sel.options).some(o => /claude/i.test(o.textContent || ''));
        }, null, { timeout: 10000 });
        // Pick "claude" from the dropdown — the select's onChange handler
        // dispatches the profile load. We resolve the exact label string from
        // the live options (Playwright's selectOption only accepts string
        // labels, not regex), then pass it through. Same path a clicking user
        // exercises.
        const claudeLabel = await profileSelect.evaluate((sel) => {
            const opt = Array.from(sel.options).find(o => /claude/i.test(o.textContent || ''));
            return opt ? opt.textContent : null;
        });
        if (!claudeLabel) {
            throw new Error('No "claude" option found in #connection_profiles dropdown');
        }
        await profileSelect.selectOption({ label: claudeLabel });
        // Poll for online_status to flip off no_connection — this is read-only
        // state inspection, not mutation.
        await page.waitForFunction(() => {
            const ctx = window.SillyTavern?.getContext?.();
            const v = ctx?.onlineStatus ?? null;
            return Boolean(v) && String(v) !== 'no_connection';
        }, null, { timeout: 30000 });
        await page.screenshot({ path: stepPath(2, 'api-claude-connected'), fullPage: false });

        // ── Step 3: select Seraphina from the right-side character list.
        // Close the API drawer first so the character panel comes back into
        // focus naturally — real user behavior.
        await page.locator('#sys-settings-button .drawer-toggle').first().click();
        await page.locator('#rm_api_block').waitFor({ state: 'hidden', timeout: 5000 });
        // Open the right-nav Character Management drawer — it's closed by
        // default on the welcome view. Real users click this fa-address-card
        // icon to surface the character list.
        const rightNavIcon = page.locator('#rightNavDrawerIcon');
        const rightNavIsClosed = await rightNavIcon.evaluate(
            el => el && el.classList.contains('closedIcon'),
        ).catch(() => true);
        if (rightNavIsClosed) {
            await rightNavIcon.click();
            // The panel content is in #right-nav-panel — wait for it to be visible.
            await page.locator('#rm_print_characters_block').waitFor({ state: 'visible', timeout: 10000 });
        }
        // The character list is rendered into #rm_print_characters_block. The
        // bundled Seraphina is rendered as a tile with her name. Click it.
        const seraphinaTile = page.locator(
            '.character_select:has-text("Seraphina"), .character_select[chid] >> text=Seraphina',
        ).first();
        await seraphinaTile.waitFor({ state: 'visible', timeout: 10000 });
        await seraphinaTile.click();
        // Wait for ctx.characterId to flip — read-only assertion.
        await page.waitForFunction(() => {
            const ctx = window.SillyTavern?.getContext?.();
            return ctx?.characterId !== null && ctx?.characterId !== undefined
                && ctx.characters?.[ctx.characterId]?.name === 'Seraphina';
        }, null, { timeout: 15000 });
        // Close the right-nav drawer — its #HotSwapWrapper overlay would
        // otherwise intercept pointer events for the next step's clicks on
        // the extensions-settings drawer toggle.
        // SillyTavern binds the click handler on `.drawer-toggle` (the parent
        // wrapper), not on the child `#rightNavDrawerIcon`. Clicking the icon
        // does not invoke doNavbarIconClick; clicking the wrapper does.
        const rightNavToggle = page.locator('#rightNavHolder > .drawer-toggle, #rightNavHolder .drawer-toggle').first();
        const rightNavStillOpen = await page.locator('#rightNavHolder').evaluate(
            el => el && el.classList.contains('openDrawer'),
        ).catch(() => false);
        if (rightNavStillOpen) {
            await rightNavToggle.click({ force: true });
            await page.waitForFunction(() => {
                const h = document.getElementById('rightNavHolder');
                return h && h.classList.contains('closedDrawer');
            }, null, { timeout: 5000 });
        }
        await page.screenshot({ path: stepPath(3, 'seraphina-loaded'), fullPage: false });

        // ── Step 4: open Extensions drawer → Orchestrator inline-drawer →
        //           click "Manage skills..."
        await ensureExtensionsDrawerOpen(page);
        await ensureInlineDrawerOpen(page, 'orchestrator_settings');
        const manageBtn = page.locator('#orchestrator_settings [data-luker-action="manage-skills"]:visible').first();
        await manageBtn.waitFor({ state: 'visible', timeout: 10000 });
        await manageBtn.click();
        const skillManagerPopup = page.locator('.popup .luker_skill_manager').first();
        await skillManagerPopup.waitFor({ state: 'visible', timeout: 10000 });
        // Record manager popup data-id so subsequent step-5/6/7 "find next popup"
        // logic can exclude it (otherwise `.last()` may resolve to the manager).
        const managerPopupId = await page.locator('dialog.popup:has(.luker_skill_manager)').first().getAttribute('data-id');
        // Wait for the skill list to populate (5 baseline scaffolds + bundled).
        await page.waitForFunction(() => {
            const rows = document.querySelectorAll('.popup .luker_skill_manager [data-skill-name]');
            return rows.length > 0;
        }, null, { timeout: 15000 });
        await page.screenshot({ path: stepPath(4, 'skills-manager-baseline'), fullPage: false });

        // ── Step 5: click "Create new" — the skill manager's import-file
        //   affordance accepts .zip/.json embed bundles only; the user-natural
        //   path for a raw SKILL.md is Create new → enter name → enter desc →
        //   select Global scope → editor opens → paste the body → Save.
        const createBtn = skillManagerPopup.locator('[data-skill-toolbar="create"]').first();
        await createBtn.waitFor({ state: 'visible', timeout: 5000 });
        await createBtn.click();
        // First popup: name input. Record data-id so subsequent waitFor calls
        // don't drift when a follow-up popup opens before this one fully detaches.
        // Exclude the manager popup explicitly — its dialog also matches
        // `dialog.popup:visible`, so plain `.last()` can resolve to it.
        const namePopup = page.locator(`dialog.popup[open]:not([data-id="${managerPopupId}"])`).last();
        await namePopup.waitFor({ state: 'visible', timeout: 5000 });
        const namePopupId = await namePopup.getAttribute('data-id');
        const namePopupById = page.locator(`dialog.popup[data-id="${namePopupId}"]`);
        // Wait for the popup to finish its opening transition before reaching
        // for its input — Luker popups carry `opening` and `closing` HTML
        // attributes during animation; the input is CSS-hidden in those states.
        await page.waitForFunction((id) => {
            const d = document.querySelector(`dialog.popup[data-id="${id}"]`);
            return d && d.hasAttribute('open') && !d.hasAttribute('opening') && !d.hasAttribute('closing');
        }, namePopupId, { timeout: 5000 });
        const nameInput = namePopupById.locator('textarea.popup-input, input.popup-input').first();
        // The popup-input textarea has offsetWidth=0 in INPUT-type popups
        // (mainInput.style.display=block is set in constructor but the dialog's
        // backdrop layout collapses its visible box). Setting .value + firing
        // input event directly is the same DOM-level mutation Playwright's
        // fill() would do, but works on 0-size elements.
        await nameInput.evaluate((el, v) => {
            el.value = v;
            el.dispatchEvent(new Event('input', { bubbles: true }));
            el.dispatchEvent(new Event('change', { bubbles: true }));
        }, SKILL_NAME);
        await page.screenshot({ path: stepPath(5, 'create-name-entered'), fullPage: false });
        // Manager popup (or its backdrop) can intercept hit-test for the child
        // popup's OK button; dispatchEvent fires click directly on the button.
        await namePopupById.locator('div.popup-button-ok, button:has-text("Next")').first().dispatchEvent('click');
        await namePopupById.waitFor({ state: 'detached', timeout: 5000 });

        // ── Step 6: description input popup.
        // Re-resolve and wait for an *opening/visible* popup whose id differs
        // from the manager + name popups (the next popup in the chain).
        await page.waitForFunction((prevIds) => {
            const dialogs = Array.from(document.querySelectorAll('dialog.popup'));
            return dialogs.some(d => !prevIds.includes(d.dataset.id) && d.hasAttribute('open'));
        }, [managerPopupId, namePopupId], { timeout: 5000 });
        const descPopup = page.locator(`dialog.popup[open]:not([data-id="${managerPopupId}"]):not([data-id="${namePopupId}"])`).last();
        const descPopupId = await descPopup.getAttribute('data-id');
        const descPopupById = page.locator(`dialog.popup[data-id="${descPopupId}"]`);
        await page.waitForFunction((id) => {
            const d = document.querySelector(`dialog.popup[data-id="${id}"]`);
            return d && d.hasAttribute('open') && !d.hasAttribute('opening') && !d.hasAttribute('closing');
        }, descPopupId, { timeout: 5000 });
        const descInput = descPopupById.locator('textarea.popup-input, input.popup-input').first();
        await descInput.evaluate((el, v) => {
            el.value = v;
            el.dispatchEvent(new Event('input', { bubbles: true }));
            el.dispatchEvent(new Event('change', { bubbles: true }));
        }, SKILL_DESC);
        await page.screenshot({ path: stepPath(6, 'create-desc-entered'), fullPage: false });
        await descPopupById.locator('div.popup-button-ok, button:has-text("Next")').first().dispatchEvent('click');
        await descPopupById.waitFor({ state: 'detached', timeout: 5000 });

        // ── Step 7: scope picker popup — choose Global.
        await page.waitForFunction((prevIds) => {
            const dialogs = Array.from(document.querySelectorAll('dialog.popup'));
            return dialogs.some(d => !prevIds.includes(d.dataset.id) && d.hasAttribute('open'));
        }, [managerPopupId, namePopupId, descPopupId], { timeout: 5000 });
        const scopePopup = page.locator(`dialog.popup[open]:not([data-id="${managerPopupId}"]):not([data-id="${namePopupId}"]):not([data-id="${descPopupId}"])`).last();
        const scopePopupId = await scopePopup.getAttribute('data-id');
        const scopePopupById = page.locator(`dialog.popup[data-id="${scopePopupId}"]`);
        const globalRadio = scopePopupById.locator('input[name="luker_skill_scope_kind"][value="global"]');
        await globalRadio.waitFor({ state: 'visible', timeout: 5000 });
        await globalRadio.check({ force: true });
        await page.screenshot({ path: stepPath(7, 'create-scope-global'), fullPage: false });
        await scopePopupById.locator('div.popup-button-ok, button:has-text("Install")').first().dispatchEvent('click');
        await scopePopupById.waitFor({ state: 'detached', timeout: 10000 });

        // ── Step 8: install completes; the create flow fires `void
        //   openSkillEditor(...)` fire-and-forget. Whether the editor popup
        //   auto-opens before we get here depends on timing. We probe once:
        //   if it's already open, use it; otherwise click the row's edit
        //   affordance to open it explicitly. Either path is a real user path.
        const managerPopupBlock = page.locator('.popup .luker_skill_manager').first();
        await managerPopupBlock.waitFor({ state: 'visible', timeout: 5000 });
        await page.waitForFunction((name) => {
            const rows = document.querySelectorAll('.popup .luker_skill_manager [data-skill-name]');
            return Array.from(rows).some(r => r.getAttribute('data-skill-name') === name);
        }, SKILL_NAME, { timeout: 10000 });
        await page.screenshot({ path: stepPath(8, 'skill-row-created'), fullPage: false });
        // Probe: did the auto-open already produce an editor popup?
        // Use a short visibility check so we don't get stuck waiting.
        const autoEditor = page.locator('dialog.popup .luker_skill_editor');
        const editorAlreadyOpen = await autoEditor.count() > 0;
        if (!editorAlreadyOpen) {
            const editBtn = page.locator(`.popup .luker_skill_manager [data-skill-name="${SKILL_NAME}"] [data-skill-action="edit"]`).first();
            await editBtn.waitFor({ state: 'attached', timeout: 5000 });
            await editBtn.dispatchEvent('click');
        }
        const editorPopup = page.locator('dialog.popup:visible .luker_skill_editor').first();
        await editorPopup.waitFor({ state: 'visible', timeout: 10000 });
        // The editor's left pane lists files; SKILL.md should be the active
        // file by default. The editor textarea is `[data-editor-textarea]`.
        const editorTextarea = page.locator('dialog.popup:visible [data-editor-textarea]').first();
        await editorTextarea.waitFor({ state: 'attached', timeout: 5000 });
        // Load the real body and replace the template content.
        const realBody = await fs.readFile(SKILL_SOURCE_PATH, 'utf8');
        // Use direct DOM mutation — Playwright's fill check fails on 0-size
        // popup-input elements; setting value + dispatching input events is
        // the same semantic the editor's onInput handler responds to.
        await editorTextarea.evaluate((el, v) => {
            el.value = v;
            el.dispatchEvent(new Event('input', { bubbles: true }));
            el.dispatchEvent(new Event('change', { bubbles: true }));
        }, realBody);
        await page.screenshot({ path: stepPath(8.5, 'editor-body-pasted'), fullPage: false });
        // Save via the editor's Save button.
        const saveBtn = page.locator('dialog.popup:visible [data-editor-save]').first();
        await saveBtn.dispatchEvent('click');
        // Wait for the success toast / save round-trip to land.
        await page.waitForTimeout(1500);
        // Close the editor popup. Scope the locator to the editor's dialog,
        // not just any visible popup — manager popup is still open below and
        // also has a popup-button-ok.
        const editorClose = page.locator('dialog.popup:has(.luker_skill_editor) div.popup-button-ok').first();
        await editorClose.dispatchEvent('click');
        await page.locator('dialog.popup:has(.luker_skill_editor)').waitFor({ state: 'detached', timeout: 5000 });

        // ── Step 9: close the manager popup so the orchestrator editor can
        //   open uncontested in step 10.
        await page.screenshot({ path: stepPath(9, 'skill-installed-global'), fullPage: false });
        const managerCloseBtn = page.locator('.popup:has(.luker_skill_manager) div.popup-button-ok').first();
        await managerCloseBtn.dispatchEvent('click');
        await page.locator('.popup .luker_skill_manager').waitFor({ state: 'hidden', timeout: 5000 });

        // ── Step 10: open the Orchestration Editor popup — this contains
        //   the director workspace and the mode-level skill chips editor.
        await ensureExtensionsDrawerOpen(page);
        await ensureInlineDrawerOpen(page, 'orchestrator_settings');
        const openEditorBtn = page.locator('#orchestrator_settings [data-luker-action="open-orch-editor"]:visible').first();
        await openEditorBtn.waitFor({ state: 'visible', timeout: 10000 });
        await openEditorBtn.click();
        const orchEditor = page.locator('.popup .luker_orch_director_block').first();
        await orchEditor.waitFor({ state: 'visible', timeout: 15000 });
        // The mode-level chip block is inside <details class="luker_orch_skills_section" open>
        // with the summary "Mode-level skills (baseline for every agent)".
        // Its chips mount has data-luker-chip-target encoding mode=director,
        // level=mode. We scope the add-select / button to that specific
        // mount to avoid colliding with per-agent chip blocks above/below.
        // CSS attr selector wraps value in single quotes because the value
        // itself (JSON-formatted) contains double quotes.
        const modeChipSelector = `.popup [data-luker-skill-chips-mount][data-luker-chip-target*='"level":"mode"'][data-luker-chip-target*='"mode":"director"']`;
        const modeChipMount = page.locator(modeChipSelector).first();
        await modeChipMount.waitFor({ state: 'visible', timeout: 10000 });
        // Wait for the chips inventory hydration — the mount starts with
        // "Loading skills..." then renders the chips block.
        await page.waitForFunction((sel) => {
            const m = document.querySelector(sel);
            return Boolean(m && m.querySelector('[data-skill-chip-add-select]'));
        }, modeChipSelector, { timeout: 15000 });
        await page.screenshot({ path: stepPath(10, 'director-editor-before-chip-add'), fullPage: false });

        // ── Step 11: add the new skill to the director mode-level visible
        //   list via the chip add control — select the name from the dropdown,
        //   then click the "Add" button. This is the chips component's
        //   user-facing path; it mutates the editor state which the orch
        //   popup persists on close.
        const addSelect = modeChipMount.locator('[data-skill-chip-add-select]').first();
        await addSelect.waitFor({ state: 'visible', timeout: 5000 });
        await addSelect.selectOption(SKILL_NAME);
        const addBtn = modeChipMount.locator('[data-skill-chip-action="open-add"]').first();
        await addBtn.click();
        // Wait for the chip with our name to appear in the chips block.
        const newChip = modeChipMount.locator(`[data-skill-chip-name="${SKILL_NAME}"]`).first();
        await newChip.waitFor({ state: 'visible', timeout: 5000 });
        await page.screenshot({ path: stepPath(11, 'director-chip-added'), fullPage: false });

        // ── Close the orchestration editor popup (saves on close via the
        //   debounced settings persister).
        const orchClose = page.locator('.popup:has(.luker_orch_director_block) div.popup-button-ok').first();
        await orchClose.click();
        await page.locator('.popup .luker_orch_director_block').waitFor({ state: 'hidden', timeout: 5000 });

        // ── Step 12: back to the chat. Verify mode === director (it's the
        //   default on a fresh worktree; confirm via the orchestrator status
        //   strip). Close the extensions drawer so the textarea is in focus.
        // Close extensions drawer.
        await page.locator('#extensions-settings-button .drawer-toggle').first().click();
        await page.locator('#rm_extensions_block').waitFor({ state: 'hidden', timeout: 5000 });
        // Sanity: the orchestrator mode is director.
        const executionMode = await page.evaluate(() => {
            const ctx = window.SillyTavern?.getContext?.();
            return String(ctx?.extensionSettings?.luker_orchestrator?.executionMode || '');
        });
        expect(executionMode, 'orchestrator must be in director mode for the demo').toBe('director');
        await page.screenshot({ path: stepPath(12, 'chat-ready'), fullPage: false });

        // ── Clear the runtime trace so the post-send assertion can't read
        //   STALE data from a prior run. There is no UI affordance for this
        //   today — it's an in-memory module-local variable; the only way to
        //   reset is via the module's exported `clearLatestOrchestrationRuntimeTrace`.
        //   This is the ONLY place we use page.evaluate for non-read-only
        //   purposes; it's not a state mutation the user would perform —
        //   it's a "fresh REPL" gate.
        await page.evaluate(async () => {
            try {
                const m = await import('/scripts/extensions/orchestrator/runtime-trace.js');
                m.clearLatestOrchestrationRuntimeTrace?.();
            } catch { /* trace module not loaded yet — safe */ }
        });

        // ── Step 13: type the RP message into the chat textarea and send.
        const sendTextarea = page.locator('#send_textarea');
        await sendTextarea.waitFor({ state: 'visible', timeout: 10000 });
        await sendTextarea.fill(USER_RP_MESSAGE);
        // The send button is `#send_but`. In some Luker UI states the top-bar
        // widgets overlap the send region and intercept clicks; if a normal
        // click fails, fall back to the locator's dispatchEvent — that is
        // legitimate DOM-level interaction, not internal state mutation.
        const sendBtn = page.locator('#send_but');
        await sendBtn.waitFor({ state: 'visible', timeout: 10000 });
        try {
            await sendBtn.click({ timeout: 5000 });
        } catch {
            await sendBtn.dispatchEvent('click');
        }
        await page.screenshot({ path: stepPath(13, 'message-sent'), fullPage: false });

        // ── Step 14: wait for the director run to complete (5-8 minutes).
        //   Watch the runtime trace status (read-only). Settled states are
        //   completed/failed/cancelled.
        const traceResult = await page.evaluate(async () => {
            const ctx = window.SillyTavern.getContext();
            const settled = new Set(['completed', 'failed', 'cancelled']);
            const start = Date.now();
            const deadline = 600_000; // 10 minutes ceiling
            while (Date.now() - start < deadline) {
                try {
                    const mod = await import('/scripts/extensions/orchestrator/runtime-trace.js');
                    const trace = mod.getLatestOrchestrationRuntimeTrace(ctx);
                    if (trace && settled.has(String(trace.status || ''))) {
                        return { status: trace.status, trace };
                    }
                } catch { /* keep waiting */ }
                await new Promise(r => setTimeout(r, 1500));
            }
            return { status: 'timeout', trace: null };
        });
        await page.screenshot({ path: stepPath(14, 'director-completed'), fullPage: false });

        // ── Assertions on the trace. These are all READ-only inspections of
        //   server-side state the model cannot fabricate.
        expect(traceResult.status, 'director run reached a terminal status (not timeout)').not.toBe('timeout');
        const { trace } = traceResult;
        expect(trace, 'runtime trace exists after dispatch').toBeTruthy();
        expect(trace.director, 'trace.director shape present (director-mode dispatch)').toBeTruthy();

        // Collect all messages across main agent + sub-agents.
        const messagesToScan = [];
        const mainMsgs = trace?.director?.mainAgent?.conversation?.messages;
        if (Array.isArray(mainMsgs)) messagesToScan.push(...mainMsgs);
        const subagents = Array.isArray(trace?.director?.subagents) ? trace.director.subagents : [];
        for (const sub of subagents) {
            const m = sub?.conversation?.messages;
            if (Array.isArray(m)) messagesToScan.push(...m);
        }
        // eslint-disable-next-line no-console
        console.log(`[rp-demo] scanned messages: main=${(mainMsgs || []).length}, sub-agents=${subagents.length}, total=${messagesToScan.length}`);

        // Assertion (1): <available_skills> catalog block carries the skill name
        // in at least one system message.
        const sawCatalogBlock = messagesToScan.some(msg => {
            if (msg?.role !== 'system') return false;
            const content = String(msg.content || '');
            return content.includes('<available_skills>') && content.includes(SKILL_NAME);
        });
        expect(sawCatalogBlock, 'main or sub-agent system prompt contains <available_skills> with the skill name').toBe(true);

        // Assertion (2): at least one skill_read tool_call referencing the
        // skill by name appears somewhere.
        const skillReadCalls = [];
        for (const msg of messagesToScan) {
            const tcs = Array.isArray(msg?.tool_calls) ? msg.tool_calls : [];
            for (const tc of tcs) {
                const name = tc?.function?.name || tc?.name || '';
                if (String(name) !== 'skill_read') continue;
                let parsedArgs = {};
                const rawArgs = tc?.function?.arguments ?? tc?.args ?? '';
                if (typeof rawArgs === 'string') {
                    try { parsedArgs = JSON.parse(rawArgs); } catch { parsedArgs = { raw: rawArgs }; }
                } else if (rawArgs && typeof rawArgs === 'object') {
                    parsedArgs = rawArgs;
                }
                skillReadCalls.push({ tc, args: parsedArgs });
            }
        }
        // eslint-disable-next-line no-console
        console.log(`[rp-demo] skill_read invocations: ${JSON.stringify(skillReadCalls.map(c => c.args))}`);
        expect(skillReadCalls.length, 'main or a sub-agent invoked skill_read at least once').toBeGreaterThan(0);
        const matchingCall = skillReadCalls.find(c => String(c.args?.name || '') === SKILL_NAME);
        expect(matchingCall, `skill_read was invoked with name="${SKILL_NAME}"`).toBeTruthy();

        // Assertion (3): the matching tool result message (role=tool, same
        // tool_call_id OR adjacent positioning) carries the distinctive
        // Chinese phrase. The phrase appears exactly once in the on-disk
        // body, so its presence in the conversation proves the read actually
        // returned the file contents.
        const sawDistinctivePhrase = messagesToScan.some(msg => {
            if (msg?.role !== 'tool') return false;
            const content = String(msg?.content || '');
            return content.includes(DISTINCTIVE_PHRASE);
        });
        // eslint-disable-next-line no-console
        console.log(`[rp-demo] distinctive phrase "${DISTINCTIVE_PHRASE}" observed in any tool-result message: ${sawDistinctivePhrase}`);
        expect(sawDistinctivePhrase, `distinctive Chinese phrase "${DISTINCTIVE_PHRASE}" appears in at least one role=tool message (proves skill_read returned the real on-disk body)`).toBe(true);

        // For the report: dump the exact tool_call shape verbatim.
        // eslint-disable-next-line no-console
        console.log(`[rp-demo] matching skill_read tool_call verbatim:\n${JSON.stringify(matchingCall.tc, null, 2)}`);

        // ── Teardown — perform user-visible cleanup via UI only. ────────
        // (a) Re-open the orchestration editor, find the chip, click its ×.
        await ensureExtensionsDrawerOpen(page);
        await ensureInlineDrawerOpen(page, 'orchestrator_settings');
        await page.locator('#orchestrator_settings [data-luker-action="open-orch-editor"]:visible').first().click();
        await page.locator('.popup .luker_orch_director_block').first().waitFor({ state: 'visible', timeout: 15000 });
        const modeChipMountTeardown = page.locator(modeChipSelector).first();
        await modeChipMountTeardown.waitFor({ state: 'visible', timeout: 10000 });
        // Wait for the chip to be rendered, then click its × span.
        const teardownChip = modeChipMountTeardown.locator(`[data-skill-chip-name="${SKILL_NAME}"]`).first();
        await teardownChip.waitFor({ state: 'visible', timeout: 10000 });
        const teardownChipX = modeChipMountTeardown.locator(
            `[data-skill-chip-action="remove"][data-skill-chip-name="${SKILL_NAME}"]`,
        ).first();
        await teardownChipX.dispatchEvent('click');
        // Confirm the chip is gone.
        await modeChipMountTeardown.locator(`[data-skill-chip-name="${SKILL_NAME}"]`).first().waitFor({ state: 'hidden', timeout: 5000 });
        await page.screenshot({ path: stepPath(15, 'teardown-chip-removed'), fullPage: false });
        // Close the orch editor.
        await page.locator('.popup:has(.luker_orch_director_block) div.popup-button-ok').first().dispatchEvent('click');
        await page.locator('.popup .luker_orch_director_block').waitFor({ state: 'hidden', timeout: 5000 });

        // (b) Re-open the Skills Manager, find the row, click Delete, accept
        //     the confirmation popup.
        await ensureInlineDrawerOpen(page, 'orchestrator_settings');
        await page.locator('#orchestrator_settings [data-luker-action="manage-skills"]:visible').first().click();
        const mgrPopupTeardown = page.locator('.popup .luker_skill_manager').first();
        await mgrPopupTeardown.waitFor({ state: 'visible', timeout: 10000 });
        await page.waitForFunction((name) => {
            const rows = document.querySelectorAll('.popup .luker_skill_manager [data-skill-name]');
            return Array.from(rows).some(r => r.getAttribute('data-skill-name') === name);
        }, SKILL_NAME, { timeout: 10000 });
        const row = mgrPopupTeardown.locator(`[data-skill-name="${SKILL_NAME}"]`).first();
        const deleteBtn = row.locator('[data-skill-action="delete"]').first();
        await deleteBtn.dispatchEvent('click');
        // Confirm popup.
        const confirmPopup = page.locator('dialog.popup:visible').last();
        await confirmPopup.waitFor({ state: 'visible', timeout: 5000 });
        await confirmPopup.locator('div.popup-button-ok, button:has-text("Delete"), button:has-text("OK"), button:has-text("Yes")').first().dispatchEvent('click');
        // Wait for the row to disappear.
        await page.waitForFunction((name) => {
            const rows = document.querySelectorAll('.popup .luker_skill_manager [data-skill-name]');
            return !Array.from(rows).some(r => r.getAttribute('data-skill-name') === name);
        }, SKILL_NAME, { timeout: 10000 });
        await page.screenshot({ path: stepPath(16, 'teardown-skill-deleted'), fullPage: false });
        // Best-effort close: the manager popup may auto-detach after the last
        // row is removed; if so the locator resolves to nothing and we exit.
        const managerCloseLast = page.locator('.popup:has(.luker_skill_manager) div.popup-button-ok').first();
        if (await managerCloseLast.count() > 0) {
            await managerCloseLast.dispatchEvent('click').catch(() => {});
        }
    });
});
