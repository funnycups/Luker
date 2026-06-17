import { describe, test, expect } from '@jest/globals';
import {
    createFactoryPresetForMode,
    ORCH_EXECUTION_MODE_LOOP,
    ORCH_EXECUTION_MODE_AGENDA,
    ORCH_EXECUTION_MODE_SPEC,
} from '../../public/scripts/extensions/orchestrator/defaults.js';
import { ORCH_EXECUTION_MODE_DIRECTOR } from '../../public/scripts/extensions/orchestrator/director-defaults.js';

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

    test('loop mode still returns a single object with name "Default"', () => {
        const result = createFactoryPresetForMode(ORCH_EXECUTION_MODE_LOOP);
        expect(Array.isArray(result)).toBe(false);
        expect(typeof result).toBe('object');
        expect(result.name).toBe('Default');
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
