import { power_user } from './power-user.js';
import { delay } from './utils.js';
import EventSourceStream from './lib/event-source-stream.js';

// Symbol for not primary swipe error
const NOT_PRIMARY = Symbol('not_primary_swipe');

/**
 * Gets a delay based on the character.
 * @param {string} s The character.
 * @returns {number} The delay in milliseconds.
 */
function getDelay(s) {
    if (!s) {
        return 0;
    }

    const speedFactor = Math.max(100 - power_user.smooth_streaming_speed, 1);
    const defaultDelayMs = speedFactor * 0.4;
    const punctuationDelayMs = defaultDelayMs * 25;

    if ([',', '\n'].includes(s)) {
        return punctuationDelayMs / 2;
    }

    if (['.', '!', '?'].includes(s)) {
        return punctuationDelayMs;
    }

    return defaultDelayMs;
}

/**
 * Parses the stream data and returns the parsed data and the chunk to be sent.
 * @param {object} json The JSON data.
 * @returns {AsyncGenerator<{data: object, chunk: string, reasoning?: boolean}>} The parsed data and the chunk to be sent.
 */
async function* parseStreamData(json) {
    if (typeof json.delta === 'object' && typeof json.delta.message === 'object' && json.type === 'content-delta') {
        // Cohere
        const text = json?.delta?.message?.content?.text ?? '';
        for (let i = 0; i < text.length; i++) {
            const str = json.delta.message.content.text[i];
            yield {
                data: { ...json, delta: { message: { content: { text: str } } } },
                chunk: str,
            };
        }
        return;
    } else if (typeof json.delta === 'object' && typeof json.delta.text === 'string') {
        // Claude
        if (json.delta.text.length > 0) {
            for (let i = 0; i < json.delta.text.length; i++) {
                const str = json.delta.text[i];
                yield {
                    data: { ...json, delta: { text: str } },
                    chunk: str,
                };
            }
        }
        return;
    } else if (typeof json.delta === 'object' && typeof json.delta.thinking === 'string') {
        // Claude (reasoning content)
        if (json.delta.thinking.length > 0) {
            for (let i = 0; i < json.delta.thinking.length; i++) {
                const str = json.delta.thinking[i];
                yield {
                    data: { ...json, delta: { thinking: str } },
                    chunk: str,
                    reasoning: true,
                };
            }
        }
        return;
    } else if (Array.isArray(json.candidates)) {
        // Google VertexAI / AI Studio
        for (let i = 0; i < json.candidates.length; i++) {
            const isNotPrimary = json.candidates?.[0]?.index > 0;
            const hasToolCalls = json?.candidates?.[0]?.content?.parts?.some(p => p?.functionCall);
            const hasInlineData = json?.candidates?.[0]?.content?.parts?.some(p => p?.inlineData);
            if (isNotPrimary || json.candidates.length === 0) {
                return null;
            }
            if (hasToolCalls || hasInlineData) {
                yield { data: json, chunk: '' };
                return;
            }
            if (typeof json.candidates[0].content === 'object' && Array.isArray(json.candidates[i].content.parts)) {
                for (let j = 0; j < json.candidates[i].content.parts.length; j++) {
                    if (typeof json.candidates[i].content.parts[j].text === 'string') {
                        for (let k = 0; k < json.candidates[i].content.parts[j].text.length; k++) {
                            const moreThanOnePart = json.candidates[i].content.parts.length > 1;
                            const isNotLastPart = j !== json.candidates[i].content.parts.length - 1;
                            const isLastSymbol = k === json.candidates[i].content.parts[j].text.length - 1;
                            const addNewline = moreThanOnePart && isNotLastPart && isLastSymbol;
                            const str = json.candidates[i].content.parts[j].text[k] + (addNewline ? '\n\n' : '');
                            const candidateClone = structuredClone(json.candidates[0]);
                            candidateClone.content.parts[j].text = str;
                            candidateClone.content.parts = [candidateClone.content.parts[j]];
                            const candidates = [candidateClone];
                            const reasoning = json.candidates[i].content.parts[j].thought ?? false;
                            yield {
                                data: { ...json, candidates },
                                chunk: str,
                                reasoning,
                            };
                        }
                    }
                }
            }
        }
        return;
    } else if (typeof json.token === 'string' && json.token.length > 0) {
        // NovelAI / KoboldCpp Classic
        for (let i = 0; i < json.token.length; i++) {
            const str = json.token[i];
            yield {
                data: { ...json, token: str },
                chunk: str,
            };
        }
        return;
    } else if (typeof json.content === 'string' && json.content.length > 0 && json.object !== 'chat.completion.chunk') {
        // llama.cpp?
        const isNotPrimary = json?.index > 0;
        if (isNotPrimary) {
            throw new Error('Not a primary swipe', { cause: NOT_PRIMARY });
        }
        for (let i = 0; i < json.content.length; i++) {
            const str = json.content[i];
            yield {
                data: { ...json, content: str },
                chunk: str,
            };
        }
        return;
    } else if (Array.isArray(json.choices)) {
        // OpenAI-likes and friends
        const isNotPrimary = json?.choices?.[0]?.index > 0;
        if (isNotPrimary || json.choices.length === 0) {
            throw new Error('Not a primary swipe', { cause: NOT_PRIMARY });
        }

        if (typeof json.choices[0].text === 'string' && json.choices[0].text.length > 0) {
            for (let j = 0; j < json.choices[0].text.length; j++) {
                const str = json.choices[0].text[j];
                const choiceClone = structuredClone(json.choices[0]);
                choiceClone.text = str;
                const choices = [choiceClone];
                yield {
                    data: { ...json, choices },
                    chunk: str,
                };
            }
            return;
        } else if (typeof json.choices[0].thinking === 'string' && json.choices[0].thinking.length > 0) {
            for (let j = 0; j < json.choices[0].thinking.length; j++) {
                const str = json.choices[0].thinking[j];
                const choiceClone = structuredClone(json.choices[0]);
                choiceClone.thinking = str;
                const choices = [choiceClone];
                yield {
                    data: { ...json, choices },
                    chunk: str,
                    reasoning: true,
                };
            }
            return;
        } else if (typeof json.choices[0].delta === 'object') {
            if (typeof json.choices[0].delta.text === 'string' && json.choices[0].delta.text.length > 0) {
                for (let j = 0; j < json.choices[0].delta.text.length; j++) {
                    const str = json.choices[0].delta.text[j];
                    const choiceClone = structuredClone(json.choices[0]);
                    choiceClone.delta.text = str;
                    const choices = [choiceClone];
                    yield {
                        data: { ...json, choices },
                        chunk: str,
                    };
                }
                return;
            } else if (typeof json.choices[0].delta.reasoning_content === 'string' && json.choices[0].delta.reasoning_content.length > 0) {
                for (let j = 0; j < json.choices[0].delta.reasoning_content.length; j++) {
                    const str = json.choices[0].delta.reasoning_content[j];
                    const isLastSymbol = j === json.choices[0].delta.reasoning_content.length - 1;
                    const choiceClone = structuredClone(json.choices[0]);
                    choiceClone.delta.reasoning_content = str;
                    choiceClone.delta.content = isLastSymbol ? choiceClone.delta.content : '';
                    const choices = [choiceClone];
                    yield {
                        data: { ...json, choices },
                        chunk: str,
                        reasoning: true,
                    };
                }
                return;
            } else if (typeof json.choices[0].delta.reasoning === 'string' && json.choices[0].delta.reasoning.length > 0) {
                for (let j = 0; j < json.choices[0].delta.reasoning.length; j++) {
                    const str = json.choices[0].delta.reasoning[j];
                    const isLastSymbol = j === json.choices[0].delta.reasoning.length - 1;
                    const choiceClone = structuredClone(json.choices[0]);
                    choiceClone.delta.reasoning = str;
                    choiceClone.delta.content = isLastSymbol ? choiceClone.delta.content : '';
                    const choices = [choiceClone];
                    yield {
                        data: { ...json, choices },
                        chunk: str,
                        reasoning: true,
                    };
                }
                return;
            } else if (typeof json.choices[0].delta.content === 'string' && json.choices[0].delta.content.length > 0) {
                for (let j = 0; j < json.choices[0].delta.content.length; j++) {
                    const str = json.choices[0].delta.content[j];
                    const choiceClone = structuredClone(json.choices[0]);
                    choiceClone.delta.content = str;
                    const choices = [choiceClone];
                    yield {
                        data: { ...json, choices },
                        chunk: str,
                    };
                }
                return;
            } else if (Array.isArray(json.choices[0].delta.content) && json.choices[0].delta.content.length > 0) {
                if (Array.isArray(json.choices[0].delta.content[0].thinking) && json.choices[0].delta.content[0].thinking.length > 0) {
                    if (typeof json.choices[0].delta.content[0].thinking[0].text === 'string' && json.choices[0].delta.content[0].thinking[0].text.length > 0) {
                        for (let j = 0; j < json.choices[0].delta.content[0].thinking[0].text.length; j++) {
                            const str = json.choices[0].delta.content[0].thinking[0].text[j];
                            const choiceClone = structuredClone(json.choices[0]);
                            choiceClone.delta.content[0].thinking[0].text = str;
                            const choices = [choiceClone];
                            yield {
                                data: { ...json, choices },
                                chunk: str,
                                reasoning: true,
                            };
                        }
                        return;
                    }
                }
            }
        } else if (typeof json.choices[0].message === 'object') {
            if (typeof json.choices[0].message.content === 'string' && json.choices[0].message.content.length > 0) {
                for (let j = 0; j < json.choices[0].message.content.length; j++) {
                    const str = json.choices[0].message.content[j];
                    const choiceClone = structuredClone(json.choices[0]);
                    choiceClone.message.content = str;
                    const choices = [choiceClone];
                    yield {
                        data: { ...json, choices },
                        chunk: str,
                    };
                }
                return;
            }
        }
    }

    throw new Error('Unknown event data format');
}

/**
 * Like the default one, but multiplies the events by the number of letters in the event data.
 */
export class SmoothEventSourceStream extends EventSourceStream {
    constructor() {
        super();
        let lastStr = '';
        const transformStream = new TransformStream({
            async transform(chunk, controller) {
                const event = chunk;
                const data = event.data;
                try {
                    const hasFocus = document.hasFocus();

                    if (data === '[DONE]') {
                        lastStr = '';
                        return controller.enqueue(event);
                    }

                    const json = JSON.parse(data);

                    if (!json) {
                        lastStr = '';
                        return controller.enqueue(event);
                    }

                    for await (const parsed of parseStreamData(json)) {
                        !(power_user.smooth_streaming_no_think && parsed.reasoning) && hasFocus && await delay(getDelay(lastStr));
                        controller.enqueue(new MessageEvent(event.type, { data: JSON.stringify(parsed.data) }));
                        lastStr = parsed.chunk;
                    }
                } catch (error) {
                    if (error instanceof Error && error.cause !== NOT_PRIMARY) {
                        console.debug('Smooth Streaming parsing error', error);
                    }
                    controller.enqueue(event);
                }
            },
        });

        this.readable = this.readable.pipeThrough(transformStream);
    }
}

export function getEventSourceStream() {
    if (power_user.smooth_streaming) {
        return new SmoothEventSourceStream();
    }

    return new EventSourceStream();
}

export default EventSourceStream;
