// @jest-environment node
import { jest } from '@jest/globals';

// New behavior (post cross-scope active-skills export):
//   maybeAttachSkillsToOrchPresetExport asks the orchestrator plugin (via
//   context.getExtensionApi('orchestrator').collectResolvedSkillsForOrchPreset)
//   for the union of skills any agent in the profile can see, groups by
//   source scope, calls context.skills.packForEmbed({scope, names}) per
//   group, merges items[] with orch-preset > preset > global precedence,
//   and attaches {version:1, items:[...]} to
//   payload.extensions.luker.embedded_skills_source.
//
// If the orchestrator API is unavailable (dev/test without plugin), the
// hook falls back to the prior scope-local behavior (context.skills.list
// on the target orch-preset scope + packAndAttachSkillsForExport).

let embedExportHook;

beforeAll(async () => {
    embedExportHook = await import('../../public/scripts/skills/embed-export-hook.js');
});

beforeEach(() => {
    jest.clearAllMocks();
});

function makeContext({
    resolverReturns = null,       // Map or null → skip orch API (test fallback)
    packReturns = null,
    popupReturns = 1,
    listReturns = [],             // used only by fallback path
} = {}) {
    const ctx = {
        skills: {
            list: jest.fn(async () => listReturns),
            packForEmbed: jest.fn(async ({ scope, names }) => {
                if (packReturns && typeof packReturns === 'object') {
                    const items = packReturns[scope.kind];
                    if (Array.isArray(items)) return { version: 1, items };
                }
                return {
                    version: 1,
                    items: names.map(n => ({ bundleFormat: 'inline-files-v1', name: n, files: [] })),
                };
            }),
        },
        callGenericPopup: jest.fn(async () => popupReturns),
        POPUP_TYPE: { CONFIRM: 1 },
    };
    if (resolverReturns instanceof Map) {
        ctx.getExtensionApi = jest.fn((name) => {
            if (name !== 'orchestrator') return null;
            return { collectResolvedSkillsForOrchPreset: jest.fn(async () => resolverReturns) };
        });
    }
    return ctx;
}

describe('maybeAttachSkillsToOrchPresetExport', () => {
    test('attaches merged multi-scope items when user confirms', async () => {
        // Resolver output: one skill in global, one in orch-preset.
        const ctx = makeContext({
            resolverReturns: new Map([
                ['global||', { scope: { kind: 'global' }, names: ['skillG'] }],
                ['orch-preset|RP4|director', { scope: { kind: 'orch-preset', mode: 'director', name: 'RP4' }, names: ['skillO'] }],
            ]),
        });
        const payload = {
            format: 'PORTABLE_PROFILE_V3',
            mode: 'director',
            name: 'RP4',
            exportedAt: '2026-01-01T00:00:00.000Z',
            profile: { name: 'RP4' },
        };
        const result = await embedExportHook.maybeAttachSkillsToOrchPresetExport({
            context: ctx, payload, t: (s) => s,
        });
        expect(result).toBe(true);
        expect(ctx.skills.packForEmbed).toHaveBeenCalledTimes(2);
        const items = payload.extensions.luker.embedded_skills_source.items;
        expect(items.map(i => i.name).sort()).toEqual(['skillG', 'skillO']);
    });

    test('cross-scope name collision: orch-preset copy wins over global', async () => {
        const ctx = makeContext({
            resolverReturns: new Map([
                ['global||', { scope: { kind: 'global' }, names: ['shared'] }],
                ['orch-preset|RP4|director', { scope: { kind: 'orch-preset', mode: 'director', name: 'RP4' }, names: ['shared'] }],
            ]),
            packReturns: {
                global: [{ bundleFormat: 'inline-files-v1', name: 'shared', files: [{ path: 'SKILL.md', encoding: 'utf8', content: 'GLOBAL' }] }],
                'orch-preset': [{ bundleFormat: 'inline-files-v1', name: 'shared', files: [{ path: 'SKILL.md', encoding: 'utf8', content: 'ORCH' }] }],
            },
        });
        const payload = {
            format: 'PORTABLE_PROFILE_V3', mode: 'director', name: 'RP4',
            exportedAt: '', profile: { name: 'RP4' },
        };
        const result = await embedExportHook.maybeAttachSkillsToOrchPresetExport({
            context: ctx, payload, t: (s) => s,
        });
        expect(result).toBe(true);
        const items = payload.extensions.luker.embedded_skills_source.items;
        expect(items).toHaveLength(1);
        expect(items[0].name).toBe('shared');
        expect(items[0].files[0].content).toBe('ORCH');
    });

    test('early-bails when resolver returns empty (no popup, no pack)', async () => {
        const ctx = makeContext({ resolverReturns: new Map() });
        const payload = {
            format: 'PORTABLE_PROFILE_V4',
            mode: 'loop',
            name: 'MyLoop',
            exportedAt: '',
            profile: { name: 'MyLoop' },
        };
        const result = await embedExportHook.maybeAttachSkillsToOrchPresetExport({
            context: ctx, payload, t: (s) => s,
        });
        expect(result).toBe(false);
        expect(ctx.callGenericPopup).not.toHaveBeenCalled();
        expect(ctx.skills.packForEmbed).not.toHaveBeenCalled();
    });

    test('skips attach when user declines popup', async () => {
        const ctx = makeContext({
            resolverReturns: new Map([
                ['orch-preset|PlanA|agenda', { scope: { kind: 'orch-preset', mode: 'agenda', name: 'PlanA' }, names: ['skillA'] }],
            ]),
            popupReturns: 0,
        });
        const payload = {
            format: 'PORTABLE_PROFILE_V2', mode: 'agenda', name: 'PlanA',
            exportedAt: '', profile: { planner: {}, agents: [], finalAgentId: '', limits: {}, defaultTools: {}, customTools: [] },
        };
        const result = await embedExportHook.maybeAttachSkillsToOrchPresetExport({
            context: ctx, payload, t: (s) => s,
        });
        expect(result).toBe(false);
        expect(ctx.skills.packForEmbed).not.toHaveBeenCalled();
    });

    test('is a no-op when payload.mode or payload.name missing', async () => {
        const ctx = makeContext({ resolverReturns: new Map() });
        const result1 = await embedExportHook.maybeAttachSkillsToOrchPresetExport({
            context: ctx, payload: { format: 'x', mode: 'director' }, t: (s) => s,
        });
        const result2 = await embedExportHook.maybeAttachSkillsToOrchPresetExport({
            context: ctx, payload: { format: 'x', name: 'RP4' }, t: (s) => s,
        });
        expect(result1).toBe(false);
        expect(result2).toBe(false);
    });

    // Regression: agenda/loop/spec sanitizers return profile literals WITHOUT
    // `.name` (only director's `sanitizeDirectorProfile` passes it through).
    // `buildPortablePayloadForMode` stamps the preset name on the envelope
    // itself so the hook can read it uniformly for all 4 modes.
    test('reads name from payload envelope for agenda/spec/loop shapes without profile.name', async () => {
        const ctx = makeContext({
            resolverReturns: new Map([
                ['orch-preset|PlanA|agenda', { scope: { kind: 'orch-preset', mode: 'agenda', name: 'PlanA' }, names: ['skillA'] }],
            ]),
        });
        const payload = {
            format: 'PORTABLE_PROFILE_V2',
            mode: 'agenda',
            name: 'PlanA',
            exportedAt: '2026-01-01T00:00:00.000Z',
            profile: { planner: {}, agents: [], finalAgentId: '', limits: {}, defaultTools: {}, customTools: [] },
        };
        const result = await embedExportHook.maybeAttachSkillsToOrchPresetExport({
            context: ctx, payload, t: (s) => s,
        });
        expect(result).toBe(true);
        expect(payload.extensions?.luker?.embedded_skills_source).toBeDefined();
        expect(payload.extensions.luker.embedded_skills_source.items).toHaveLength(1);
    });

    // Fallback path: when the orchestrator plugin isn't loaded (dev/test),
    // the hook falls back to the scope-local behavior so exports still
    // include any skill that happens to live in orch-preset scope.
    test('falls back to scope-local list when orchestrator plugin missing', async () => {
        const ctx = makeContext({ listReturns: [{ name: 'skillLocal' }] });
        // No resolverReturns → no getExtensionApi wired.
        const payload = {
            format: 'PORTABLE_PROFILE_V3', mode: 'director', name: 'RP4',
            exportedAt: '', profile: { name: 'RP4' },
        };
        const result = await embedExportHook.maybeAttachSkillsToOrchPresetExport({
            context: ctx, payload, t: (s) => s,
        });
        expect(result).toBe(true);
        expect(ctx.skills.list).toHaveBeenCalledWith({
            scope: { kind: 'orch-preset', mode: 'director', name: 'RP4' },
        });
    });
});
