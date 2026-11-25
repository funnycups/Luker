import { describe, test, expect, beforeAll, afterAll } from '@jest/globals';
import { installBrowserModuleContext } from '../util/browser-module-context.js';
import { ORCH_EXECUTION_MODE_DIRECTOR } from '../../public/scripts/extensions/orchestrator/director-defaults.js';
import { DEFAULT_LOOP_SYSTEM_PROMPT } from '../../public/scripts/extensions/orchestrator/loop-default-prompt.js';
import { DEFAULT_LAYER2_CUSTOMS, LOOP_PROFILE_DEFAULTS } from '../../public/scripts/extensions/orchestrator/persistence.js';

let browserEnv;
let createFactoryPresetForMode;
let defaultLoopProfile;
let ORCH_EXECUTION_MODE_LOOP;
let ORCH_EXECUTION_MODE_AGENDA;
let ORCH_EXECUTION_MODE_SPEC;

beforeAll(async () => {
    browserEnv = installBrowserModuleContext({
        constants: {
            promptRoles: { SYSTEM: 0, USER: 1, ASSISTANT: 2 },
            wiPosition: { before: 0, after: 1, ANTop: 2, ANBottom: 3, EMTop: 4, EMBottom: 5, atDepth: 6 },
        },
    });
    ({
        createFactoryPresetForMode,
        defaultLoopProfile,
        ORCH_EXECUTION_MODE_LOOP,
        ORCH_EXECUTION_MODE_AGENDA,
        ORCH_EXECUTION_MODE_SPEC,
    } = await import('../../public/scripts/extensions/orchestrator/defaults.js'));
});

afterAll(() => {
    browserEnv?.restore();
});

describe('createFactoryPresetForMode', () => {
    test('director mode returns an array', () => {
        const result = createFactoryPresetForMode(ORCH_EXECUTION_MODE_DIRECTOR);
        expect(Array.isArray(result)).toBe(true);
    });

    test('director mode returns exactly 2 entries', () => {
        const result = createFactoryPresetForMode(ORCH_EXECUTION_MODE_DIRECTOR);
        expect(result).toHaveLength(2);
    });

    test('director array first entry is Full (id=default-full, name="Default (记忆图 + 搜索)")', () => {
        const result = createFactoryPresetForMode(ORCH_EXECUTION_MODE_DIRECTOR);
        expect(result[0].id).toBe('default-full');
        expect(result[0].name).toBe('Default (记忆图 + 搜索)');
    });

    test('director array second entry is Minimal (id=default, name="Default (无记忆图，无搜索)")', () => {
        const result = createFactoryPresetForMode(ORCH_EXECUTION_MODE_DIRECTOR);
        expect(result[1].id).toBe('default');
        expect(result[1].name).toBe('Default (无记忆图，无搜索)');
    });

    test('director Full entry has memory_curator in sub-agents', () => {
        const result = createFactoryPresetForMode(ORCH_EXECUTION_MODE_DIRECTOR);
        const ids = result[0].subAgents.map(a => a.id);
        expect(ids).toContain('memory_curator');
    });

    test('director Minimal entry does NOT have memory_curator in sub-agents', () => {
        const result = createFactoryPresetForMode(ORCH_EXECUTION_MODE_DIRECTOR);
        const ids = result[1].subAgents.map(a => a.id);
        expect(ids).not.toContain('memory_curator');
    });

    test('loop mode returns a fresh V3 object sharing LOOP_PROFILE_DEFAULTS and DEFAULT_LOOP_SYSTEM_PROMPT', () => {
        const result = createFactoryPresetForMode(ORCH_EXECUTION_MODE_LOOP);
        expect(Array.isArray(result)).toBe(false);
        expect(typeof result).toBe('object');
        expect(result.name).toBe('Default');
        expect(defaultLoopProfile).toBe(LOOP_PROFILE_DEFAULTS);
        expect(result.system_prompt).toBe(DEFAULT_LOOP_SYSTEM_PROMPT);
        expect(result.tools.note).toEqual({ open: true, close: true });
        expect(result.tools.custom).toEqual(DEFAULT_LAYER2_CUSTOMS);
        expect(result.tools.memory).toBeUndefined();
        expect(result.tools.search).toBeUndefined();
        result.tools.custom.memory_schema = false;
        expect(LOOP_PROFILE_DEFAULTS.tools.custom.memory_schema).toBe(true);
    });

    test('director Full and Minimal tool defaults stay in lockstep with DEFAULT_LAYER2_CUSTOMS', () => {
        const [full, minimal] = createFactoryPresetForMode(ORCH_EXECUTION_MODE_DIRECTOR);
        for (const name of Object.keys(DEFAULT_LAYER2_CUSTOMS)) {
            expect(full.tools.custom[name]).toBe(true);
            expect(minimal.tools.custom[name]).toBe(false);
        }
    });

    test('agenda mode still returns a single object with name "Default"', () => {
        const result = createFactoryPresetForMode(ORCH_EXECUTION_MODE_AGENDA);
        expect(Array.isArray(result)).toBe(false);
        expect(result.name).toBe('Default');
    });

    test('spec mode still returns a single object with name "Default"', () => {
        const result = createFactoryPresetForMode(ORCH_EXECUTION_MODE_SPEC);
        expect(Array.isArray(result)).toBe(false);
        expect(result.name).toBe('Default');
    });
});
