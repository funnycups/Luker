// #47 — Orchestrator iter-studio: `inspect_bound_preset` end-to-end.
//
// `inspect_bound_preset` is a shared iter-studio read tool spliced into
// the orchestrator iter-studio catalog (studio.js#2358 and
// studio.js#2894-2905). This test exercises the full round-trip via
// real UI gestures + mockLLM tool_call injection:
//
//   1. Seed a card with two card-bound presets (default = Slot1).
//   2. Open the orchestrator iter-studio via real drawer + inline-drawer +
//      "Open AI Iteration Studio" click (the shared openIterStudio helper).
//   3. Script the mock LLM to emit `inspect_bound_preset {action:'list'}`
//      on the first send, then `inspect_bound_preset {action:'get', name:
//      '<Slot1>'}` on the second, then `inspect_bound_preset {action:'get',
//      name:'nonexistent'}` on the third.
//   4. Assert the tool_result surfaces in the popup DOM (rendered by
//      renderMessageCard → renderToolCallChip → renderResultDetails) with:
//        - list: two entries, correct isDefault flag on Slot1, hasBody:true.
//        - get:  Slot1's body (temperature matches seed).
//        - get(nonexistent): result is `null` — presets.get returns null
//          for unknown names; the executor treats this as ok:true result:null
//          (this is the observed contract; error branches are exercised via
//          an invalid `action` in the second test below).
//
// Real UI/gestures only: real drawer clicks, real "Open AI Iteration
// Studio" click, real composer input + Send button. mockLLM is the only
// mock. page.evaluate is used for state observation only.

import { test, expect } from '@playwright/test';
import { startServer, tearDownServer } from '../_lib/server.js';
import { startMockLLM } from '../_lib/mockLLM.js';
import { bootstrapCustomBackend, appendConnectionProfile, markOnboarded } from '../_lib/fixtures.js';
import { awaitMainUI, openExtensionsDrawer, openInlineDrawer, selectCharacterByName } from '../_lib/page.js';
import { openIterStudio, closeIterStudio } from '../_lib/ui-iter-studio.js';
import { normalizeIterStudioSettings } from './_helpers.js';
import { writeEmbeddedCharacter } from '../character/_helpers.js';

let server, mock;

const CHAR_NAME = 'Iris the Inspector';
const CHAR_AVATAR = 'iris-the-inspector.png';

const SLOT1_NAME = 'Slot1';
const SLOT2_NAME = 'Slot2';
const SLOT1_TEMP = 0.31;
const SLOT2_TEMP = 0.82;

test.beforeAll(async () => {
    mock = await startMockLLM({});
    server = await startServer({
        batchKey: 'preset',
        scenarioId: 'orch-inspect-bound-preset',
        extraConfig: { 'storage.mode': 'fs' },
    });
    markOnboarded({ dataRoot: server.dataRoot });
    bootstrapCustomBackend({ dataRoot: server.dataRoot, baseURL: mock.baseURL });
    appendConnectionProfile({ dataRoot: server.dataRoot, baseURL: mock.baseURL });
    writeEmbeddedCharacter({
        dataRoot: server.dataRoot,
        avatarFile: CHAR_AVATAR,
        overrides: {
            name: CHAR_NAME,
            extensions: {
                luker: {
                    chat_completion_preset: {
                        presets: [
                            { name: SLOT1_NAME, preset: { temperature: SLOT1_TEMP, chat_completion_source: 'openai' } },
                            { name: SLOT2_NAME, preset: { temperature: SLOT2_TEMP, chat_completion_source: 'openai' } },
                        ],
                        defaultPresetName: SLOT1_NAME,
                    },
                },
            },
        },
    });
    normalizeIterStudioSettings(server.dataRoot);
});

test.afterAll(async () => {
    await tearDownServer(server);
    await mock?.stop();
});

/**
 * Enable the orchestrator (its "Open AI Iteration Studio" button is
 * gated on the extension being enabled). Idempotent — no-op when
 * already enabled.
 */
async function enableOrchestrator(page) {
    await openExtensionsDrawer(page);
    await openInlineDrawer(page, 'orchestrator_settings').catch(() => {});
    const enabled = page.locator('#luker_orch_enabled');
    await enabled.waitFor({ state: 'visible', timeout: 5000 });
    if (!(await enabled.isChecked())) {
        await enabled.check();
    }
}

/**
 * Read the last `inspect_bound_preset` tool-result payload out of the
 * visible iter-studio popup. renderResultDetails emits the payload as
 * JSON via `<pre class="luker_lib_toolcall_result_pre">`; primitive
 * `null` / `undefined` come through as bare `String(...)` text.
 */
async function readLastToolResultPayload(page, toolLabel) {
    return page.evaluate((name) => {
        const popups = Array.from(document.querySelectorAll('dialog.popup[open]'));
        let root = null;
        for (let i = popups.length - 1; i >= 0; i--) {
            if (popups[i].querySelector('.luker_lib_message_assistant')) {
                root = popups[i];
                break;
            }
        }
        if (!root) return null;
        const chips = Array.from(root.querySelectorAll('.luker_lib_toolcall'));
        const matching = chips.filter((chip) => {
            const label = chip.querySelector('.luker_lib_toolcall_label');
            return label && label.textContent.trim() === name;
        });
        if (matching.length === 0) return null;
        const last = matching[matching.length - 1];
        const pre = last.querySelector('.luker_lib_toolcall_result_pre');
        if (!pre) return null;
        const text = pre.textContent || '';
        const trimmed = text.trim();
        if (trimmed === 'null') return { __primitive: null };
        if (trimmed === 'undefined') return { __primitive: undefined };
        try { return JSON.parse(trimmed); } catch { return { __raw: text }; }
    }, toolLabel);
}

/**
 * Read-only send helper.
 *
 * The shared `sendIterPrompt` waits for a proposal-bus Approve button,
 * which read tools never produce. This variant instead waits for:
 *   1. A new `.luker_lib_toolcall` chip carrying the given tool label
 *      to appear inside the visible iter popup.
 *   2. The Send button's text to toggle back from "Stop" to "Send" (the
 *      isBusy flag flips false — see studio.js:2104 — when the loop
 *      stalls, which for read-only turns happens once the next round
 *      returns no more tool_calls and the mockLLM's fallback echo lands
 *      as a text-only assistant turn).
 */
async function sendReadOnlyPrompt(page, prompt, { expectedToolLabel = 'inspect_bound_preset', timeoutMs = 60_000 } = {}) {
    const popup = page.locator('.popup:visible').last();
    const input = popup.locator('[data-orch-it-input], .orch_it_composer_input textarea, .orch_it_composer_input [contenteditable="true"]').first();
    await input.waitFor({ state: 'visible', timeout: 10_000 });
    const priorChipCount = await popup.locator('.luker_lib_toolcall .luker_lib_toolcall_label', { hasText: expectedToolLabel }).count().catch(() => 0);
    const tag = await input.evaluate(el => el.tagName.toLowerCase());
    if (tag === 'textarea' || tag === 'input') {
        await input.fill(prompt);
    } else {
        await input.click();
        await input.press('ControlOrMeta+a');
        await input.press('Delete');
        await input.type(prompt);
    }
    const sendBtn = popup.locator('[data-orch-it-action="send"]').first();
    await sendBtn.click();
    await expect.poll(async () => {
        return popup.locator('.luker_lib_toolcall .luker_lib_toolcall_label', { hasText: expectedToolLabel }).count();
    }, { timeout: timeoutMs }).toBeGreaterThan(priorChipCount);
    // Then wait for the busy flag to clear (Send button text back to
    // its send-string). Using `not.toMatch(/^stop$/i)` — the send-string
    // is either "Send" or the localised variant, but the busy-state
    // label is deterministic ("Stop").
    await expect.poll(async () => {
        return (await sendBtn.textContent().catch(() => ''))?.trim() || '';
    }, { timeout: timeoutMs }).not.toMatch(/^stop$/i);
}

test.describe.configure({ mode: 'serial' });



test.describe('#47 — orchestrator iter-studio inspect_bound_preset', () => {
    test('list + get(existing) + get(nonexistent): tool_results surface in popup DOM with structural payloads', async ({ page }) => {
        await awaitMainUI(page, server.baseURL);
        await enableOrchestrator(page);
        await selectCharacterByName(page, CHAR_NAME);

        await openIterStudio(page, 'orch');

        // ---- Turn 1: list ----
        mock.scriptToolCall({
            name: 'inspect_bound_preset',
            arguments: { action: 'list' },
        });
        await sendReadOnlyPrompt(page, 'Please list every preset embedded on this card.');

        await expect.poll(async () => {
            const payload = await readLastToolResultPayload(page, 'inspect_bound_preset');
            return Array.isArray(payload) ? payload.length : -1;
        }, { timeout: 20_000 }).toBe(2);

        const listPayload = await readLastToolResultPayload(page, 'inspect_bound_preset');
        const bySlot = Object.fromEntries(listPayload.map(e => [e.name, e]));
        expect(bySlot[SLOT1_NAME]).toEqual({ name: SLOT1_NAME, isDefault: true, hasBody: true });
        expect(bySlot[SLOT2_NAME]).toEqual({ name: SLOT2_NAME, isDefault: false, hasBody: true });

        // ---- Turn 2: get Slot1 ----
        mock.scriptToolCall({
            name: 'inspect_bound_preset',
            arguments: { action: 'get', name: SLOT1_NAME },
        });
        await sendReadOnlyPrompt(page, `Fetch the body for ${SLOT1_NAME}.`);

        await expect.poll(async () => {
            const payload = await readLastToolResultPayload(page, 'inspect_bound_preset');
            return payload && !Array.isArray(payload) && payload.name === SLOT1_NAME
                ? Number(payload.preset?.temperature ?? -1)
                : -1;
        }, { timeout: 20_000 }).toBeCloseTo(SLOT1_TEMP, 5);

        // ---- Turn 3: get(nonexistent) ----
        // presets.get(character, unknownName) returns undefined; the
        // executor collapses it to `null` (character-presets-reads.js:162
        // — `return { ok: true, result: hit || null };`). The DOM pre-
        // block renders that as the literal string "null".
        mock.scriptToolCall({
            name: 'inspect_bound_preset',
            arguments: { action: 'get', name: 'nonexistent-slot-name' },
        });
        await sendReadOnlyPrompt(page, 'Try to fetch a preset that does not exist.');

        await expect.poll(async () => {
            const payload = await readLastToolResultPayload(page, 'inspect_bound_preset');
            return payload && Object.hasOwn(payload, '__primitive') ? payload.__primitive : 'still-something-else';
        }, { timeout: 20_000 }).toBeNull();

        await closeIterStudio(page);
    });
    test('validation error branch: action=get without name surfaces error envelope on tool_result', async ({ page }) => {
        await awaitMainUI(page, server.baseURL);
        await enableOrchestrator(page);
        await selectCharacterByName(page, CHAR_NAME);

        await openIterStudio(page, 'orch');
        // action=get without a name argument bypasses the JSON-schema
        // check (name is not in `required`) but hits the executor's
        // VALIDATION_ARGS branch (character-presets-reads.js:157-160).
        // The orchestrator studio wraps failed reads as
        // `{ error: <string> }` (studio.js:2903), so the DOM result-pre
        // renders a JSON object with an `error` field.
        //
        // Structural assertion only — no wording regex. The hint text
        // itself is validated shape-wise (string, non-empty).
        mock.scriptToolCall({
            name: 'inspect_bound_preset',
            arguments: { action: 'get' },
        });
        await sendReadOnlyPrompt(page, 'Try get without a name to prove the error envelope surfaces.');

        await expect.poll(async () => {
            const payload = await readLastToolResultPayload(page, 'inspect_bound_preset');
            if (!payload || Array.isArray(payload)) return null;
            // primitive-null wrapper is not what we want here; only
            // structured error objects satisfy the assertion.
            if (Object.hasOwn(payload, '__primitive')) return null;
            return typeof payload.error === 'string' && payload.error.length > 0
                ? 'has-error'
                : null;
        }, { timeout: 20_000 }).toBe('has-error');

        await closeIterStudio(page);
    });
});
