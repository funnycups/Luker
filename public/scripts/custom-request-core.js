// SPDX-License-Identifier: AGPL-3.0-or-later

import { ProtocolParseError, createProtocolStreamParser, isParsedTurnEmpty, parseCompatChatCompletionResponse, resolveWireProtocol } from './lib/protocol-parser/index.js';
import { unescapeMacroBracesInRequestData } from './macros/util/escape.js';
import EventSourceStream from './lib/event-source-stream.js';
import {
    resolveCustomRequestLeaseOptions,
    runWithRequestActivityLease,
    wrapStreamFactoryWithActivityLease,
} from './lib/request-activity-lease.js';

export function createCompletionServices({
    getPresetManager,
    extractJsonFromData,
    extractMessageFromData,
    getGenerateUrl,
    getRequestHeaders,
    getName1,
    getName2,
    getTextGenServer,
    createTextGenGenerationData,
    getTextGenSettingNames,
    getTextGenSettings,
    extractReasoningFromData,
    formatInstructModeChat,
    formatInstructModePrompt,
    getInstructStoppingSequences,
    tryParseStreamingError,
    createGenerationParameters,
    isOpenAIConnectionPresetField,
    getOpenAISettingsToUpdate,
    getOpenAISettings,
}) {
    async function openSseStreamWithLease(url, sanitizedData, signal, leaseOptions, { allowJsonFallback = false } = {}) {
        return await runWithRequestActivityLease(leaseOptions, async () => {
            const response = await fetch(url, {
                method: 'POST',
                headers: getRequestHeaders(),
                cache: 'no-cache',
                body: JSON.stringify(sanitizedData),
                signal: signal ?? new AbortController().signal,
            });

            if (!response.ok) {
                const text = await response.text();
                tryParseStreamingError(response, text, { quiet: true });

                throw new Error(`Got response status ${response.status}`);
            }

            const contentType = String(response.headers?.get?.('content-type') || '').toLowerCase();
            if (allowJsonFallback && contentType.includes('application/json')) {
                return { response, reader: null, eventStream: null, isJsonFallback: true };
            }

            const eventStream = new EventSourceStream();
            response.body.pipeThrough(eventStream);
            return { response, reader: eventStream.readable.getReader(), eventStream, isJsonFallback: false };
        });
    }

    class TextCompletionService {
        static TYPE = 'textgenerationwebui';

        static createRequestData({ stream = false, prompt, max_tokens, model, api_type, api_server, temperature, min_p, ...props }) {
            const payload = {
                stream,
                prompt,
                max_tokens,
                max_new_tokens: max_tokens,
                model,
                api_type,
                api_server: api_server ?? getTextGenServer(api_type),
                temperature,
                min_p,
                ...props,
            };

            Object.keys(payload).forEach(key => {
                if (payload[key] === undefined) {
                    delete payload[key];
                }
            });

            return payload;
        }

        static async sendRequest(data, extractData = true, signal = null, requestOptions = {}) {
            const sanitizedData = unescapeMacroBracesInRequestData(data);
            const leaseOptions = resolveCustomRequestLeaseOptions(requestOptions);
            if (!data.stream) {
                return await runWithRequestActivityLease(leaseOptions, async () => {
                    const response = await fetch(getGenerateUrl(this.TYPE), {
                        method: 'POST',
                        headers: getRequestHeaders(),
                        cache: 'no-cache',
                        body: JSON.stringify(sanitizedData),
                        signal: signal ?? new AbortController().signal,
                    });

                    const json = await response.json();
                    if (!response.ok || json.error) {
                        throw new Error(String(json.error?.message || 'Response not OK'));
                    }

                    if (!extractData) {
                        return json;
                    }

                    return {
                        content: extractMessageFromData(json, this.TYPE),
                        reasoning: extractReasoningFromData(json, {
                            mainApi: this.TYPE,
                            textGenType: data.api_type,
                            ignoreShowThoughts: true,
                        }),
                    };
                });
            }

            const { response, reader } = await openSseStreamWithLease('/api/backends/text-completions/generate', sanitizedData, signal, leaseOptions);
            return wrapStreamFactoryWithActivityLease(leaseOptions, async function* streamData() {
                let text = '';
                const swipes = [];
                const state = { reasoning: '', finishReason: null };
                while (true) {
                    const { done, value } = await reader.read();
                    if (done) return;
                    if (value.data === '[DONE]') return;

                    tryParseStreamingError(response, value.data, { quiet: true });

                    let parsed = JSON.parse(value.data);

                    if (parsed?.choices?.[0]?.index > 0) {
                        const swipeIndex = parsed.choices[0].index - 1;
                        swipes[swipeIndex] = (swipes[swipeIndex] || '') + parsed.choices[0].text;
                    } else {
                        const newText = parsed?.choices?.[0]?.text || parsed?.content || '';
                        text += newText;
                        state.reasoning += parsed?.choices?.[0]?.reasoning ?? '';
                    }

                    const rawFinish = parsed?.choices?.[0]?.finish_reason ?? null;
                    if (rawFinish) {
                        state.finishReason = String(rawFinish);
                    }

                    yield { text, swipes, state };
                }
            });
        }

        static constructPrompt(prompt, instructPreset, instructSettings) {
            if (typeof instructPreset === 'string') {
                const instructPresetManager = getPresetManager('instruct');
                instructPreset = instructPresetManager?.getCompletionPresetByName(instructPreset);
            }

            instructPreset = structuredClone(instructPreset);
            if (instructSettings) {
                Object.assign(instructPreset, instructSettings);
            }

            if (typeof instructPreset === 'string') {
                return;
            }

            const name1 = getName1();
            const name2 = getName2();
            const formattedMessages = [];
            const prefillActive = prompt.length > 0 ? prompt[prompt.length - 1].role === 'assistant' : false;
            for (const message of prompt) {
                let messageContent = message.content;
                if (!message.ignoreInstruct) {
                    const isLastMessage = message === prompt[prompt.length - 1];

                    if (!isLastMessage || !prefillActive) {
                        messageContent = formatInstructModeChat(
                            message.name ?? message.role,
                            message.content,
                            message.role === 'user',
                            message.role === 'system',
                            undefined,
                            name1,
                            name2,
                            undefined,
                            instructPreset,
                        );
                    }

                    if (isLastMessage) {
                        let last_line = formatInstructModePrompt(
                            'assistant',
                            false,
                            prefillActive ? message.content : undefined,
                            name1,
                            name2,
                            true,
                            false,
                            instructPreset,
                        );

                        if (prefillActive) {
                            if (last_line.endsWith('\n') && !message.content.endsWith('\n')) {
                                last_line = last_line.slice(0, -1);
                            }
                            messageContent = last_line;
                        } else {
                            messageContent += last_line;
                        }
                    }
                }
                formattedMessages.push(messageContent);
            }
            return formattedMessages.join('');
        }

        static async processRequest(requestData, options = {}, extractData = true, signal = null) {
            const { presetName, instructName, instructSettings, activity } = options || {};

            requestData = this.createRequestData(requestData);

            let instructPreset;
            const prompt = requestData.prompt;
            if (Array.isArray(prompt)) {
                if (instructName) {
                    const instructPresetManager = getPresetManager('instruct');
                    instructPreset = instructPresetManager?.getCompletionPresetByName(instructName);
                    if (instructPreset) {
                        requestData.prompt = this.constructPrompt(prompt, instructPreset, instructSettings);
                        const stoppingStrings = getInstructStoppingSequences({ customInstruct: instructPreset, useStopStrings: false });
                        requestData.stop = stoppingStrings;
                        requestData.stopping_strings = stoppingStrings;
                    } else {
                        console.warn(`Instruct preset "${instructName}" not found, using basic formatting`);
                        requestData.prompt = prompt.map(x => x.content).join('\n\n');
                    }
                } else {
                    requestData.prompt = prompt.map(x => x.content).join('\n\n');
                }
            } else if (typeof prompt === 'string') {
                requestData.prompt = prompt;
            }

            if (presetName) {
                const presetManager = getPresetManager(this.TYPE);
                if (presetManager) {
                    const preset = presetManager.getCompletionPresetByName(presetName);
                    if (preset) {
                        requestData = this.presetToGeneratePayload(preset, {}, requestData);
                    } else {
                        console.warn(`Preset "${presetName}" not found, continuing with default settings`);
                    }
                } else {
                    console.warn('Preset manager not found, continuing with default settings');
                }
            }

            const response = await this.sendRequest(requestData, extractData, signal, { activity });

            if (!requestData.stream && extractData) {
                const extractedData = response;
                let message = extractedData.content;

                message = message.replace(/[^\S\r\n]+$/gm, '');

                if (requestData.stopping_strings) {
                    for (const stoppingString of requestData.stopping_strings) {
                        if (stoppingString.length) {
                            for (let j = stoppingString.length; j > 0; j--) {
                                if (message.slice(-j) === stoppingString.slice(0, j)) {
                                    message = message.slice(0, -j);
                                    break;
                                }
                            }
                        }
                    }
                }

                if (instructPreset) {
                    [
                        instructPreset.stop_sequence,
                        instructPreset.input_sequence,
                    ].forEach(sequence => {
                        if (sequence?.trim()) {
                            const index = message.indexOf(sequence);
                            if (index !== -1) {
                                message = message.substring(0, index);
                            }
                        }
                    });

                    [
                        instructPreset.output_sequence,
                        instructPreset.last_output_sequence,
                    ].forEach(sequences => {
                        if (sequences) {
                            sequences.split('\n')
                                .filter(line => line.trim() !== '')
                                .forEach(line => {
                                    message = message.replaceAll(line, '');
                                });
                        }
                    });
                }

                extractedData.content = message;
            }

            return response;
        }

        static presetToGeneratePayload(preset, overridePreset = {}, overridePayload = {}) {
            if (!preset || typeof preset !== 'object') {
                throw new Error('Invalid preset: must be an object');
            }

            preset = { ...preset, ...overridePreset };

            const setting_names = getTextGenSettingNames();
            const settings = structuredClone(getTextGenSettings());
            for (const [key, value] of Object.entries(preset)) {
                if (!setting_names.includes(key)) continue;
                settings[key] = value;
            }

            const payload = createTextGenGenerationData(settings, overridePayload.model, overridePayload.prompt, preset.genamt);
            return this.createRequestData({ ...payload, ...overridePayload });
        }
    }

    class ChatCompletionService {
        static TYPE = 'openai';

        static createRequestData({ stream = false, messages, model, chat_completion_source, max_tokens, temperature, custom_url, reverse_proxy, proxy_password, custom_prompt_post_processing, ...props }) {
            const payload = {
                stream,
                messages,
                model,
                chat_completion_source,
                max_tokens,
                temperature,
                custom_url,
                reverse_proxy,
                proxy_password,
                custom_prompt_post_processing,
                use_sysprompt: true,
                ...props,
            };

            Object.keys(payload).forEach(key => {
                if (payload[key] === undefined) {
                    delete payload[key];
                }
            });

            return payload;
        }

        static async sendRequest(data, extractData = true, signal = null, requestOptions = {}) {
            const sanitizedData = unescapeMacroBracesInRequestData(data);
            const leaseOptions = resolveCustomRequestLeaseOptions(requestOptions);
            if (!data.stream) {
                return await runWithRequestActivityLease(leaseOptions, async () => {
                    const response = await fetch('/api/backends/chat-completions/generate', {
                        method: 'POST',
                        headers: getRequestHeaders(),
                        cache: 'no-cache',
                        body: JSON.stringify(sanitizedData),
                        signal: signal ?? new AbortController().signal,
                    });

                    const json = await response.json();
                    const arrayError = Array.isArray(json) ? json[0]?.error : null;
                    const nativeMessageError = !Array.isArray(json)
                        && json && typeof json === 'object'
                        && typeof json.message === 'string' && json.message.trim().length > 0
                        && !Array.isArray(json.choices) && !Array.isArray(json.candidates) && !Array.isArray(json.content) && !Array.isArray(json.output);
                    if (!response.ok || json?.error || arrayError || nativeMessageError) {
                        const errObj = json?.error ?? arrayError;
                        const errMsg = typeof errObj === 'string'
                            ? errObj
                            : (errObj?.message || (nativeMessageError ? json.message : 'Response not OK'));
                        throw new Error(String(errMsg || 'Response not OK'));
                    }

                    if (!extractData) {
                        return json;
                    }

                    const protocol = resolveWireProtocol(data.chat_completion_source);
                    let result;
                    if (protocol) {
                        const turn = parseCompatChatCompletionResponse(protocol, json);
                        result = {
                            content: turn.text,
                            reasoning: turn.reasoning,
                        };
                    } else {
                        result = {
                            content: extractMessageFromData(json, this.TYPE),
                            reasoning: extractReasoningFromData(json, {
                                mainApi: this.TYPE,
                                chatCompletionSource: data.chat_completion_source,
                                ignoreShowThoughts: true,
                            }),
                        };
                    }
                    if (data.json_schema) {
                        result.content = JSON.parse(
                            extractJsonFromData(json, { mainApi: this.TYPE, chatCompletionSource: data.chat_completion_source }),
                        );
                    }
                    return result;
                });
            }

            const { response, reader, eventStream, isJsonFallback } = await openSseStreamWithLease(
                '/api/backends/chat-completions/generate',
                sanitizedData,
                signal,
                leaseOptions,
                { allowJsonFallback: true },
            );
            if (isJsonFallback) {
                const source = data.chat_completion_source || 'openai';
                return wrapStreamFactoryWithActivityLease(leaseOptions, async function* streamJsonFallback() {
                    const json = await response.json();
                    const protocol = resolveWireProtocol(source);
                    const turn = protocol
                        ? parseCompatChatCompletionResponse(protocol, json)
                        : { text: extractMessageFromData(json, ChatCompletionService.TYPE), reasoning: '', images: [], swipes: [], signature: '', finishReason: null };
                    yield {
                        text: turn.text ?? '',
                        swipes: Array.isArray(turn.swipes) ? turn.swipes : [],
                        state: {
                            reasoning: turn.reasoning ?? '',
                            images: Array.isArray(turn.images) ? turn.images : [],
                            signature: turn.signature || '',
                            finishReason: turn.finishReason ?? null,
                        },
                    };
                });
            }
            let streamParser;
            try {
                streamParser = createProtocolStreamParser(data.chat_completion_source || 'openai');
            } catch (err) {
                try { await reader.cancel(); } catch { /* ignore cancel failure */ }
                try { reader.releaseLock(); } catch { /* already released */ }
                throw err;
            }
            return wrapStreamFactoryWithActivityLease(leaseOptions, async function* streamData() {
                let text = '';
                const swipes = [];
                const state = { reasoning: '', images: [], signature: '', finishReason: null };
                let sawDirectText = false;
                let sawAnyFrame = false;
                let finishedNormally = false;
                try {
                    while (true) {
                        const { done, value } = await reader.read();
                        if (done) {
                            if (!signal?.aborted) {
                                const invalidSse = eventStream?.getInvalidDiagnostic?.();
                                if (!sawAnyFrame && invalidSse) {
                                    throw new ProtocolParseError({
                                        protocol: streamParser.protocol,
                                        stage: 'sse',
                                        location: 'stream',
                                        message: 'Expected text/event-stream SSE frames, received non-SSE response body.',
                                        rawDiagnostic: invalidSse,
                                    });
                                }
                                let finalTurn;
                                try {
                                    finalTurn = streamParser.finish();
                                } catch (err) {
                                    if (err instanceof ProtocolParseError && err.stage === 'eof') {
                                        const snap = streamParser.getSnapshot();
                                        if (!isParsedTurnEmpty(snap) || text.length > 0) {
                                            console.warn('[custom-request] Stream closed without terminal marker; preserving received output:', err.message);
                                            finalTurn = snap;
                                        } else {
                                            throw err;
                                        }
                                    } else {
                                        throw err;
                                    }
                                }
                                const prevSig = state.signature;
                                const prevFinish = state.finishReason;
                                state.signature = finalTurn.signature || state.signature;
                                state.finishReason = finalTurn.finishReason;
                                if (state.signature !== prevSig || state.finishReason !== prevFinish) {
                                    yield { text, swipes, state };
                                }
                            }
                            finishedNormally = true;
                            return;
                        }
                        sawAnyFrame = true;
                        const rawData = value.data;
                        if (rawData === '[DONE]') {
                            streamParser.feedFrame('[DONE]');
                            continue;
                        }
                        const frame = streamParser.feedFrame(rawData, value.event);
                        if (frame.textDelta) {
                            sawDirectText = true;
                            text += frame.textDelta;
                        } else if (!sawDirectText && frame.refusalDelta) {
                            text += frame.refusalDelta;
                        }
                        if (frame.choiceTextDeltas) {
                            for (const [choiceIdxKey, deltaStr] of Object.entries(frame.choiceTextDeltas)) {
                                const swipeIdx = Number(choiceIdxKey) - 1;
                                if (swipeIdx >= 0 && deltaStr) {
                                    swipes[swipeIdx] = (swipes[swipeIdx] || '') + deltaStr;
                                }
                            }
                        }
                        if (frame.reasoningDelta) {
                            state.reasoning += frame.reasoningDelta;
                        }
                        if (Array.isArray(frame.imagesDelta) && frame.imagesDelta.length > 0) {
                            state.images.push(...frame.imagesDelta);
                        }
                        if (frame.hasMetadataUpdate) {
                            const snap = streamParser.getSnapshot();
                            state.signature = snap.signature || '';
                            state.finishReason = snap.finishReason;
                        }

                        yield { text, swipes: swipes, state };
                    }
                } finally {
                    if (!finishedNormally) {
                        try { await reader.cancel(); } catch { /* ignore cancel failure */ }
                    }
                    try { reader.releaseLock(); } catch { /* already released */ }
                }
            });
        }

        static async processRequest(requestData, options = {}, extractData = true, signal = null) {
            const { presetName, activity } = options || {};
            requestData = this.createRequestData(requestData);

            if (presetName) {
                const presetManager = getPresetManager(this.TYPE);
                if (presetManager) {
                    const preset = presetManager.getCompletionPresetByName(presetName);
                    if (preset) {
                        requestData = await this.presetToGeneratePayload(preset, {}, requestData);
                    } else {
                        console.warn(`Preset "${presetName}" not found, continuing with default settings`);
                    }
                } else {
                    console.warn('Preset manager not found, continuing with default settings');
                }
            }

            return await this.sendRequest(requestData, extractData, signal, { activity });
        }

        static async presetToGeneratePayload(preset, overridePreset = {}, overridePayload = {}) {
            if (!preset || typeof preset !== 'object') {
                throw new Error('Invalid preset: must be an object');
            }

            preset = { ...preset, ...overridePreset };
            preset.bias_preset_selected = preset.bias_presets !== undefined ? preset.bias_preset_selected : undefined;

            const oai_settings = getOpenAISettings();
            const settingsToUpdate = getOpenAISettingsToUpdate();
            const settings = structuredClone(oai_settings);
            for (const [key, value] of Object.entries(preset)) {
                const settingToUpdate = settingsToUpdate[key];
                if (!settingToUpdate) continue;
                if (isOpenAIConnectionPresetField(key)) continue;
                settings[settingToUpdate[1]] = value;
            }

            ['custom_url', 'vertexai_region', 'zai_endpoint', 'siliconflow_endpoint', 'minimax_endpoint', 'pollinations_endpoint'].forEach(field => {
                overridePayload[field] = overridePayload[field] || settings[field] || oai_settings[field];
            });
            if (overridePayload.chat_completion_source) {
                settings.chat_completion_source = overridePayload.chat_completion_source;
            }

            const data = await createGenerationParameters(settings, overridePayload.model, 'quiet', overridePayload.messages);
            const payload = data.generate_data;

            return this.createRequestData({ ...payload, ...overridePayload });
        }
    }

    return {
        TextCompletionService,
        ChatCompletionService,
    };
}
