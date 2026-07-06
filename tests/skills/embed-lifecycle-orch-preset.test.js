// @jest-environment node
import { jest } from '@jest/globals';

jest.unstable_mockModule('../../public/scripts/skills/embed-import-dialog.js', () => ({
    runEmbedImportFlow: jest.fn(async () => ({ imported: 0, skipped: 0 })),
    getEmbeddedSkillsSource: jest.fn((body) => body?.extensions?.luker?.embedded_skills_source || null),
}));

let embedLifecycle;
let runEmbedImportFlow;

beforeAll(async () => {
    embedLifecycle = await import('../../public/scripts/skills/embed-lifecycle.js');
    const dialog = await import('../../public/scripts/skills/embed-import-dialog.js');
    runEmbedImportFlow = dialog.runEmbedImportFlow;
});

beforeEach(() => {
    jest.clearAllMocks();
});

function makeContext({ deleteScope = jest.fn(async () => null), listReturns = [] } = {}) {
    const storage = { removeItem: jest.fn(), getItem: jest.fn(() => null), setItem: jest.fn() };
    return {
        skills: { deleteScope, list: jest.fn(async () => listReturns) },
        accountStorage: storage,
        callGenericPopup: jest.fn(async () => 1),
        POPUP_TYPE: { CONFIRM: 1 },
    };
}

describe('onOrchPresetDeletedCascade', () => {
    test('calls skills.deleteScope with orch-preset kind + mode + name', async () => {
        const context = makeContext();
        await embedLifecycle.onOrchPresetDeletedCascade(
            { mode: 'director', name: 'RP4' },
            { context },
        );
        expect(context.skills.deleteScope).toHaveBeenCalledWith(
            { kind: 'orch-preset', mode: 'director', name: 'RP4' },
        );
    });

    test('clears the AlertSkills_orch_preset_<mode>_<name> prompt key', async () => {
        const context = makeContext();
        await embedLifecycle.onOrchPresetDeletedCascade(
            { mode: 'agenda', name: 'PlanA' },
            { context },
        );
        expect(context.accountStorage.removeItem).toHaveBeenCalledWith('AlertSkills_orch_preset_agenda_PlanA');
    });

    test('is a no-op when name missing', async () => {
        const context = makeContext();
        await embedLifecycle.onOrchPresetDeletedCascade({ mode: 'director' }, { context });
        expect(context.skills.deleteScope).not.toHaveBeenCalled();
        expect(context.accountStorage.removeItem).not.toHaveBeenCalled();
    });
});

describe('checkOrchPresetEmbeddedSkills', () => {
    test('runs import flow with orch-preset targetScope when embedded skills present', async () => {
        const context = makeContext();
        const embeddedPayload = { format: 'inline-files-v1', skills: [{ name: 'skillA' }] };
        const importedData = { name: 'RP5', extensions: { luker: { embedded_skills_source: embeddedPayload } } };
        await embedLifecycle.checkOrchPresetEmbeddedSkills(
            { data: importedData, mode: 'director', name: 'RP5' },
            { context, t: (s) => s },
        );
        expect(runEmbedImportFlow).toHaveBeenCalledTimes(1);
        expect(runEmbedImportFlow.mock.calls[0][0]).toMatchObject({
            context,
            payload: embeddedPayload,
            targetScope: { kind: 'orch-preset', mode: 'director', name: 'RP5' },
        });
    });

    test('is a no-op when data lacks embedded_skills_source', async () => {
        const context = makeContext();
        const bareData = { name: 'RP5', mainAgent: { systemPrompt: 'plain' } };
        await embedLifecycle.checkOrchPresetEmbeddedSkills(
            { data: bareData, mode: 'director', name: 'RP5' },
            { context, t: (s) => s },
        );
        expect(runEmbedImportFlow).not.toHaveBeenCalled();
    });
});
