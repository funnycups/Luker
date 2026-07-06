// @jest-environment node
import { jest } from '@jest/globals';

jest.unstable_mockModule('../../public/scripts/skills/embed-export-helper.js', () => ({
    packAndAttachSkillsForExport: jest.fn(async ({ attachTo }) => {
        // Simulate the helper's real behavior: mutate attachTo in place
        // with a synthetic embedded_skills_source object.
        if (attachTo && typeof attachTo === 'object') {
            attachTo.extensions = attachTo.extensions || {};
            attachTo.extensions.luker = attachTo.extensions.luker || {};
            attachTo.extensions.luker.embedded_skills_source = { skills: [{ name: 'attached' }] };
        }
        return attachTo?.extensions?.luker?.embedded_skills_source || null;
    }),
}));

let embedExportHook;
let packAndAttachSkillsForExport;

beforeAll(async () => {
    embedExportHook = await import('../../public/scripts/skills/embed-export-hook.js');
    const helper = await import('../../public/scripts/skills/embed-export-helper.js');
    packAndAttachSkillsForExport = helper.packAndAttachSkillsForExport;
});

beforeEach(() => {
    jest.clearAllMocks();
});

function makeContext({ listReturns = [], popupReturns = 1 } = {}) {
    return {
        skills: { list: jest.fn(async () => listReturns) },
        callGenericPopup: jest.fn(async () => popupReturns),
        POPUP_TYPE: { CONFIRM: 1 },
    };
}

describe('maybeAttachSkillsToOrchPresetExport', () => {
    test('attaches when scope has skills and user confirms', async () => {
        const context = makeContext({ listReturns: [{ name: 'skillA' }] });
        const payload = {
            format: 'PORTABLE_PROFILE_V3',
            mode: 'director',
            exportedAt: '2026-01-01T00:00:00.000Z',
            profile: { name: 'RP4' },
        };
        const result = await embedExportHook.maybeAttachSkillsToOrchPresetExport({
            context, payload, t: (s) => s,
        });
        expect(result).toBe(true);
        expect(context.skills.list).toHaveBeenCalledWith({
            scope: { kind: 'orch-preset', mode: 'director', name: 'RP4' },
        });
        expect(packAndAttachSkillsForExport).toHaveBeenCalledWith({
            context,
            targetScope: { kind: 'orch-preset', mode: 'director', name: 'RP4' },
            attachTo: payload,
        });
        // Confirm the mutation happened (payload now carries embedded source).
        expect(payload.extensions?.luker?.embedded_skills_source).toBeDefined();
    });

    test('early-bails when scope has no skills (no popup, no attach)', async () => {
        const context = makeContext({ listReturns: [] });
        const payload = {
            format: 'PORTABLE_PROFILE_V4',
            mode: 'loop',
            exportedAt: '2026-01-01T00:00:00.000Z',
            profile: { name: 'MyLoop' },
        };
        const result = await embedExportHook.maybeAttachSkillsToOrchPresetExport({
            context, payload, t: (s) => s,
        });
        expect(result).toBe(false);
        expect(context.callGenericPopup).not.toHaveBeenCalled();
        expect(packAndAttachSkillsForExport).not.toHaveBeenCalled();
    });

    test('skips attach when user declines popup', async () => {
        const context = makeContext({ listReturns: [{ name: 'skillA' }], popupReturns: 0 });
        const payload = {
            format: 'PORTABLE_PROFILE_V2',
            mode: 'agenda',
            exportedAt: '2026-01-01T00:00:00.000Z',
            profile: { name: 'PlanA' },
        };
        const result = await embedExportHook.maybeAttachSkillsToOrchPresetExport({
            context, payload, t: (s) => s,
        });
        expect(result).toBe(false);
        expect(packAndAttachSkillsForExport).not.toHaveBeenCalled();
    });

    test('is a no-op when payload.mode or payload.profile.name missing', async () => {
        const context = makeContext({ listReturns: [{ name: 'skillA' }] });
        const result1 = await embedExportHook.maybeAttachSkillsToOrchPresetExport({
            context, payload: { format: 'x', mode: 'director' }, t: (s) => s,
        });
        const result2 = await embedExportHook.maybeAttachSkillsToOrchPresetExport({
            context, payload: { format: 'x', profile: { name: 'RP4' } }, t: (s) => s,
        });
        expect(result1).toBe(false);
        expect(result2).toBe(false);
        expect(context.skills.list).not.toHaveBeenCalled();
    });
});
