// @jest-environment node
import { jest } from '@jest/globals';

let hooks;

beforeAll(async () => {
    hooks = await import('../../public/scripts/extensions/orchestrator/preset-lifecycle-hooks.js');
});

function makeContext({ skills = {}, eventTypes = {}, emitError = null } = {}) {
    const emit = jest.fn(async (name, payload) => {
        if (emitError) throw emitError;
    });
    return {
        context: {
            skills,
            eventTypes,
            eventSource: { emit },
        },
        emit,
    };
}

describe('copyOrchPresetSkills', () => {
    test('calls skills.copyScope with correct fromScope/toScope shapes', async () => {
        const copyScope = jest.fn(async () => null);
        const { context } = makeContext({ skills: { copyScope } });
        await hooks.copyOrchPresetSkills(context, {
            mode: 'director', oldName: 'RP4', newName: 'RP5',
        });
        expect(copyScope).toHaveBeenCalledTimes(1);
        expect(copyScope).toHaveBeenCalledWith(
            { kind: 'orch-preset', mode: 'director', name: 'RP4' },
            { kind: 'orch-preset', mode: 'director', name: 'RP5' },
        );
    });

    test('is a no-op when oldName === newName', async () => {
        const copyScope = jest.fn();
        const { context } = makeContext({ skills: { copyScope } });
        await hooks.copyOrchPresetSkills(context, {
            mode: 'director', oldName: 'same', newName: 'same',
        });
        expect(copyScope).not.toHaveBeenCalled();
    });

    test('swallows 404 (source has no skills) silently — no console.warn', async () => {
        const err = new Error('skill scope not found: orch-preset/director/RP4');
        err.status = 404;
        const copyScope = jest.fn(async () => { throw err; });
        const warnSpy = jest.spyOn(console, 'warn').mockImplementation(() => {});
        const { context } = makeContext({ skills: { copyScope } });
        await hooks.copyOrchPresetSkills(context, {
            mode: 'director', oldName: 'RP4', newName: 'RP5',
        });
        expect(warnSpy).not.toHaveBeenCalled();
        warnSpy.mockRestore();
    });

    test('logs on non-404 error but does not throw', async () => {
        const err = new Error('destination already exists');
        err.status = 409;
        const copyScope = jest.fn(async () => { throw err; });
        const warnSpy = jest.spyOn(console, 'warn').mockImplementation(() => {});
        const { context } = makeContext({ skills: { copyScope } });
        await expect(hooks.copyOrchPresetSkills(context, {
            mode: 'director', oldName: 'RP4', newName: 'RP5',
        })).resolves.not.toThrow();
        expect(warnSpy).toHaveBeenCalledTimes(1);
        expect(warnSpy.mock.calls[0][0]).toContain('duplicate preset skills copy failed');
        warnSpy.mockRestore();
    });
});

describe('renameOrchPresetSkills', () => {
    test('calls skills.renameScope with {mode, name} newName shape (orch-preset requires object)', async () => {
        const renameScope = jest.fn(async () => null);
        const { context } = makeContext({ skills: { renameScope } });
        await hooks.renameOrchPresetSkills(context, {
            mode: 'agenda', oldName: 'planA', newName: 'planB',
        });
        expect(renameScope).toHaveBeenCalledWith(
            { kind: 'orch-preset', mode: 'agenda', name: 'planA' },
            { mode: 'agenda', name: 'planB' },
        );
    });
});

describe('emitOrchPresetDeleted', () => {
    test('emits ORCH_PRESET_DELETED with {mode, name} payload', async () => {
        const { context, emit } = makeContext({
            eventTypes: { ORCH_PRESET_DELETED: 'orch_preset_deleted' },
        });
        await hooks.emitOrchPresetDeleted(context, { mode: 'director', name: 'RP4' });
        expect(emit).toHaveBeenCalledWith('orch_preset_deleted', { mode: 'director', name: 'RP4' });
    });

    test('is a no-op when eventTypes.ORCH_PRESET_DELETED is undefined', async () => {
        const { context, emit } = makeContext({ eventTypes: {} });
        await hooks.emitOrchPresetDeleted(context, { mode: 'director', name: 'RP4' });
        expect(emit).not.toHaveBeenCalled();
    });
});

describe('emitOrchPresetExportReady', () => {
    test('emits with payload as sole positional argument (matches OAI convention)', async () => {
        const payload = { format: 'PORTABLE_PROFILE_V2', mode: 'director', profile: { name: 'RP4' } };
        const { context, emit } = makeContext({
            eventTypes: { ORCH_PRESET_EXPORT_READY: 'orch_preset_export_ready' },
        });
        await hooks.emitOrchPresetExportReady(context, payload);
        expect(emit).toHaveBeenCalledWith('orch_preset_export_ready', payload);
    });
});

describe('emitOrchPresetImportReady', () => {
    test('emits with {data, mode, name} payload (mirrors OAI {data, presetName} with mode extension)', async () => {
        const data = { name: 'RP5', mainAgent: { systemPrompt: 'x' } };
        const { context, emit } = makeContext({
            eventTypes: { ORCH_PRESET_IMPORT_READY: 'orch_preset_import_ready' },
        });
        await hooks.emitOrchPresetImportReady(context, { data, mode: 'director', name: 'RP5' });
        expect(emit).toHaveBeenCalledWith('orch_preset_import_ready', {
            data, mode: 'director', name: 'RP5',
        });
    });
});
