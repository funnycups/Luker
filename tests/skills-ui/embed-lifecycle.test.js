/**
 * Skill embed lifecycle (character/preset import + delete).
 *
 * Pure composition tests cover `extractCharacterPayloads`, `mergePayloads`, and
 * `registerSkillEmbedLifecycle` subscription idempotence.
 *
 * Lifecycle cascade-delete and import-flow tests execute against a real
 * `SkillRepository` and real `embed.js` preview/materialization on managed
 * directories rather than fake list/delete/extract stubs. Genuine browser popup
 * DOM flows are covered separately in `character/38`, `character/39`,
 * `character/48`, `preset/66`, and `regression/123`.
 */

import { describe, test, expect, jest, beforeEach, afterEach } from '@jest/globals';
import { createSkillRepository } from '../../src/skills/repository.js';
import { computeEmbedItemHash, materializeFromEmbed, parseEmbedPayload } from '../../src/skills/embed.js';
import { currentScopeForResources } from '../harness/storage-scope.js';

function skillMd(name, body = `Body for ${name}.`) {
    return ['---', `name: ${name}`, `description: "Description for ${name}"`, '---', '', body, ''].join('\n');
}

function makePayload(items) {
    return {
        version: 1,
        items: items.map(name => ({
            name,
            bundleFormat: 'inline-files-v1',
            files: [{ path: 'SKILL.md', encoding: 'utf8', content: skillMd(name) }],
        })),
    };
}

async function createRealSkillsAdapter({ deleteOverride } = {}) {
    const dir = (await currentScopeForResources().directory('embed-lifecycle-skills')).path;
    const repo = createSkillRepository(dir);

    const api = {
        list: jest.fn(({ scope }) => repo.list({ scope })),
        delete: jest.fn(async (scope, name) => {
            if (deleteOverride) return deleteOverride(scope, name, () => repo.delete(name, scope));
            return repo.delete(name, scope);
        }),
        deleteScope: jest.fn((scope) => repo.deleteScope(scope)),
        previewExtractEmbed: jest.fn(async ({ payload, targetScope }) => {
            const items = await parseEmbedPayload(payload);
            const existing = await repo.list({ scope: targetScope });
            const byName = new Map(existing.map(entry => [entry.name, entry]));
            const result = [];
            for (const item of items) {
                const hash = await computeEmbedItemHash(item);
                const cur = byName.get(item.name);
                const conflict = !cur ? 'new' : (cur.installedHash === hash ? 'same' : 'different');
                result.push({ name: item.name, conflict });
            }
            return { items: result };
        }),
        executeExtractEmbed: jest.fn(({ payload, targetScope, conflictStrategies }) =>
            materializeFromEmbed({ repository: repo, payload, targetScope, conflictStrategies }),
        ),
    };

    const seed = async (scope, names) => {
        for (const name of names) {
            await repo.install({
                scope,
                payload: { files: [{ path: 'SKILL.md', encoding: 'utf8', content: skillMd(name) }] },
            });
        }
    };

    return { dir, repo, api, seed };
}

async function waitUntil(predicate, timeoutMs = 5000) {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
        if (await predicate()) return;
        await new Promise(resolve => setTimeout(resolve, 10));
    }
    throw new Error('Timed out waiting for async lifecycle condition');
}

function makeContext({
    skills,
    extensionSettings = {},
    characters = [],
    characterId = undefined,
} = {}) {
    return {
        skills: skills || {
            list: jest.fn(async () => []),
            delete: jest.fn(async () => null),
            previewExtractEmbed: jest.fn(async () => ({ items: [] })),
            executeExtractEmbed: jest.fn(async () => ({ installed: [], skipped: [] })),
        },
        characters,
        characterId,
        extensionSettings,
        callGenericPopup: jest.fn(),
        POPUP_TYPE: { TEXT: 1, CONFIRM: 2 },
        POPUP_RESULT: { AFFIRMATIVE: 1, NEGATIVE: 0 },
        Popup: class {
            constructor(html, type, _val, opts) {
                this.html = html; this.type = type; this.opts = opts;
                this.dlg = {
                    querySelectorAll: () => [],
                };
            }
            async show() {
                if (this.opts && typeof this.opts.onClosing === 'function') {
                    this.opts.onClosing({ result: 1, dlg: this.dlg });
                }
                return 1; // AFFIRMATIVE
            }
        },
        accountStorage: {
            _store: new Map(),
            getItem(k) { return this._store.get(k) || null; },
            setItem(k, v) { this._store.set(k, v); },
            removeItem(k) { this._store.delete(k); },
        },
        eventSource: {
            _listeners: new Map(),
            on(event, handler) {
                if (!this._listeners.has(event)) this._listeners.set(event, []);
                this._listeners.get(event).push(handler);
            },
            emit(event, payload) {
                const list = this._listeners.get(event) || [];
                return Promise.all(list.map(h => h(payload)));
            },
        },
        eventTypes: {
            CHAT_CHANGED: 'chat_id_changed',
            OAI_PRESET_IMPORT_READY: 'oai_preset_import_ready',
            CHARACTER_DELETED: 'characterDeleted',
            PRESET_DELETED: 'preset_deleted',
        },
    };
}

describe('embed-lifecycle — pure helpers and real repository cascade', () => {
    let mod;

    beforeEach(async () => {
        mod = await import('../../public/scripts/skills/embed-lifecycle.js');
    });

    test('extractCharacterPayloads returns 0 when nothing embedded', () => {
        expect(mod.extractCharacterPayloads({})).toEqual([]);
        expect(mod.extractCharacterPayloads({ data: {} })).toEqual([]);
        expect(mod.extractCharacterPayloads({ data: { extensions: {} } })).toEqual([]);
    });

    test('extractCharacterPayloads returns the character-own payload', () => {
        const payload = makePayload(['a']);
        const character = {
            data: {
                extensions: { luker: { embedded_skills_source: payload } },
            },
        };
        const out = mod.extractCharacterPayloads(character);
        expect(out).toHaveLength(1);
        expect(out[0]).toBe(payload);
    });

    test('extractCharacterPayloads returns own + every card-bound preset payload', () => {
        const ownPayload = makePayload(['own']);
        const firstPreset = makePayload(['first']);
        const secondPreset = makePayload(['second']);
        const character = {
            data: {
                extensions: {
                    luker: {
                        embedded_skills_source: ownPayload,
                        chat_completion_preset: {
                            presets: [
                                { name: 'A', preset: { extensions: { luker: { embedded_skills_source: firstPreset } } } },
                                { name: 'B', preset: { temperature: 1 } },
                                { name: 'C', preset: { extensions: { luker: { embedded_skills_source: secondPreset } } } },
                            ],
                            defaultPresetName: 'A',
                        },
                    },
                },
            },
        };
        const out = mod.extractCharacterPayloads(character);
        expect(out).toHaveLength(3);
        expect(out[0]).toBe(ownPayload);
        expect(out[1]).toBe(firstPreset);
        expect(out[2]).toBe(secondPreset);
    });

    test('extractCharacterPayloads reads the legacy single-binding chat completion preset', () => {
        const payload = makePayload(['legacy']);
        expect(mod.extractCharacterPayloads({ data: { extensions: { luker: {
            chat_completion_preset: { preset: { extensions: { luker: { embedded_skills_source: payload } } } },
        } } } })).toEqual([payload]);
    });

    test('extractCharacterPayloads still reads the hand-authored bound_preset field', () => {
        const boundPayload = makePayload(['bound']);
        const character = {
            data: {
                extensions: {
                    luker: {
                        bound_preset: {
                            extensions: { luker: { embedded_skills_source: boundPayload } },
                        },
                    },
                },
            },
        };
        const out = mod.extractCharacterPayloads(character);
        expect(out).toEqual([boundPayload]);
    });

    test('mergePayloads concatenates item arrays', () => {
        const a = makePayload(['x']);
        const b = makePayload(['y', 'z']);
        const merged = mod.mergePayloads([a, b]);
        expect(merged.version).toBe(1);
        expect(merged.items).toHaveLength(3);
        expect(merged.items.map(i => i.name)).toEqual(['x', 'y', 'z']);
    });

    test('mergePayloads returns null for empty input', () => {
        expect(mod.mergePayloads([])).toBeNull();
        expect(mod.mergePayloads(null)).toBeNull();
    });

    test('mergePayloads returns single payload unmodified', () => {
        const a = makePayload(['x']);
        expect(mod.mergePayloads([a])).toBe(a);
    });

    test('cascadeDeleteSkillsInScope deletes each installed skill from the real repository', async () => {
        const { repo, api, seed } = await createRealSkillsAdapter();
        const scope = { kind: 'character', characterFile: 'A.png' };
        await seed(scope, ['a', 'b', 'c']);
        const ctx = makeContext({ skills: api });
        const out = await mod.cascadeDeleteSkillsInScope({ context: ctx, scope });
        expect(out).toEqual({ deleted: 3, failed: 0 });
        expect(await repo.list({ scope })).toEqual([]);
    });

    test('cascadeDeleteSkillsInScope continues deleting sibling skills when one delete fails', async () => {
        const { repo, api, seed } = await createRealSkillsAdapter({
            deleteOverride: async (_scope, name, proceed) => {
                if (name === 'b') throw new Error('nope');
                return proceed();
            },
        });
        const scope = { kind: 'character', characterFile: 'Partial.png' };
        await seed(scope, ['a', 'b']);
        const ctx = makeContext({ skills: api });
        const out = await mod.cascadeDeleteSkillsInScope({ context: ctx, scope });
        expect(out).toEqual({ deleted: 1, failed: 1 });
        expect((await repo.list({ scope })).map(skill => skill.name)).toEqual(['b']);
    });

    test('cascadeDeleteSkillsInScope handles empty scope without deleting', async () => {
        const { api } = await createRealSkillsAdapter();
        const ctx = makeContext({ skills: api });
        const out = await mod.cascadeDeleteSkillsInScope({
            context: ctx,
            scope: { kind: 'character', characterFile: 'Empty.png' },
        });
        expect(out).toEqual({ deleted: 0, failed: 0 });
        expect(api.delete).not.toHaveBeenCalled();
    });
});

describe('embed-lifecycle — character handlers', () => {
    let origToastr;

    // eslint-disable-next-line playwright/no-duplicate-hooks
    beforeEach(() => {
        origToastr = global.toastr;
        global.toastr = { info: jest.fn(), success: jest.fn(), error: jest.fn() };
    });

    // eslint-disable-next-line playwright/no-duplicate-hooks
    afterEach(() => {
        global.toastr = origToastr;
    });

    test('checkCharEmbeddedSkills: no character → no-op', async () => {
        const mod = await import('../../public/scripts/skills/embed-lifecycle.js');
        const { api } = await createRealSkillsAdapter();
        const ctx = makeContext({ skills: api });
        await mod.checkCharEmbeddedSkills({ context: ctx });
        expect(api.previewExtractEmbed).not.toHaveBeenCalled();
    });

    test('checkCharEmbeddedSkills: character without payload → no-op', async () => {
        const mod = await import('../../public/scripts/skills/embed-lifecycle.js');
        const { api } = await createRealSkillsAdapter();
        const ctx = makeContext({
            skills: api,
            characters: [{ avatar: 'A.png', data: {} }],
            characterId: 0,
        });
        await mod.checkCharEmbeddedSkills({ context: ctx });
        expect(api.previewExtractEmbed).not.toHaveBeenCalled();
    });

    test('checkCharEmbeddedSkills: character with payload → previews and materializes into real character scope', async () => {
        const mod = await import('../../public/scripts/skills/embed-lifecycle.js');
        const { repo, api } = await createRealSkillsAdapter();
        const payload = makePayload(['s1', 's2']);
        const ctx = makeContext({
            characters: [{
                avatar: 'A.png',
                data: {
                    extensions: { luker: { embedded_skills_source: payload } },
                },
            }],
            characterId: 0,
            skills: api,
        });
        await mod.checkCharEmbeddedSkills({ context: ctx });
        const installed = await repo.list({ scope: { kind: 'character', characterFile: 'A.png' } });
        expect(installed.map(skill => skill.name)).toEqual(['s1', 's2']);
    });

    test('checkCharEmbeddedSkills: already prompted (accountStorage flag) → no-op', async () => {
        const mod = await import('../../public/scripts/skills/embed-lifecycle.js');
        const { api } = await createRealSkillsAdapter();
        const payload = makePayload(['s1']);
        const ctx = makeContext({
            skills: api,
            characters: [{
                avatar: 'A.png',
                data: { extensions: { luker: { embedded_skills_source: payload } } },
            }],
            characterId: 0,
        });
        ctx.accountStorage.setItem('AlertSkills_A.png', 'true');
        await mod.checkCharEmbeddedSkills({ context: ctx });
        expect(api.previewExtractEmbed).not.toHaveBeenCalled();
    });

    test('onCharacterDeletedCascade: removes character-scope skills from real repository and clears prompt flag', async () => {
        const mod = await import('../../public/scripts/skills/embed-lifecycle.js');
        const { repo, api, seed } = await createRealSkillsAdapter();
        const scope = { kind: 'character', characterFile: 'A.png' };
        await seed(scope, ['s1', 's2']);
        const ctx = makeContext({ skills: api });
        ctx.accountStorage.setItem('AlertSkills_A.png', 'true');
        await mod.onCharacterDeletedCascade(
            { id: 0, character: { avatar: 'A.png' } },
            { context: ctx },
        );
        expect(await repo.list({ scope })).toEqual([]);
        expect(ctx.accountStorage.getItem('AlertSkills_A.png')).toBeNull();
    });

    test('onCharacterDeletedCascade: missing avatar → no-op', async () => {
        const mod = await import('../../public/scripts/skills/embed-lifecycle.js');
        const { api } = await createRealSkillsAdapter();
        const ctx = makeContext({ skills: api });
        await mod.onCharacterDeletedCascade({ character: {} }, { context: ctx });
        expect(api.list).not.toHaveBeenCalled();
    });
});

describe('embed-lifecycle — preset handlers', () => {
    let origToastr;

    // eslint-disable-next-line playwright/no-duplicate-hooks
    beforeEach(() => {
        origToastr = global.toastr;
        global.toastr = { info: jest.fn(), success: jest.fn(), error: jest.fn() };
    });

    // eslint-disable-next-line playwright/no-duplicate-hooks
    afterEach(() => {
        global.toastr = origToastr;
    });

    test('checkPresetEmbeddedSkills: no payload → no-op', async () => {
        const mod = await import('../../public/scripts/skills/embed-lifecycle.js');
        const { api } = await createRealSkillsAdapter();
        const ctx = makeContext({ skills: api });
        await mod.checkPresetEmbeddedSkills({ data: {}, presetName: 'rp4' }, { context: ctx });
        expect(api.previewExtractEmbed).not.toHaveBeenCalled();
    });

    test('checkPresetEmbeddedSkills: with payload → materializes into preset name scope', async () => {
        const mod = await import('../../public/scripts/skills/embed-lifecycle.js');
        const { repo, api } = await createRealSkillsAdapter();
        const payload = makePayload(['s1']);
        const ctx = makeContext({ skills: api });
        await mod.checkPresetEmbeddedSkills({
            data: { extensions: { luker: { embedded_skills_source: payload } } },
            presetName: 'pj-romance',
        }, { context: ctx });
        const installed = await repo.list({ scope: { kind: 'preset', name: 'pj-romance' } });
        expect(installed.map(skill => skill.name)).toEqual(['s1']);
    });

    test('checkPresetEmbeddedSkills: scope uses preset name regardless of active connection profile', async () => {
        const mod = await import('../../public/scripts/skills/embed-lifecycle.js');
        const { repo, api } = await createRealSkillsAdapter();
        const payload = makePayload(['s1']);
        const ctx = makeContext({
            extensionSettings: {
                connectionManager: {
                    selectedProfile: 'p1',
                    profiles: [{ id: 'p1', name: 'RP4-claude4' }],
                },
            },
            skills: api,
        });
        await mod.checkPresetEmbeddedSkills({
            data: { extensions: { luker: { embedded_skills_source: payload } } },
            presetName: 'foo',
        }, { context: ctx });
        expect((await repo.list({ scope: { kind: 'preset', name: 'foo' } })).map(skill => skill.name)).toEqual(['s1']);
        expect(await repo.list({ scope: { kind: 'preset', name: 'RP4-claude4' } })).toEqual([]);
    });

    test('checkPresetEmbeddedSkills: already prompted → no-op', async () => {
        const mod = await import('../../public/scripts/skills/embed-lifecycle.js');
        const { api } = await createRealSkillsAdapter();
        const payload = makePayload(['s1']);
        const ctx = makeContext({ skills: api });
        ctx.accountStorage.setItem('AlertSkills_preset_rp4', 'true');
        await mod.checkPresetEmbeddedSkills({
            data: { extensions: { luker: { embedded_skills_source: payload } } },
            presetName: 'rp4',
        }, { context: ctx });
        expect(api.previewExtractEmbed).not.toHaveBeenCalled();
    });

    test('onPresetDeletedCascade: removes preset-scope skills from real repository and clears prompt flag', async () => {
        const mod = await import('../../public/scripts/skills/embed-lifecycle.js');
        const { repo, api, seed } = await createRealSkillsAdapter();
        const scope = { kind: 'preset', name: 'rp4' };
        await seed(scope, ['rp-pal']);
        const ctx = makeContext({ skills: api });
        ctx.accountStorage.setItem('AlertSkills_preset_rp4', 'true');
        await mod.onPresetDeletedCascade(
            { name: 'rp4' },
            { context: ctx },
        );
        expect(await repo.list({ scope })).toEqual([]);
        expect(ctx.accountStorage.getItem('AlertSkills_preset_rp4')).toBeNull();
    });

    test('onPresetDeletedCascade: missing name → no-op', async () => {
        const mod = await import('../../public/scripts/skills/embed-lifecycle.js');
        const { api } = await createRealSkillsAdapter();
        const ctx = makeContext({ skills: api });
        await mod.onPresetDeletedCascade({}, { context: ctx });
        await mod.onPresetDeletedCascade({ apiId: 'openai' /* ignored */ }, { context: ctx });
        expect(api.list).not.toHaveBeenCalled();
    });
});

describe('embed-lifecycle — registerSkillEmbedLifecycle', () => {
    let origToastr;

    // eslint-disable-next-line playwright/no-duplicate-hooks
    beforeEach(() => {
        origToastr = global.toastr;
        global.toastr = { info: jest.fn(), success: jest.fn(), error: jest.fn() };
    });

    // eslint-disable-next-line playwright/no-duplicate-hooks
    afterEach(() => {
        global.toastr = origToastr;
    });

    test('registers all four event handlers on the context bus', async () => {
        const mod = await import('../../public/scripts/skills/embed-lifecycle.js');
        const ctx = makeContext({});
        mod.registerSkillEmbedLifecycle({ context: ctx });
        expect(ctx.eventSource._listeners.get('chat_id_changed')).toBeTruthy();
        expect(ctx.eventSource._listeners.get('oai_preset_import_ready')).toBeTruthy();
        expect(ctx.eventSource._listeners.get('characterDeleted')).toBeTruthy();
        expect(ctx.eventSource._listeners.get('preset_deleted')).toBeTruthy();
    });

    test('idempotent: double-register does not double-subscribe', async () => {
        const mod = await import('../../public/scripts/skills/embed-lifecycle.js');
        const ctx = makeContext({});
        mod.registerSkillEmbedLifecycle({ context: ctx });
        mod.registerSkillEmbedLifecycle({ context: ctx });
        expect(ctx.eventSource._listeners.get('chat_id_changed')).toHaveLength(1);
        expect(ctx.eventSource._listeners.get('characterDeleted')).toHaveLength(1);
    });

    test('idempotent across fresh context objects that share one event bus', async () => {
        const mod = await import('../../public/scripts/skills/embed-lifecycle.js');
        const first = makeContext({});
        first.eventTypes.OAI_PRESET_EXPORT_READY = 'oai_preset_export_ready';
        const second = { ...makeContext({}), eventSource: first.eventSource, eventTypes: first.eventTypes };
        mod.registerSkillEmbedLifecycle({ context: first });
        mod.registerSkillEmbedLifecycle({ context: second });
        for (const listeners of first.eventSource._listeners.values()) {
            expect(listeners).toHaveLength(1);
        }
        expect(first.eventSource._listeners.get('oai_preset_export_ready')).toHaveLength(1);
    });

    test('PRESET_DELETED event triggers real repository cascade delete', async () => {
        const mod = await import('../../public/scripts/skills/embed-lifecycle.js');
        const { repo, api, seed } = await createRealSkillsAdapter();
        const scope = { kind: 'preset', name: 'rp4' };
        await seed(scope, ['pumpernickel']);
        const ctx = makeContext({ skills: api });
        mod.registerSkillEmbedLifecycle({ context: ctx });
        await ctx.eventSource.emit('preset_deleted', { name: 'rp4' });
        await waitUntil(async () => (await repo.list({ scope })).length === 0);
        expect(await repo.list({ scope })).toEqual([]);
    });

    test('CHARACTER_DELETED event triggers real character-scope cascade delete', async () => {
        const mod = await import('../../public/scripts/skills/embed-lifecycle.js');
        const { repo, api, seed } = await createRealSkillsAdapter();
        const scope = { kind: 'character', characterFile: 'B.png' };
        await seed(scope, ['char-rule']);
        const ctx = makeContext({ skills: api });
        mod.registerSkillEmbedLifecycle({ context: ctx });
        await ctx.eventSource.emit('characterDeleted', { id: 0, character: { avatar: 'B.png' } });
        await waitUntil(async () => (await repo.list({ scope })).length === 0);
        expect(await repo.list({ scope })).toEqual([]);
    });
});
