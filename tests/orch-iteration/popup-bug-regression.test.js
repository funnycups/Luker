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

    test('iterate-target recognizes simulate via isRead / SIMULATE_TOOL_NAME', async () => {
        const src = await readOrch('lens/iterate-target.js');
        expect(src).toMatch(/SIMULATE_TOOL_NAME\s*=\s*['"]luker_orch_simulate['"]/);
        expect(src).toMatch(/isRead\s*\(/);
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

    test('iterate-target rejection branches surface Reset rejected error', async () => {
        const src = await readOrch('lens/iterate-target.js');
        expect(src).toMatch(/Reset rejected/);
        expect(src).toMatch(/not_allowed/);
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

describe('director-mode iteration: luker_orch_simulate is wired through', () => {
    let mainSrc;
    beforeAll(async () => {
        mainSrc = await readOrch('main.js');
    });

    test('director executor no longer carries the v1-skip comment', () => {
        expect(mainSrc).not.toMatch(/director\s+skips\s+simulate/i);
    });

    test('director executor routes luker_orch_simulate through runAiIterationSimulation', () => {
        const directorExecBlock = mainSrc.match(
            /async\s+function\s+executeDirectorIterationToolCalls[\s\S]+?\n}/,
        );
        expect(directorExecBlock).not.toBeNull();
        expect(directorExecBlock[0]).toMatch(/name\s*===\s*['"]luker_orch_simulate['"]/);
        expect(directorExecBlock[0]).toMatch(/runAiIterationSimulation\s*\(/);
    });

    test('director iteration tool catalog registers luker_orch_simulate', () => {
        const directorCatalogBlock = mainSrc.match(
            /isDirectorIterationSession\(session\)\)\s*\{\s*return\s*\[[\s\S]+?\];\s*\}/,
        );
        expect(directorCatalogBlock).not.toBeNull();
        expect(directorCatalogBlock[0]).toMatch(/name:\s*['"]luker_orch_simulate['"]/);
    });

    test('director iteration system prompt explains the annotation envelope', () => {
        const directorPromptBlock = mainSrc.match(
            /DEFAULT_DIRECTOR_ITERATION_MODE_BLOCK\s*=\s*\[[\s\S]+?\]\.join\('\\n'\);/,
        );
        expect(directorPromptBlock).not.toBeNull();
        expect(directorPromptBlock[0]).toMatch(/luker_orch_simulate/);
        expect(directorPromptBlock[0]).toMatch(/<simulation_chain>/);
        expect(directorPromptBlock[0]).toMatch(/<<<ANNOTATION/);
        expect(directorPromptBlock[0]).toMatch(/submitted="false"/);
    });

    test('runAiIterationSimulation has a director branch that invokes runMainAgentLoop', () => {
        expect(mainSrc).toMatch(/runMainAgentLoop/);
        expect(mainSrc).toMatch(/createMessageEditorHandle/);
        expect(mainSrc).toMatch(/isDirectorIterationSession\(session\)\s*\)\s*\{[\s\S]+?runDirectorSimulationLoop/);
    });
});

// ORCH-Post-Refactor: `luker_orch_read_<mode>_fields` tool calls must
// reach `dispatchReadFields` in the iterate-target executor.
describe('ORCH-post-refactor: profile read tool dispatch is wired to dispatchReadFields', () => {
    let targetSrc;

    beforeAll(async () => {
        targetSrc = await readOrch('lens/iterate-target.js');
    });

    test('iterate-target.js imports dispatchReadFields from iter-studio/read-fields-dispatcher', () => {
        expect(targetSrc).toMatch(
            /import\s*\{\s*dispatchReadFields\s*\}\s*from\s*['"]\.\.\/iter-studio\/read-fields-dispatcher\.js['"]/,
        );
    });

    test('iterate-target.js routes PROFILE_READ_TOOLS calls to dispatchReadFields with sanitized profile', () => {
        expect(targetSrc).toMatch(
            /if\s*\(\s*PROFILE_READ_TOOLS\.has\s*\(\s*name\s*\)\s*\)\s*\{[\s\S]+?dispatchReadFields\s*\(\s*\{\s*sanitizedProfile:\s*sanitizeForMode\s*\(/,
        );
    });
});
