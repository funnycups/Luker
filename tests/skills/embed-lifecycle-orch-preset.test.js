import { describe, test, expect, jest, beforeEach, afterEach } from '@jest/globals';
import { createSkillRepository } from '../../src/skills/repository.js';
import { computeEmbedItemHash, materializeFromEmbed, parseEmbedPayload } from '../../src/skills/embed.js';
import { currentScopeForResources } from '../harness/storage-scope.js';
import {
    checkOrchPresetEmbeddedSkills,
    onOrchPresetDeletedCascade,
} from '../../public/scripts/skills/embed-lifecycle.js';

function skillMd(name, body = `Instructions for ${name}.`) {
    return ['---', `name: ${name}`, `description: "Description for ${name}"`, '---', '', body, ''].join('\n');
}

async function createRealContext() {
    const dir = (await currentScopeForResources().directory('embed-lifecycle-orch-preset')).path;
    const repo = createSkillRepository(dir);
    const store = new Map();
    const accountStorage = {
        getItem: (key) => store.get(key) || null,
        setItem: (key, value) => store.set(key, value),
        removeItem: (key) => store.delete(key),
    };
    const skills = {
        list: jest.fn(({ scope }) => repo.list({ scope })),
        deleteScope: jest.fn((scope) => repo.deleteScope(scope)),
        previewExtractEmbed: jest.fn(async ({ payload, targetScope }) => {
            const items = await parseEmbedPayload(payload);
            const existing = await repo.list({ scope: targetScope });
            const byName = new Map(existing.map(entry => [entry.name, entry]));
            const out = [];
            for (const item of items) {
                const hash = await computeEmbedItemHash(item);
                const cur = byName.get(item.name);
                out.push({ name: item.name, conflict: !cur ? 'new' : (cur.installedHash === hash ? 'same' : 'different') });
            }
            return { items: out };
        }),
        executeExtractEmbed: jest.fn(({ payload, targetScope, conflictStrategies }) =>
            materializeFromEmbed({ repository: repo, payload, targetScope, conflictStrategies }),
        ),
    };
    const context = {
        skills,
        accountStorage,
        POPUP_TYPE: { TEXT: 1, CONFIRM: 2 },
        POPUP_RESULT: { AFFIRMATIVE: 1, NEGATIVE: 0 },
        Popup: class {
            constructor(_html, _type, _val, opts) {
                this.opts = opts;
                this.dlg = { querySelectorAll: () => [] };
            }
            async show() {
                if (typeof this.opts?.onClosing === 'function') {
                    this.opts.onClosing({ result: 1, dlg: this.dlg });
                }
                return 1;
            }
        },
    };
    return { repo, context };
}

describe('orch-preset embedded skill lifecycle', () => {
    let origToastr;

    beforeEach(() => {
        origToastr = global.toastr;
        global.toastr = { info: jest.fn(), success: jest.fn(), error: jest.fn() };
    });

    afterEach(() => {
        global.toastr = origToastr;
    });

    test('onOrchPresetDeletedCascade deletes the real orch-preset scope directory on disk', async () => {
        const { repo, context } = await createRealContext();
        const scope = { kind: 'orch-preset', mode: 'director', name: 'RP4' };
        await repo.install({
            scope,
            payload: { files: [{ path: 'SKILL.md', encoding: 'utf8', content: skillMd('director-skill') }] },
        });
        expect((await repo.list({ scope })).map(skill => skill.name)).toEqual(['director-skill']);

        await onOrchPresetDeletedCascade({ mode: 'director', name: 'RP4' }, { context });

        expect(await repo.list({ scope })).toEqual([]);
    });

    test('onOrchPresetDeletedCascade clears the AlertSkills_orch_preset_<mode>_<name> prompt key', async () => {
        const { context } = await createRealContext();
        context.accountStorage.setItem('AlertSkills_orch_preset_agenda_PlanA', 'true');

        await onOrchPresetDeletedCascade({ mode: 'agenda', name: 'PlanA' }, { context });

        expect(context.accountStorage.getItem('AlertSkills_orch_preset_agenda_PlanA')).toBeNull();
    });

    test('onOrchPresetDeletedCascade is a no-op when name is missing', async () => {
        const { context } = await createRealContext();
        context.accountStorage.setItem('AlertSkills_orch_preset_director_RP4', 'true');

        await onOrchPresetDeletedCascade({ mode: 'director' }, { context });

        expect(context.skills.deleteScope).not.toHaveBeenCalled();
        expect(context.accountStorage.getItem('AlertSkills_orch_preset_director_RP4')).toBe('true');
    });

    test('checkOrchPresetEmbeddedSkills materializes embedded skills into real orch-preset scope on disk', async () => {
        const { repo, context } = await createRealContext();
        const embeddedPayload = {
            version: 1,
            items: [{
                bundleFormat: 'inline-files-v1',
                name: 'skill-a',
                files: [{ path: 'SKILL.md', encoding: 'utf8', content: skillMd('skill-a', 'Director skill body.') }],
            }],
        };
        const importedData = { name: 'RP5', extensions: { luker: { embedded_skills_source: embeddedPayload } } };

        await checkOrchPresetEmbeddedSkills(
            { data: importedData, mode: 'director', name: 'RP5' },
            { context, t: (s) => s },
        );

        const scope = { kind: 'orch-preset', mode: 'director', name: 'RP5' };
        const installed = await repo.list({ scope });
        expect(installed.map(skill => skill.name)).toEqual(['skill-a']);
        const file = await repo.readFile({ scope, name: 'skill-a', path: 'SKILL.md' });
        expect(file.content).toContain('Director skill body.');
    });

    test('checkOrchPresetEmbeddedSkills is a no-op when data lacks embedded_skills_source', async () => {
        const { context } = await createRealContext();
        const bareData = { name: 'RP5', mainAgent: { systemPrompt: 'plain' } };

        await checkOrchPresetEmbeddedSkills(
            { data: bareData, mode: 'director', name: 'RP5' },
            { context, t: (s) => s },
        );

        expect(context.skills.previewExtractEmbed).not.toHaveBeenCalled();
    });
});
