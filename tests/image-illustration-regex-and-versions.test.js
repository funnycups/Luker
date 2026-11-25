/**
 * @jest-environment jsdom
 */
import { describe, expect, jest, test } from '@jest/globals';

globalThis.structuredClone ??= value => JSON.parse(JSON.stringify(value));

const mockCallGenericPopup = jest.fn(async () => 'edited prompt');

class MockPopup {
    constructor(content) {
        this.content = content;
        this.el = null;
    }

    show() {
        this.el = document.createElement('div');
        this.el.className = 'mock-popup';
        this.el.innerHTML = String(this.content || '');
        document.body.appendChild(this.el);
    }

    async complete() {
        this.el?.remove();
        this.el = null;
        return 1;
    }
}

jest.unstable_mockModule('../public/scripts/popup.js', () => ({
    Popup: MockPopup,
    POPUP_TYPE: { TEXT: 1, CONFIRM: 2, INPUT: 3, DISPLAY: 4, CROP: 5 },
    POPUP_RESULT: { AFFIRMATIVE: 1, NEGATIVE: 0, CANCELLED: null },
    callGenericPopup: mockCallGenericPopup,
}));

jest.unstable_mockModule('../public/scripts/chats.js', () => ({
    deleteMediaFromServer: jest.fn(async () => true),
}));

const {
    buildImageTag,
    buildFailedTag,
    buildIllustrationStripRegexScript,
    stripUnlockedIllustrationMarkup,
} = await import('../public/scripts/extensions/stable-diffusion/illustration/message.js');
const {
    buildIllustrationContext,
} = await import('../public/scripts/extensions/stable-diffusion/illustration/task.js');
const {
    createIllustrationRecord,
    collectVersionTree,
    switchMessageIllustrationVersion,
} = await import('../public/scripts/extensions/stable-diffusion/illustration/records.js');
const {
    createIllustrationPipeline,
} = await import('../public/scripts/extensions/stable-diffusion/illustration/pipeline.js');
const {
    filterReplayReferences,
    initIllustrationActions,
} = await import('../public/scripts/extensions/stable-diffusion/illustration/actions.js');

function installDomJquery() {
    function wrap(elements) {
        const list = elements.filter(Boolean);
        return {
            length: list.length,
            0: list[0],
            on(eventName, selectorOrHandler, maybeHandler) {
                const isDelegated = typeof selectorOrHandler === 'string';
                const handler = isDelegated ? maybeHandler : selectorOrHandler;
                for (const el of list) {
                    el.addEventListener(eventName, event => {
                        if (!isDelegated) {
                            handler.call(el, event);
                            return;
                        }
                        const matched = event.target?.closest?.(selectorOrHandler);
                        if (matched && el.contains(matched)) {
                            handler.call(matched, event);
                        }
                    });
                }
                return this;
            },
            find(selector) {
                const found = [];
                for (const el of list) {
                    found.push(...el.querySelectorAll(selector));
                }
                return wrap(found);
            },
            attr(name) {
                return list[0]?.getAttribute?.(name) ?? undefined;
            },
            prop(name) {
                return list[0]?.[name];
            },
        };
    }
    const jq = selectorOrEl => {
        if (typeof selectorOrEl === 'string') {
            return wrap([...document.querySelectorAll(selectorOrEl)]);
        }
        if (selectorOrEl instanceof Element || selectorOrEl === document) {
            return wrap([selectorOrEl]);
        }
        return wrap([]);
    };
    globalThis.$ = jq;
    globalThis.jQuery = jq;
}

function compileScriptRegex(findRegex) {
    const match = /^\/([\s\S]+)\/([gimsuy]*)$/.exec(String(findRegex || ''));
    if (!match) {
        throw new Error(`Invalid regex literal: ${findRegex}`);
    }
    return new RegExp(match[1], match[2]);
}

describe('Illustration promptOnly regex, <img alt> context, version switching, locking, and source edits', () => {
    test('buildImageTag writes alt without duplicate title and buildIllustrationStripRegexScript strips only illustration tags on prompt lane', () => {
        const imgHtml = buildImageTag({
            id: 'ill_10',
            imageUrl: '/user/images/scene.png',
            prompt: '1girl, starry balcony',
            width: 85,
        });
        expect(imgHtml).toContain('alt="1girl, starry balcony"');
        expect(imgHtml).not.toContain('title=');

        const failedHtml = buildFailedTag({
            id: 'ill_11',
            prompt: 'broken',
            error: 'upstream 500',
        });

        const rule = buildIllustrationStripRegexScript({ placement: { USER_INPUT: 1, AI_OUTPUT: 2 } });
        expect(rule).toMatchObject({
            promptOnly: true,
            markdownOnly: false,
            pluginLanes: [],
            placement: [1, 2],
        });

        const regex = compileScriptRegex(rule.findRegex);
        const mixed = `Alpha ${imgHtml} Beta <img src="/user/images/manual.png"> Gamma ${failedHtml} Delta`;
        expect(mixed.replace(regex, rule.replaceString)).toBe('Alpha Beta <img src="/user/images/manual.png"> Gamma Delta');
    });

    test('buildIllustrationContext uses readPluginFloors to preserve historical <img alt> while stripping only unlocked tags on current floor', () => {
        const histImg = buildImageTag({
            id: 'ill_prev',
            imageUrl: '/user/images/prev.png',
            prompt: 'silver-haired girl holding umbrella',
            width: 80,
        });
        const lockedImg = buildImageTag({
            id: 'ill_locked',
            imageUrl: '/user/images/locked.png',
            prompt: 'close-up of golden pocket watch',
            width: 80,
        });
        const unlockedImg = buildImageTag({
            id: 'ill_unlocked',
            imageUrl: '/user/images/unlocked.png',
            prompt: 'old unlocked scene',
            width: 80,
        });

        const chat = [
            { name: 'User', is_user: true, mes: 'Show me the station.' },
            { name: 'Narrator', is_user: false, mes: `Rain fell softly. ${histImg} She stepped onto the platform.` },
            { name: 'Narrator', is_user: false, mes: `First moment. ${lockedImg} Second moment. ${unlockedImg} Final moment.` },
        ];

        const readPluginFloors = jest.fn(() => [
            { seq: 1, sourceIndex: 0, is_user: true, is_system: false, mesCooked: chat[0].mes },
            { seq: 2, sourceIndex: 1, is_user: false, is_system: false, mesCooked: chat[1].mes },
        ]);

        const built = buildIllustrationContext({
            chat,
            context: { chat, readPluginFloors },
            messageId: 2,
            contextMessageCount: 5,
            stripMarkup: text => stripUnlockedIllustrationMarkup(text, new Set()),
            lockedIds: new Set(['ill_locked']),
        });

        expect(readPluginFloors).toHaveBeenCalledWith(expect.objectContaining({ toSeq: 2 }));
        expect(built.context).toContain('alt="silver-haired girl holding umbrella"');
        expect(built.context).toContain('data-illustration-id="ill_prev"');
        expect(built.current).toContain('data-illustration-id="ill_locked"');
        expect(built.current).not.toContain('data-illustration-id="ill_unlocked"');
    });

    test('manual pipeline re-run preserves locked illustrations and aligns new anchors without offset', async () => {
        const lockedTag = buildImageTag({
            id: 'locked_1',
            imageUrl: '/user/images/locked.png',
            prompt: 'locked prompt',
            width: 100,
        });
        const unlockedTag = buildImageTag({
            id: 'unlocked_1',
            imageUrl: '/user/images/unlocked.png',
            prompt: 'unlocked prompt',
            width: 100,
        });

        const message = {
            name: 'Narrator',
            is_user: false,
            is_system: false,
            mes: `Opening scene. ${lockedTag} Middle scene. ${unlockedTag} Closing scene.`,
            send_date: 10,
            original_avatar: 'a.png',
            swipe_id: 0,
            swipes: [`Opening scene. ${lockedTag} Middle scene. ${unlockedTag} Closing scene.`],
            swipe_info: [{ extra: {} }],
            extra: {
                illustrations: [
                    createIllustrationRecord({
                        id: 'locked_1',
                        prompt: 'locked prompt',
                        imageUrl: '/user/images/locked.png',
                        anchorAfter: 'Opening scene.',
                        anchorBefore: 'Middle scene.',
                        locked: true,
                    }),
                    createIllustrationRecord({
                        id: 'unlocked_1',
                        prompt: 'unlocked prompt',
                        imageUrl: '/user/images/unlocked.png',
                        anchorAfter: 'Middle scene.',
                        anchorBefore: 'Closing scene.',
                        locked: false,
                    }),
                ],
            },
        };

        const chat = [message];
        let capturedTaskMessages = null;
        const pipeline = createIllustrationPipeline({
            context: {
                chat,
                chatId: 'chat-lock',
                readPluginFloors: () => [],
                generateTask: async ({ taskMessages }) => {
                    capturedTaskMessages = taskMessages;
                    return {
                        toolCalls: [{
                            name: 'add_image_prompt',
                            args: {
                                prompt: 'fresh closing scene',
                                insert_after: 'Middle scene.',
                                insert_before: 'Closing scene.',
                            },
                        }],
                    };
                },
            },
            imageService: {
                configure() {},
                getAvailableLoras: async () => ({ names: [], includeWeight: false }),
                getCapabilities: async () => ({
                    source: 'novel',
                    model: 'nai-diffusion-4-5-full',
                    supportsCharacterReference: true,
                    maxCharacterReferences: 4,
                    supportsStyleReference: true,
                    maxStyleReferences: 4,
                    supportsSourceImage: true,
                    supportsMultiCharacterPrompts: true,
                    supportsDynamicAspectRatio: true,
                    availableLoras: { names: [], includeWeight: false },
                }),
                generate: async () => '/user/images/fresh.png',
            },
            settings: {
                enabled: true,
                autoGenerate: false,
                currentPresetId: 'p1',
                presets: [{ id: 'p1', illustrationPrompt: 'DRAW', llm: { apiPresetName: '', llmPresetName: '' } }],
                contextMessageCount: 3,
                maxConcurrentGenerations: 1,
                minGenerationInterval: 0,
                imageDisplayWidth: 100,
            },
            hooks: {
                toast() {},
                notifyError() {},
                t: (strings, ...values) => strings.reduce((out, s, i) => out + s + (values[i] ?? ''), ''),
                saveChat: async () => {},
                updateMessageBlock() {},
                ensureSwipes() {},
                getChatId: () => 'chat-lock',
                getChat: () => chat,
                confirmReplace: async () => true,
            },
        });

        await pipeline.runForMessage({ messageId: 0, source: 'manual' });

        expect(capturedTaskMessages[1].content).toContain('data-illustration-id="locked_1"');
        expect(capturedTaskMessages[1].content).not.toContain('data-illustration-id="unlocked_1"');

        expect(message.mes).toContain('data-illustration-id="locked_1"');
        expect(message.mes).not.toContain('data-illustration-id="unlocked_1"');
        expect(message.mes).toContain('src="/user/images/fresh.png"');
        expect(message.mes.indexOf('locked_1')).toBeLessThan(message.mes.indexOf('Middle scene.'));
        expect(message.mes.indexOf('Middle scene.')).toBeLessThan(message.mes.indexOf('/user/images/fresh.png'));
        expect(message.mes.indexOf('/user/images/fresh.png')).toBeLessThan(message.mes.indexOf('Closing scene.'));
        expect(message.extra.illustrations.map(r => r.prompt)).toEqual(['locked prompt', 'fresh closing scene']);
    });

    test('createIllustrationRecord persists extended fields and collectVersionTree retains full ancestor+descendant tree', () => {
        const root = createIllustrationRecord({
            id: 'v1',
            prompt: 'v1 prompt',
            negativePrompt: 'bad hands',
            aspectRatio: '2:3',
            references: [{ imagePath: '/user/images/_references/c1.png', role: 'character' }],
            characterPrompts: [{ prompt: '1girl', center: { x: 0.5, y: 0.5 } }],
            locked: true,
            imageUrl: '/user/images/v1.png',
            createdAt: 100,
        });
        const child = createIllustrationRecord({
            id: 'v2',
            parentId: 'v1',
            prompt: 'v2 prompt',
            imageUrl: '/user/images/v2.png',
            createdAt: 200,
        });
        const grandChild = createIllustrationRecord({
            id: 'v3',
            parentId: 'v2',
            prompt: 'v3 prompt',
            imageUrl: '/user/images/v3.png',
            createdAt: 300,
        });

        expect(root.negativePrompt).toBe('bad hands');
        expect(root.aspectRatio).toBe('2:3');
        expect(root.references).toEqual([{ imagePath: '/user/images/_references/c1.png', role: 'character' }]);
        expect(root.characterPrompts).toEqual([{ prompt: '1girl', center: { x: 0.5, y: 0.5 } }]);
        expect(root.locked).toBe(true);

        const msg = {
            mes: `Scene ${buildImageTag({ id: 'v3', imageUrl: '/user/images/v3.png', prompt: 'v3 prompt', width: 90 })} end`,
            swipe_id: 0,
            swipes: [''],
            swipe_info: [{ extra: {} }],
            extra: { illustrations: [root, child, grandChild] },
        };
        // Even when currently viewing v1, collectVersionTree still returns [v1, v2, v3]!
        expect(collectVersionTree(msg, root).map(r => r.id)).toEqual(['v1', 'v2', 'v3']);
        expect(collectVersionTree(msg, grandChild).map(r => r.id)).toEqual(['v1', 'v2', 'v3']);

        // Direct switch from v3 -> v1 updates markup & swipe without dropping v2/v3
        const switchedToV1 = switchMessageIllustrationVersion({
            message: msg,
            fromId: 'v3',
            toId: 'v1',
            imageDisplayWidth: 90,
            ensureSwipes: () => {},
        });
        expect(switchedToV1).toBe(true);
        expect(msg.mes).toContain('data-illustration-id="v1"');
        expect(msg.mes).toContain('src="/user/images/v1.png"');
        expect(msg.swipes[0]).toBe(msg.mes);

        // And switching forward from v1 -> v2 works seamlessly
        const switchedToV2 = switchMessageIllustrationVersion({
            message: msg,
            fromId: 'v1',
            toId: 'v2',
            imageDisplayWidth: 90,
            ensureSwipes: () => {},
        });
        expect(switchedToV2).toBe(true);
        expect(msg.mes).toContain('data-illustration-id="v2"');
        expect(msg.mes).toContain('src="/user/images/v2.png"');
    });

    test('filterReplayReferences strips only roles disabled by current preset capabilities', () => {
        const saved = [
            { imagePath: '/user/images/_references/char.png', role: 'character', label: 'Lyra' },
            { imagePath: '/user/images/src.png', role: 'source' },
            { imagePath: '/user/images/style.png', role: 'style', strength: 0.7 },
        ];

        const onlyStyle = filterReplayReferences(saved, {
            supportsCharacterReference: false,
            supportsSourceImage: false,
            supportsStyleReference: true,
        });
        expect(onlyStyle.references).toEqual([saved[2]]);
        expect(onlyStyle.skipped).toEqual([saved[0], saved[1]]);

        const allEnabled = filterReplayReferences(saved, {
            supportsCharacterReference: true,
            supportsSourceImage: true,
            supportsStyleReference: true,
        });
        expect(allEnabled.references).toEqual(saved);
        expect(allEnabled.skipped).toEqual([]);
    });

    test('initIllustrationActions filters disabled saved references on replay, warns, and toggles Edit from this image by supportsSourceImage', async () => {
        installDomJquery();
        document.body.innerHTML = '';
        mockCallGenericPopup.mockReset();

        const chatEl = document.createElement('div');
        chatEl.id = 'chat';
        document.body.appendChild(chatEl);

        const savedRefs = [
            { imagePath: '/user/images/_references/lyra.png', role: 'character', label: 'Lyra' },
        ];
        const imgTag = buildImageTag({
            id: 'ill_saved',
            imageUrl: '/user/images/saved.png',
            prompt: '1girl on balcony',
            width: 100,
        });
        const chat = [{
            name: 'Narrator',
            is_user: false,
            is_system: false,
            send_date: 1,
            original_avatar: 'a.png',
            mes: `Before ${imgTag} After`,
            swipe_id: 0,
            swipes: [`Before ${imgTag} After`],
            swipe_info: [{ extra: {} }],
            extra: {
                illustrations: [
                    createIllustrationRecord({
                        id: 'ill_saved',
                        prompt: '1girl on balcony',
                        imageUrl: '/user/images/saved.png',
                        references: savedRefs,
                        anchorAfter: 'Before',
                        anchorBefore: 'After',
                    }),
                ],
            },
        }];

        chatEl.innerHTML = `<div class="mes" mesid="0"><div class="mes_text">${chat[0].mes}</div></div>`;

        let currentCaps = {
            supportsCharacterReference: false,
            supportsSourceImage: false,
            supportsStyleReference: false,
        };
        const generateCalls = [];
        const toasts = [];
        const actions = initIllustrationActions({
            context: {
                chatId: 'chat-replay',
                chat,
                updateMessageBlock() {},
                saveChat: async () => {},
                eventSource: { emit: jest.fn(async () => {}) },
                eventTypes: { MESSAGE_EDITED: 'MESSAGE_EDITED', MESSAGE_UPDATED: 'MESSAGE_UPDATED' },
            },
            pipeline: { cancelForMessage() {} },
            imageService: {
                getAvailableLoras: async () => ({ names: [], includeWeight: false }),
                getCapabilitiesSnapshot: () => currentCaps,
                generate: async (prompt, opts) => {
                    generateCalls.push({ prompt, opts });
                    return `/user/images/replayed_${generateCalls.length}.png`;
                },
            },
            settings: { imageDisplayWidth: 100 },
            ensureSwipes: () => {},
            toast: (msg, type) => toasts.push({ msg, type }),
            notifyError: err => { throw new Error(`Unexpected error: ${err}`); },
            t: (strings, ...values) => strings.reduce((out, s, i) => out + s + (values[i] ?? ''), ''),
        });

        // When supportsSourceImage is false, Edit from this image button is hidden and replay skips character ref
        const imgEl = chatEl.querySelector('[data-illustration-id="ill_saved"]');
        await actions.handleClick(imgEl);
        expect(document.getElementById('sd_illustration_action_edit_from_image')).toBeNull();

        document.getElementById('sd_illustration_action_regenerate').click();
        await new Promise(resolve => setTimeout(resolve, 20));

        expect(generateCalls).toHaveLength(1);
        expect(generateCalls[0].opts.references).toBeUndefined();
        expect(toasts).toHaveLength(1);
        expect(toasts[0].type).toBe('warning');
        expect(chat[0].extra.illustrations.at(-1).references).toEqual([]);

        // When supportsSourceImage is true, Edit from this image button is visible and sends role:'source'
        currentCaps = {
            supportsCharacterReference: false,
            supportsSourceImage: true,
            supportsStyleReference: false,
        };
        chat[0].extra.illustrations.push(createIllustrationRecord({
            id: 'ill_source_saved',
            prompt: '1girl with lantern',
            imageUrl: '/user/images/lantern.png',
            references: [{ imagePath: '/user/images/old_src.png', role: 'source' }],
            anchorAfter: 'Before',
            anchorBefore: 'After',
        }));
        const imgTag2 = buildImageTag({
            id: 'ill_source_saved',
            imageUrl: '/user/images/lantern.png',
            prompt: '1girl with lantern',
            width: 100,
        });
        chatEl.innerHTML = `<div class="mes" mesid="0"><div class="mes_text">Before ${imgTag2} After</div></div>`;
        chat[0].mes = `Before ${imgTag2} After`;

        await actions.handleClick(chatEl.querySelector('[data-illustration-id="ill_source_saved"]'));
        const editFromBtn = document.getElementById('sd_illustration_action_edit_from_image');
        expect(editFromBtn).not.toBeNull();

        mockCallGenericPopup.mockResolvedValueOnce('Add moonlight');
        editFromBtn.click();
        await new Promise(resolve => setTimeout(resolve, 20));

        expect(generateCalls).toHaveLength(2);
        expect(generateCalls[1].opts.references).toEqual([
            { imagePath: '/user/images/lantern.png', role: 'source' },
        ]);

        // Replaying a saved source-ref illustration while supportsSourceImage is now false skips the source ref
        currentCaps = {
            supportsCharacterReference: false,
            supportsSourceImage: false,
            supportsStyleReference: false,
        };
        toasts.length = 0;
        const latestImgEl = chatEl.querySelector('[data-illustration-id]');
        await actions.handleClick(latestImgEl);
        expect(document.getElementById('sd_illustration_action_edit_from_image')).toBeNull();

        mockCallGenericPopup.mockResolvedValueOnce('1girl with brighter lantern');
        document.getElementById('sd_illustration_action_edit_prompt').click();
        await new Promise(resolve => setTimeout(resolve, 20));

        expect(generateCalls).toHaveLength(3);
        expect(generateCalls[2].opts.references).toBeUndefined();
        expect(toasts).toHaveLength(1);
        expect(toasts[0].type).toBe('warning');
    });
});
