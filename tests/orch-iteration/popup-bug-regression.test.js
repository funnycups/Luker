// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 FunnyCups

// Regression tests for the orchestrator iter-studio popup bug audit.
// Each block covers one of the audit findings (ORCH-1 / ORCH-6 / ORCH-2
// + ORCH-3 + ORCH-4 / ORCH-5) so a future refactor that re-introduces
// the silent-drop / locale-loss / fake-tool-name behaviour blows up
// here instead of shipping.
//
// Most assertions read source files directly (fs.readFile) instead of
// importing modules. The orchestrator's defaults.js + main.js
// transitively pull `script.js` → `MacroEnvBuilder.js` → an absolute
// path `/scripts/utils.js` which jest's resolver can't reach (same
// issue that pins `iter-workspace/preview-renderers.test.js`). The
// module-level pieces we *can* import jest-cleanly — session-store.js
// + tool-display.js — are kept as actual import-based tests.

import { describe, test, expect, jest } from '@jest/globals';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

// public/lib.js pulls in a browser bundle that can't be resolved under
// jest. Mirror the workaround other orch-iteration tests use.
jest.unstable_mockModule('../../public/lib.js', async () => {
    const { default: lodash } = await import('lodash');
    return { lodash };
});

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, '../..');
const ORCH_DIR = path.resolve(REPO_ROOT, 'public/scripts/extensions/orchestrator');

async function readOrch(rel) {
    return fs.readFile(path.resolve(ORCH_DIR, rel), 'utf8');
}

let normalizeMessageShape;
let ORCH_TOOL_DISPLAY;

beforeAll(async () => {
    ({ normalizeMessageShape } = await import(
        '../../public/scripts/extensions/orchestrator/iter-studio/session-store.js'
    ));
    ({ ORCH_TOOL_DISPLAY } = await import(
        '../../public/scripts/extensions/orchestrator/iter-studio/tool-display.js'
    ));
});

describe('ORCH-1: luker_orch_simulate is classified as a read tool', () => {
    test('tool-display map classifies simulate as read-type', () => {
        expect(ORCH_TOOL_DISPLAY.luker_orch_simulate?.type).toBe('read');
    });

    test('iter-studio recognizes simulate via isInlineExecutedTool / isSimulateTool', async () => {
        const src = await readOrch('iter-studio/studio.js');
        // The popup needs to recognize simulate as inline-executed so it
        // routes to the read-path execution that persists results to
        // assistantMsg.toolResults. Bare-string grep is enough: a
        // future refactor that drops this name would have to also
        // re-introduce some other read-routing path explicitly.
        expect(src).toMatch(/SIMULATE_TOOL_NAME\s*=\s*['"]luker_orch_simulate['"]/);
        // The read/edit split uses isInlineExecutedTool, the umbrella
        // predicate that covers reads + writes + simulate. Lorebook
        // writes share the same inline execution path because they
        // mutate real data directly (no sandbox-diff proposal step).
        expect(src).toMatch(/isInlineExecutedTool\s*\(/);
    });

    test('persisted assistant message round-trips simulate toolResults', () => {
        // The simulate read-path persists `{simulated:true, message}` (or
        // the executor's real simulation payload) on assistantMsg.toolResults.
        // Verify normalizeMessageShape preserves that on disk round-trip.
        const m = {
            id: 'msg-1',
            role: 'assistant',
            content: 'Simulated.',
            at: 100,
            toolCalls: [{ id: 'call-1', name: 'luker_orch_simulate', args: {} }],
            toolResults: [{
                tool_call_id: 'call-1',
                content: { simulated: true, message: 'simulation complete' },
                status: 'ok',
            }],
        };
        const n = normalizeMessageShape(m, 1);
        expect(n.toolResults).toEqual(m.toolResults);
        expect(n.toolCalls).toEqual(m.toolCalls);
    });
});

describe('ORCH-6: normalizeMessageShape preserves toolResults across roundtrip', () => {
    test('preserves toolResults on reload', () => {
        const m = {
            id: 'msg-1',
            role: 'assistant',
            content: 'Listed.',
            at: 100,
            toolCalls: [{ id: 'c1', name: 'lorebook_list', args: { book_name: 'main' } }],
            toolResults: [{
                tool_call_id: 'c1',
                content: { entries: [{ uid: 1, name: 'Foo' }] },
                status: 'ok',
            }],
        };
        const n = normalizeMessageShape(m, 1);
        expect(Array.isArray(n.toolResults)).toBe(true);
        expect(n.toolResults).toHaveLength(1);
        expect(n.toolResults[0].tool_call_id).toBe('c1');
    });

    test('does NOT add toolResults when missing', () => {
        const m = {
            id: 'msg-1',
            role: 'assistant',
            content: 'Hi',
            at: 100,
        };
        const n = normalizeMessageShape(m, 1);
        expect(n.toolResults).toBeUndefined();
    });

    test('drops empty toolResults array (Array.isArray gate)', () => {
        const m = {
            id: 'msg-1',
            role: 'assistant',
            content: 'Hi',
            at: 100,
            toolResults: [],
        };
        const n = normalizeMessageShape(m, 1);
        expect(n.toolResults).toBeUndefined();
    });
});

describe('ORCH-2 / ORCH-3 / ORCH-4: system prompt references only real tool names', () => {
    let defaultsSrc;
    let mainSrc;
    beforeAll(async () => {
        defaultsSrc = await readOrch('defaults.js');
        mainSrc = await readOrch('main.js');
    });

    test('defaults.js does not reference luker_orch_append_stage (fake name)', () => {
        expect(defaultsSrc).not.toMatch(/luker_orch_append_stage/);
    });

    test('defaults.js does not reference luker_orch_upsert_preset (fake name)', () => {
        expect(defaultsSrc).not.toMatch(/luker_orch_upsert_preset/);
    });

    test('defaults.js does not reference luker_orch_finalize_profile (fake name)', () => {
        expect(defaultsSrc).not.toMatch(/luker_orch_finalize_profile/);
    });

    test('defaults.js does reference luker_orch_set_stage (real name)', () => {
        expect(defaultsSrc).toMatch(/luker_orch_set_stage/);
    });

    test('defaults.js does reference luker_orch_set_preset (real name)', () => {
        expect(defaultsSrc).toMatch(/luker_orch_set_preset/);
    });

    test('defaults.js no longer references luker_orch_finalize_iteration (legacy, removed)', () => {
        // The iter popup catalog removed finalize; the autonomous orch
        // executor in main.js still handles it for its own loop, but
        // defaults.js (the director default prompt) was cleaned up to
        // describe the implicit-termination contract instead. This
        // regression guard catches a future revert.
        expect(defaultsSrc).not.toMatch(/luker_orch_finalize_iteration/);
    });

    test('main.js macros contract drops luker_orch_str_replace_field (fake name) — ORCH-3', () => {
        expect(mainSrc).not.toMatch(/luker_orch_str_replace_field/);
    });

    test('main.js does not use luker_orch_set_node.type dotted syntax — ORCH-4', () => {
        // Function names with dots are invalid in OpenAI tool catalogs;
        // any `luker_orch_<word>.<word>` is a bug.
        expect(mainSrc).not.toMatch(/luker_orch_\w+\.\w+/);
    });
});

describe('ORCH-5: reset rejection produces a system + tool error result', () => {
    test('rejected reset message persists with status=fail and error content', () => {
        // Synthetic shape — mirrors what runIterationTurn pushes onto
        // assistantMsg.toolResults for rejected reset calls. Round-trip
        // through normalizeMessageShape so the persistence layer
        // doesn't strip the fail status.
        const msg = normalizeMessageShape({
            id: 'a-1',
            role: 'assistant',
            content: '',
            at: 1,
            toolCalls: [{ id: 'reset_call_1', name: 'luker_orch_reset_live_to_blank', args: {} }],
            toolResults: [{
                tool_call_id: 'reset_call_1',
                content: { error: 'Reset rejected: this card already has an override.' },
                status: 'fail',
            }],
        }, 1);
        expect(msg.toolResults).toHaveLength(1);
        expect(msg.toolResults[0].status).toBe('fail');
        expect(String(msg.toolResults[0].content?.error || '')).toMatch(/Reset rejected/);
    });

    test('iter-studio rejection branches push system + tool result', async () => {
        const src = await readOrch('iter-studio/studio.js');
        // Locks in the rejection path: each rejection appends to
        // rejectedResets, which then pushes both a system message and a
        // fail-status tool result.
        expect(src).toMatch(/rejectedResets\.push/);
        expect(src).toMatch(/Reset rejected/);
        // Tool result entries are added to persistedToolResults with status:'fail'.
        expect(src).toMatch(/status:\s*['"]fail['"]/);
    });
});

describe('ORCH-16: lorebook guidance pulled into a separate exported constant', () => {
    test('defaults.js exports LOREBOOK_READ_GUIDANCE_LINES', async () => {
        const src = await readOrch('defaults.js');
        expect(src).toMatch(/export\s+const\s+LOREBOOK_READ_GUIDANCE_LINES/);
    });

    test('main.js imports LOREBOOK_READ_GUIDANCE_LINES and appends inside buildAiIterationSystemPrompt', async () => {
        const src = await readOrch('main.js');
        expect(src).toMatch(/LOREBOOK_READ_GUIDANCE_LINES/);
        // The append happens inside buildAiIterationSystemPrompt, after
        // the base (possibly user-customized) prompt. Locked here via a
        // shape check: the construction interleaves base + guidance +
        // macros, in that order.
        expect(src).toMatch(/withGuidance.*\.\.\.LOREBOOK_READ_GUIDANCE_LINES/s);
    });
});

describe('iter-studio Stop button: race + immediate feedback', () => {
    // The previous shape created the AbortController inside runIterationTurn
    // and only flipped state visibly in the post-await finally. That left
    // two latent gaps:
    //   1. A Stop click during the pre-flight (persistSession + render,
    //      before runIterationTurn fires) hit a null abortController and
    //      was silently dropped.
    //   2. Even when the click landed, the button kept saying "Stop" with
    //      no spinner change until the network actually dropped — which on
    //      a slow connection looked like the button was broken.
    // This block locks in: state.aborting flag, pre-seeded AbortController
    // in handleSendMessage + continueAfterReviewDecision, and runIterationTurn
    // reusing the caller-owned controller.

    test('state includes the aborting flag', async () => {
        const src = await readOrch('iter-studio/studio.js');
        expect(src).toMatch(/aborting:\s*false/);
    });

    test('busy branch sets aborting and triggers a render before returning', async () => {
        const src = await readOrch('iter-studio/studio.js');
        // The whole busy branch should: guard re-entry, set aborting,
        // call abort, and fire a best-effort render. Match the shape
        // rather than exact whitespace so future cosmetic edits don't
        // trip the regression.
        expect(src).toMatch(/if\s*\(!state\.aborting\)\s*\{[\s\S]*?state\.aborting\s*=\s*true[\s\S]*?state\.abortController\?\.abort\(\)[\s\S]*?render\(\)\.catch/);
    });

    test('handleSendMessage seeds AbortController before pre-flight awaits', async () => {
        const src = await readOrch('iter-studio/studio.js');
        // The fix lifts AC creation above the first await so a Stop
        // click during persistSession / render isn't dropped.
        expect(src).toMatch(/state\.isBusy\s*=\s*true;\s*\n\s*\/\/[^\n]*\n[\s\S]*?state\.abortController\s*=\s*new AbortController\(\);[\s\S]*?await\s+persistSession\(\);[\s\S]*?await\s+render\(\);/);
    });

    test('runIterationTurn reuses the caller-owned AbortController', async () => {
        const src = await readOrch('iter-studio/studio.js');
        // The `||` fallback keeps the function safe for callers that
        // forget to seed, but the production paths now always do.
        expect(src).toMatch(/state\.abortController\s*\|\|\s*new AbortController\(\)/);
    });

    test('render disables the Send/Stop button while aborting', async () => {
        const src = await readOrch('iter-studio/studio.js');
        expect(src).toMatch(/prop\(['"]disabled['"]\s*,\s*Boolean\(state\.aborting\)\)/);
    });

    test('finally blocks clear state.aborting alongside isBusy', async () => {
        const src = await readOrch('iter-studio/studio.js');
        // Both handleSendMessage and continueAfterReviewDecision share
        // the same finally pattern; lock in that the new flag is reset
        // in every spot the existing flags are.
        const finallyResets = src.match(/state\.aborting\s*=\s*false/g) || [];
        expect(finallyResets.length).toBeGreaterThanOrEqual(2);
    });
});

describe('director-mode iteration: luker_orch_simulate is wired through', () => {
    // Pins the wiring landed when director-mode simulate was enabled. The
    // earlier shape had `simulations = []  // director skips simulate for v1`
    // in `executeDirectorIterationToolCalls` and the director tool
    // catalog had no `luker_orch_simulate` entry, so the workbench-LLM
    // could not test director profiles via the iteration popup. Each
    // assertion catches one piece of that wiring regressing.

    let mainSrc;
    beforeAll(async () => {
        mainSrc = await readOrch('main.js');
    });

    test('director executor no longer carries the v1-skip comment', () => {
        // The old shape was `const simulations = [];  // director skips
        // simulate for v1`. Catching the comment (rather than the empty
        // initializer) keeps the assertion robust against legitimate
        // formatting changes.
        expect(mainSrc).not.toMatch(/director\s+skips\s+simulate/i);
    });

    test('director executor routes luker_orch_simulate through runAiIterationSimulation', () => {
        // The block lives between the director-specific tools and the
        // shared continue/finalize handlers; verify the dispatch shape
        // matches what loop/agenda/spec already do.
        const directorExecBlock = mainSrc.match(
            /async\s+function\s+executeDirectorIterationToolCalls[\s\S]+?\n}/
        );
        expect(directorExecBlock).not.toBeNull();
        expect(directorExecBlock[0]).toMatch(/name\s*===\s*['"]luker_orch_simulate['"]/);
        expect(directorExecBlock[0]).toMatch(/runAiIterationSimulation\s*\(/);
    });

    test('director iteration tool catalog registers luker_orch_simulate', () => {
        // The catalog is the per-mode array returned from getAiIterationTools
        // when isDirectorIterationSession(session) is true. The simulate
        // entry must sit alongside the other luker_orch_set_director_* tools.
        const directorCatalogBlock = mainSrc.match(
            /isDirectorIterationSession\(session\)\)\s*\{\s*return\s*\[[\s\S]+?\];\s*\}/
        );
        expect(directorCatalogBlock).not.toBeNull();
        expect(directorCatalogBlock[0]).toMatch(/name:\s*['"]luker_orch_simulate['"]/);
    });

    test('director iteration system prompt explains the annotation envelope', () => {
        // Shared contract paragraph spec/agenda/loop already carry.
        // The director block must teach the workbench-LLM how to read
        // <simulation_chain> / <annotations> / <status submitted="..."/>
        // so it can act on user annotations after a simulate call.
        const directorPromptBlock = mainSrc.match(
            /DEFAULT_DIRECTOR_ITERATION_MODE_BLOCK\s*=\s*\[[\s\S]+?\]\.join\('\\n'\);/
        );
        expect(directorPromptBlock).not.toBeNull();
        expect(directorPromptBlock[0]).toMatch(/luker_orch_simulate/);
        expect(directorPromptBlock[0]).toMatch(/<simulation_chain>/);
        expect(directorPromptBlock[0]).toMatch(/<<<ANNOTATION/);
        expect(directorPromptBlock[0]).toMatch(/submitted="false"/);
    });

    test('runAiIterationSimulation has a director branch that invokes runMainAgentLoop', () => {
        // Director can't go through `runOrchestration` because production
        // director runs claim SillyTavern's takeover handle from the
        // kernel — there is no callable runDirectorOrchestration. The
        // simulation path mints a throwaway editor handle and calls
        // runMainAgentLoop directly. Lock in that wiring.
        expect(mainSrc).toMatch(/runMainAgentLoop/);
        expect(mainSrc).toMatch(/createMessageEditorHandle/);
        // The director branch flows the trace it built into the existing
        // exportDirectorPayload adapter via the same `trace` accumulator
        // the agenda/loop/spec branches already use.
        expect(mainSrc).toMatch(/isDirectorIterationSession\(session\)\s*\)\s*\{[\s\S]+?runDirectorSimulationLoop/);
    });
});

// ORCH-Post-Refactor: `luker_orch_read_<mode>_fields` tool calls must
// reach `dispatchReadFields` in the popup executor. The tool schema
// existed and the AI could see + call it, but the executor's
// if/else-if dispatch chain missed the `isProfileReadTool` branch,
// so calls fell through to `runLorebookReadTool` which returned
// `{error: 'Not a lorebook read tool: <name>'}`. AI wasted rounds
// pattern-matching around a dead tool. Locked here as a code-shape
// contract on the popup's executor: (1) `isProfileReadTool` is imported
// and exported for the umbrella predicate, (2) `dispatchReadFields`
// is imported from the sibling module, (3) the dispatch chain has
// an `else if (isProfileReadTool(call?.name))` branch that awaits
// `dispatchReadFields`. Sibling studios (MG / CEA / CPA) have their
// own read-tool routes; this test covers only the orchestrator popup.
describe('ORCH-post-refactor: profile read tool dispatch is wired to dispatchReadFields', () => {
    let studioSrc;

    beforeAll(async () => {
        studioSrc = await readOrch('iter-studio/studio.js');
    });

    test('studio.js imports dispatchReadFields from the sibling read-fields-dispatcher module', () => {
        expect(studioSrc).toMatch(
            /import\s*\{\s*dispatchReadFields\s*\}\s*from\s*['"]\.\/read-fields-dispatcher\.js['"]/,
        );
    });

    test('studio.js dispatch chain routes isProfileReadTool calls to dispatchReadFields', () => {
        // The bug: profile-read calls (luker_orch_read_<mode>_fields)
        // fell into the terminal `else { runLorebookReadTool(...) }`
        // branch and got "Not a lorebook read tool" back.
        // Fix: add `else if (isProfileReadTool(call?.name)) { ... await
        // dispatchReadFields(...) }` before the terminal else. This
        // shape check locks in that both the predicate AND the executor
        // call co-occur in the dispatch chain in that order.
        expect(studioSrc).toMatch(
            /else\s+if\s*\(\s*isProfileReadTool\s*\(\s*call\?\.name\s*\)\s*\)\s*\{[\s\S]+?dispatchReadFields\s*\(/,
        );
    });

    test('studio.js sanitizes the live profile per-mode before dispatchReadFields sees it', () => {
        // The dispatcher takes a pre-sanitized profile (see the
        // read-fields.test.js contract). The popup call site must
        // route state.live through `sanitizeForMode` so any future
        // scratch/debug field on the working profile cannot leak
        // to the LLM through the read tool.
        expect(studioSrc).toMatch(
            /else\s+if\s*\(\s*isProfileReadTool\s*\(\s*call\?\.name\s*\)\s*\)\s*\{[\s\S]+?sanitizeForMode\s*\(\s*state\.live\s*\)[\s\S]+?dispatchReadFields\s*\(/,
        );
    });
});
