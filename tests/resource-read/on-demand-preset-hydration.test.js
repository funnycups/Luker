// SPDX-License-Identifier: AGPL-3.0-or-later

import { afterEach, describe, expect, jest, test } from '@jest/globals';

import { dispatchToSender, generateTask } from '../../public/scripts/generate-task.js';

describe('generate-task on-demand preset hydration', () => {
    afterEach(() => {
        jest.restoreAllMocks();
    });

    test('hydrates llmPresetName before message assembly and stream-flag resolution', async () => {
        const callOrder = [];
        const openaiSettingNames = { Default: 0, ColdPreset: 1 };
        const openaiSettings = [{ stream_openai: false, temperature: 1.0 }, null];
        const hydratedBody = { stream_openai: false, temperature: 0.25 };

        const ensurePresetHydrated = jest.fn(async (apiId, name) => {
            callOrder.push(`hydrate:${apiId}:${name}`);
            if (apiId === 'openai' && name === 'ColdPreset') {
                openaiSettings[1] = hydratedBody;
            }
            return hydratedBody;
        });

        const sendOpenAIRequest = jest.fn(async () => {
            callOrder.push('sendOpenAIRequest');
            expect(openaiSettings[1]).toBe(hydratedBody);
            return { choices: [{ message: { content: 'ok' } }] };
        });

        const controller = new AbortController();
        const result = await generateTask(
            {
                taskMessages: [{ role: 'user', content: 'hi' }],
                llmPresetName: 'ColdPreset',
                worldInfoSource: 'none',
                includeCharacterCard: false,
                abortSignal: controller.signal,
            },
            {
                _injected: {
                    profileResolver: () => ({
                        requestApi: 'openai',
                        apiSettingsOverride: null,
                    }),
                    builder: ({ promptPresetName }) => {
                        callOrder.push(`builder:${promptPresetName}`);
                        expect(openaiSettings[1]).toBe(hydratedBody);
                        return [{ role: 'user', content: 'hi' }];
                    },
                    senders: {
                        sendOpenAIRequest,
                        ensurePresetHydrated,
                        getOpenAiRuntime: () => ({
                            oai_settings: { stream_openai: false },
                            openai_settings: openaiSettings,
                            openai_setting_names: openaiSettingNames,
                        }),
                    },
                },
            },
        );

        expect(result.assistantText).toBe('ok');
        expect(ensurePresetHydrated).toHaveBeenCalledTimes(1);
        expect(ensurePresetHydrated).toHaveBeenCalledWith('openai', 'ColdPreset', { signal: controller.signal });
        expect(callOrder).toEqual([
            'hydrate:openai:ColdPreset',
            'builder:ColdPreset',
            'sendOpenAIRequest',
        ]);
    });

    test('dispatchToSender hydrates unhydrated Kobold and NovelAI presets on demand', async () => {
        const koboldBodies = [null];
        const koboldNames = { KoboldCold: 0 };
        const hydratedKobold = { temp: 0.6 };

        const ensureKobold = jest.fn(async (apiId, name) => {
            expect(apiId).toBe('kobold');
            expect(name).toBe('KoboldCold');
            koboldBodies[0] = hydratedKobold;
            return hydratedKobold;
        });
        const getKoboldGenerationData = jest.fn((prompt, settings) => {
            expect(settings).toBe(hydratedKobold);
            return { prompt, temp: settings.temp };
        });

        await dispatchToSender({
            requestApi: 'kobold',
            payload: 'hello',
        }, {
            senders: {
                ensurePresetHydrated: ensureKobold,
                getKoboldGenerationData,
                getKoboldRuntime: () => ({
                    kai_settings: { preset_settings: 'KoboldCold', api_server: 'http://localhost' },
                    koboldai_settings: koboldBodies,
                    koboldai_setting_names: koboldNames,
                    amount_gen: 120,
                    max_context: 2048,
                }),
                getGenerateUrl: () => '/api/backends/kobold/generate',
                getRequestHeaders: () => ({ 'Content-Type': 'application/json' }),
                fetchImpl: jest.fn(async () => ({
                    ok: true,
                    status: 200,
                    json: async () => ({ results: [{ text: 'done' }] }),
                })),
            },
        });
        expect(ensureKobold).toHaveBeenCalledTimes(1);

        const novelBodies = [null];
        const novelNames = { NovelCold: 0 };
        const hydratedNovel = { temperature: 0.8 };
        const ensureNovel = jest.fn(async (apiId, name) => {
            expect(apiId).toBe('novel');
            expect(name).toBe('NovelCold');
            novelBodies[0] = hydratedNovel;
            return hydratedNovel;
        });
        const getNovelGenerationData = jest.fn((prompt, settings) => {
            expect(settings).toBe(hydratedNovel);
            return { input: prompt, temperature: settings.temperature };
        });

        await dispatchToSender({
            requestApi: 'novel',
            payload: 'hello',
        }, {
            senders: {
                ensurePresetHydrated: ensureNovel,
                getNovelGenerationData,
                getNovelRuntime: () => ({
                    nai_settings: { preset_settings_novel: 'NovelCold' },
                    novelai_settings: novelBodies,
                    novelai_setting_names: novelNames,
                    amount_gen: 120,
                }),
                getGenerateUrl: () => '/api/novelai/generate',
                getRequestHeaders: () => ({ 'Content-Type': 'application/json' }),
                fetchImpl: jest.fn(async () => ({
                    ok: true,
                    status: 200,
                    json: async () => ({ output: 'done' }),
                })),
            },
        });
        expect(ensureNovel).toHaveBeenCalledTimes(1);
    });
});
