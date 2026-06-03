/**
 * Plan 2 Unit 5 — Skill embed lifecycle (character/preset import + delete).
 *
 * Tests the four lifecycle hooks:
 *   - checkCharEmbeddedSkills (CHAT_CHANGED → import dialog)
 *   - checkPresetEmbeddedSkills (OAI_PRESET_IMPORT_READY → import dialog)
 *   - onCharacterDeletedCascade (CHARACTER_DELETED → skill cleanup)
 *   - onPresetDeletedCascade (PRESET_DELETED → skill cleanup)
 *
 * Plus the pure helpers extractCharacterPayloads / mergePayloads /
 * getActiveConnectionProfileName / cascadeDeleteSkillsInScope.
 */

import { describe, test, expect, jest, beforeEach, afterEach } from '@jest/globals';

function makePayload(items) {
    return { version: 1, items: items.map(name => ({ name, bundleFormat: 'inline-files-v1', files: [] })) };
}

function makeContext({
    skills = {},
    extensionSettings = {},
    characters = [],
    characterId = undefined,
} = {}) {
    return {
        skills: {
            list: jest.fn(async () => []),
            delete: jest.fn(async () => null),
            previewExtractEmbed: jest.fn(async () => ({ items: [] })),
            executeExtractEmbed: jest.fn(async () => ({ installed: [], skipped: [] })),
            ...skills,
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
                    querySelectorAll: () => {
                        const arr = [];
                        arr.forEach = function (cb) { for (const e of this) cb(e); };
                        return arr;
                    },
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

describe('embed-lifecycle — pure helpers', () => {
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

    test('extractCharacterPayloads returns both own + bound-preset payloads', () => {
        const ownPayload = makePayload(['own']);
        const boundPayload = makePayload(['bound']);
        const character = {
            data: {
                extensions: {
                    luker: {
                        embedded_skills_source: ownPayload,
                        bound_preset: {
                            extensions: { luker: { embedded_skills_source: boundPayload } },
                        },
                    },
                },
            },
        };
        const out = mod.extractCharacterPayloads(character);
        expect(out).toHaveLength(2);
        expect(out[0]).toBe(ownPayload);
        expect(out[1]).toBe(boundPayload);
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

    test('getActiveConnectionProfileName reads from connectionManager', () => {
        const ctx = makeContext({
            extensionSettings: {
                connectionManager: {
                    selectedProfile: 'p1',
                    profiles: [
                        { id: 'p1', name: 'RP4-claude4' },
                        { id: 'p2', name: 'Other' },
                    ],
                },
            },
        });
        expect(mod.getActiveConnectionProfileName(ctx)).toBe('RP4-claude4');
    });

    test('getActiveConnectionProfileName returns null when no selection', () => {
        const ctx = makeContext({
            extensionSettings: {
                connectionManager: {
                    selectedProfile: null,
                    profiles: [{ id: 'p1', name: 'X' }],
                },
            },
        });
        expect(mod.getActiveConnectionProfileName(ctx)).toBeNull();
        expect(mod.getActiveConnectionProfileName({})).toBeNull();
    });

    test('cascadeDeleteSkillsInScope deletes each listed skill', async () => {
        const ctx = makeContext({
            skills: {
                list: jest.fn(async () => [{ name: 'a' }, { name: 'b' }, { name: 'c' }]),
                delete: jest.fn(async () => null),
            },
        });
        const out = await mod.cascadeDeleteSkillsInScope({
            context: ctx,
            scope: { kind: 'character', characterFile: 'A.png' },
        });
        expect(out.deleted).toBe(3);
        expect(out.failed).toBe(0);
        expect(ctx.skills.delete).toHaveBeenCalledTimes(3);
        expect(ctx.skills.delete).toHaveBeenCalledWith({ kind: 'character', characterFile: 'A.png' }, 'a');
        expect(ctx.skills.delete).toHaveBeenCalledWith({ kind: 'character', characterFile: 'A.png' }, 'b');
        expect(ctx.skills.delete).toHaveBeenCalledWith({ kind: 'character', characterFile: 'A.png' }, 'c');
    });

    test('cascadeDeleteSkillsInScope swallows per-skill failures', async () => {
        const ctx = makeContext({
            skills: {
                list: jest.fn(async () => [{ name: 'a' }, { name: 'b' }]),
                delete: jest.fn(async (_scope, name) => {
                    if (name === 'b') throw new Error('nope');
                    return null;
                }),
            },
        });
        const out = await mod.cascadeDeleteSkillsInScope({
            context: ctx,
            scope: { kind: 'global' },
        });
        expect(out.deleted).toBe(1);
        expect(out.failed).toBe(1);
    });

    test('cascadeDeleteSkillsInScope handles empty list', async () => {
        const ctx = makeContext({
            skills: {
                list: jest.fn(async () => []),
                delete: jest.fn(),
            },
        });
        const out = await mod.cascadeDeleteSkillsInScope({
            context: ctx,
            scope: { kind: 'global' },
        });
        expect(out.deleted).toBe(0);
        expect(ctx.skills.delete).not.toHaveBeenCalled();
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
        const ctx = makeContext({});
        await mod.checkCharEmbeddedSkills({ context: ctx });
        expect(ctx.skills.previewExtractEmbed).not.toHaveBeenCalled();
    });

    test('checkCharEmbeddedSkills: character without payload → no-op', async () => {
        const mod = await import('../../public/scripts/skills/embed-lifecycle.js');
        const ctx = makeContext({
            characters: [{ avatar: 'A.png', data: {} }],
            characterId: 0,
        });
        await mod.checkCharEmbeddedSkills({ context: ctx });
        expect(ctx.skills.previewExtractEmbed).not.toHaveBeenCalled();
    });

    test('checkCharEmbeddedSkills: character with payload → preview + execute', async () => {
        const mod = await import('../../public/scripts/skills/embed-lifecycle.js');
        const payload = makePayload(['s1', 's2']);
        const ctx = makeContext({
            characters: [{
                avatar: 'A.png',
                data: {
                    extensions: { luker: { embedded_skills_source: payload } },
                },
            }],
            characterId: 0,
            skills: {
                previewExtractEmbed: jest.fn(async () => ({ items: [
                    { name: 's1', conflict: 'new' },
                    { name: 's2', conflict: 'new' },
                ] })),
                executeExtractEmbed: jest.fn(async () => ({ installed: ['s1', 's2'], skipped: [] })),
            },
        });
        await mod.checkCharEmbeddedSkills({ context: ctx });
        expect(ctx.skills.previewExtractEmbed).toHaveBeenCalledTimes(1);
        const args = ctx.skills.previewExtractEmbed.mock.calls[0][0];
        expect(args.targetScope).toEqual({ kind: 'character', characterFile: 'A.png' });
        expect(ctx.skills.executeExtractEmbed).toHaveBeenCalledTimes(1);
    });

    test('checkCharEmbeddedSkills: already prompted (accountStorage flag) → no-op', async () => {
        const mod = await import('../../public/scripts/skills/embed-lifecycle.js');
        const payload = makePayload(['s1']);
        const ctx = makeContext({
            characters: [{
                avatar: 'A.png',
                data: { extensions: { luker: { embedded_skills_source: payload } } },
            }],
            characterId: 0,
        });
        ctx.accountStorage.setItem('AlertSkills_A.png', 'true');
        await mod.checkCharEmbeddedSkills({ context: ctx });
        expect(ctx.skills.previewExtractEmbed).not.toHaveBeenCalled();
    });

    test('onCharacterDeletedCascade: removes character-scope skills', async () => {
        const mod = await import('../../public/scripts/skills/embed-lifecycle.js');
        const ctx = makeContext({
            skills: {
                list: jest.fn(async () => [{ name: 's1' }, { name: 's2' }]),
                delete: jest.fn(async () => null),
            },
        });
        ctx.accountStorage.setItem('AlertSkills_A.png', 'true');
        await mod.onCharacterDeletedCascade(
            { id: 0, character: { avatar: 'A.png' } },
            { context: ctx },
        );
        expect(ctx.skills.delete).toHaveBeenCalledTimes(2);
        expect(ctx.skills.delete).toHaveBeenCalledWith(
            { kind: 'character', characterFile: 'A.png' },
            's1',
        );
        // accountStorage flag should be cleared.
        expect(ctx.accountStorage.getItem('AlertSkills_A.png')).toBeNull();
    });

    test('onCharacterDeletedCascade: missing avatar → no-op', async () => {
        const mod = await import('../../public/scripts/skills/embed-lifecycle.js');
        const ctx = makeContext({
            skills: { list: jest.fn(), delete: jest.fn() },
        });
        await mod.onCharacterDeletedCascade({ character: {} }, { context: ctx });
        expect(ctx.skills.list).not.toHaveBeenCalled();
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
        const ctx = makeContext({});
        await mod.checkPresetEmbeddedSkills({ data: {}, presetName: 'rp4' }, { context: ctx });
        expect(ctx.skills.previewExtractEmbed).not.toHaveBeenCalled();
    });

    test('checkPresetEmbeddedSkills: with payload → uses active connection profile as apiId', async () => {
        const mod = await import('../../public/scripts/skills/embed-lifecycle.js');
        const payload = makePayload(['s1']);
        const ctx = makeContext({
            extensionSettings: {
                connectionManager: {
                    selectedProfile: 'p1',
                    profiles: [{ id: 'p1', name: 'RP4-claude4' }],
                },
            },
            skills: {
                previewExtractEmbed: jest.fn(async () => ({ items: [{ name: 's1', conflict: 'new' }] })),
            },
        });
        await mod.checkPresetEmbeddedSkills({
            data: { extensions: { luker: { embedded_skills_source: payload } } },
            presetName: 'pj-romance',
        }, { context: ctx });
        const args = ctx.skills.previewExtractEmbed.mock.calls[0][0];
        expect(args.targetScope).toEqual({
            kind: 'preset',
            apiId: 'RP4-claude4',
            name: 'pj-romance',
        });
    });

    test('checkPresetEmbeddedSkills: no connection profile → falls back to openai', async () => {
        const mod = await import('../../public/scripts/skills/embed-lifecycle.js');
        const payload = makePayload(['s1']);
        const ctx = makeContext({
            skills: {
                previewExtractEmbed: jest.fn(async () => ({ items: [] })),
            },
        });
        await mod.checkPresetEmbeddedSkills({
            data: { extensions: { luker: { embedded_skills_source: payload } } },
            presetName: 'foo',
        }, { context: ctx });
        const args = ctx.skills.previewExtractEmbed.mock.calls[0][0];
        expect(args.targetScope.apiId).toBe('openai');
        expect(args.targetScope.name).toBe('foo');
    });

    test('checkPresetEmbeddedSkills: already prompted → no-op', async () => {
        const mod = await import('../../public/scripts/skills/embed-lifecycle.js');
        const payload = makePayload(['s1']);
        const ctx = makeContext({});
        ctx.accountStorage.setItem('AlertSkills_openai_rp4', 'true');
        await mod.checkPresetEmbeddedSkills({
            data: { extensions: { luker: { embedded_skills_source: payload } } },
            presetName: 'rp4',
        }, { context: ctx });
        expect(ctx.skills.previewExtractEmbed).not.toHaveBeenCalled();
    });

    test('onPresetDeletedCascade: removes preset-scope skills', async () => {
        const mod = await import('../../public/scripts/skills/embed-lifecycle.js');
        const ctx = makeContext({
            skills: {
                list: jest.fn(async () => [{ name: 'rp-pal' }]),
                delete: jest.fn(async () => null),
            },
        });
        ctx.accountStorage.setItem('AlertSkills_openai_rp4', 'true');
        await mod.onPresetDeletedCascade(
            { apiId: 'openai', name: 'rp4' },
            { context: ctx },
        );
        expect(ctx.skills.delete).toHaveBeenCalledWith(
            { kind: 'preset', apiId: 'openai', name: 'rp4' },
            'rp-pal',
        );
        expect(ctx.accountStorage.getItem('AlertSkills_openai_rp4')).toBeNull();
    });

    test('onPresetDeletedCascade: missing apiId/name → no-op', async () => {
        const mod = await import('../../public/scripts/skills/embed-lifecycle.js');
        const ctx = makeContext({
            skills: { list: jest.fn(), delete: jest.fn() },
        });
        await mod.onPresetDeletedCascade({}, { context: ctx });
        await mod.onPresetDeletedCascade({ apiId: 'openai' }, { context: ctx });
        await mod.onPresetDeletedCascade({ name: 'foo' }, { context: ctx });
        expect(ctx.skills.list).not.toHaveBeenCalled();
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
        // Verify each event has at least one listener.
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

    test('PRESET_DELETED event triggers cascade delete', async () => {
        const mod = await import('../../public/scripts/skills/embed-lifecycle.js');
        const ctx = makeContext({
            skills: {
                list: jest.fn(async () => [{ name: 'pumpernickel' }]),
                delete: jest.fn(async () => null),
            },
        });
        mod.registerSkillEmbedLifecycle({ context: ctx });
        await ctx.eventSource.emit('preset_deleted', { apiId: 'openai', name: 'rp4' });
        // Listener is fire-and-forget (void Promise) — allow the async chain to flush.
        await new Promise(resolve => setTimeout(resolve, 10));
        expect(ctx.skills.delete).toHaveBeenCalledWith(
            { kind: 'preset', apiId: 'openai', name: 'rp4' },
            'pumpernickel',
        );
    });

    test('CHARACTER_DELETED event triggers character-scope cascade delete', async () => {
        const mod = await import('../../public/scripts/skills/embed-lifecycle.js');
        const ctx = makeContext({
            skills: {
                list: jest.fn(async () => [{ name: 'char-rule' }]),
                delete: jest.fn(async () => null),
            },
        });
        mod.registerSkillEmbedLifecycle({ context: ctx });
        await ctx.eventSource.emit('characterDeleted', { id: 0, character: { avatar: 'B.png' } });
        await new Promise(resolve => setTimeout(resolve, 10));
        expect(ctx.skills.delete).toHaveBeenCalledWith(
            { kind: 'character', characterFile: 'B.png' },
            'char-rule',
        );
    });
});
