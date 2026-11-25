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
import { DEFAULT_EXPLORATION_PROMPT } from '../public/scripts/extensions/stable-diffusion/exploration/prompts.js';
import { getDefaultPromptValues } from '../public/scripts/extensions/stable-diffusion/illustration/presets.js';
import { migrateIllustrationPromptSettings } from '../public/scripts/extensions/stable-diffusion/illustration/settings.js';
import { openLegacyCharacterDesignMigrationDialog } from '../public/scripts/extensions/stable-diffusion/illustration/legacy-migration-dialog.js';
import { registerWorkbenchLocaleData } from '../public/scripts/workbench/locale-data.js';
import { initSdLens } from '../public/scripts/extensions/stable-diffusion/lens/index.js';
import { mountSdLens } from '../public/scripts/extensions/stable-diffusion/lens/app.js';
import { createStudioSessionStore, normalizeStudioSession } from '../public/scripts/extensions/stable-diffusion/lens/studio-store.js';
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
                promptStyle: 'tag',
                promptDefaultsInitialized: true,
                illustrationPrompt: 'Prompt instructions',
                studioPrompt: 'Studio instructions',
                explorationPrompt: DEFAULT_EXPLORATION_PROMPT,
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

describe('workbench sd studio separation, legacy migration, and free drawing', () => {
    test('preservesLegacyStudioContent', async () => {
        const { ctx } = createHarnessContext();
        const legacySession = {
            id: 'sess_legacy_oc',
            title: 'Legacy OC Sheet',
            presetId: 'preset_1',
            mode: 'character_design',
            targetProfileId: 'char_99',
            sourceKind: 'card',
            sourceCardAvatar: 'lyra.png',
            stagedProfileDraft: { name: 'Aurelia', outfits: [] },
            visualReview: true,
            attachedReferences: [{ imagePath: '/user/images/_studio/base.png', role: 'source' }],
            messages: [
                { id: 'm_u1', role: 'user', content: 'Draw a golden observatory portrait.', at: 100, tool_calls: [], tool_results: [] },
                {
                    id: 'm_a1',
                    role: 'assistant',
                    content: 'Generated the observatory portrait.',
                    at: 200,
                    tool_calls: [{ id: 'tc_1', type: 'function', function: { name: 'generate_image', arguments: '{"prompt":"observatory"}' } }],
                    tool_results: [{ tool_call_id: 'tc_1', content: '{"status":"ready","image_id":"img_1"}' }],
                },
            ],
            images: [{
                id: 'img_1',
                messageId: 'm_a1',
                prompt: '1girl, observatory, lantern',
                negativePrompt: 'blurry',
                aspectRatio: '2:3',
                imageUrl: '/user/images/_studio/obs_1.png',
                sourceImageId: '',
                characterImageIds: [],
                loras: [{ name: 'detail.safetensors', weight: 0.7 }],
                status: 'ready',
                error: '',
                createdAt: 200,
            }],
            createdAt: 100,
            updatedAt: 200,
        };

        const normalized = normalizeStudioSession(legacySession);
        expect(normalized.messages).toEqual(legacySession.messages);
        expect(normalized.images).toEqual(legacySession.images);
        expect(normalized.attachedReferences).toEqual(legacySession.attachedReferences);
        expect(normalized.visualReview).toBe(true);
        for (const retiredKey of ['mode', 'targetProfileId', 'sourceKind', 'sourceCardAvatar', 'stagedProfileDraft']) {
            expect(Object.hasOwn(normalized, retiredKey)).toBe(false);
        }

        await ctx.updateGlobalState('sd_studio_sessions', () => ({
            version: 1,
            sessions: { [legacySession.id]: legacySession },
        }));
        const store = createStudioSessionStore(ctx);
        const loaded = await store.getSession(legacySession.id);
        expect(loaded.messages).toEqual(legacySession.messages);
        expect(loaded.images).toEqual(legacySession.images);
        expect(loaded.attachedReferences).toEqual(legacySession.attachedReferences);
        for (const retiredKey of ['mode', 'targetProfileId', 'sourceKind', 'sourceCardAvatar', 'stagedProfileDraft']) {
            expect(Object.hasOwn(loaded, retiredKey)).toBe(false);
        }
    });

    test('keepsFreeDrawingAndEditing', async () => {
        const { ctx, reg, sdSettings } = createHarnessContext();
        const generatedCalls = [];
        const llmCalls = [];

        const originalFetch = globalThis.fetch;
        globalThis.fetch = async (url) => {
            if (String(url).startsWith('/user/images/_studio/')) {
                const bytes = new Uint8Array([137, 80, 78, 71]);
                return {
                    ok: true,
                    status: 200,
                    blob: async () => ({
                        type: 'image/png',
                        arrayBuffer: async () => bytes.buffer,
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
                return `/user/images/_studio/free_${generatedCalls.length}.png`;
            },
        };

        let round = 0;
        ctx.generateTask = async (opts) => {
            round += 1;
            llmCalls.push(opts);
            const toolNames = (opts.tools || []).map(t => t.function.name);
            expect(toolNames).toEqual(['generate_image']);
            expect(opts.taskMessages[0].role).toBe('system');
            expect(opts.taskMessages[0].content).toContain('Studio instructions');

            if (round === 1) {
                return {
                    toolCalls: [{
                        id: 'st_1',
                        name: 'generate_image',
                        args: {
                            prompt: '1girl, lighthouse harbor, dusk light',
                            aspect_ratio: '2:3',
                            loras: [{ name: 'detail_tweaker.safetensors', weight: 0.7 }],
                        },
                    }],
                    assistantText: '',
                };
            }
            if (round === 2) {
                // Visual review round receives the preview image and replies in text.
                const hasImagePreview = opts.taskMessages
                    .filter(m => m.role === 'user' && Array.isArray(m.content))
                    .flatMap(m => m.content)
                    .some(part => part.type === 'image_url' && part.image_url?.url?.startsWith('data:image/'));
                expect(hasImagePreview).toBe(true);
                return { toolCalls: [], assistantText: 'Lighting looks crisp.' };
            }
            if (round === 3) {
                return {
                    toolCalls: [{
                        id: 'st_2',
                        name: 'generate_image',
                        args: {
                            prompt: '1girl, lighthouse harbor, starry midnight sky',
                        },
                    }],
                    assistantText: '',
                };
            }
            return { toolCalls: [], assistantText: 'Finished.' };
        };

        globalThis.Luker = { getContext: () => ctx };
        const cleanup = initSdLens({ getContext: () => ctx, imageService });
        const ws = reg.getWorkspaces().find(w => w.id === 'sd');
        const container = document.createElement('div');
        document.body.appendChild(container);

        try {
            const toastMock = jest.fn();
            const handle = ws.mount(container, {
                app: { toast: toastMock, isCompact: () => false },
                opts: { ws: 'sd', subview: 'studio' },
            });
            await new Promise(r => setTimeout(r, 30));

            // Character-design UI controls are physically gone from Studio.
            expect(container.querySelector('[data-sd-studio-mode]')).toBeNull();
            expect(container.querySelector('[data-sd-role="studio-target-profile"]')).toBeNull();
            expect(container.querySelector('[data-sd-role="studio-source-select"]')).toBeNull();
            expect(container.querySelector('[data-sd-role="staged-proposal"]')).toBeNull();

            // New session lives in the session list header; prompt preset lives in the main toolbar; empty states appear before first turn.
            expect(container.querySelector('.sdlens-studio-sessions-head [data-sd-role="studio-new-session"]')).not.toBeNull();
            expect(container.querySelector('.sdlens-studio-sessions [data-sd-role="studio-preset"]')).toBeNull();
            expect(container.querySelector('.sdlens-studio-toolbar [data-sd-role="studio-preset"]')).not.toBeNull();
            expect(container.querySelector('[data-sd-role="studio-sessions-empty"]')).not.toBeNull();
            expect(container.querySelector('.sdlens-studio-messages > .lw-empty')).not.toBeNull();
            expect(container.querySelector('.sdlens-studio-gallery .lw-empty')).not.toBeNull();
            expect(container.querySelector('.sdlens-studio-gallery .lw-empty-hint')?.textContent?.trim().length).toBeGreaterThan(0);

            // Switching prompt preset in the Studio toolbar updates currentPresetId and persists settings.
            const saveSettingsDebounced = jest.fn();
            ctx.saveSettingsDebounced = saveSettingsDebounced;
            sdSettings.illustration.presets.push({
                id: 'preset_2',
                name: 'Natural language style',
                promptStyle: 'natural',
                promptDefaultsInitialized: true,
                illustrationPrompt: 'Natural prompt instructions',
                studioPrompt: 'Studio instructions',
                explorationPrompt: DEFAULT_EXPLORATION_PROMPT,
                llm: { apiPresetName: '', llmPresetName: '' },
                explorationLlm: { apiPresetName: '', llmPresetName: '' },
                visualInspection: false,
            });
            handle.update({ ws: 'sd', subview: 'studio' });
            await new Promise(r => setTimeout(r, 20));
            const presetSelect = container.querySelector('.sdlens-studio-toolbar [data-sd-role="studio-preset"]');
            presetSelect.value = 'preset_2';
            presetSelect.dispatchEvent(new Event('change', { bubbles: true }));
            await new Promise(r => setTimeout(r, 20));
            expect(sdSettings.illustration.currentPresetId).toBe('preset_2');
            expect(saveSettingsDebounced).toHaveBeenCalledTimes(1);
            presetSelect.value = 'preset_1';
            presetSelect.dispatchEvent(new Event('change', { bubbles: true }));
            await new Promise(r => setTimeout(r, 20));
            expect(sdSettings.illustration.currentPresetId).toBe('preset_1');

            // Enable Visual review and generate an image.
            const visualSwitch = container.querySelector('.sdlens-studio-toolbar button[role="switch"]');
            expect(visualSwitch).not.toBeNull();
            visualSwitch.click();
            await new Promise(r => setTimeout(r, 15));

            const input = container.querySelector('[data-sd-role="studio-input"]');
            input.value = 'Paint a harbor lighthouse at dusk.';
            input.dispatchEvent(new Event('input', { bubbles: true }));
            container.querySelector('[data-sd-role="studio-send"]').click();
            await new Promise(r => setTimeout(r, 80));

            expect(round).toBe(2);
            expect(generatedCalls).toHaveLength(1);
            expect(generatedCalls[0].opts).toMatchObject({
                attribution: 'none',
                subdir: '_studio',
                aspectRatio: '2:3',
                loras: [{ name: 'detail_tweaker.safetensors', weight: 0.7 }],
            });
            expect(container.querySelector('[data-studio-action="promote-reference"]')).toBeNull();

            // Attach the generated image as source via Edit source, disable visual review, and edit.
            container.querySelector('.sdlens-studio-toolbar button[role="switch"]').click();
            container.querySelector('[data-studio-action="edit-source"]').click();
            await new Promise(r => setTimeout(r, 15));

            const editInput = container.querySelector('[data-sd-role="studio-input"]');
            editInput.value = 'Turn the sky to starry midnight.';
            editInput.dispatchEvent(new Event('input', { bubbles: true }));
            container.querySelector('[data-sd-role="studio-send"]').click();
            await new Promise(r => setTimeout(r, 60));

            expect(generatedCalls).toHaveLength(2);
            expect(generatedCalls[1].opts.references).toEqual([
                { imagePath: '/user/images/_studio/free_1.png', role: 'source' },
            ]);

            // Empty studioPrompt errors before contacting the model.
            const callsBeforeEmpty = llmCalls.length;
            sdSettings.illustration.presets[0].studioPrompt = '   ';
            const emptyInput = container.querySelector('[data-sd-role="studio-input"]');
            emptyInput.value = 'Should fail without studio prompt.';
            emptyInput.dispatchEvent(new Event('input', { bubbles: true }));
            container.querySelector('[data-sd-role="studio-send"]').click();
            await new Promise(r => setTimeout(r, 20));
            expect(llmCalls).toHaveLength(callsBeforeEmpty);
            expect(toastMock).toHaveBeenCalledWith(expect.stringContaining('Fill in the prompt or reset it to the default.'), { error: true });

            // Characters view has no legacy launcher or OC studio refine button.
            handle.update({ ws: 'sd', subview: 'characters' });
            await new Promise(r => setTimeout(r, 20));
            expect(container.querySelector('.sdlens-launcher')).toBeNull();
            expect(container.querySelector('[data-sd-role="launch-submit"]')).toBeNull();
            expect(container.querySelector('[data-sd-role="refine-in-studio"]')).toBeNull();
            expect(container.querySelector('[data-sd-role="open-ai-builder"]')).not.toBeNull();

            handle.destroy();
        } finally {
            globalThis.fetch = originalFetch;
            cleanup();
        }
    });

    test('requiresVisiblePromptMigration', async () => {
        const legacyText = '  Custom legacy appearance sheet instructions.\nKeep exact details.\n';
        const { settings } = migrateIllustrationPromptSettings({
            initialized: true,
            currentPresetId: 'p_legacy',
            presets: [{
                id: 'p_legacy',
                name: 'Legacy Preset',
                promptStyle: 'tag',
                promptDefaultsInitialized: true,
                illustrationPrompt: 'ill',
                studioPrompt: 'stu',
                explorationPrompt: 'exp',
                characterDesignPrompt: legacyText,
            }],
        });

        expect(Object.hasOwn(settings.presets[0], 'characterDesignPrompt')).toBe(false);
        expect(settings.pendingCharacterDesignPrompts).toEqual([{
            presetId: 'p_legacy',
            presetName: 'Legacy Preset',
            text: legacyText,
        }]);

        // Minimal Popup harness hosting real dialog DOM inside document.body.
        const makePopupClass = (driveAction) => class MockPopup {
            constructor(content, _type, _input, opts = {}) {
                this.content = content;
                this.opts = opts;
                this.resolve = null;
            }
            async show() {
                document.body.appendChild(this.content);
                return await new Promise(resolve => {
                    this.resolve = resolve;
                    setTimeout(() => { void driveAction(this.content, this); }, 0);
                });
            }
            async complete(val) {
                this.content.remove();
                this.resolve?.(val);
            }
        };

        let saveCount = 0;
        const makeCtx = (PopupClass) => ({
            Popup: PopupClass,
            POPUP_TYPE: { DISPLAY: 1, CONFIRM: 2 },
            POPUP_RESULT: { AFFIRMATIVE: 1, NEGATIVE: 0, CANCELLED: null },
            translate: s => String(s ?? ''),
            workbench: {
                saveSettingsChecked: async () => { saveCount += 1; },
            },
        });

        // 1. Cancel keeps pendingCharacterDesignPrompts intact.
        await openLegacyCharacterDesignMigrationDialog({
            settings,
            context: makeCtx(makePopupClass((el) => {
                expect(el.querySelector('[data-sd-role="legacy-prompt-text"]').value).toBe(legacyText);
                el.querySelector('[data-sd-role="legacy-prompt-cancel"]').click();
            })),
        });
        expect(settings.pendingCharacterDesignPrompts).toHaveLength(1);
        expect(saveCount).toBe(0);

        // 2. Export without user confirmation keeps pendingCharacterDesignPrompts intact.
        let exportedPayload = '';
        await openLegacyCharacterDesignMigrationDialog({
            settings,
            context: makeCtx(makePopupClass(async (el) => {
                el.querySelector('[data-sd-role="legacy-prompt-export"]').click();
                await new Promise(r => setTimeout(r, 20));
                el.querySelector('[data-sd-role="legacy-prompt-cancel"]').click();
            })),
            exportFile: async (_name, content) => {
                exportedPayload = content;
                return true;
            },
            confirmAction: async () => false,
        });
        expect(exportedPayload).toContain(legacyText);
        expect(settings.pendingCharacterDesignPrompts).toHaveLength(1);
        expect(saveCount).toBe(0);

        // 3. Export with confirmed complete file clears pending record and persists settings.
        await openLegacyCharacterDesignMigrationDialog({
            settings,
            context: makeCtx(makePopupClass((el) => {
                el.querySelector('[data-sd-role="legacy-prompt-export"]').click();
            })),
            exportFile: async (_name, content) => {
                exportedPayload = content;
                return true;
            },
            confirmAction: async () => true,
        });
        expect(Object.hasOwn(settings, 'pendingCharacterDesignPrompts')).toBe(false);
        expect(saveCount).toBe(1);

        // 4. Discard requires explicit confirmation before clearing.
        settings.pendingCharacterDesignPrompts = [{ presetId: 'p_legacy', presetName: 'Legacy Preset', text: legacyText }];
        await openLegacyCharacterDesignMigrationDialog({
            settings,
            context: makeCtx(makePopupClass(async (el) => {
                el.querySelector('[data-sd-role="legacy-prompt-discard"]').click();
                await new Promise(r => setTimeout(r, 20));
                el.querySelector('[data-sd-role="legacy-prompt-cancel"]').click();
            })),
            confirmAction: async () => false,
        });
        expect(settings.pendingCharacterDesignPrompts).toHaveLength(1);

        await openLegacyCharacterDesignMigrationDialog({
            settings,
            context: makeCtx(makePopupClass((el) => {
                el.querySelector('[data-sd-role="legacy-prompt-discard"]').click();
            })),
            confirmAction: async () => true,
        });
        expect(Object.hasOwn(settings, 'pendingCharacterDesignPrompts')).toBe(false);
        expect(saveCount).toBe(2);
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

            // Draft edits: modify preset_1 (no retired character_design_prompt) AND add a character profile
            const toolDefs = await target.tools();
            const updateTool = toolDefs.find(t => t.function.name === 'sd_update_preset');
            expect(Object.hasOwn(updateTool.function.parameters.properties, 'character_design_prompt')).toBe(false);

            let draft = await target.runEdit({
                name: 'sd_update_preset',
                args: {
                    preset_id: 'preset_1',
                    illustration_prompt: 'Updated illustration instructions',
                    exploration_prompt: 'Updated exploration instructions',
                },
            }, JSON.parse(JSON.stringify(base)));
            draft = await target.runEdit({
                name: 'sd_upsert_character',
                args: {
                    id: 'char_iter_1',
                    name: 'Seren',
                    description: 'Emerald eyes, wearing a green cloak.',
                },
            }, draft);

            const baseUnits = target.units(base);
            const draftUnits = target.units(draft);
            expect(baseUnits.has('preset:preset_1')).toBe(true);
            expect(draftUnits.has('character:char_iter_1')).toBe(true);
            expect(Object.hasOwn(draftUnits.get('preset:preset_1').fields, 'characterDesignPrompt')).toBe(false);
            expect(draftUnits.get('preset:preset_1').fields.explorationPrompt).toBe('Updated exploration instructions');

            // Newly synthesized presets in rebuild use stored defaults rather than blank strings.
            const withAddedPreset = JSON.parse(JSON.stringify(draft));
            withAddedPreset.presets.push({ id: 'preset_new', name: 'Added Preset' });
            const rebuiltAdded = target.rebuild(base, withAddedPreset, ['preset:preset_new']);
            const addedPreset = rebuiltAdded.presets.find(p => p.id === 'preset_new');
            expect(addedPreset.promptStyle).toBe('tag');
            expect(addedPreset.promptDefaultsInitialized).toBe(true);
            expect(addedPreset.illustrationPrompt).toBe(getDefaultPromptValues('tag').illustrationPrompt);
            expect(addedPreset.studioPrompt).toBe(getDefaultPromptValues('tag').studioPrompt);
            expect(addedPreset.explorationPrompt).toBe(getDefaultPromptValues('tag').explorationPrompt);
            expect(Object.hasOwn(addedPreset, 'characterDesignPrompt')).toBe(false);

            // Selective rebuild: accept BOTH units, commit, verify persistence, then undo!
            const selectedKeys = ['preset:preset_1', 'character:char_iter_1'];
            const rebuilt = target.rebuild(base, draft, selectedKeys);
            const committed = await target.commit(loaded.target, base, rebuilt, selectedKeys);

            expect(committed.applied).toEqual(expect.arrayContaining(selectedKeys));
            expect(saveCount).toBeGreaterThanOrEqual(1);
            expect(sdSettings.illustration.presets[0].illustrationPrompt).toBe('Updated illustration instructions');
            expect(sdSettings.illustration.presets[0].explorationPrompt).toBe('Updated exploration instructions');
            expect(Object.hasOwn(sdSettings.illustration.presets[0], 'characterDesignPrompt')).toBe(false);

            const profileStore = createCharacterProfileStore(ctx);
            expect((await profileStore.getProfile('char_iter_1'))?.name).toBe('Seren');

            // Undo reverts both preset and character archive!
            await committed.undo();
            expect(sdSettings.illustration.presets[0].illustrationPrompt).toBe('Prompt instructions');
            expect(sdSettings.illustration.presets[0].explorationPrompt).toBe(DEFAULT_EXPLORATION_PROMPT);
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

            // sd.reference-config-conflict SuggestRule fires when switches conflict with backend protocol
            const conflictRule = suggestProvider.rules.find(r => r.id === 'sd.reference-config-conflict');
            expect(conflictRule).toBeDefined();
            expect(conflictRule.check({ providers: { sd: cleanSnap } })).toBeNull();

            sdSettings.source = 'google';
            sdSettings.model = 'imagen-3.0-generate-002';
            sdSettings.img2img_enabled = true;
            const conflictSnap = await askProvider.getSnapshot(ctx);
            expect(conflictSnap.img2imgEnabled).toBe(true);
            expect(conflictSnap.referenceWarnings.map(w => w.code)).toContain('google_model_no_image_input');
            const conflictHit = conflictRule.check({ providers: { sd: conflictSnap } });
            expect(conflictHit).not.toBeNull();
            expect(conflictHit.sig).toContain('google_model_no_image_input');

            const capPayload = await askProvider.readers.wb_read_sd({ part: 'capabilities' }, ctx);
            expect(capPayload.supportsSourceImage).toBe(true);
            expect(capPayload.warnings.map(w => w.code)).toContain('google_model_no_image_input');
        } finally {
            globalThis.fetch = originalFetch;
            cleanup();
        }
    });

    test('Studio obeys reference switches, hides Edit source when img2img is off, filters disabled refs on replay, and enforces caps/conflicts', async () => {
        const { ctx, reg } = createHarnessContext();
        const profileStore = createCharacterProfileStore(ctx);
        await profileStore.upsertProfile({
            id: 'char_elena',
            name: 'Elena',
            sourceWork: 'Harbor',
            description: 'Silver bob, teal eyes, wearing a navy coat.',
            referenceImages: [
                { path: '/user/images/_references/elena_1.png', label: 'Coat' },
                { path: '/user/images/_references/elena_2.png', label: 'Coat' },
            ],
        });

        let activeCaps = {
            source: 'google',
            model: 'gemini-2.5-flash-image',
            characterReferenceEnabled: false,
            characterReferenceMode: 'text_only',
            supportsCharacterTextReference: false,
            supportsCharacterReference: false,
            maxCharacterReferences: 0,
            supportsStyleReference: false,
            maxStyleReferences: 0,
            supportsSourceImage: false,
            supportsMultiCharacterPrompts: false,
            supportsDynamicAspectRatio: true,
            availableLoras: { names: [], includeWeight: false },
            warnings: [],
        };

        const generatedCalls = [];
        const llmCalls = [];
        let scriptStep = 'no_source';
        let charModeRound = 0;
        ctx.generateTask = async (opts) => {
            llmCalls.push(JSON.parse(JSON.stringify(opts)));
            if (scriptStep === 'no_source') {
                return {
                    toolCalls: [{ id: 'g1', name: 'generate_image', args: { prompt: '1girl, pier' } }],
                    assistantText: '',
                };
            }
            if (scriptStep === 'char_mode') {
                charModeRound += 1;
                if (charModeRound === 1) {
                    return {
                        toolCalls: [{ id: 'r1', name: 'read_character_profiles', args: { ids: ['char_elena'] } }],
                        assistantText: '',
                    };
                }
                return {
                    toolCalls: [{
                        id: 'g2',
                        name: 'generate_image',
                        args: {
                            prompt: '1girl, pier at dusk',
                            character_refs: [{ profile_id: 'char_elena' }],
                        },
                    }],
                    assistantText: '',
                };
            }
            return { toolCalls: [], assistantText: '' };
        };

        const imageService = {
            async getAvailableLoras() { return { names: [], includeWeight: false }; },
            async getCapabilities() { return JSON.parse(JSON.stringify(activeCaps)); },
            async generate(prompt, opts) {
                generatedCalls.push({ prompt, opts });
                return `/user/images/_studio/sw_${generatedCalls.length}.png`;
            },
        };

        globalThis.Luker = { getContext: () => ctx };
        const cleanup = initSdLens({ getContext: () => ctx, imageService });
        const ws = reg.getWorkspaces().find(w => w.id === 'sd');
        const container = document.createElement('div');
        document.body.appendChild(container);
        const toastMock = jest.fn();

        try {
            const handle = ws.mount(container, {
                app: { toast: toastMock, isCompact: () => false },
                opts: { ws: 'sd', subview: 'studio' },
            });
            await new Promise(r => setTimeout(r, 30));

            // 1. With supportsSourceImage=false and characterReferenceEnabled=false: generate succeeds, Edit source is hidden.
            const input = container.querySelector('[data-sd-role="studio-input"]');
            input.value = 'Draw a quiet pier.';
            input.dispatchEvent(new Event('input', { bubbles: true }));
            container.querySelector('[data-sd-role="studio-send"]').click();
            await new Promise(r => setTimeout(r, 50));

            expect(generatedCalls).toHaveLength(1);
            expect(llmCalls[0].tools.map(t => t.function.name)).toEqual(['generate_image']);
            expect(llmCalls[0].tools[0].function.parameters.properties).not.toHaveProperty('source_image_id');
            expect(container.querySelector('[data-studio-action="edit-source"]')).toBeNull();

            // 2. Enable character references (image_only) -> exposes read_character_profiles & character_refs, hides description.
            activeCaps = {
                ...activeCaps,
                characterReferenceEnabled: true,
                characterReferenceMode: 'image_only',
                supportsCharacterTextReference: false,
                supportsCharacterReference: true,
                maxCharacterReferences: 2,
            };
            scriptStep = 'char_mode';
            const input2 = container.querySelector('[data-sd-role="studio-input"]');
            input2.value = 'Draw Elena at dusk.';
            input2.dispatchEvent(new Event('input', { bubbles: true }));
            container.querySelector('[data-sd-role="studio-send"]').click();
            await new Promise(r => setTimeout(r, 60));

            expect(generatedCalls).toHaveLength(2);
            expect(generatedCalls[1].opts.references).toEqual([
                { imagePath: '/user/images/_references/elena_1.png', role: 'character', label: 'Elena — Coat' },
                { imagePath: '/user/images/_references/elena_2.png', role: 'character', label: 'Elena — Coat' },
            ]);
            const readToolReply = llmCalls.at(-1).taskMessages.findLast(m => m.role === 'tool')?.content || '';
            expect(readToolReply).toContain('path=/user/images/_references/elena_1.png | label=Coat');
            expect(readToolReply).not.toContain('description:');

            // 3. Replay with character references disabled -> skips saved character refs and warns via toast.
            activeCaps = {
                ...activeCaps,
                characterReferenceEnabled: false,
                characterReferenceMode: 'text_only',
                supportsCharacterReference: false,
                maxCharacterReferences: 0,
            };
            container.querySelector('[data-studio-action="regenerate"]').click();
            await new Promise(r => setTimeout(r, 50));

            expect(generatedCalls).toHaveLength(3);
            expect(generatedCalls[2].opts.references).toBeUndefined();
            expect(toastMock).toHaveBeenCalledWith(
                expect.stringContaining('Some saved reference images were skipped'),
                expect.any(Object),
            );

            // 4. Conflict fast-fail blocks studio turn before sending to LLM.
            activeCaps = {
                ...activeCaps,
                characterReferenceEnabled: true,
                characterReferenceMode: 'text_and_image',
                supportsCharacterReference: true,
                maxCharacterReferences: 0,
                warnings: [{
                    code: 'comfy_missing_ref_slots',
                    message: 'Current ComfyUI workflow does not contain any %ref_image% LoadImage nodes, so requests with reference images or img2img will fail.',
                    affects: ['character_image'],
                }],
            };
            const llmCountBeforeConflict = llmCalls.length;
            const input3 = container.querySelector('[data-sd-role="studio-input"]');
            input3.value = 'Should fail fast on conflict.';
            input3.dispatchEvent(new Event('input', { bubbles: true }));
            container.querySelector('[data-sd-role="studio-send"]').click();
            await new Promise(r => setTimeout(r, 40));

            expect(llmCalls).toHaveLength(llmCountBeforeConflict);
            expect(toastMock).toHaveBeenCalledWith(expect.stringContaining('%ref_image%'), { error: true });

            handle.destroy();
        } finally {
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

        // Important 4: Studio regeneration reconstructs references and zh-cn characters view localizes labels cleanly
        const profileStore = createCharacterProfileStore(ctx);
        await profileStore.upsertProfile({
            id: 'char_unrelated',
            name: 'Unrelated Hero',
            description: 'Armored knight.',
            referenceImages: [],
        });
        await profileStore.upsertProfile({
            id: 'char_target',
            name: 'Target Heroine',
            description: 'Wears casual attire or a gala gown.',
            referenceImages: [],
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

        // Regenerate img_derived -> must pass reconstructed source + character references, with no promote-reference button!
        expect(container.querySelector('[data-studio-action="promote-reference"]')).toBeNull();
        container.querySelector('[data-studio-action="regenerate"]').click();
        await new Promise(r => setTimeout(r, 30));
        expect(generateCalls).toHaveLength(1);
        expect(generateCalls[0].opts.references).toEqual([
            { imagePath: '/user/images/_studio/src.png', role: 'source' },
            { imagePath: '/user/images/_studio/chr.png', role: 'character' },
        ]);

        // Switch to characters & run views in zh-cn -> verify zero UNTRANSLATED:, no legacy launcher, and no raw reference image(s)/outfit(s)/round(s)
        handle.update({ subview: 'characters' });
        await new Promise(r => setTimeout(r, 30));
        expect(container.textContent).not.toContain('UNTRANSLATED:');
        expect(container.textContent).not.toContain('outfit(s)');
        expect(container.textContent).not.toContain('reference image(s)');
        expect(container.querySelector('.sdlens-launcher')).toBeNull();
        expect(container.querySelector('[data-sd-role="refine-in-studio"]')).toBeNull();

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
