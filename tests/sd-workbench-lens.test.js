/**
 * @jest-environment jsdom
 */
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { beforeAll, beforeEach, describe, expect, jest, test } from '@jest/globals';
import { icon } from '../public/scripts/workbench/icons.js';
import { toneLabel } from '../public/scripts/workbench/ui/components.js';
import { knownRoles } from '../public/scripts/workbench/pages/settings.js';
import { createWorkbenchRegistry } from '../public/scripts/workbench/registry.js';
import { createRunStore } from '../public/scripts/run-panel/store.js';
import { createRecorder, createMemoryStorage } from '../public/scripts/run-panel/recorder.js';
import { createCharacterProfileStore } from '../public/scripts/extensions/stable-diffusion/character-archive/store.js';
import { registerWorkbenchLocaleData } from '../public/scripts/workbench/locale-data.js';
import { initSdLens } from '../public/scripts/extensions/stable-diffusion/lens/index.js';
import { mountSdLens } from '../public/scripts/extensions/stable-diffusion/lens/app.js';
import { buildSdDiagnoseDraft } from '../public/scripts/extensions/stable-diffusion/activity.js';
import { askTools, readLabel } from '../public/scripts/workbench/model/ask.js';
import { wsName } from '../public/scripts/workbench/pages/ask.js';
import { ensureSkillI18n } from '../public/scripts/skills/i18n.js';

beforeAll(() => {
    globalThis.structuredClone ??= value => JSON.parse(JSON.stringify(value));
    if (!globalThis.CSS) globalThis.CSS = {};
    if (typeof globalThis.CSS.escape !== 'function') {
        globalThis.CSS.escape = s => String(s).replace(/[^a-zA-Z0-9_\u00a0-\uffff-]/g, c => `\\${c}`);
    }
    if (!globalThis.matchMedia) {
        globalThis.matchMedia = () => ({
            matches: false,
            addEventListener: () => {},
            removeEventListener: () => {},
        });
    }
    if (!globalThis.requestAnimationFrame) {
        globalThis.requestAnimationFrame = cb => setTimeout(cb, 0);
    }
    if (!globalThis.cancelAnimationFrame) {
        globalThis.cancelAnimationFrame = id => clearTimeout(id);
    }
});

beforeEach(() => {
    document.head.innerHTML = '';
    document.body.innerHTML = '';
});

function createHarnessContext({ recorder = null, workbenchRegistry = null } = {}) {
    const namespaces = new Map();
    const reg = workbenchRegistry || createWorkbenchRegistry();
    const rec = recorder || createRecorder({ storage: createMemoryStorage() });
    const openedCalls = [];
    reg.setOpenHandler(async opts => {
        openedCalls.push(opts);
        return opts;
    });

    const sdSettings = {
        source: 'google',
        model: 'gemini-2.5-flash-image',
        illustration: {
            enabled: true,
            autoGenerate: false,
            initialized: true,
            currentPresetId: 'preset_1',
            presets: [{
                id: 'preset_1',
                name: 'Tag style',
                illustrationPrompt: 'Prompt instructions',
                studioPrompt: 'Studio instructions',
                explorationPrompt: '',
                llm: { apiPresetName: '', llmPresetName: '' },
                explorationLlm: { apiPresetName: '', llmPresetName: '' },
                visualInspection: false,
            }],
        },
    };

    const ctx = {
        chatId: 'chat_lens_1',
        characterId: 0,
        name1: 'Traveler',
        name2: 'Lyra',
        characters: [
            {
                name: 'Lyra',
                avatar: 'lyra.png',
                description: 'Navigator with a silver braid.',
                data: { extensions: { world: 'HorizonLore' } },
            },
            {
                name: 'Kaelen',
                avatar: 'kaelen.png',
                description: 'Vanguard captain.',
                data: { extensions: {} },
            },
        ],
        extensionSettings: { sd: sdSettings },
        addLocaleData: () => {},
        translate: text => String(text ?? ''),
        getCurrentLocale: () => 'en',
        getRequestHeaders: () => ({ 'Content-Type': 'application/json' }),
        workbench: reg,
        runPanel: {
            getRunRecorder: () => rec,
            attachDock: (store, opts) => rec.attach(store, opts?.source || 'sd'),
        },
        async getGlobalState(ns) {
            return {
                ok: true,
                state: namespaces.has(ns) ? JSON.parse(JSON.stringify(namespaces.get(ns))) : {},
            };
        },
        async updateGlobalState(ns, updater) {
            const prev = namespaces.has(ns) ? JSON.parse(JSON.stringify(namespaces.get(ns))) : {};
            const next = await updater(prev);
            if (next !== null && next !== undefined) {
                namespaces.set(ns, JSON.parse(JSON.stringify(next)));
            }
            return { ok: true, state: namespaces.get(ns) || {} };
        },
        async generateTask() {
            return {
                toolCalls: [],
                assistantText: 'Exploration complete.',
            };
        },
    };

    return { ctx, reg, rec, namespaces, openedCalls, sdSettings };
}

describe('workbench sd tone, image icon, and locale contracts', () => {
    test('defines --lw-t-sd and --wb-t-sd tokens, distinct image icon path, and sd tone role', () => {
        const tokensCss = readFileSync(
            fileURLToPath(new URL('../public/scripts/lens-shared/tokens.css', import.meta.url)),
            'utf8',
        );
        expect(tokensCss).toContain('--lw-t-sd:');
        expect(tokensCss).toContain('--wb-t-sd: var(--lw-t-sd)');

        const imgSvg = icon('image');
        const infoSvg = icon('info');
        expect(imgSvg.querySelector('path').getAttribute('d')).not.toBe(
            infoSvg.querySelector('path').getAttribute('d'),
        );

        globalThis.Luker = { getContext: () => ({ translate: s => s, getCurrentLocale: () => 'en' }) };
        expect(toneLabel('sd')).toBe('Image Generation');
        expect(knownRoles().some(r => r.key === 'sd' && r.tone === 'sd')).toBe(true);
    });

    test('sd lens resolves all i18n literals directly from core locale JSONs with fullwidth CJK punctuation and no split locale-data.js', () => {
        const splitPath = fileURLToPath(new URL('../public/scripts/extensions/stable-diffusion/lens/locale-data.js', import.meta.url));
        expect(existsSync(splitPath)).toBe(false);

        const zhCnCore = JSON.parse(
            readFileSync(fileURLToPath(new URL('../public/locales/zh-cn.json', import.meta.url)), 'utf8'),
        );
        const zhTwCore = JSON.parse(
            readFileSync(fileURLToPath(new URL('../public/locales/zh-tw.json', import.meta.url)), 'utf8'),
        );
        const wbLocale = { 'zh-cn': {}, 'zh-tw': {} };
        registerWorkbenchLocaleData((loc, data) => {
            if (loc === 'zh-cn' || loc === 'zh-tw') Object.assign(wbLocale[loc], data);
        });
        const allCn = { ...zhCnCore, ...wbLocale['zh-cn'] };
        const allTw = { ...zhTwCore, ...wbLocale['zh-tw'] };

        const lensDir = fileURLToPath(new URL('../public/scripts/extensions/stable-diffusion/lens', import.meta.url));
        const jsFiles = [];
        const walk = dir => {
            for (const ent of readdirSync(dir, { withFileTypes: true })) {
                const full = `${dir}/${ent.name}`;
                if (ent.isDirectory()) walk(full);
                else if (ent.name.endsWith('.js')) jsFiles.push(full);
            }
        };
        walk(lensDir);

        const usedKeys = new Set();
        const callRe = /\bi18n(?:Format)?\(\s*'((?:\\'|[^'])+)'|\bi18n(?:Format)?\(\s*"((?:\\"|[^"])+)"/g;
        for (const file of jsFiles) {
            const src = readFileSync(file, 'utf8');
            for (const m of src.matchAll(callRe)) {
                const raw = m[1] !== undefined
                    ? m[1].replace(/\\'/g, '\'').replace(/\\\\/g, '\\')
                    : m[2].replace(/\\"/g, '"').replace(/\\\\/g, '\\');
                usedKeys.add(raw);
            }
        }
        expect(usedKeys.size).toBeGreaterThan(20);

        for (const key of usedKeys) {
            expect(key.replace(/\\;/g, '')).not.toContain(';');
            expect(Object.hasOwn(allCn, key)).toBe(true);
            expect(Object.hasOwn(allTw, key)).toBe(true);
            expect(allCn[key]).not.toMatch(/[\u4e00-\u9fff][,;:!?()]|[,;:!?()][\u4e00-\u9fff]/);
            expect(allTw[key]).not.toMatch(/[\u4e00-\u9fff][,;:!?()]|[,;:!?()][\u4e00-\u9fff]/);
        }
    });
});

describe('embedded ws:sd workspace, characters archive view, and run view', () => {
    test('registers workspace id sd (order 30, tone sd, icon image, flush true) and supports subview switching', async () => {
        const { ctx, reg } = createHarnessContext();
        globalThis.Luker = { getContext: () => ctx };

        const cleanup = initSdLens({ getContext: () => ctx });
        const ws = reg.getWorkspaces().find(w => w.id === 'sd');
        expect(ws).toBeDefined();
        expect(ws).toMatchObject({
            id: 'sd',
            order: 30,
            tone: 'sd',
            icon: 'image',
            flush: true,
        });

        const container = document.createElement('div');
        document.body.appendChild(container);
        const handle = ws.mount(container, {
            app: { toast: jest.fn(), isCompact: () => false },
            opts: { ws: 'sd', subview: 'characters' },
        });
        await new Promise(r => setTimeout(r, 20));

        expect(container.querySelector('.sdlens')).not.toBeNull();
        expect(container.querySelector('[data-sd-view="characters"]')).not.toBeNull();

        handle.update({ ws: 'sd', subview: 'run' });
        await new Promise(r => setTimeout(r, 10));
        expect(container.querySelector('[data-sd-view="run"]')).not.toBeNull();

        handle.destroy();
        cleanup();
    });

    test('characters view supports profile CRUD and per-action fanwork vs OC mode switch without writing global settings', async () => {
        const explorationCalls = [];
        const { ctx, reg, sdSettings } = createHarnessContext();
        ctx.generateTask = async (opts) => {
            explorationCalls.push(opts);
            if (explorationCalls.length === 1) {
                return {
                    toolCalls: [{
                        id: 'exp_1',
                        name: 'save_character_profile',
                        args: {
                            id: 'char_lyra',
                            name: 'Lyra',
                            source_work: 'Horizon',
                            canonical_tags: ['1girl', 'silver braid'],
                            outfits: [{ id: 'outfit_1', name: 'Coat', tags: ['navy coat'] }],
                        },
                    }],
                    assistantText: '',
                };
            }
            return { toolCalls: [], assistantText: 'Archived Lyra.' };
        };
        globalThis.Luker = { getContext: () => ctx };

        const store = createCharacterProfileStore(ctx);
        await store.upsertProfile({
            id: 'char_existing',
            name: 'Existing Heroine',
            canonicalTags: ['1girl', 'blonde hair'],
            outfits: [{ id: 'outfit_base', name: ' Casual', tags: ['white dress'] }],
        });

        const cleanup = initSdLens({ getContext: () => ctx });
        const ws = reg.getWorkspaces().find(w => w.id === 'sd');
        const container = document.createElement('div');
        document.body.appendChild(container);

        const sdSettingsSnapshotBefore = JSON.stringify(sdSettings);
        const cardExtensionsBefore = JSON.stringify(ctx.characters.map(c => c.data.extensions));

        const handle = ws.mount(container, {
            app: { toast: jest.fn(), isCompact: () => false },
            opts: { ws: 'sd', subview: 'characters' },
        });
        await new Promise(r => setTimeout(r, 30));

        expect(container.textContent).toContain('Existing Heroine');

        // Verify known character card selector is a <select> dropdown, not free-text
        const cardSelect = container.querySelector('[data-sd-role="launch-card-select"]');
        expect(cardSelect?.tagName).toBe('SELECT');
        const optionValues = [...cardSelect.querySelectorAll('option')].map(o => o.value);
        expect(optionValues).toEqual(expect.arrayContaining(['', 'lyra.png', 'kaelen.png']));

        // Switch per-invocation toggle to OC design -> verify NO global or card setting was mutated, and clicking launch switches to studio view
        const ocSegBtn = container.querySelector('[data-sd-launch-mode="oc"]');
        expect(ocSegBtn).not.toBeNull();
        ocSegBtn.click();
        expect(JSON.stringify(sdSettings)).toBe(sdSettingsSnapshotBefore);
        expect(JSON.stringify(ctx.characters.map(c => c.data.extensions))).toBe(cardExtensionsBefore);

        const targetInput = container.querySelector('[data-sd-role="launch-target-input"]');
        targetInput.value = 'Aurelia';
        targetInput.dispatchEvent(new Event('input', { bubbles: true }));
        cardSelect.value = 'lyra.png';
        cardSelect.dispatchEvent(new Event('change', { bubbles: true }));

        const launchBtn = container.querySelector('[data-sd-role="launch-submit"]');
        launchBtn.click();
        await new Promise(r => setTimeout(r, 20));
        expect(container.querySelector('[data-sd-view="studio"]')).not.toBeNull();
        expect(JSON.stringify(sdSettings)).toBe(sdSettingsSnapshotBefore);

        // Switch back to characters view, toggle to fanwork exploration, and dispatch exploration agent
        handle.update({ ws: 'sd', subview: 'characters' });
        await new Promise(r => setTimeout(r, 20));
        const fanworkBtn = container.querySelector('[data-sd-launch-mode="fanwork"]');
        fanworkBtn.click();
        const fanTargetInput = container.querySelector('[data-sd-role="launch-target-input"]');
        fanTargetInput.value = 'Lyra';
        fanTargetInput.dispatchEvent(new Event('input', { bubbles: true }));

        container.querySelector('[data-sd-role="launch-submit"]').click();
        await new Promise(r => setTimeout(r, 60));

        expect(explorationCalls.length).toBe(2);
        const profilesAfter = await store.listProfiles();
        expect(profilesAfter.map(p => p.id)).toEqual(expect.arrayContaining(['char_existing', 'char_lyra']));

        handle.destroy();
        cleanup();
    });

    test('run view renders live and historical source:sd runs with full details and AI diagnosis jump', async () => {
        const { ctx, reg, rec, openedCalls } = createHarnessContext();
        globalThis.Luker = { getContext: () => ctx };

        const runStore = createRunStore();
        rec.attach(runStore, 'sd');
        const runId = runStore.startRun({ mode: 'image', chatKey: 'chat_lens_1' });
        runStore.appendRound({ runId, round: { id: 'r1', label: 'Message #3' } });
        runStore.ensureSection({
            runId,
            roundId: 'r1',
            section: { id: 's1', kind: 'prompt', title: 'Prompt 1' },
        });
        const fullPrompt = '1girl, astronomical observatory, long brass telescope, midnight starfield, detailed oil painting';
        runStore.appendToSection({ runId, roundId: 'r1', sectionId: 's1', delta: fullPrompt });
        runStore.setSectionStatus({ runId, roundId: 'r1', sectionId: 's1', status: 'done' });
        runStore.ensureSection({
            runId,
            roundId: 'r1',
            section: { id: 's2', kind: 'error', title: 'Error 1' },
        });
        runStore.appendToSection({ runId, roundId: 'r1', sectionId: 's2', delta: 'HTTP 502 from upstream image relay' });
        runStore.setSectionStatus({ runId, roundId: 'r1', sectionId: 's2', status: 'failed' });
        runStore.setRoundStatus({ runId, roundId: 'r1', status: 'failed' });
        runStore.finishRun({ runId, status: 'error' });

        const cleanup = initSdLens({ getContext: () => ctx });
        const ws = reg.getWorkspaces().find(w => w.id === 'sd');
        const container = document.createElement('div');
        document.body.appendChild(container);

        const handle = ws.mount(container, {
            app: { toast: jest.fn(), isCompact: () => false },
            opts: { ws: 'sd', subview: 'run', runKey: `sd:${runId}` },
        });
        await new Promise(r => setTimeout(r, 20));

        expect(container.textContent).toContain('Message #3');
        expect(container.textContent).toContain(fullPrompt);
        expect(container.textContent).toContain('HTTP 502 from upstream image relay');

        const diagBtn = container.querySelector('[data-sd-role="diagnose-run"]');
        expect(diagBtn).not.toBeNull();
        diagBtn.click();
        await new Promise(r => setTimeout(r, 10));

        expect(openedCalls).toContainEqual(expect.objectContaining({
            page: 'ai',
            ws: 'sd',
            draft: expect.stringContaining(`sd:${runId}`),
        }));

        handle.destroy();
        cleanup();
    });
});

describe('workbench sd studio view and multi-turn OC reference design', () => {
    test('executes general and character_design multi-turn loops with attribution:none, promotes staged gallery refs, and records undo history', async () => {
        const { ctx, reg } = createHarnessContext();
        const generatedCalls = [];
        const promotedCalls = [];
        const historyRecords = [];

        ctx.powerUserSettings = { persona_description: 'Tall astronomer with amber eyes and a dark cape.' };
        ctx.userAvatar = 'astronomer.png';
        ctx.worldNames = ['HorizonLore'];
        ctx.loadWorldInfo = async (bookName) => {
            if (bookName === 'HorizonLore') {
                return {
                    entries: {
                        0: {
                            uid: 0,
                            comment: 'Aurelia Appearance',
                            key: ['Aurelia'],
                            content: 'Aurelia wears a star-embroidered white gown and golden circlet.',
                            disable: false,
                        },
                    },
                };
            }
            return { entries: {} };
        };

        const originalFetch = globalThis.fetch;
        globalThis.fetch = async (url, init) => {
            if (String(url).includes('/api/sd/character-sources/promote-local-image')) {
                const body = JSON.parse(init.body);
                promotedCalls.push(body);
                return {
                    ok: true,
                    status: 200,
                    json: async () => ({
                        ok: true,
                        imagePath: `/user/images/_references/${body.profileId || 'oc'}_promoted.png`,
                        sha256: 'abc123def456',
                        width: 1024,
                        height: 1024,
                    }),
                };
            }
            throw new Error(`Unexpected fetch URL: ${url}`);
        };

        const imageService = {
            async getAvailableLoras() {
                return { names: ['detail_tweaker.safetensors'], includeWeight: true };
            },
            async getCapabilities() {
                return {
                    source: 'google',
                    model: 'gemini-2.5-flash-image',
                    supportsCharacterReference: true,
                    maxCharacterReferences: null,
                    supportsStyleReference: true,
                    maxStyleReferences: null,
                    supportsSourceImage: true,
                    supportsMultiCharacterPrompts: false,
                    supportsDynamicAspectRatio: true,
                    availableLoras: { names: ['detail_tweaker.safetensors'], includeWeight: true },
                };
            },
            async generate(prompt, opts) {
                generatedCalls.push({ prompt, opts });
                return `/user/images/_studio/cand_${generatedCalls.length}.png`;
            },
        };

        let studioRound = 0;
        let capturedCandidateId = '';
        ctx.generateTask = async (opts) => {
            studioRound += 1;
            const toolNames = (opts.tools || []).map(t => t.function.name);
            expect(toolNames).toEqual(expect.arrayContaining([
                'read_character_card',
                'read_user_persona',
                'lorebook_get',
                'generate_image',
                'stage_character_profile',
            ]));

            if (studioRound === 1) {
                return {
                    toolCalls: [
                        { id: 'st_1', name: 'read_user_persona', args: {} },
                        { id: 'st_2', name: 'lorebook_get', args: { book_name: 'HorizonLore', uids: [0] } },
                    ],
                    assistantText: '',
                };
            }
            if (studioRound === 2) {
                const toolMsgs = opts.taskMessages.filter(m => m.role === 'tool').map(m => m.content).join('\n');
                expect(toolMsgs).toContain('amber eyes');
                expect(toolMsgs).toContain('star-embroidered white gown');
                return {
                    toolCalls: [{
                        id: 'st_3',
                        name: 'generate_image',
                        args: {
                            prompt: '1girl, golden circlet, star-embroidered white gown, standing portrait',
                            aspect_ratio: '2:3',
                            loras: [{ name: 'detail_tweaker.safetensors', weight: 0.7 }],
                        },
                    }],
                    assistantText: '',
                };
            }
            if (studioRound === 3) {
                const lastToolMsg = opts.taskMessages.filter(m => m.role === 'tool').at(-1);
                const parsed = JSON.parse(lastToolMsg.content);
                capturedCandidateId = parsed.image_id;
                expect(capturedCandidateId).toBeTruthy();
                return {
                    toolCalls: [{
                        id: 'st_4',
                        name: 'stage_character_profile',
                        args: {
                            name: 'Aurelia',
                            source_work: 'Original',
                            canonical_tags: ['1girl', 'golden circlet', 'amber eyes'],
                            prose_description: 'Regal astronomer with amber eyes and a golden circlet.',
                            outfits: [{
                                id: 'outfit_ceremonial',
                                name: 'Ceremonial Gown',
                                tags: ['star-embroidered white gown'],
                                image_ids: [capturedCandidateId],
                            }],
                            default_outfit_id: 'outfit_ceremonial',
                        },
                    }],
                    assistantText: '',
                };
            }
            return {
                toolCalls: [],
                assistantText: 'Here is Aurelia with her ceremonial gown ready to apply.',
            };
        };

        globalThis.Luker = { getContext: () => ctx };
        const cleanup = initSdLens({ getContext: () => ctx, imageService });
        const ws = reg.getWorkspaces().find(w => w.id === 'sd');
        const container = document.createElement('div');
        document.body.appendChild(container);

        try {
            const toastMock = jest.fn();
            const handle = ws.mount(container, {
                app: {
                    toast: toastMock,
                    isCompact: () => false,
                    history: {
                        record: entry => historyRecords.push(entry),
                    },
                },
                opts: { ws: 'sd', subview: 'studio' },
            });
            await new Promise(r => setTimeout(r, 30));

            // Switch studio session mode to character_design
            const charDesignModeBtn = container.querySelector('[data-sd-studio-mode="character_design"]');
            expect(charDesignModeBtn).not.toBeNull();
            charDesignModeBtn.click();
            await new Promise(r => setTimeout(r, 15));

            const input = container.querySelector('[data-sd-role="studio-input"]');
            expect(input).not.toBeNull();
            input.value = 'Design Aurelia based on the lorebook and persona.';
            input.dispatchEvent(new Event('input', { bubbles: true }));

            container.querySelector('[data-sd-role="studio-send"]').click();
            await new Promise(r => setTimeout(r, 80));

            const errorToasts = toastMock.mock.calls.filter(([, opts]) => opts?.error);
            expect(errorToasts).toEqual([]);
            expect(studioRound).toBe(4);
            expect(generatedCalls).toHaveLength(1);
            expect(generatedCalls[0].opts).toMatchObject({
                attribution: 'none',
                subdir: '_studio',
                aspectRatio: '2:3',
                loras: [{ name: 'detail_tweaker.safetensors', weight: 0.7 }],
            });

            // Staged proposal review card is rendered; click Apply
            const applyBtn = container.querySelector('[data-sd-role="apply-staged-profile"]');
            expect(applyBtn).not.toBeNull();
            applyBtn.click();
            await new Promise(r => setTimeout(r, 40));

            expect(promotedCalls).toHaveLength(1);
            expect(promotedCalls[0].sourcePath).toBe('/user/images/_studio/cand_1.png');

            const profileStore = createCharacterProfileStore(ctx);
            const allProfiles = await profileStore.listProfiles();
            expect(allProfiles).toHaveLength(1);
            expect(allProfiles[0].name).toBe('Aurelia');
            expect(allProfiles[0].outfits[0].referenceImages).toEqual([
                `/user/images/_references/${allProfiles[0].id}_promoted.png`,
            ]);

            // Verify Workbench history undo removes the newly created profile cleanly
            expect(historyRecords).toHaveLength(1);
            expect(historyRecords[0].ws).toBe('sd');
            await historyRecords[0].undo();
            expect(await profileStore.listProfiles()).toHaveLength(0);

            handle.destroy();
        } finally {
            globalThis.fetch = originalFetch;
            cleanup();
        }
    });
});

describe('workbench sd IterateTarget, AskProvider, and SuggestRuleProvider', () => {
    test('IterateTarget supports read tools, selective rebuild, commit, and reversible undo across presets and character profiles', async () => {
        const { ctx, reg, rec, sdSettings } = createHarnessContext();
        let saveCount = 0;
        ctx.saveSettings = async (_delay, opts) => {
            saveCount += 1;
            opts?.onSaved?.();
        };
        sdSettings.illustration.presets[0].llm = {
            apiPresetName: 'Claude Connection',
            llmPresetName: 'Plugin Preset',
        };

        const runStore = createRunStore();
        rec.attach(runStore, 'sd');
        const rId = runStore.startRun({ mode: 'image', chatKey: 'chat_lens_1' });
        runStore.appendRound({ runId: rId, round: { id: 'rd_1', label: 'Message #1' } });
        runStore.setRoundStatus({ runId: rId, roundId: 'rd_1', status: 'done' });
        runStore.finishRun({ runId: rId, status: 'committed' });

        const originalFetch = globalThis.fetch;
        globalThis.fetch = async (url) => {
            if (url === '/api/sd/comfy/workflows') {
                return { ok: true, status: 200, json: async () => [] };
            }
            throw new Error(`Unexpected fetch URL: ${url}`);
        };
        globalThis.Luker = { getContext: () => ctx };
        const cleanup = initSdLens({ getContext: () => ctx });

        try {
            const target = reg.getIterateTargets().find(t => t.id === 'sd');
            expect(target).toBeDefined();
            expect(await target.scopes(ctx)).toEqual({ global: true });
            expect(target.getNativeAi()).toEqual({
                connection: 'Claude Connection',
                preset: 'Plugin Preset',
            });
            const pInfo = await target.promptInfo(ctx);
            expect(typeof pInfo.text).toBe('string');
            expect(pInfo.text.length).toBeGreaterThan(20);

            const loaded = await target.load('global', ctx);
            const base = JSON.parse(JSON.stringify(loaded.live));

            // Read run tool
            expect(target.isRead('sd_read_run')).toBe(true);
            const runReadOut = await target.runRead({ name: 'sd_read_run', args: {} }, loaded.live);
            expect(runReadOut.runId).toBe(rId);

            // Draft edits: modify preset_1 (including character_design_prompt) AND add a character profile
            let draft = await target.runEdit({
                name: 'sd_update_preset',
                args: {
                    preset_id: 'preset_1',
                    illustration_prompt: 'Updated illustration instructions',
                    character_design_prompt: 'Custom OC sheet instructions',
                },
            }, JSON.parse(JSON.stringify(base)));
            draft = await target.runEdit({
                name: 'sd_upsert_character',
                args: {
                    id: 'char_iter_1',
                    name: 'Seren',
                    canonical_tags: ['1girl', 'emerald eyes'],
                    outfits: [{ id: 'outfit_1', name: 'Cloak', tags: ['green cloak'] }],
                },
            }, draft);

            const baseUnits = target.units(base);
            const draftUnits = target.units(draft);
            expect(baseUnits.has('preset:preset_1')).toBe(true);
            expect(draftUnits.has('character:char_iter_1')).toBe(true);
            expect(draftUnits.get('preset:preset_1').fields.characterDesignPrompt).toBe('Custom OC sheet instructions');

            // Selective rebuild: accept BOTH units, commit, verify persistence, then undo!
            const selectedKeys = ['preset:preset_1', 'character:char_iter_1'];
            const rebuilt = target.rebuild(base, draft, selectedKeys);
            const committed = await target.commit(loaded.target, base, rebuilt, selectedKeys);

            expect(committed.applied).toEqual(expect.arrayContaining(selectedKeys));
            expect(saveCount).toBeGreaterThanOrEqual(1);
            expect(sdSettings.illustration.presets[0].illustrationPrompt).toBe('Updated illustration instructions');
            expect(sdSettings.illustration.presets[0].characterDesignPrompt).toBe('Custom OC sheet instructions');

            const profileStore = createCharacterProfileStore(ctx);
            expect((await profileStore.getProfile('char_iter_1'))?.name).toBe('Seren');

            // Undo reverts both preset and character archive!
            await committed.undo();
            expect(sdSettings.illustration.presets[0].illustrationPrompt).toBe('Prompt instructions');
            expect(sdSettings.illustration.presets[0].characterDesignPrompt || '').toBe('');
            expect(await profileStore.getProfile('char_iter_1')).toBeNull();
        } finally {
            globalThis.fetch = originalFetch;
            cleanup();
        }
    });

    test('AskProvider wb_read_sd strips credentials and private endpoint URLs while SuggestRuleProvider detects broken profile and failed run', async () => {
        const { ctx, reg, rec, sdSettings } = createHarnessContext();
        Object.assign(sdSettings, {
            connection_profile: '',
            generationPresets: {
                currentId: 'gp_active',
                presets: [{
                    id: 'gp_active',
                    name: 'Preset One',
                    config: { connection_profile: 'Deleted Preset Profile' },
                }],
            },
            auto_url: 'http://192.168.1.55:7860',
            auto_auth: 'admin:supersecretpassword',
            vlad_auth: 'vlad:topsecret',
            comfy_url: 'http://10.0.0.9:8188',
            novel_url: 'https://private-nai-proxy.internal.local',
            chat_image_url: 'https://relay.private.example/v1',
            api_key: 'sk-live-secret-999999',
        });
        ctx.connectionProfiles = {
            list: () => [{ id: 'prof_uuid_99', name: 'Valid Profile' }],
        };

        const runStore = createRunStore();
        rec.attach(runStore, 'sd');
        const badRunId = runStore.startRun({ mode: 'image', chatKey: 'chat_lens_1' });
        runStore.appendRound({ runId: badRunId, round: { id: 'r_err', label: 'Message #5' } });
        runStore.finishRun({ runId: badRunId, status: 'error', error: 'Upstream 500' });

        const originalFetch = globalThis.fetch;
        globalThis.fetch = async (url) => {
            if (url === '/api/sd/comfy/workflows') {
                return { ok: true, status: 200, json: async () => [] };
            }
            throw new Error(`Unexpected fetch URL: ${url}`);
        };
        globalThis.Luker = { getContext: () => ctx };
        const cleanup = initSdLens({ getContext: () => ctx });

        try {
            const askProvider = reg.getAskProviders().find(p => p.id === 'sd');
            expect(askProvider).toBeDefined();

            for (const part of ['summary', 'capabilities', 'presets', 'characters', 'workflows', 'last_run']) {
                const payload = await askProvider.readers.wb_read_sd({ part }, ctx);
                const serialized = JSON.stringify(payload);
                expect(serialized).not.toContain('supersecretpassword');
                expect(serialized).not.toContain('topsecret');
                expect(serialized).not.toContain('sk-live-secret-999999');
                expect(serialized).not.toContain('192.168.1.55');
                expect(serialized).not.toContain('10.0.0.9');
                expect(serialized).not.toContain('private-nai-proxy');
                expect(serialized).not.toContain('relay.private.example');
            }

            const snap = await askProvider.getSnapshot(ctx);
            const suggestProvider = reg.getSuggestRuleProviders().find(p => p.id === 'sd');
            expect(suggestProvider).toBeDefined();

            const missingConnRule = suggestProvider.rules.find(r => r.id === 'sd.missing-connection-profile');
            const failedRunRule = suggestProvider.rules.find(r => r.id === 'sd.last-run-failed');
            expect(missingConnRule).toBeDefined();
            expect(failedRunRule).toBeDefined();

            const wbSnap = { providers: { sd: snap } };
            const connHit = missingConnRule.check(wbSnap);
            expect(connHit).not.toBeNull();
            expect(connHit.text).toContain('Deleted Preset Profile');

            const runHit = failedRunRule.check(wbSnap);
            expect(runHit).not.toBeNull();

            // Rebind active generation preset to valid profile NAME (where id !== name) -> missing-connection-profile clears
            sdSettings.generationPresets.presets[0].config.connection_profile = 'Valid Profile';
            const cleanSnap = await askProvider.getSnapshot(ctx);
            expect(missingConnRule.check({ providers: { sd: cleanSnap } })).toBeNull();
        } finally {
            globalThis.fetch = originalFetch;
            cleanup();
        }
    });

    test('Diagnose draft targets sd_read_run (not wb_read_sd), Workbench Ask/Home expose sd labels, Studio preserves references/target outfit, and zh-cn renders zero untranslated Lens strings', async () => {
        const recorder = createRecorder({
            storage: createMemoryStorage(),
            getRunContext: () => ({ chatId: 'c_zh', chatLabel: '海雾哨站' }),
        });
        const { ctx, reg, rec } = createHarnessContext({ recorder });
        const runStore = createRunStore();
        rec.attach(runStore, 'sd');
        const rId = runStore.startRun({ mode: 'image', chatKey: 'chat_diag' });
        runStore.appendRound({ runId: rId, round: { id: 'rd_diag', label: 'Message #2' } });
        runStore.ensureSection({ runId: rId, roundId: 'rd_diag', section: { id: 'sec_err', kind: 'error', title: 'Error' } });
        runStore.appendToSection({ runId: rId, roundId: 'rd_diag', sectionId: 'sec_err', delta: 'Invalid API key' });
        runStore.setSectionStatus({ runId: rId, roundId: 'rd_diag', sectionId: 'sec_err', status: 'failed' });
        runStore.setRoundStatus({ runId: rId, roundId: 'rd_diag', status: 'failed' });
        runStore.finishRun({ runId: rId, status: 'error', error: 'Invalid API key' });

        // Critical 3: Diagnose draft for page:'ai' must reference sd_read_run and never wb_read_sd
        const diagRecorded = buildSdDiagnoseDraft(`sd:${rId}`, ctx);
        expect(diagRecorded).toContain('sd_read_run');
        expect(diagRecorded).not.toContain('wb_read_sd');
        const diagMissing = buildSdDiagnoseDraft('sd:nonexistent_99', ctx);
        expect(diagMissing).toContain('sd_read_run');
        expect(diagMissing).not.toContain('wb_read_sd');

        // Important 5: Workbench Ask suggest enum, readLabel, and wsName include 'sd' / 'wb_read_sd'
        globalThis.Luker = { getContext: () => ctx };
        const cleanup = initSdLens({ getContext: () => ctx });
        const answerTool = askTools().find(t => t.function.name === 'wb_answer');
        expect(answerTool.function.parameters.properties.suggest.enum).toContain('sd');
        expect(readLabel('wb_read_sd')).toBe('Image Generation');
        expect(wsName('sd')).toBe('Image Generation');

        // Important 4: Studio regeneration reconstructs references, single-image promote respects empty targetProfileId vs defaultOutfitId, and OC launch resets draftInput cleanly
        const profileStore = createCharacterProfileStore(ctx);
        await profileStore.upsertProfile({
            id: 'char_unrelated',
            name: 'Unrelated Hero',
            outfits: [{ id: 'out_u', name: 'Armor', referenceImages: [] }],
            defaultOutfitId: 'out_u',
        });
        await profileStore.upsertProfile({
            id: 'char_target',
            name: 'Target Heroine',
            outfits: [
                { id: 'out_casual', name: 'Casual', referenceImages: [] },
                { id: 'out_gala', name: 'Gala Gown', referenceImages: [] },
            ],
            defaultOutfitId: 'out_gala',
        });

        globalThis.fetch = jest.fn(async (url, init) => {
            if (url === '/api/sd/character-sources/promote-local-image') {
                const body = JSON.parse(init.body);
                return {
                    ok: true,
                    status: 200,
                    json: async () => ({
                        imagePath: `/user/images/_references/${body.profileId}_promoted.png`,
                        width: 512,
                        height: 512,
                        mimeType: 'image/png',
                    }),
                };
            }
            throw new Error(`Unexpected fetch: ${url}`);
        });

        const generateCalls = [];
        const imageService = {
            getAvailableLoras: async () => ({ names: [], includeWeight: false }),
            getCapabilities: async () => ({
                source: 'google',
                model: 'gemini-2.5-flash-image',
                supportsCharacterReference: true,
                maxCharacterReferences: null,
                supportsStyleReference: true,
                maxStyleReferences: null,
                supportsSourceImage: true,
                supportsMultiCharacterPrompts: false,
                supportsDynamicAspectRatio: true,
                availableLoras: { names: [], includeWeight: false },
            }),
            generate: async (prompt, opts) => {
                generateCalls.push({ prompt, opts });
                return `/user/images/_studio/gen_${generateCalls.length}.png`;
            },
        };

        // Pre-seed a studio session with source + character gallery images to test regenerateGalleryImage & promoteSingleGalleryImageToProfile
        await ctx.updateGlobalState('sd_studio_sessions', () => ({
            version: 1,
            sessions: {
                sess_1: {
                    id: 'sess_1',
                    title: 'New OC Candidate',
                    mode: 'character_design',
                    targetProfileId: '',
                    messages: [{
                        id: 'm1',
                        role: 'assistant',
                        content: 'Drafted sheet.',
                        tool_calls: [{ id: 'tc1', type: 'function', function: { name: 'generate_image', arguments: '{}' } }],
                        tool_results: [{ tool_call_id: 'tc1', content: '{"status":"ready"}' }],
                    }],
                    images: [
                        { id: 'img_src', prompt: 'base pose', imageUrl: '/user/images/_studio/src.png', status: 'ready' },
                        { id: 'img_chr', prompt: 'char sheet', imageUrl: '/user/images/_studio/chr.png', status: 'ready' },
                        {
                            id: 'img_derived',
                            prompt: 'derived portrait',
                            imageUrl: '/user/images/_studio/derived.png',
                            sourceImageId: 'img_src',
                            characterImageIds: ['img_chr'],
                            status: 'ready',
                        },
                    ],
                    attachedReferences: [{ imagePath: '/user/images/_studio/src.png', role: 'source' }],
                    updatedAt: 1000,
                },
            },
        }));

        // Important 8: Also verify zh-cn translation table resolves every visible string with zero untranslated leaks
        const zhTable = JSON.parse(
            readFileSync(fileURLToPath(new URL('../public/locales/zh-cn.json', import.meta.url)), 'utf8'),
        );
        ctx.getCurrentLocale = () => 'zh-cn';
        ctx.translate = text => zhTable[text] ?? `UNTRANSLATED:${text}`;

        const container = document.createElement('div');
        document.body.appendChild(container);
        const handle = mountSdLens({
            container,
            hostApp: { toast: jest.fn(), history: { record: jest.fn() } },
            opts: { subview: 'studio' },
            getContext: () => ctx,
            imageService,
        });
        await new Promise(r => setTimeout(r, 30));

        expect(container.textContent).not.toContain('UNTRANSLATED:');
        expect(container.textContent).not.toContain('Studio AI');
        expect(container.textContent).not.toContain('Edit source');
        expect(container.textContent).not.toContain('Editing source image:');
        expect(container.textContent).not.toContain('tool call(s)');

        // Regenerate img_derived -> must pass reconstructed source + character references!
        container.querySelector('[data-studio-action="regenerate"]').click();
        await new Promise(r => setTimeout(r, 30));
        expect(generateCalls).toHaveLength(1);
        expect(generateCalls[0].opts.references).toEqual([
            { imagePath: '/user/images/_studio/src.png', role: 'source' },
            { imagePath: '/user/images/_studio/chr.png', role: 'character' },
        ]);

        // Promote when targetProfileId === '' -> must create a NEW profile, NOT mutate char_unrelated!
        container.querySelector('[data-studio-action="promote-reference"]').click();
        await new Promise(r => setTimeout(r, 30));
        const unrelatedAfter = await profileStore.getProfile('char_unrelated');
        expect(unrelatedAfter.outfits[0].referenceImages).toEqual([]);
        const allProfiles = await profileStore.listProfiles();
        expect(allProfiles.length).toBe(3);

        // Switch targetProfileId to char_target (defaultOutfitId === 'out_gala') and promote -> must append to out_gala (2nd outfit), not out_casual!
        const targetSelect = container.querySelector('[data-sd-role="studio-target-profile"]');
        targetSelect.value = 'char_target';
        targetSelect.dispatchEvent(new Event('change', { bubbles: true }));
        container.querySelector('[data-studio-action="promote-reference"]').click();
        await new Promise(r => setTimeout(r, 30));
        const targetAfter = await profileStore.getProfile('char_target');
        expect(targetAfter.outfits[0].referenceImages).toEqual([]);
        expect(targetAfter.outfits[1].referenceImages).toEqual(['/user/images/_references/char_target_promoted.png']);

        // Switch to characters & run views in zh-cn -> verify zero UNTRANSLATED: or raw outfit(s)/round(s)
        handle.update({ subview: 'characters' });
        await new Promise(r => setTimeout(r, 30));
        expect(container.textContent).not.toContain('UNTRANSLATED:');
        expect(container.textContent).not.toContain('outfit(s)');

        // Launch OC design with empty target text after typing in studio earlier -> draftInput must reset to ''
        const studioInputBefore = document.createElement('div');
        handle.update({ subview: 'studio' });
        await new Promise(r => setTimeout(r, 20));
        const ta1 = container.querySelector('[data-sd-role="studio-input"]');
        ta1.value = 'stale draft text';
        ta1.dispatchEvent(new Event('input', { bubbles: true }));

        handle.update({ subview: 'characters' });
        await new Promise(r => setTimeout(r, 20));
        container.querySelector('[data-sd-launch-mode="oc"]').click();
        container.querySelector('[data-sd-role="launch-submit"]').click();
        await new Promise(r => setTimeout(r, 30));
        expect(container.querySelector('[data-sd-role="studio-input"]').value).toBe('');
        void studioInputBefore;

        handle.update({ subview: 'run' });
        await new Promise(r => setTimeout(r, 20));
        expect(container.textContent).not.toContain('UNTRANSLATED:');
        expect(container.textContent).not.toContain('round(s)');

        // Verify populated run view in zh-cn localizes status pills and shows chatLabel as title
        const sdRunStore = createRunStore();
        rec.attach(sdRunStore, 'sd');
        const zhRunId = sdRunStore.startRun({ mode: 'image', chatKey: 'c_zh' });
        sdRunStore.appendRound({ runId: zhRunId, round: { id: 'r_zh', label: '消息 #12' } });
        sdRunStore.ensureSection({ runId: zhRunId, roundId: 'r_zh', section: { id: 'p_zh', kind: 'prompt', title: '提示词 1' } });
        sdRunStore.appendToSection({ runId: zhRunId, roundId: 'r_zh', sectionId: 'p_zh', delta: '1girl, lantern' });
        sdRunStore.setSectionStatus({ runId: zhRunId, roundId: 'r_zh', sectionId: 'p_zh', status: 'running' });
        sdRunStore.setRoundStatus({ runId: zhRunId, roundId: 'r_zh', status: 'running' });
        handle.update({ subview: 'run', runKey: `sd:${zhRunId}` });
        await new Promise(r => setTimeout(r, 20));
        expect(container.textContent).not.toContain('UNTRANSLATED:');
        expect(container.textContent).not.toContain('(running)');
        expect(container.querySelector('.sdlens-runs-detail h3')?.textContent).toBe('海雾哨站');
        expect(container.querySelector('.sdlens-runs-detail h3')?.getAttribute('title')).toBe(`sd:${zhRunId}`);
        expect(container.textContent).toContain('运行中');

        // Verify AskProvider overview / sideInfo / Home card localize all labels in zh-cn
        const sdAskProvider = reg.getAskProviders().find(p => p.id === 'sd');
        const overviewZh = await sdAskProvider.getOverview(ctx);
        expect(Object.keys(overviewZh)).not.toContain('Backend');
        expect(Object.keys(overviewZh)).not.toContain('Illustration');
        const sideZh = sdAskProvider.getSideInfo({ characterCount: 3, brokenConnectionProfile: false });
        expect(sideZh.countText).not.toContain('chars');
        expect(sideZh.countText).not.toContain('UNTRANSLATED:');

        // Verify ensureSkillI18n registers synchronously via Luker.getContext().addLocaleData
        const addedLocales = [];
        ctx.addLocaleData = (loc, table) => addedLocales.push([loc, table]);
        const registration = ensureSkillI18n();
        expect(addedLocales.map(([loc]) => loc)).toEqual(['zh-cn', 'zh-tw']);
        await registration;

        handle.destroy();
        cleanup();
    });
});
