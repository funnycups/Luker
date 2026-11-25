/**
 * @jest-environment jsdom
 */
// SPDX-License-Identifier: AGPL-3.0-or-later

import { describe, test, expect, beforeEach, afterEach, jest } from '@jest/globals';
import { clearRegistry } from '../../public/scripts/iteration-library/storage/target-registry.js';
import {
    runIterateTurn,
    createIterateBus,
    buildTurnChanges,
    commitTurnBatch,
} from '../../public/scripts/workbench/model/iterate.js';
import { diffUnits } from '../../public/scripts/workbench/model/units.js';
import { presetUnits, applyPresetOps, presetRebuild } from '../../public/scripts/workbench/model/adapters.js';
import { fieldPlan } from '../../public/scripts/workbench/model/patch.js';
import { createPresetTarget } from '../../public/scripts/workbench/targets/preset.js';
import { isCpaSkillTool } from '../../public/scripts/workbench/targets/preset-tools.js';
import { initWorkbench, resetWorkbenchForTest } from '../../public/scripts/workbench/index.js';
import { getIterateTargets } from '../../public/scripts/workbench/registry.js';
import { buildBaseSystemPrompt, buildOrchestratorOptimizeModeBlock, buildJailbreakOnlyModeBlock } from '../../public/scripts/workbench/targets/preset-prompts.js';

const clone = (v) => (v == null ? v : JSON.parse(JSON.stringify(v)));

function createMockPresetCtx({
    selectedName = 'MainPreset',
    presets = {},
    extensionSettings = {},
    skillsApi = null,
    buildPresetAwarePromptMessages = null,
} = {}) {
    const stored = new Map(
        Object.entries(presets).map(([name, body]) => [
            name,
            { ref: { collection: 'openai', name, origin: { kind: 'global' } }, body: clone(body) },
        ]),
    );
    let currentName = selectedName;

    const ctx = {
        extensionSettings: {
            ...clone(extensionSettings),
            completion_preset_assistant: {
                iterBaseSystemPrompt: buildBaseSystemPrompt(),
                iterModePromptOrchestratorOptimize: buildOrchestratorOptimizeModeBlock(),
                iterModePromptJailbreakOnly: buildJailbreakOnlyModeBlock(),
                ...clone(extensionSettings.completion_preset_assistant || {}),
            },
        },
        openai: {
            stripPresetConnectionFields: (body) => {
                const copy = clone(body);
                delete copy.api_server;
                return copy;
            },
        },
        presets: {
            list: (collection = 'openai') => [...stored.keys()].map((name) => ({
                collection,
                name,
                origin: { kind: 'global' },
            })),
            getSelected: () => (currentName && stored.has(currentName)
                ? clone(stored.get(currentName).ref)
                : null),
            getStored: (ref) => {
                const entry = stored.get(ref?.name);
                return entry ? clone(entry) : null;
            },
            getLive: (collection = 'openai') => (currentName && stored.has(currentName)
                ? {
                    ref: { collection, name: currentName, origin: { kind: 'global' } },
                    body: clone(stored.get(currentName).body),
                    stored: true,
                    selected: true,
                }
                : null),
            get: async (ref) => {
                const entry = stored.get(ref?.name);
                return entry ? clone(entry.body) : null;
            },
            save: jest.fn(async (ref, body, opts = {}) => {
                const name = String(ref?.name || '').trim();
                if (!name) return { ok: false, ref: null };
                const savedRef = { collection: 'openai', name, origin: { kind: 'global' } };
                stored.set(name, { ref: savedRef, body: clone(body) });
                if (opts?.select) currentName = name;
                return { ok: true, ref: savedRef };
            }),
        },
        skills: skillsApi || {
            list: jest.fn(async () => []),
            get: jest.fn(async () => null),
            listFiles: jest.fn(async () => ({ files: [] })),
            readFile: jest.fn(async () => ''),
            search: jest.fn(async () => ({ hits: [] })),
            install: jest.fn(async () => ({ ok: true })),
            writeFile: jest.fn(async () => ({ ok: true })),
            editFile: jest.fn(async () => ({ ok: true })),
            rename: jest.fn(async () => ({ ok: true })),
            moveScope: jest.fn(async () => ({ ok: true })),
            delete: jest.fn(async () => ({ ok: true })),
        },
        translate: (s) => String(s ?? ''),
        getCurrentLocale: () => 'en',
        ...(buildPresetAwarePromptMessages ? { buildPresetAwarePromptMessages } : {}),
    };
    return { ctx, stored, getCurrentName: () => currentName };
}

beforeEach(() => {
    document.body.innerHTML = '';
    clearRegistry();
    delete globalThis.Luker;
});

afterEach(() => {
    resetWorkbenchForTest();
    clearRegistry();
    delete globalThis.Luker;
    jest.restoreAllMocks();
});

describe('preset adapter: empty and multi-group prompt_order', () => {
    test('adding, enabling, or reordering prompt on prompt_order: [] persists { character_id: 100001, order: [...] } into next.prompt_order', async () => {
        const base = {
            temperature: 0.8,
            prompts: [
                { identifier: 'main', name: 'Main Prompt', role: 'system', content: 'Be helpful.' },
            ],
            prompt_order: [],
        };

        const { ctx, stored } = createMockPresetCtx({
            selectedName: 'EmptyOrderPreset',
            presets: { EmptyOrderPreset: base },
        });
        const target = createPresetTarget({ getContext: () => ctx });

        const loaded = await target.load('preset', ctx);
        let ai = clone(loaded.live);

        // Add a new prompt entry (auto-added to order) and enable existing 'main'
        ai = await target.runEdit({
            id: 'e1',
            name: 'preset_upsert_prompt_entry',
            args: { identifier: 'custom_rule', name: 'Custom Rule', role: 'system', content: 'Stay sharp.', enabled: true, position: 1 },
        }, ai);
        ai = await target.runEdit({
            id: 'e2',
            name: 'preset_upsert_prompt_order_item',
            args: { character_id: '100001', identifier: 'main', position: 1, enabled: true },
        }, ai);

        const changes = diffUnits(presetUnits(loaded.live), presetUnits(ai));
        const keys = changes.map((c) => c.key);
        expect(keys).toContain('prompt:custom_rule');
        expect(keys).toContain('order');

        // Also verify applyPresetOps directly attaches into next.prompt_order (not detached)
        const ops = fieldPlan(presetUnits(base), presetUnits(ai), keys);
        const directNext = applyPresetOps(base, ops);
        expect(Array.isArray(directNext.prompt_order)).toBe(true);
        expect(directNext.prompt_order).toEqual([
            {
                character_id: 100001,
                order: [
                    { identifier: 'main', enabled: true },
                    { identifier: 'custom_rule', enabled: true },
                ],
            },
        ]);

        // Commit through target.commit and verify persisted body
        const rebuilt = presetRebuild(loaded.live, ai, keys);
        const handle = await target.commit(loaded.target, loaded.live, rebuilt, keys);
        const persisted = stored.get('EmptyOrderPreset').body;
        expect(persisted.prompt_order).toEqual([
            {
                character_id: 100001,
                order: [
                    { identifier: 'main', enabled: true },
                    { identifier: 'custom_rule', enabled: true },
                ],
            },
        ]);
        expect(persisted.prompts.find((p) => p.identifier === 'custom_rule')?.content).toBe('Stay sharp.');

        await handle.undo();
        const reverted = stored.get('EmptyOrderPreset').body;
        expect(reverted.prompts.some((p) => p.identifier === 'custom_rule')).toBe(false);
        expect(reverted.prompt_order[0]?.order || []).toEqual([]);
    });

    test('missing prompt_order (undefined) initializes and attaches { character_id: 100001, order: [...] } cleanly', () => {
        const base = {
            prompts: [{ identifier: 'a', name: 'A', role: 'system', content: 'alpha' }],
        };
        const ai = {
            prompts: [{ identifier: 'a', name: 'A', role: 'system', content: 'alpha' }],
            prompt_order: [{ character_id: 100001, order: [{ identifier: 'a', enabled: true }] }],
        };
        const keys = diffUnits(presetUnits(base), presetUnits(ai)).map((c) => c.key);
        const next = presetRebuild(base, ai, keys);
        expect(next.prompt_order).toEqual([
            { character_id: 100001, order: [{ identifier: 'a', enabled: true }] },
        ]);
    });

    test('multi-group prompt_order (e.g. 100000 + 100001) surfaces edits in non-100001 groups and applies cleanly', () => {
        const base = {
            prompts: [
                { identifier: 'main', name: 'Main', role: 'system', content: 'M' },
                { identifier: 'nsfw', name: 'NSFW', role: 'system', content: 'N' },
            ],
            prompt_order: [
                { character_id: 100000, order: [{ identifier: 'main', enabled: true }, { identifier: 'nsfw', enabled: true }] },
                { character_id: 100001, order: [{ identifier: 'main', enabled: true }, { identifier: 'nsfw', enabled: true }] },
            ],
        };
        const ai = clone(base);
        // Edit ONLY group 100000: reorder and disable nsfw
        ai.prompt_order[0].order = [
            { identifier: 'nsfw', enabled: false },
            { identifier: 'main', enabled: true },
        ];

        const changes = diffUnits(presetUnits(base), presetUnits(ai));
        expect(changes.map((c) => c.key)).toEqual(['order:100000']);

        const next = presetRebuild(base, ai, ['order:100000']);
        expect(next.prompt_order[0]).toEqual({
            character_id: 100000,
            order: [
                { identifier: 'nsfw', enabled: false },
                { identifier: 'main', enabled: true },
            ],
        });
        // Group 100001 remains untouched
        expect(next.prompt_order[1]).toEqual(base.prompt_order[1]);
    });

    test('single non-100001 prompt_order group (e.g. 100000) touching both prompt:<id> and order:100000 modifies 100000 without synthesizing 100001', () => {
        const base = {
            prompts: [
                { identifier: 'main', name: 'Main', role: 'system', content: 'M' },
                { identifier: 'nsfw', name: 'NSFW', role: 'system', content: 'N' },
            ],
            prompt_order: [
                { character_id: 100000, order: [{ identifier: 'main', enabled: true }, { identifier: 'nsfw', enabled: true }] },
            ],
        };
        const ai = clone(base);
        ai.prompts[1].content = 'N updated';
        ai.prompt_order[0].order = [
            { identifier: 'nsfw', enabled: false },
            { identifier: 'main', enabled: true },
        ];

        const changes = diffUnits(presetUnits(base), presetUnits(ai));
        const keys = changes.map((c) => c.key);
        expect(keys).toEqual(['prompt:nsfw', 'order:100000']);

        const ops = fieldPlan(presetUnits(base), presetUnits(ai), keys);
        const next = applyPresetOps(base, ops);
        expect(next.prompt_order).toEqual([
            {
                character_id: 100000,
                order: [
                    { identifier: 'nsfw', enabled: false },
                    { identifier: 'main', enabled: true },
                ],
            },
        ]);
        expect(next.prompts[1].content).toBe('N updated');
    });
});

describe('platform preset target (controls, modes, reference, proposal-bus, custom prompts)', () => {
    test('applyLaunch preselects the requested edit mode', () => {
        const liveBody = {
            temperature: 0.7,
            prompts: [{ identifier: 'main', name: 'Main', role: 'system', content: 'Original main' }],
            prompt_order: [{ character_id: 100001, order: [{ identifier: 'main', enabled: true }] }],
        };
        const { ctx } = createMockPresetCtx({
            selectedName: 'LivePreset',
            presets: { LivePreset: liveBody },
        });
        const target = createPresetTarget({ getContext: () => ctx });
        target.applyLaunch({ presetMode: 'jailbreak-only' });
        const controls = target.renderControls({ live: liveBody, scope: 'preset', settings: {}, onReload: () => {} });
        expect(controls.querySelector('[data-wb-preset-control="mode"]').value).toBe('jailbreak-only');
    });

    test('renderControls switches CPA mode and reference preset, updating prompt, active tool catalog, and runCpaReadTool reference injection', async () => {
        const liveBody = {
            temperature: 0.7,
            prompts: [{ identifier: 'main', name: 'Main', role: 'system', content: 'Original main' }],
            prompt_order: [{ character_id: 100001, order: [{ identifier: 'main', enabled: true }] }],
        };
        const refBody = {
            temperature: 1.1,
            prompts: [{ identifier: 'main', name: 'Main', role: 'system', content: 'Reference main' }],
            prompt_order: [{ character_id: 100001, order: [{ identifier: 'main', enabled: true }] }],
            api_server: 'secret-should-strip',
        };
        const { ctx } = createMockPresetCtx({
            selectedName: 'LivePreset',
            presets: { LivePreset: liveBody, RefPreset: refBody },
        });
        const target = createPresetTarget({ getContext: () => ctx });
        const onReload = jest.fn();

        const controlsEl = target.renderControls({ live: liveBody, scope: 'preset', settings: {}, onReload });
        expect(controlsEl).toBeInstanceOf(Node);
        document.body.appendChild(controlsEl);

        const modeSelect = controlsEl.querySelector('[data-wb-preset-control="mode"]');
        const refSelect = controlsEl.querySelector('[data-wb-preset-control="reference"]');
        expect(modeSelect).not.toBeNull();
        expect(refSelect).not.toBeNull();

        // Current preset must not appear in reference dropdown
        const refOptions = [...refSelect.querySelectorAll('option')].map((o) => o.value);
        expect(refOptions).toEqual(['', 'RefPreset']);

        // Default 'general' mode: no skill tools, no reference tools
        const generalPrompt = await target.prompt(liveBody, 'preset', ctx);
        const generalTools = (await target.tools(liveBody, 'preset', ctx)).map((t) => t.function.name);
        expect(generalPrompt).not.toContain('Mode: orchestrator-optimize');
        expect(generalPrompt).not.toContain('Mode: jailbreak-only');
        expect(generalTools.some((n) => isCpaSkillTool(n))).toBe(false);
        expect(generalTools).not.toContain('preset_read_reference_fields');
        expect(generalTools).not.toContain('preset_copy_from_reference');

        // Switch mode -> orchestrator-optimize
        modeSelect.value = 'orchestrator-optimize';
        modeSelect.dispatchEvent(new Event('change', { bubbles: true }));
        expect(onReload).toHaveBeenCalledTimes(1);

        const orchPrompt = await target.prompt(liveBody, 'preset', ctx);
        const orchTools = (await target.tools(liveBody, 'preset', ctx)).map((t) => t.function.name);
        expect(orchPrompt).toContain('Mode: orchestrator-optimize');
        expect(orchPrompt).toContain('Skill management');
        expect(orchTools.some((n) => isCpaSkillTool(n))).toBe(true);

        // Switch mode -> jailbreak-only
        modeSelect.value = 'jailbreak-only';
        modeSelect.dispatchEvent(new Event('change', { bubbles: true }));
        expect(onReload).toHaveBeenCalledTimes(2);

        const jbPrompt = await target.prompt(liveBody, 'preset', ctx);
        const jbTools = (await target.tools(liveBody, 'preset', ctx)).map((t) => t.function.name);
        expect(jbPrompt).toContain('Mode: jailbreak-only');
        expect(jbPrompt).not.toContain('Mode: orchestrator-optimize');
        expect(jbTools.some((n) => isCpaSkillTool(n))).toBe(false);

        // Choose reference preset -> RefPreset
        refSelect.value = 'RefPreset';
        refSelect.dispatchEvent(new Event('change', { bubbles: true }));
        expect(onReload).toHaveBeenCalledTimes(3);

        const refPrompt = await target.prompt(liveBody, 'preset', ctx);
        const refTools = (await target.tools(liveBody, 'preset', ctx)).map((t) => t.function.name);
        expect(refPrompt).toContain('RefPreset');
        expect(refTools).toContain('preset_read_reference_fields');
        expect(refTools).toContain('preset_copy_from_reference');

        // runRead injects loaded reference into preset_read_reference_fields and strips connection fields
        const readRes = await target.runRead({
            id: 'r1',
            name: 'preset_read_reference_fields',
            args: { paths: ['temperature', 'api_server'] },
        }, liveBody);
        expect(readRes.source).toBe('reference');
        expect(readRes.presetName).toBe('RefPreset');
        expect(readRes.values).toEqual([
            { path: 'temperature', exists: true, value: 1.1 },
            { path: 'api_server', exists: false, value: null },
        ]);

        // preset_copy_from_reference copies from RefPreset into live
        const copied = await target.runEdit({
            id: 'e1',
            name: 'preset_copy_from_reference',
            args: { path: 'temperature' },
        }, liveBody);
        expect(copied.temperature).toBe(1.1);
    });

    test('preset_clone_to_new emits a preset-clone proposal via proposal-bus and writes the cloned preset cleanly', async () => {
        const liveBody = {
            temperature: 0.9,
            prompts: [{ identifier: 'main', name: 'Main', role: 'system', content: 'Base prompt' }],
            prompt_order: [{ character_id: 100001, order: [{ identifier: 'main', enabled: true }] }],
        };
        const { ctx, stored, getCurrentName } = createMockPresetCtx({
            selectedName: 'SourcePreset',
            presets: { SourcePreset: liveBody },
        });
        const target = createPresetTarget({ getContext: () => ctx });
        const loaded = await target.load('preset', ctx);
        const bus = createIterateBus({ proposalKinds: target.proposalKinds });

        let round = 0;
        const turnRes = await runIterateTurn({
            messages: [{ role: 'system', content: 'sys' }, { role: 'user', content: 'clone preset' }],
            live: clone(loaded.live),
            tools: await target.tools(loaded.live, 'preset', ctx),
            bus,
            proposalKinds: target.proposalKinds,
            isRead: (n) => target.isRead(n),
            runRead: (call, live, helpers) => target.runRead(call, live, helpers),
            runEdit: (call, live, helpers) => target.runEdit(call, live, helpers),
            request: async () => {
                round++;
                if (round === 1) {
                    return {
                        text: '',
                        calls: [{ id: 'clone_1', name: 'preset_clone_to_new', args: { new_name: 'DerivedPreset', reason: 'safe copy' } }],
                    };
                }
                return { text: 'Proposed clone.', calls: [] };
            },
        });

        expect(turnRes.proposalIds).toHaveLength(1);
        const changes = buildTurnChanges({
            base: loaded.live,
            ai: turnRes.live,
            units: target.units,
            bus,
            proposalIds: turnRes.proposalIds,
            kindAdapters: target.proposalKinds,
        });
        expect(changes).toHaveLength(1);
        expect(changes[0]).toMatchObject({
            proposalKind: 'preset-clone',
            inverseAvailable: false,
        });

        const handle = await commitTurnBatch({
            target,
            targetRef: loaded.target,
            base: loaded.live,
            ai: turnRes.live,
            keys: changes.map((c) => c.key),
            bus,
            proposalIds: turnRes.proposalIds,
            kindAdapters: target.proposalKinds,
        });

        expect(handle.nonRollbackable).toBe(true);
        expect(stored.has('DerivedPreset')).toBe(true);
        expect(stored.get('DerivedPreset').body).toEqual(liveBody);
        expect(getCurrentName()).toBe('DerivedPreset');
    });

    test('skill authoring and inspection tools route through read vs proposal-bus cleanly', async () => {
        const liveBody = {
            prompts: [{ identifier: 'main', name: 'Main', role: 'system', content: 'Rule body' }],
            prompt_order: [{ character_id: 100001, order: [{ identifier: 'main', enabled: true }] }],
        };
        const installedSkills = [];
        const skillsApi = {
            list: jest.fn(async () => [...installedSkills]),
            install: jest.fn(async ({ scope, payload }) => {
                installedSkills.push({ scope, files: payload.files });
                return { ok: true };
            }),
        };
        const { ctx } = createMockPresetCtx({
            selectedName: 'SkillPreset',
            presets: { SkillPreset: liveBody },
            skillsApi,
        });
        // skill-iter-studio reads Luker.getContext().skills lazily inside handlers
        globalThis.Luker = { getContext: () => ctx };

        const target = createPresetTarget({ getContext: () => ctx });
        const bus = createIterateBus({ proposalKinds: target.proposalKinds });

        expect(target.isRead('skill_list_visible')).toBe(true);
        expect(target.isRead('skill_create')).toBe(false);
        expect(target.isRead('preset_clone_to_new')).toBe(false);

        let round = 0;
        const turnRes = await runIterateTurn({
            messages: [{ role: 'system', content: 'sys' }, { role: 'user', content: 'extract skill' }],
            live: clone(liveBody),
            tools: await target.tools(liveBody, 'preset', ctx),
            bus,
            proposalKinds: target.proposalKinds,
            isRead: (n) => target.isRead(n),
            runRead: (call, live, helpers) => target.runRead(call, live, helpers),
            runEdit: (call, live, helpers) => target.runEdit(call, live, helpers),
            request: async () => {
                round++;
                if (round === 1) {
                    return {
                        text: '',
                        calls: [
                            { id: 'r_sk', name: 'skill_list_visible', args: {} },
                            {
                                id: 'c_sk',
                                name: 'skill_create',
                                args: {
                                    name: 'voice-rule',
                                    scope: { kind: 'preset', name: 'SkillPreset' },
                                    description: 'Voice rules',
                                    body: 'Keep voice consistent.',
                                },
                            },
                        ],
                    };
                }
                return { text: 'Created skill proposal.', calls: [] };
            },
        });

        expect(turnRes.reads).toHaveLength(1);
        expect(turnRes.proposalIds).toHaveLength(1);

        const changes = buildTurnChanges({
            base: liveBody,
            ai: turnRes.live,
            units: target.units,
            bus,
            proposalIds: turnRes.proposalIds,
            kindAdapters: target.proposalKinds,
        });
        expect(changes).toHaveLength(1);
        expect(changes[0].proposalKind).toBe('skill-author');

        await commitTurnBatch({
            target,
            targetRef: { scope: 'preset', ref: { collection: 'openai', name: 'SkillPreset' } },
            base: liveBody,
            ai: turnRes.live,
            keys: changes.map((c) => c.key),
            bus,
            proposalIds: turnRes.proposalIds,
            kindAdapters: target.proposalKinds,
        });

        expect(skillsApi.install).toHaveBeenCalledTimes(1);
        expect(installedSkills[0].files[0].content).toContain('Keep voice consistent.');
    });

    test('honors custom extensionSettings.completion_preset_assistant prompts when set', async () => {
        const liveBody = { prompts: [], prompt_order: [] };
        const { ctx } = createMockPresetCtx({
            selectedName: 'CustomPromptPreset',
            presets: { CustomPromptPreset: liveBody },
            extensionSettings: {
                completion_preset_assistant: {
                    iterBaseSystemPrompt: 'CUSTOM BASE PROMPT FOR PRESET',
                    iterModePromptOrchestratorOptimize: 'CUSTOM ORCH MODE BLOCK',
                    iterModePromptJailbreakOnly: 'CUSTOM JAILBREAK MODE BLOCK',
                },
            },
        });
        const target = createPresetTarget({ getContext: () => ctx });
        const controls = target.renderControls({ live: liveBody, scope: 'preset', settings: {}, onReload: () => {} });
        const modeSelect = controls.querySelector('[data-wb-preset-control="mode"]');

        const basePrompt = await target.prompt(liveBody, 'preset', ctx);
        expect(basePrompt).toBe('CUSTOM BASE PROMPT FOR PRESET');

        modeSelect.value = 'orchestrator-optimize';
        modeSelect.dispatchEvent(new Event('change', { bubbles: true }));
        const orchPrompt = await target.prompt(liveBody, 'preset', ctx);
        expect(orchPrompt).toContain('CUSTOM BASE PROMPT FOR PRESET');
        expect(orchPrompt).toContain('CUSTOM ORCH MODE BLOCK');

        modeSelect.value = 'jailbreak-only';
        modeSelect.dispatchEvent(new Event('change', { bubbles: true }));
        const jbPrompt = await target.prompt(liveBody, 'preset', ctx);
        expect(jbPrompt).toContain('CUSTOM BASE PROMPT FOR PRESET');
        expect(jbPrompt).toContain('CUSTOM JAILBREAK MODE BLOCK');

        const info = await target.promptInfo(ctx);
        expect(info.custom).toBe(true);
    });

    test('initWorkbench registers built-in preset target and resetWorkbenchForTest cleans it up', () => {
        const { ctx } = createMockPresetCtx({ selectedName: 'P1', presets: { P1: { prompts: [], prompt_order: [] } } });
        ctx.eventSource = { on: () => {}, off: () => {} };
        ctx.eventTypes = { APP_READY: 'APP_READY' };
        ctx.listExtensionNames = () => [];
        globalThis.Luker = { getContext: () => ctx };

        initWorkbench();
        expect(getIterateTargets().some((t) => t.id === 'preset')).toBe(true);

        resetWorkbenchForTest();
        expect(getIterateTargets().some((t) => t.id === 'preset')).toBe(false);
    });

    test('preset_simulate routes through runRead and surfaces environment availability', async () => {
        const liveBody = {
            prompts: [{ identifier: 'main', name: 'Main', role: 'system', content: 'Be clear' }],
            prompt_order: [{ character_id: 100001, order: [{ identifier: 'main', enabled: true }] }],
        };
        const { ctx } = createMockPresetCtx({
            selectedName: 'SimPreset',
            presets: { SimPreset: liveBody },
        });
        const target = createPresetTarget({ getContext: () => ctx });
        expect(target.isRead('preset_simulate')).toBe(true);
        await expect(target.runRead({ id: 'sim_1', name: 'preset_simulate', args: { text: 'Hi' } }, liveBody))
            .rejects.toThrow(/simulator is unavailable/i);
    });

    test('renderControls clears state.referenceName when all other presets are deleted', async () => {
        const liveBody = {
            temperature: 0.7,
            prompts: [{ identifier: 'main', name: 'Main', role: 'system', content: 'Live' }],
            prompt_order: [{ character_id: 100001, order: [{ identifier: 'main', enabled: true }] }],
        };
        const refBody = {
            temperature: 1.0,
            prompts: [{ identifier: 'main', name: 'Main', role: 'system', content: 'Ref' }],
            prompt_order: [{ character_id: 100001, order: [{ identifier: 'main', enabled: true }] }],
        };
        const { ctx, stored } = createMockPresetCtx({
            selectedName: 'LivePreset',
            presets: { LivePreset: liveBody, RefPreset: refBody },
        });
        const target = createPresetTarget({ getContext: () => ctx });

        const controls1 = target.renderControls({ live: liveBody, scope: 'preset', settings: {}, onReload: () => {} });
        const refSelect1 = controls1.querySelector('[data-wb-preset-control="reference"]');
        refSelect1.value = 'RefPreset';
        refSelect1.dispatchEvent(new Event('change', { bubbles: true }));

        expect(await target.prompt(liveBody, 'preset', ctx)).toContain('RefPreset');
        expect((await target.tools(liveBody, 'preset', ctx)).map((t) => t.function.name)).toContain('preset_read_reference_fields');

        // Delete the only other preset so allNames becomes empty
        stored.delete('RefPreset');
        const controls2 = target.renderControls({ live: liveBody, scope: 'preset', settings: {}, onReload: () => {} });
        const refSelect2 = controls2.querySelector('[data-wb-preset-control="reference"]');
        expect(refSelect2.value).toBe('');
        expect(await target.prompt(liveBody, 'preset', ctx)).not.toContain('RefPreset');
        expect((await target.tools(liveBody, 'preset', ctx)).map((t) => t.function.name)).not.toContain('preset_read_reference_fields');
    });

    test('runEdit passes context into normalizeToolCallToEdit so ctx.lib.lodash is used', async () => {
        const liveBody = {
            temperature: 0.7,
            prompts: [{ identifier: 'main', name: 'Main', role: 'system', content: 'Original' }],
            prompt_order: [{ character_id: 100001, order: [{ identifier: 'main', enabled: true }] }],
        };
        const { ctx } = createMockPresetCtx({
            selectedName: 'LivePreset',
            presets: { LivePreset: liveBody },
        });
        const lodashGet = jest.fn((obj, path) => obj?.[path]);
        const lodashHas = jest.fn((obj, path) => Object.prototype.hasOwnProperty.call(obj || {}, path));
        ctx.lib = { lodash: { get: lodashGet, has: lodashHas } };
        ctx.edits = {
            applyEdits: jest.fn((edits, live) => ({
                newLive: { ...live, [edits[0].path]: edits[0].newValue },
                conflicts: [],
            })),
        };
        const target = createPresetTarget({ getContext: () => ctx });

        const updated = await target.runEdit({
            id: 'e_ctx',
            name: 'preset_set_field',
            args: { path: 'temperature', value_json: '0.5' },
        }, liveBody);

        expect(lodashGet).toHaveBeenCalledWith(liveBody, 'temperature');
        expect(ctx.edits.applyEdits).toHaveBeenCalledWith(
            [{ op: 'set', path: 'temperature', oldValue: 0.7, newValue: 0.5 }],
            liveBody,
        );
        expect(updated.temperature).toBe(0.5);
    });

    test('in-flight prompt, runRead, and preset_clone_to_new use captured session target even after live preset switches', async () => {
        const sourceBody = {
            temperature: 0.6,
            prompts: [{ identifier: 'main', name: 'Main', role: 'system', content: 'Source prompt' }],
            prompt_order: [{ character_id: 100001, order: [{ identifier: 'main', enabled: true }] }],
        };
        const otherBody = {
            temperature: 1.4,
            prompts: [{ identifier: 'main', name: 'Main', role: 'system', content: 'Other prompt' }],
            prompt_order: [{ character_id: 100001, order: [{ identifier: 'main', enabled: true }] }],
        };
        const { ctx, stored } = createMockPresetCtx({
            selectedName: 'SourcePreset',
            presets: { SourcePreset: sourceBody, OtherPreset: otherBody },
        });
        ctx.skills.list = jest.fn(async () => [
            { name: 'source-skill', scope: { kind: 'preset', name: 'SourcePreset' }, description: 'Belongs to source' },
            { name: 'other-skill', scope: { kind: 'preset', name: 'OtherPreset' }, description: 'Belongs to other' },
        ]);

        const target = createPresetTarget({ getContext: () => ctx });
        const loaded = await target.load('preset', ctx);
        target.applyLaunch({ presetMode: 'orchestrator-optimize' });

        // Switch live selected preset to OtherPreset mid-turn
        await ctx.presets.save({ collection: 'openai', name: 'OtherPreset' }, otherBody, { select: true });
        expect(ctx.presets.getSelected('openai').name).toBe('OtherPreset');

        const promptText = await target.prompt(loaded.live, 'preset', ctx, { target: loaded.target });
        expect(promptText).toContain('SourcePreset');
        expect(promptText).not.toContain('OtherPreset');

        const readRes = await target.runRead(
            { id: 'r_captured', name: 'preset_read_live_fields', args: { paths: ['temperature'] } },
            loaded.live,
            { target: loaded.target },
        );
        expect(readRes.presetName).toBe('SourcePreset');

        const bus = createIterateBus({ proposalKinds: target.proposalKinds });
        const proposedIds = [];
        await target.runEdit(
            { id: 'c_captured', name: 'preset_clone_to_new', args: { new_name: 'ForkedFromSource' } },
            loaded.live,
            {
                target: loaded.target,
                bus,
                propose: async (input) => {
                    const res = await bus.propose({ sourceCallId: 'c_captured', ...input });
                    proposedIds.push(res.id);
                    return res;
                },
            },
        );
        expect(proposedIds).toHaveLength(1);
        const approved = await bus.approve(proposedIds[0]);
        expect(approved).toEqual({ ok: true, status: 'committed' });
        expect(stored.get('ForkedFromSource').body).toEqual(sourceBody);
    });
});
