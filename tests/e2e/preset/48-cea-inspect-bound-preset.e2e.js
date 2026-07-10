// #48 — CEA editor iter-studio: `inspect_bound_preset` end-to-end,
//        exercising the READ_TOOL_LEGACY_NAMES self-map.
//
// `inspect_bound_preset` is wired into the CEA editor tool catalog
// via a self-map (`READ_TOOL_LEGACY_NAMES.inspect_bound_preset =
// 'inspect_bound_preset'`) so runCeaEditorReadTool dispatches to the
// short name unchanged. The full chain per turn:
//
//   mock LLM tool_call → editor-iteration/studio.js executes
//     → runCeaEditorReadTool(call, {helperApis})
//     → READ_TOOL_LEGACY_NAMES lookup → 'inspect_bound_preset'
//     → runCharacterEditorHelperToolCall(legacyCall, helperApis)
//     → createCharacterEditorBoundPresetToolApi.invoke(call)
//     → runCharacterPresetReadTool(call, {context, avatar})
//     → context.character.presets.list / get → tool_result → back to LLM.
//
// The self-map is the load-bearing hook this test pins: a future mistyped
// entry like `'inspect_bound_preset': 'wrong_name'` would surface here as
// runCharacterEditorHelperToolCall throwing "Unsupported helper tool:
// wrong_name" (none of the helper APIs' `isToolName` would match), and
// the DOM result-pre would carry `{ error: 'Unsupported helper tool:
// wrong_name' }`. Structural assertions on the happy-path payload shape
// (list array + get object) verify the legacy map is intact.
//
// Real UI/gestures: open Extensions drawer → CEA inline-drawer → click
// "Open Editor" (real gesture opens the unified CEA editor iter-studio
// popup). mockLLM scripts tool_calls; assertions run on the popup DOM.

import { test, expect } from '@playwright/test';
import { startServer, tearDownServer } from '../_lib/server.js';
import { startMockLLM } from '../_lib/mockLLM.js';
import { bootstrapCustomBackend, appendConnectionProfile, markOnboarded } from '../_lib/fixtures.js';
import { awaitMainUI, selectCharacterByName } from '../_lib/page.js';
import { openIterStudio, closeIterStudio } from '../_lib/ui-iter-studio.js';
import { normalizeIterStudioSettings } from './_helpers.js';
import { writeEmbeddedCharacter } from '../character/_helpers.js';

let server, mock;

const CHAR_NAME = 'Cassian the Curator';
const CHAR_AVATAR = 'cassian-the-curator.png';

const SLOT_A_NAME = 'CurationSlotA';
const SLOT_B_NAME = 'CurationSlotB';
const SLOT_A_TEMP = 0.19;
const SLOT_B_TEMP = 0.87;

test.beforeAll(async () => {
    mock = await startMockLLM({});
    server = await startServer({
        batchKey: 'preset',
        scenarioId: 'cea-inspect-bound-preset',
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
                            { name: SLOT_A_NAME, preset: { temperature: SLOT_A_TEMP, chat_completion_source: 'openai' } },
                            { name: SLOT_B_NAME, preset: { temperature: SLOT_B_TEMP, chat_completion_source: 'openai' } },
                        ],
                        defaultPresetName: SLOT_A_NAME,
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
 * Read the last `inspect_bound_preset` tool-result payload out of the
 * visible iter popup. Same shape as #47 — the shared iteration-library
 * message renderer emits the tool_result as JSON via
 * `<pre class="luker_lib_toolcall_result_pre">`.
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
 * CEA editor iter-studio composer send helper. Same shape as the
 * orchestrator version in #47 but with CEA-specific selectors
 * (data-cea-editor-action, data-cea-editor-input).
 */
async function sendReadOnlyPrompt(page, prompt, { expectedToolLabel = 'inspect_bound_preset', timeoutMs = 60_000 } = {}) {
    const popup = page.locator('.popup:visible').last();
    const input = popup.locator('[data-cea-editor-input], .cea_editor_composer_input textarea, .cea_editor_composer_input [contenteditable="true"]').first();
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
    const sendBtn = popup.locator('[data-cea-editor-action="send"]').first();
    await sendBtn.click();
    await expect.poll(async () => {
        return popup.locator('.luker_lib_toolcall .luker_lib_toolcall_label', { hasText: expectedToolLabel }).count();
    }, { timeout: timeoutMs }).toBeGreaterThan(priorChipCount);
    await expect.poll(async () => {
        return (await sendBtn.textContent().catch(() => ''))?.trim() || '';
    }, { timeout: timeoutMs }).not.toMatch(/^stop$/i);
}

test.describe.configure({ mode: 'serial' });

test.describe('#48 — CEA editor iter-studio inspect_bound_preset (legacy-map coverage)', () => {
    test('list + get(existing) + get(nonexistent): tool_results flow through the CEA dispatch chain', async ({ page }) => {
        await awaitMainUI(page, server.baseURL);
        await selectCharacterByName(page, CHAR_NAME);

        await openIterStudio(page, 'cea');

        // ---- Turn 1: list ----
        // If READ_TOOL_LEGACY_NAMES['inspect_bound_preset'] is mistyped
        // (e.g. to 'wrong_name'), the dispatch chain lands on
        // runCharacterEditorHelperToolCall's throw path — no helper API
        // matches 'wrong_name' → thrown error → runCeaEditorReadTool
        // returns `{ok:false, error:'Unsupported helper tool: wrong_name'}`
        // → the studio renders `{error: ...}` in the result-pre and the
        // Array.isArray + length===2 assertion below fails.
        mock.scriptToolCall({
            name: 'inspect_bound_preset',
            arguments: { action: 'list' },
        });
        await sendReadOnlyPrompt(page, 'List every preset embedded on this character card.');

        await expect.poll(async () => {
            const payload = await readLastToolResultPayload(page, 'inspect_bound_preset');
            return Array.isArray(payload) ? payload.length : -1;
        }, { timeout: 20_000 }).toBe(2);

        const listPayload = await readLastToolResultPayload(page, 'inspect_bound_preset');
        const bySlot = Object.fromEntries(listPayload.map(e => [e.name, e]));
        expect(bySlot[SLOT_A_NAME]).toEqual({ name: SLOT_A_NAME, isDefault: true, hasBody: true });
        expect(bySlot[SLOT_B_NAME]).toEqual({ name: SLOT_B_NAME, isDefault: false, hasBody: true });

        // ---- Turn 2: get Slot A ----
        mock.scriptToolCall({
            name: 'inspect_bound_preset',
            arguments: { action: 'get', name: SLOT_A_NAME },
        });
        await sendReadOnlyPrompt(page, `Fetch the body for ${SLOT_A_NAME}.`);

        await expect.poll(async () => {
            const payload = await readLastToolResultPayload(page, 'inspect_bound_preset');
            return payload && !Array.isArray(payload) && payload.name === SLOT_A_NAME
                ? Number(payload.preset?.temperature ?? -1)
                : -1;
        }, { timeout: 20_000 }).toBeCloseTo(SLOT_A_TEMP, 5);

        // ---- Turn 3: get(nonexistent) → result null ----
        mock.scriptToolCall({
            name: 'inspect_bound_preset',
            arguments: { action: 'get', name: 'no-such-slot' },
        });
        await sendReadOnlyPrompt(page, 'Try to fetch a preset that is not on the card.');

        await expect.poll(async () => {
            const payload = await readLastToolResultPayload(page, 'inspect_bound_preset');
            return payload && Object.hasOwn(payload, '__primitive') ? payload.__primitive : 'still-something-else';
        }, { timeout: 20_000 }).toBeNull();

        await closeIterStudio(page);
    });

    test('error branch: action=get without name surfaces error envelope', async ({ page }) => {
        await awaitMainUI(page, server.baseURL);
        await selectCharacterByName(page, CHAR_NAME);

        await openIterStudio(page, 'cea');

        // action=get without a name bypasses the JSON-schema check
        // (name is not `required`) but hits the executor's
        // VALIDATION_ARGS branch. CEA's helper API `throws` on
        // ok:false; runCeaEditorReadTool catches and returns
        // `{ok:false, error}`; the studio persists `{error}` on the
        // tool_result — the DOM result-pre carries an `error` field.
        mock.scriptToolCall({
            name: 'inspect_bound_preset',
            arguments: { action: 'get' },
        });
        await sendReadOnlyPrompt(page, 'Try get without a name to prove the error envelope surfaces.');

        await expect.poll(async () => {
            const payload = await readLastToolResultPayload(page, 'inspect_bound_preset');
            if (!payload || Array.isArray(payload)) return null;
            if (Object.hasOwn(payload, '__primitive')) return null;
            return typeof payload.error === 'string' && payload.error.length > 0
                ? 'has-error'
                : null;
        }, { timeout: 20_000 }).toBe('has-error');

        await closeIterStudio(page);
    });
});
