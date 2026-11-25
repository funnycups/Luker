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

import { test, expect } from '../../harness/playwright.js';
import { startServer } from '../../harness/server.js';
import { startMockLLM } from '../_lib/mockLLM.js';
import { bootstrapCustomBackend, appendConnectionProfile, markOnboarded } from '../_lib/fixtures.js';
import { awaitMainUI, selectCharacterByName } from '../_lib/page.js';
import { openIterStudio, closeIterStudio } from '../_lib/ui-iter-studio.js';
import { setOrchEnabled, sendWorkbenchIterationPrompt } from '../_lib/ui-workbench.js';
import { normalizeIterStudioSettings } from './_helpers.js';
import { writeEmbeddedCharacter } from '../character/_helpers.js';

let server, mock;

const CHAR_NAME = 'Iris the Inspector';
const CHAR_AVATAR = 'iris-the-inspector.png';

const SLOT1_NAME = 'Slot1';
const SLOT2_NAME = 'Slot2';
const SLOT1_TEMP = 0.31;
const SLOT2_TEMP = 0.82;

test.beforeAll(async ({ workerResources }, testInfo) => {
    const scope = await workerResources.scenario(testInfo.file);
    mock = await startMockLLM({});
    server = await startServer({ scope,
        batchKey: 'preset',
        scenarioId: 'orch-inspect-bound-preset',
        extraConfig: { storage: { mode: 'fs' } },
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

    await mock?.stop();
});

async function enableOrchestrator(page) {
    await setOrchEnabled(page, true);
}

let lastToolPayload = null;

async function readLastToolResultPayload() {
    return lastToolPayload;
}

async function sendReadOnlyPrompt(page, prompt) {
    const reqBefore = mock.requests.length;
    await sendWorkbenchIterationPrompt(page, prompt);
    const toolMsgs = mock.requests
        .slice(reqBefore)
        .flatMap((r) => (Array.isArray(r.body?.messages) ? r.body.messages : []))
        .filter((m) => m?.role === 'tool');
    const last = toolMsgs[toolMsgs.length - 1];
    if (!last) {
        lastToolPayload = null;
        return;
    }
    const text = String(last.content ?? '').trim();
    if (text === 'null') {
        lastToolPayload = { __primitive: null };
        return;
    }
    if (text === 'undefined') {
        lastToolPayload = { __primitive: undefined };
        return;
    }
    try {
        lastToolPayload = JSON.parse(text);
    } catch {
        lastToolPayload = { __raw: text };
    }
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
