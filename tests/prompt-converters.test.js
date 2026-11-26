import { describe, test, expect, jest, beforeAll } from '@jest/globals';

jest.unstable_mockModule('../src/util.js', () => ({
    getConfigValue: jest.fn((_key, defaultValue) => defaultValue),
    tryParse: (str) => { try { return JSON.parse(str); } catch { return undefined; } },
}));

/** @type {import('../src/prompt-converters.js')} */
let mod;

beforeAll(async () => {
    mod = await import('../src/prompt-converters.js');
});

function makeNames(charName = '', userName = '', groupNames = []) {
    return {
        charName,
        userName,
        groupNames,
        startsWithGroupName(message) {
            return this.groupNames.some(name => message.startsWith(`${name}: `));
        },
    };
}


describe('addAssistantPrefix', () => {
    test('returns empty array unchanged', () => {
        expect(mod.addAssistantPrefix([], [], 'prefix')).toEqual([]);
    });

    test('sets property on last message when it is assistant and no tools', () => {
        const prompt = [
            { role: 'user', content: 'hi' },
            { role: 'assistant', content: 'hello' },
        ];
        mod.addAssistantPrefix(prompt, [], 'prefix');
        expect(prompt[1].prefix).toBe(true);
    });

    test('does not set property when tools are present', () => {
        const prompt = [
            { role: 'user', content: 'hi' },
            { role: 'assistant', content: 'hello' },
        ];
        mod.addAssistantPrefix(prompt, [{ type: 'function' }], 'prefix');
        expect(prompt[1].prefix).toBeUndefined();
    });

    test('does not set property when last message is not assistant', () => {
        const prompt = [
            { role: 'assistant', content: 'hello' },
            { role: 'user', content: 'hi' },
        ];
        mod.addAssistantPrefix(prompt, [], 'prefix');
        expect(prompt[0].prefix).toBeUndefined();
        expect(prompt[1].prefix).toBeUndefined();
    });

    test('does not set property when a tool role message exists in prompt', () => {
        const prompt = [
            { role: 'user', content: 'hi' },
            { role: 'tool', content: 'result' },
            { role: 'assistant', content: 'hello' },
        ];
        mod.addAssistantPrefix(prompt, [], 'prefix');
        expect(prompt[2].prefix).toBeUndefined();
    });
});


describe('convertTextCompletionPrompt', () => {
    test('passes through string input unchanged', () => {
        expect(mod.convertTextCompletionPrompt('raw prompt')).toBe('raw prompt');
    });

    test('converts basic message array to text format', () => {
        const messages = [
            { role: 'system', content: 'You are helpful.' },
            { role: 'user', content: 'Hello' },
            { role: 'assistant', content: 'Hi there' },
        ];
        const result = mod.convertTextCompletionPrompt(messages);
        expect(result).toBe(
            'System: You are helpful.\nuser: Hello\nassistant: Hi there\nassistant:',
        );
    });

    test('uses name instead of role for named system messages', () => {
        const messages = [
            { role: 'system', name: 'Narrator', content: 'Once upon a time' },
        ];
        const result = mod.convertTextCompletionPrompt(messages);
        expect(result).toBe('Narrator: Once upon a time\nassistant:');
    });

    test('handles empty array', () => {
        expect(mod.convertTextCompletionPrompt([])).toBe('\nassistant:');
    });
});


describe('calculateClaudeBudgetTokens', () => {
    describe('adaptive model (Opus 4.6+)', () => {
        test('auto returns null', () => {
            expect(mod.calculateClaudeBudgetTokens(8192, 'auto', true, true)).toBeNull();
        });

        test('min returns "low"', () => expect(mod.calculateClaudeBudgetTokens(8192, 'min', true, true)).toBe('low'));

        test('minimal returns "low"', () => expect(mod.calculateClaudeBudgetTokens(8192, 'minimal', true, true)).toBe('low'));

        test('off returns null', () => expect(mod.calculateClaudeBudgetTokens(8192, 'off', true, true)).toBeNull());

        test('low returns "low"', () => expect(mod.calculateClaudeBudgetTokens(8192, 'low', true, true)).toBe('low'));

        test('medium returns "medium"', () => expect(mod.calculateClaudeBudgetTokens(8192, 'medium', true, true)).toBe('medium'));

        test('high returns "high"', () => expect(mod.calculateClaudeBudgetTokens(8192, 'high', true, true)).toBe('high'));

        test('xhigh returns "xhigh"', () => expect(mod.calculateClaudeBudgetTokens(8192, 'xhigh', true, true)).toBe('xhigh'));

        test('max returns "max"', () => expect(mod.calculateClaudeBudgetTokens(8192, 'max', true, true)).toBe('max'));
    });

    describe('traditional model', () => {
        test('auto returns null', () => {
            expect(mod.calculateClaudeBudgetTokens(8192, 'auto', true, false)).toBeNull();
        });

        test('off returns null', () => {
            expect(mod.calculateClaudeBudgetTokens(8192, 'off', true, false)).toBeNull();
        });

        test('min returns 1024 regardless of maxTokens', () => {
            expect(mod.calculateClaudeBudgetTokens(100, 'min', true, false)).toBe(1024);
            expect(mod.calculateClaudeBudgetTokens(100000, 'min', true, false)).toBe(1024);
        });

        test('minimal returns 1024 regardless of maxTokens', () => {
            expect(mod.calculateClaudeBudgetTokens(100, 'minimal', true, false)).toBe(1024);
            expect(mod.calculateClaudeBudgetTokens(100000, 'minimal', true, false)).toBe(1024);
        });

        test('low is 10% of maxTokens, floored to 1024', () => {
            expect(mod.calculateClaudeBudgetTokens(50000, 'low', true, false)).toBe(5000);
            // 10% of 5000 = 500, but floor is 1024
            expect(mod.calculateClaudeBudgetTokens(5000, 'low', true, false)).toBe(1024);
        });

        test('medium is 25% of maxTokens', () => {
            expect(mod.calculateClaudeBudgetTokens(40000, 'medium', true, false)).toBe(10000);
        });

        test('high is 50% of maxTokens', () => {
            expect(mod.calculateClaudeBudgetTokens(40000, 'high', true, false)).toBe(20000);
        });

        test('max is 95% of maxTokens', () => {
            expect(mod.calculateClaudeBudgetTokens(40000, 'max', true, false)).toBe(38000);
        });

        test('xhigh is 95% of maxTokens', () => {
            expect(mod.calculateClaudeBudgetTokens(40000, 'xhigh', true, false)).toBe(38000);
        });

        test('non-streaming caps at 21333', () => {
            expect(mod.calculateClaudeBudgetTokens(100000, 'max', false, false)).toBe(21333);
        });

        test('streaming does not cap at 21333', () => {
            expect(mod.calculateClaudeBudgetTokens(100000, 'max', true, false)).toBe(95000);
        });
    });
});


describe('calculateGoogleBudgetTokens', () => {
    test('returns null for unrecognized model', () => {
        expect(mod.calculateGoogleBudgetTokens(8192, 'medium', 'gpt-4')).toBeNull();
    });

    describe('gemini-3 flash', () => {
        test('auto returns null', () => expect(mod.calculateGoogleBudgetTokens(8192, 'auto', 'gemini-3.5-flash')).toBeNull());

        test('min returns minimal', () => expect(mod.calculateGoogleBudgetTokens(8192, 'min', 'gemini-3.5-flash')).toBe('minimal'));

        test('low returns low', () => expect(mod.calculateGoogleBudgetTokens(8192, 'low', 'gemini-3.5-flash')).toBe('low'));

        test('medium returns medium', () => expect(mod.calculateGoogleBudgetTokens(8192, 'medium', 'gemini-3.5-flash')).toBe('medium'));

        test('high returns high', () => expect(mod.calculateGoogleBudgetTokens(8192, 'high', 'gemini-3.5-flash')).toBe('high'));

        test('max returns high', () => expect(mod.calculateGoogleBudgetTokens(8192, 'max', 'gemini-3.5-flash')).toBe('high'));
    });

    test('Gemini 3.7 Flash uses Gemini 3 thinking levels without minimal', () => {
        expect(mod.calculateGoogleBudgetTokens(8192, 'auto', 'gemini-3.7-flash')).toBeNull();
        expect(mod.calculateGoogleBudgetTokens(8192, 'min', 'gemini-3.7-flash')).toBe('low');
        expect(mod.calculateGoogleBudgetTokens(8192, 'medium', 'gemini-3.7-flash')).toBe('medium');
        expect(mod.calculateGoogleBudgetTokens(8192, 'max', 'gemini-3.7-flash')).toBe('high');
    });

    test('Gemini 3.6 Flash uses Gemini 3 thinking levels', () => {
        expect(mod.calculateGoogleBudgetTokens(8192, 'auto', 'gemini-3.6-flash')).toBeNull();
        expect(mod.calculateGoogleBudgetTokens(8192, 'min', 'gemini-3.6-flash')).toBe('minimal');
        expect(mod.calculateGoogleBudgetTokens(8192, 'medium', 'gemini-3.6-flash')).toBe('medium');
        expect(mod.calculateGoogleBudgetTokens(8192, 'max', 'gemini-3.6-flash')).toBe('high');
    });

    test('Gemini 3.5 Flash-Lite uses Gemini 3 thinking levels', () => {
        expect(mod.calculateGoogleBudgetTokens(8192, 'auto', 'gemini-3.5-flash-lite')).toBeNull();
        expect(mod.calculateGoogleBudgetTokens(8192, 'min', 'gemini-3.5-flash-lite')).toBe('minimal');
        expect(mod.calculateGoogleBudgetTokens(8192, 'medium', 'gemini-3.5-flash-lite')).toBe('medium');
        expect(mod.calculateGoogleBudgetTokens(8192, 'max', 'gemini-3.5-flash-lite')).toBe('high');
    });

    test('stable Gemini 3.1 Flash-Lite uses Gemini 3 thinking levels', () => {
        expect(mod.calculateGoogleBudgetTokens(8192, 'min', 'gemini-3.1-flash-lite')).toBe('minimal');
        expect(mod.calculateGoogleBudgetTokens(8192, 'medium', 'gemini-3.1-flash-lite')).toBe('medium');
        expect(mod.calculateGoogleBudgetTokens(8192, 'max', 'gemini-3.1-flash-lite')).toBe('high');
    });

    test('stable Gemini 3 image models use Gemini 3 thinking levels', () => {
        expect(mod.calculateGoogleBudgetTokens(8192, 'min', 'gemini-3.1-flash-image')).toBe('minimal');
        expect(mod.calculateGoogleBudgetTokens(8192, 'max', 'gemini-3.1-flash-image')).toBe('high');
        expect(mod.calculateGoogleBudgetTokens(8192, 'min', 'gemini-3-pro-image')).toBe('low');
        expect(mod.calculateGoogleBudgetTokens(8192, 'max', 'gemini-3-pro-image')).toBe('high');
    });

    test('gemini-nano-banana-2.1 maps thinking levels to minimal, medium, and high', () => {
        expect(mod.calculateGoogleBudgetTokens(8192, 'auto', 'gemini-nano-banana-2.1')).toBeNull();
        expect(mod.calculateGoogleBudgetTokens(8192, 'minimal', 'gemini-nano-banana-2.1')).toBe('minimal');
        expect(mod.calculateGoogleBudgetTokens(8192, 'low', 'gemini-nano-banana-2.1')).toBe('minimal');
        expect(mod.calculateGoogleBudgetTokens(8192, 'medium', 'gemini-nano-banana-2.1')).toBe('medium');
        expect(mod.calculateGoogleBudgetTokens(8192, 'high', 'gemini-nano-banana-2.1')).toBe('high');
        expect(mod.calculateGoogleBudgetTokens(8192, 'max', 'gemini-nano-banana-2.1')).toBe('high');
    });

    describe('gemini-3 pro', () => {
        test('auto returns null', () => expect(mod.calculateGoogleBudgetTokens(8192, 'auto', 'gemini-3.0-pro')).toBeNull());

        test('min returns low', () => expect(mod.calculateGoogleBudgetTokens(8192, 'min', 'gemini-3.0-pro')).toBe('low'));

        test('low returns low', () => expect(mod.calculateGoogleBudgetTokens(8192, 'low', 'gemini-3.0-pro')).toBe('low'));

        test('medium returns low', () => expect(mod.calculateGoogleBudgetTokens(8192, 'medium', 'gemini-3.0-pro')).toBe('low'));

        test('high returns high', () => expect(mod.calculateGoogleBudgetTokens(8192, 'high', 'gemini-3.0-pro')).toBe('high'));

        test('max returns high', () => expect(mod.calculateGoogleBudgetTokens(8192, 'max', 'gemini-3.0-pro')).toBe('high'));
    });

    describe('gemini-3.1 pro', () => {
        test('medium returns medium', () => expect(mod.calculateGoogleBudgetTokens(8192, 'medium', 'gemini-3.1-pro')).toBe('medium'));
    });

    describe('gemini-4', () => {
        test('auto returns null', () => expect(mod.calculateGoogleBudgetTokens(8192, 'auto', 'gemini-4-argon')).toBeNull());

        test('min degrades to low (no minimal support)', () => expect(mod.calculateGoogleBudgetTokens(8192, 'min', 'gemini-4-argon')).toBe('low'));

        test('low returns low', () => expect(mod.calculateGoogleBudgetTokens(8192, 'low', 'gemini-4-argon')).toBe('low'));

        test('medium returns medium', () => expect(mod.calculateGoogleBudgetTokens(8192, 'medium', 'gemini-4-argon')).toBe('medium'));

        test('high returns high', () => expect(mod.calculateGoogleBudgetTokens(8192, 'high', 'gemini-4-argon')).toBe('high'));

        test('max returns high', () => expect(mod.calculateGoogleBudgetTokens(8192, 'max', 'gemini-4-argon')).toBe('high'));
    });

    describe('flash (non-gemini-3)', () => {
        test('auto returns null', () => {
            expect(mod.calculateGoogleBudgetTokens(8192, 'auto', 'gemini-2.0-flash')).toBeNull();
        });

        test('min returns 0', () => {
            expect(mod.calculateGoogleBudgetTokens(8192, 'min', 'gemini-2.0-flash')).toBe(0);
        });

        test('caps at 24576', () => {
            expect(mod.calculateGoogleBudgetTokens(500000, 'max', 'gemini-2.0-flash')).toBe(24576);
        });
    });

    describe('flash-lite', () => {
        test('min returns 0', () => {
            expect(mod.calculateGoogleBudgetTokens(8192, 'min', 'gemini-2.0-flash-lite')).toBe(0);
        });

        test('floors at 512', () => {
            expect(mod.calculateGoogleBudgetTokens(1000, 'low', 'gemini-2.0-flash-lite')).toBe(512);
        });
    });

    describe('pro (non-gemini-3)', () => {
        test('min returns 128', () => {
            expect(mod.calculateGoogleBudgetTokens(8192, 'min', 'gemini-2.5-pro')).toBe(128);
        });

        test('floors at 128', () => {
            expect(mod.calculateGoogleBudgetTokens(500, 'low', 'gemini-2.5-pro')).toBe(128);
        });

        test('caps at 32768', () => {
            expect(mod.calculateGoogleBudgetTokens(500000, 'max', 'gemini-2.5-pro')).toBe(32768);
        });
    });

    describe('canonical minimal / xhigh tokens', () => {
        test('flash minimal returns 0, xhigh returns capped max', () => {
            expect(mod.calculateGoogleBudgetTokens(8192, 'minimal', 'gemini-2.0-flash')).toBe(0);
            expect(mod.calculateGoogleBudgetTokens(500000, 'xhigh', 'gemini-2.0-flash')).toBe(24576);
        });

        test('flash-lite minimal returns 0, xhigh returns capped max', () => {
            expect(mod.calculateGoogleBudgetTokens(8192, 'minimal', 'gemini-2.0-flash-lite')).toBe(0);
            expect(mod.calculateGoogleBudgetTokens(500000, 'xhigh', 'gemini-2.0-flash-lite')).toBe(24576);
        });

        test('pro minimal returns 128, xhigh returns capped max', () => {
            expect(mod.calculateGoogleBudgetTokens(8192, 'minimal', 'gemini-2.5-pro')).toBe(128);
            expect(mod.calculateGoogleBudgetTokens(500000, 'xhigh', 'gemini-2.5-pro')).toBe(32768);
        });

        test('gemini-3 flash minimal returns minimal, xhigh returns high', () => {
            expect(mod.calculateGoogleBudgetTokens(8192, 'minimal', 'gemini-3.5-flash')).toBe('minimal');
            expect(mod.calculateGoogleBudgetTokens(8192, 'xhigh', 'gemini-3.5-flash')).toBe('high');
        });

        test('gemini-3.7 flash minimal degrades to low, xhigh returns high', () => {
            expect(mod.calculateGoogleBudgetTokens(8192, 'minimal', 'gemini-3.7-flash')).toBe('low');
            expect(mod.calculateGoogleBudgetTokens(8192, 'xhigh', 'gemini-3.7-flash')).toBe('high');
        });

        test('gemini-3 pro minimal returns low, xhigh returns high', () => {
            expect(mod.calculateGoogleBudgetTokens(8192, 'minimal', 'gemini-3.0-pro')).toBe('low');
            expect(mod.calculateGoogleBudgetTokens(8192, 'xhigh', 'gemini-3.0-pro')).toBe('high');
        });
    });

    describe('model matching priority', () => {
        // flash-lite must match before flash
        test('flash-lite matches before flash', () => {
            // flash-lite min = 0, flash min = 0 too, so use a differentiating case
            // flash-lite low floors at 512, flash low does not
            expect(mod.calculateGoogleBudgetTokens(1000, 'low', 'gemini-2.0-flash-lite')).toBe(512);
            expect(mod.calculateGoogleBudgetTokens(1000, 'low', 'gemini-2.0-flash')).toBe(100);
        });
    });
});


describe('ensureDeepSeekReasoningContent', () => {
    test('seeds a single space on every assistant message without reasoning', () => {
        const messages = [
            { role: 'user', content: 'weather?' },
            { role: 'assistant', content: 'Let me check.' },
            { role: 'user', content: 'ok' },
            {
                role: 'assistant',
                content: '',
                tool_calls: [{ id: '1', function: { name: 'weather', arguments: '{}' } }],
            },
            { role: 'tool', tool_call_id: '1', content: 'cloudy' },
            { role: 'assistant', content: '<think>', prefix: true },
        ];
        mod.ensureDeepSeekReasoningContent(messages);
        expect(messages[0].reasoning_content).toBeUndefined(); // user untouched
        expect(messages[1].reasoning_content).toBe(' ');       // plain assistant
        expect(messages[2].reasoning_content).toBeUndefined(); // user untouched
        expect(messages[3].reasoning_content).toBe(' ');       // tool_calls assistant
        expect(messages[4].reasoning_content).toBeUndefined(); // tool role untouched
        expect(messages[5].reasoning_content).toBe(' ');       // prefix assistant
    });

    test('promotes existing `reasoning` field to reasoning_content verbatim and deletes reasoning', () => {
        const messages = [
            { role: 'assistant', content: 'x', reasoning: 'prior CoT' },
            { role: 'assistant', content: 'y', tool_calls: [{ id: '1' }], reasoning: 'tool CoT' },
        ];
        mod.ensureDeepSeekReasoningContent(messages);
        expect(messages[0].reasoning_content).toBe('prior CoT');
        expect(messages[0].reasoning).toBeUndefined();
        expect(messages[1].reasoning_content).toBe('tool CoT');
        expect(messages[1].reasoning).toBeUndefined();
    });

    test('does not overwrite existing string reasoning_content (including empty string)', () => {
        const messages = [
            { role: 'assistant', content: 'x', reasoning_content: 'kept' },
            { role: 'assistant', content: 'y', reasoning_content: '' },
        ];
        mod.ensureDeepSeekReasoningContent(messages);
        expect(messages[0].reasoning_content).toBe('kept');
        expect(messages[1].reasoning_content).toBe('');
    });

    test('does not touch non-assistant roles', () => {
        const messages = [
            { role: 'user', content: 'hi' },
            { role: 'tool', tool_call_id: '1', content: 'result' },
            { role: 'system', content: 'sys' },
        ];
        mod.ensureDeepSeekReasoningContent(messages);
        expect(messages[0].reasoning_content).toBeUndefined();
        expect(messages[1].reasoning_content).toBeUndefined();
        expect(messages[2].reasoning_content).toBeUndefined();
    });

    test('handles empty and non-array input gracefully', () => {
        expect(() => mod.ensureDeepSeekReasoningContent([])).not.toThrow();
        expect(() => mod.ensureDeepSeekReasoningContent(null)).not.toThrow();
        expect(() => mod.ensureDeepSeekReasoningContent('nope')).not.toThrow();
    });
});


describe('embedOpenRouterMedia', () => {
    test('converts audio data URLs to input_audio format', () => {
        const messages = [{
            role: 'user',
            content: [{
                type: 'audio_url',
                audio_url: { url: 'data:audio/wav;base64,AAAA' },
            }],
        }];
        mod.embedOpenRouterMedia(messages);
        expect(messages[0].content[0]).toEqual({
            type: 'input_audio',
            input_audio: { format: 'wav', data: 'AAAA' },
        });
    });

    test('defaults to mp3 for unknown audio mime types', () => {
        const messages = [{
            role: 'user',
            content: [{
                type: 'audio_url',
                audio_url: { url: 'data:audio/ogg;base64,BBBB' },
            }],
        }];
        mod.embedOpenRouterMedia(messages);
        expect(messages[0].content[0].input_audio.format).toBe('mp3');
    });

    test('skips non-data-URL audio', () => {
        const messages = [{
            role: 'user',
            content: [{
                type: 'audio_url',
                audio_url: { url: 'https://example.com/audio.mp3' },
            }],
        }];
        mod.embedOpenRouterMedia(messages);
        expect(messages[0].content[0].type).toBe('audio_url');
    });

    test('keeps video_url type for video data URLs', () => {
        const messages = [{
            role: 'user',
            content: [{
                type: 'video_url',
                video_url: { url: 'data:video/mp4;base64,CCCC' },
            }],
        }];
        mod.embedOpenRouterMedia(messages);
        expect(messages[0].content[0].type).toBe('video_url');
    });

    test('skips non-data-URL video', () => {
        const messages = [{
            role: 'user',
            content: [{
                type: 'video_url',
                video_url: { url: 'https://example.com/video.mp4' },
            }],
        }];
        mod.embedOpenRouterMedia(messages);
        expect(messages[0].content[0].type).toBe('video_url');
    });

    test('respects audio=false option', () => {
        const messages = [{
            role: 'user',
            content: [{
                type: 'audio_url',
                audio_url: { url: 'data:audio/wav;base64,AAAA' },
            }],
        }];
        mod.embedOpenRouterMedia(messages, { audio: false, video: true });
        expect(messages[0].content[0].type).toBe('audio_url');
    });

    test('respects video=false option', () => {
        const messages = [{
            role: 'user',
            content: [{
                type: 'video_url',
                video_url: { url: 'data:video/mp4;base64,CCCC' },
            }],
        }];
        mod.embedOpenRouterMedia(messages, { audio: true, video: false });
        expect(messages[0].content[0].type).toBe('video_url');
    });

    test('handles non-array input gracefully', () => {
        expect(() => mod.embedOpenRouterMedia(null)).not.toThrow();
        expect(() => mod.embedOpenRouterMedia('string')).not.toThrow();
    });

    test('skips messages with string content', () => {
        const messages = [{ role: 'user', content: 'just text' }];
        mod.embedOpenRouterMedia(messages);
        expect(messages[0].content).toBe('just text');
    });
});


describe('cachingSystemPromptForOpenRouter', () => {
    test('adds cache_control to string system message', () => {
        const messages = [{ role: 'system', content: 'You are helpful.' }];
        mod.cachingSystemPromptForOpenRouter(messages);
        expect(messages[0].content).toEqual([
            { type: 'text', text: 'You are helpful.', cache_control: { type: 'ephemeral' } },
        ]);
    });

    test('adds cache_control with TTL', () => {
        const messages = [{ role: 'system', content: 'System prompt' }];
        mod.cachingSystemPromptForOpenRouter(messages, '300');
        expect(messages[0].content[0].cache_control).toEqual({ type: 'ephemeral', ttl: '300' });
    });

    test('adds cache_control to last text part of array content', () => {
        const messages = [{
            role: 'system',
            content: [
                { type: 'text', text: 'first' },
                { type: 'text', text: 'second' },
            ],
        }];
        mod.cachingSystemPromptForOpenRouter(messages);
        expect(messages[0].content[0].cache_control).toBeUndefined();
        expect(messages[0].content[1].cache_control).toEqual({ type: 'ephemeral' });
    });

    test('skips if system message already has cache_control', () => {
        const messages = [{ role: 'system', content: 'prompt', cache_control: { type: 'ephemeral' } }];
        mod.cachingSystemPromptForOpenRouter(messages);
        // content should remain a string, not converted
        expect(messages[0].content).toBe('prompt');
    });

    test('skips if array content already has cache_control', () => {
        const messages = [{
            role: 'system',
            content: [{ type: 'text', text: 'cached', cache_control: { type: 'ephemeral' } }],
        }];
        mod.cachingSystemPromptForOpenRouter(messages);
        // Should not add another cache_control
        expect(messages[0].content).toHaveLength(1);
    });

    test('does nothing with empty array', () => {
        expect(() => mod.cachingSystemPromptForOpenRouter([])).not.toThrow();
    });

    test('does nothing without system message', () => {
        const messages = [{ role: 'user', content: 'hi' }];
        mod.cachingSystemPromptForOpenRouter(messages);
        expect(messages[0].content).toBe('hi');
    });
});


describe('convertAI21Messages', () => {
    const names = makeNames('Bot', 'User');

    test('returns empty array for non-array input', () => {
        expect(mod.convertAI21Messages(null, names)).toEqual([]);
        expect(mod.convertAI21Messages('string', names)).toEqual([]);
    });

    test('extracts leading system messages into merged system prompt', () => {
        const messages = [
            { role: 'system', content: 'You are a bot.' },
            { role: 'system', content: 'Be helpful.' },
            { role: 'user', content: 'Hello' },
        ];
        const result = mod.convertAI21Messages(messages, names);
        expect(result[0]).toEqual({ role: 'system', content: 'You are a bot.\n\nBe helpful.' });
        expect(result[1]).toEqual({ role: 'user', content: 'Hello' });
    });

    test('prepends character name to example_assistant system messages', () => {
        const messages = [
            { role: 'system', name: 'example_assistant', content: 'I greet you.' },
            { role: 'user', content: 'Hi' },
        ];
        const result = mod.convertAI21Messages(messages, names);
        expect(result[0].content).toContain('Bot: I greet you.');
    });

    test('does not double-prepend if name already present', () => {
        const messages = [
            { role: 'system', name: 'example_assistant', content: 'Bot: I greet you.' },
            { role: 'user', content: 'Hi' },
        ];
        const result = mod.convertAI21Messages(messages, names);
        expect(result[0].content).not.toContain('Bot: Bot:');
    });

    test('merges consecutive same-role messages', () => {
        const messages = [
            { role: 'user', content: 'First' },
            { role: 'user', content: 'Second' },
            { role: 'assistant', content: 'Reply' },
        ];
        const result = mod.convertAI21Messages(messages, names);
        expect(result).toHaveLength(2);
        expect(result[0].content).toBe('First\n\nSecond');
    });

    test('prepends name to non-system messages and deletes name property', () => {
        const messages = [
            { role: 'user', name: 'Alice', content: 'Hello' },
        ];
        const result = mod.convertAI21Messages(messages, names);
        expect(result[0].content).toBe('Alice: Hello');
        expect(result[0].name).toBeUndefined();
    });

    test('inserts placeholder when all messages are system', () => {
        const messages = [
            { role: 'system', content: 'Setup' },
        ];
        const result = mod.convertAI21Messages(messages, names);
        // After extracting the system message, array is empty, so placeholder is inserted
        expect(result).toHaveLength(2);
        expect(result[0]).toEqual({ role: 'system', content: 'Setup' });
        expect(result[1].role).toBe('user');
    });
});


describe('convertCohereMessages', () => {
    const names = makeNames('Bot', 'User');

    test('inserts placeholder for empty messages', () => {
        const messages = [];
        const result = mod.convertCohereMessages(messages, names);
        expect(result.chatHistory).toHaveLength(1);
        expect(result.chatHistory[0].role).toBe('user');
    });

    test('prepends character name to example_assistant system messages', () => {
        const messages = [
            { role: 'system', name: 'example_assistant', content: 'Greetings' },
        ];
        const result = mod.convertCohereMessages(messages, names);
        expect(result.chatHistory[0].content).toBe('Bot: Greetings');
    });

    test('prepends user name to example_user system messages', () => {
        const messages = [
            { role: 'system', name: 'example_user', content: 'Hello there' },
        ];
        const result = mod.convertCohereMessages(messages, names);
        expect(result.chatHistory[0].content).toBe('User: Hello there');
    });

    test('prepends name to non-system messages', () => {
        const messages = [
            { role: 'assistant', name: 'NPC', content: 'I am an NPC' },
        ];
        const result = mod.convertCohereMessages(messages, names);
        expect(result.chatHistory[0].content).toBe('NPC: I am an NPC');
        expect(result.chatHistory[0].name).toBeUndefined();
    });

    test('handles tool_calls by extracting function names', () => {
        const messages = [
            { role: 'assistant', tool_calls: [{ function: { name: 'search' } }, { function: { name: 'fetch' } }] },
        ];
        const result = mod.convertCohereMessages(messages, names);
        expect(result.chatHistory[0].content).toContain('search, fetch');
    });
});


describe('convertXAIMessages', () => {
    const names = makeNames('Char', 'Player');

    test('returns empty array for non-array input', () => {
        expect(mod.convertXAIMessages(null, names)).toEqual([]);
    });

    test('prepends char name to assistant messages', () => {
        const messages = [
            { role: 'assistant', name: 'Char', content: 'Hello' },
        ];
        const result = mod.convertXAIMessages(messages, names);
        expect(result[0].content).toBe('Char: Hello');
        expect(result[0].name).toBeUndefined();
    });

    test('skips user role messages entirely', () => {
        const messages = [
            { role: 'user', name: 'Someone', content: 'Hello' },
        ];
        const result = mod.convertXAIMessages(messages, names);
        expect(result[0].content).toBe('Hello');
        expect(result[0].name).toBe('Someone');
    });

    test('handles group names - does not double prefix', () => {
        const groupNames = makeNames('Char', 'Player', ['Alice', 'Bob']);
        const messages = [
            { role: 'assistant', name: 'SomeNPC', content: 'Alice: speaking as Alice' },
        ];
        const result = mod.convertXAIMessages(messages, groupNames);
        // Starts with group name, so charName prefix should not be added
        expect(result[0].content).toBe('Alice: speaking as Alice');
    });
});


describe('mergeMessages', () => {
    const names = makeNames('Bot', 'User');

    test('squashes consecutive same-role messages', () => {
        const messages = [
            { role: 'user', content: 'A' },
            { role: 'user', content: 'B' },
            { role: 'assistant', content: 'C' },
        ];
        const result = mod.mergeMessages(messages, names);
        expect(result).toHaveLength(2);
        expect(result[0].content).toBe('A\n\nB');
    });

    test('inserts placeholder for empty messages', () => {
        const result = mod.mergeMessages([], names);
        expect(result).toHaveLength(1);
        expect(result[0].role).toBe('user');
    });

    test('removes name property and prepends to content for non-system', () => {
        const messages = [
            { role: 'assistant', name: 'NPC', content: 'dialogue' },
        ];
        const result = mod.mergeMessages(messages, names);
        expect(result[0].content).toBe('NPC: dialogue');
        expect(result[0].name).toBeUndefined();
    });

    test('strict mode forces mid-prompt system to user', () => {
        const messages = [
            { role: 'system', content: 'Setup' },
            { role: 'system', content: 'More setup' },
            { role: 'user', content: 'Hi' },
        ];
        const result = mod.mergeMessages(messages, names, { strict: true });
        // First system stays, second should become user and merge
        expect(result[0].role).toBe('system');
        expect(result.filter(m => m.role === 'system')).toHaveLength(1);
    });

    test('single mode forces all roles to user', () => {
        const messages = [
            { role: 'system', content: 'Setup' },
            { role: 'user', content: 'Hello' },
            { role: 'assistant', content: 'Response' },
        ];
        const result = mod.mergeMessages(messages, names, { single: true });
        expect(result.every(m => m.role === 'user')).toBe(true);
    });

    test('single mode prepends charName to assistant, userName to user', () => {
        const messages = [
            { role: 'user', content: 'Hello' },
            { role: 'assistant', content: 'Hi back' },
        ];
        const result = mod.mergeMessages(messages, names, { single: true });
        // Both become user and get merged
        expect(result[0].content).toContain('User: Hello');
        expect(result[0].content).toContain('Bot: Hi back');
    });

    test('tools=false removes tool_calls and tool_call_id', () => {
        const messages = [
            { role: 'assistant', content: 'calling', tool_calls: [{ id: '1' }] },
            { role: 'tool', content: 'result', tool_call_id: '1' },
        ];
        const result = mod.mergeMessages(messages, names, { tools: false });
        expect(result[0].tool_calls).toBeUndefined();
        // tool role should be converted to user
        const toolMsg = result.find(m => m.content === 'result' || m.content?.includes?.('result'));
        expect(toolMsg).toBeDefined();
    });

    test('flattens array content and preserves image URLs via tokens', () => {
        const imageContent = { type: 'image_url', image_url: { url: 'data:image/png;base64,abc' } };
        const messages = [
            { role: 'user', content: [{ type: 'text', text: 'Look at this' }, imageContent] },
        ];
        const result = mod.mergeMessages(messages, names);
        // Content should be reconstituted with image preserved
        expect(Array.isArray(result[0].content)).toBe(true);
        const types = result[0].content.map(c => c.type);
        expect(types).toContain('text');
        expect(types).toContain('image_url');
    });

    test('refuses to merge consecutive messages carrying native replay blocks', () => {
        const cases = [
            { native_content_blocks: [{ type: 'thinking', thinking: 't', signature: 'sig' }, { type: 'text', text: 'A' }] },
            { native_parts: [{ text: 'A', thoughtSignature: 'gsig' }] },
            { responses_output_items: [{ type: 'reasoning', encrypted_content: 'enc' }, { type: 'message', content: [{ type: 'output_text', text: 'A' }] }] },
        ];
        for (const envelope of cases) {
            const prevHasEnvelope = mod.mergeMessages([
                { role: 'assistant', content: 'A', ...envelope },
                { role: 'assistant', content: 'B' },
            ], names);
            expect(prevHasEnvelope).toHaveLength(2);
            expect(prevHasEnvelope[0].content).toBe('A');
            expect(prevHasEnvelope[1].content).toBe('B');

            const nextHasEnvelope = mod.mergeMessages([
                { role: 'assistant', content: 'A' },
                { role: 'assistant', content: 'B', ...envelope },
            ], names);
            expect(nextHasEnvelope).toHaveLength(2);
            expect(nextHasEnvelope[0].content).toBe('A');
            expect(nextHasEnvelope[1].content).toBe('B');
        }
    });

    test('single mode strips native replay blocks and merges all turns into one user message', () => {
        const messages = [
            { role: 'system', content: 'System prompt' },
            { role: 'user', content: 'Hello' },
            {
                role: 'assistant',
                content: 'Reply A',
                native_content_blocks: [{ type: 'thinking', thinking: 't', signature: 'sig' }, { type: 'text', text: 'Reply A' }],
                reasoning_blocks: [{ type: 'thinking', thinking: 't', signature: 'sig' }],
            },
            {
                role: 'assistant',
                content: 'Reply B',
                native_parts: [{ text: 'Reply B', thoughtSignature: 'gsig' }],
                responses_output_items: [{ type: 'reasoning', encrypted_content: 'enc' }],
            },
            { role: 'user', content: 'Follow up' },
        ];

        const singleResult = mod.mergeMessages(structuredClone(messages), names, { single: true });
        expect(singleResult).toHaveLength(1);
        expect(singleResult[0].role).toBe('user');
        expect(singleResult[0].content).toBe('System prompt\n\nUser: Hello\n\nBot: Reply A\n\nBot: Reply B\n\nUser: Follow up');
        expect(singleResult[0].native_content_blocks).toBeUndefined();
        expect(singleResult[0].native_parts).toBeUndefined();
        expect(singleResult[0].responses_output_items).toBeUndefined();
        expect(singleResult[0].reasoning_blocks).toBeUndefined();

        const postProcessed = mod.postProcessPrompt(structuredClone(messages), mod.PROMPT_PROCESSING_TYPE.SINGLE, names);
        expect(postProcessed).toHaveLength(1);
        expect(postProcessed[0].role).toBe('user');
        expect(postProcessed[0].content).toBe('System prompt\n\nUser: Hello\n\nBot: Reply A\n\nBot: Reply B\n\nUser: Follow up');
        expect(postProcessed[0].native_content_blocks).toBeUndefined();
        expect(postProcessed[0].native_parts).toBeUndefined();
        expect(postProcessed[0].responses_output_items).toBeUndefined();
        expect(postProcessed[0].reasoning_blocks).toBeUndefined();
    });
});


describe('postProcessPrompt', () => {
    const names = makeNames('Bot', 'User');

    test('NONE type returns messages unchanged', () => {
        const messages = [{ role: 'user', content: 'hi' }];
        expect(mod.postProcessPrompt(messages, '', names)).toBe(messages);
    });

    test('MERGE type merges consecutive same-role messages', () => {
        const messages = [
            { role: 'user', content: 'A' },
            { role: 'user', content: 'B' },
        ];
        const result = mod.postProcessPrompt(messages, 'merge', names);
        expect(result).toHaveLength(1);
        expect(result[0].content).toBe('A\n\nB');
    });

    test('deprecated CLAUDE type works same as MERGE', () => {
        const messages = [
            { role: 'user', content: 'A' },
            { role: 'user', content: 'B' },
        ];
        const result = mod.postProcessPrompt(messages, 'claude', names);
        expect(result).toHaveLength(1);
    });
});


describe('addOpenRouterSignatures', () => {
    test('handles non-array input gracefully', () => {
        expect(() => mod.addOpenRouterSignatures(null, 'model')).not.toThrow();
    });

    test('detects google model format', () => {
        const messages = [{ role: 'assistant', content: 'hi', signature: 'sig123' }];
        mod.addOpenRouterSignatures(messages, 'google/gemini-2.5-pro');
        expect(messages[0].reasoning_details).toBeDefined();
        expect(messages[0].reasoning_details[0].format).toBe('google-gemini-v1');
    });

    test('detects anthropic model format', () => {
        const messages = [{ role: 'assistant', content: 'hi', signature: 'sig123' }];
        mod.addOpenRouterSignatures(messages, 'anthropic/claude-sonnet-4');
        expect(messages[0].reasoning_details).toBeDefined();
        expect(messages[0].reasoning_details[0].format).toBe('anthropic-claude-v1');
    });

    test('removes signature property from messages', () => {
        const messages = [{ role: 'assistant', content: 'hi', signature: 'sig123' }];
        mod.addOpenRouterSignatures(messages, 'anthropic/claude-sonnet-4');
        expect(messages[0].signature).toBeUndefined();
    });

    test('removes signature property from tool_calls', () => {
        const messages = [{
            role: 'assistant',
            content: '',
            tool_calls: [{ id: 'tc1', function: { name: 'f' }, signature: 'toolsig' }],
        }];
        mod.addOpenRouterSignatures(messages, 'anthropic/claude-sonnet-4');
        expect(messages[0].tool_calls[0].signature).toBeUndefined();
    });

    test('passes through message.reasoning_details verbatim when present', () => {
        const preExisting = [
            { index: 0, id: 'r0', type: 'reasoning.encrypted', data: 'block1data', format: 'anthropic-claude-v1' },
            { index: 1, id: 'r1', type: 'reasoning.encrypted', data: 'block2data', format: 'anthropic-claude-v1' },
        ];
        const messages = [{
            role: 'assistant',
            content: 'hi',
            reasoning_details: preExisting,
        }];
        mod.addOpenRouterSignatures(messages, 'anthropic/claude-sonnet-4');
        expect(messages[0].reasoning_details).toBe(preExisting);
        expect(messages[0].reasoning_details).toHaveLength(2);
        expect(messages[0].reasoning_details[0].data).toBe('block1data');
        expect(messages[0].reasoning_details[1].data).toBe('block2data');
    });

    test('does not overwrite multi-block reasoning_details with single-signature build', () => {
        const preExisting = [
            { index: 0, id: 'r0', type: 'reasoning.encrypted', data: 'realblock', format: 'anthropic-claude-v1' },
        ];
        const messages = [{
            role: 'assistant',
            content: 'hi',
            signature: 'shouldbestripped',
            reasoning_details: preExisting,
        }];
        mod.addOpenRouterSignatures(messages, 'anthropic/claude-sonnet-4');
        expect(messages[0].reasoning_details).toBe(preExisting);
        expect(messages[0].signature).toBeUndefined();
    });

    test('strips tool_calls[].signature when reasoning_details already present', () => {
        const preExisting = [
            { index: 0, id: 'r0', type: 'reasoning.encrypted', data: 'block1', format: 'anthropic-claude-v1' },
        ];
        const messages = [{
            role: 'assistant',
            content: '',
            reasoning_details: preExisting,
            tool_calls: [{ id: 'tc1', function: { name: 'f' }, signature: 'shouldalsostrip' }],
        }];
        mod.addOpenRouterSignatures(messages, 'anthropic/claude-sonnet-4');
        expect(messages[0].tool_calls[0].signature).toBeUndefined();
        expect(messages[0].reasoning_details).toBe(preExisting);
    });

    test('legacy single-signature build still runs when reasoning_details absent', () => {
        const messages = [{
            role: 'assistant',
            content: 'hi',
            signature: 'legacysig',
        }];
        mod.addOpenRouterSignatures(messages, 'anthropic/claude-sonnet-4');
        expect(messages[0].reasoning_details).toBeDefined();
        expect(messages[0].reasoning_details).toHaveLength(1);
        expect(messages[0].reasoning_details[0].data).toBe('legacysig');
        expect(messages[0].signature).toBeUndefined();
    });
});


describe('getPromptNames', () => {
    test('extracts names from request body', () => {
        const request = { body: { char_name: 'Bot', user_name: 'User', group_names: ['Alice', 'Bob'] } };
        const names = mod.getPromptNames(request);
        expect(names.charName).toBe('Bot');
        expect(names.userName).toBe('User');
        expect(names.groupNames).toEqual(['Alice', 'Bob']);
    });

    test('defaults to empty strings and array when missing', () => {
        const request = { body: {} };
        const names = mod.getPromptNames(request);
        expect(names.charName).toBe('');
        expect(names.userName).toBe('');
        expect(names.groupNames).toEqual([]);
    });

    test('startsWithGroupName checks message prefix', () => {
        const request = { body: { char_name: '', user_name: '', group_names: ['Alice', 'Bob'] } };
        const names = mod.getPromptNames(request);
        expect(names.startsWithGroupName('Alice: hello')).toBe(true);
        expect(names.startsWithGroupName('Charlie: hello')).toBe(false);
    });

    test('coerces non-string group_names to strings', () => {
        const request = { body: { group_names: [123, null] } };
        const names = mod.getPromptNames(request);
        expect(names.groupNames).toEqual(['123', 'null']);
    });
});


describe('convertClaudePrompt', () => {
    test('returns empty string for empty messages', () => {
        const result = mod.convertClaudePrompt([], false, '', false, false, '', false);
        expect(result).toBe('');
    });

    test('basic conversion with Human/Assistant prefixes', () => {
        const messages = [
            { role: 'system', content: 'You are helpful.' },
            { role: 'user', content: 'Hello' },
            { role: 'assistant', content: 'Hi there' },
        ];
        const result = mod.convertClaudePrompt(messages, false, '', false, false, '', false);
        expect(result).toContain('Hello');
        expect(result).toContain('Hi there');
        expect(result).toContain('\n\nHuman: ');
        expect(result).toContain('\n\nAssistant: ');
    });

    test('adds assistant postfix when requested', () => {
        const messages = [
            { role: 'user', content: 'Hello' },
        ];
        const result = mod.convertClaudePrompt(messages, true, '', false, false, '', false);
        expect(result).toMatch(/\n\nAssistant: $/);
    });

    test('adds assistant prefill when provided', () => {
        const messages = [
            { role: 'user', content: 'Hello' },
        ];
        const result = mod.convertClaudePrompt(messages, true, 'Sure, I', false, false, '', false);
        expect(result).toMatch(/\n\nAssistant: Sure, I$/);
    });

    test('system prompt mode sets first message role to system', () => {
        const messages = [
            { role: 'system', content: 'System prompt' },
            { role: 'user', content: 'Hello' },
        ];
        mod.convertClaudePrompt(messages, false, '', true, true, '', false);
        // First message should remain system (no prefix)
        expect(messages[0].role).toBe('system');
    });

    test('exclude prefixes mode sets non-last messages to system', () => {
        const messages = [
            { role: 'user', content: 'First' },
            { role: 'assistant', content: 'Second' },
            { role: 'user', content: 'Third' },
        ];
        const result = mod.convertClaudePrompt(messages, false, '', false, false, '', true);
        // Non-last messages should have been set to system role (no Human/Assistant prefix)
        // Last message keeps its original role
        expect(result).toContain('Third');
    });

    test('stringifies tool_calls into content', () => {
        const messages = [
            { role: 'assistant', content: 'Let me check', tool_calls: [{ id: '1', function: { name: 'search' } }] },
            { role: 'user', content: 'OK' },
        ];
        const result = mod.convertClaudePrompt(messages, false, '', false, false, '', false);
        expect(result).toContain('search');
    });
});


describe('convertClaudeMessages', () => {
    const names = makeNames('Bot', 'User');

    test('extracts leading system messages when useSysPrompt is true', () => {
        const messages = [
            { role: 'system', content: 'System instruction' },
            { role: 'user', content: 'Hello' },
        ];
        const result = mod.convertClaudeMessages(messages, '', true, false, names);
        expect(result.systemPrompt).toHaveLength(1);
        expect(result.systemPrompt[0]).toEqual({ type: 'text', text: 'System instruction' });
        expect(result.messages[0].role).toBe('user');
    });

    test('inserts placeholder when all messages are system and useSysPrompt is true', () => {
        const messages = [
            { role: 'system', content: 'Only system' },
        ];
        const result = mod.convertClaudeMessages(messages, '', true, false, names);
        expect(result.messages).toHaveLength(1);
        expect(result.messages[0].role).toBe('user');
    });

    test('converts system messages to user role after extraction', () => {
        const messages = [
            { role: 'user', content: 'Hi' },
            { role: 'system', content: 'Mid-prompt system' },
            { role: 'assistant', content: 'Reply' },
        ];
        const result = mod.convertClaudeMessages(messages, '', false, false, names);
        // system messages should become user
        const roles = result.messages.map(m => m.role);
        expect(roles).not.toContain('system');
    });

    test('merges consecutive same-role messages', () => {
        const messages = [
            { role: 'user', content: 'A' },
            { role: 'user', content: 'B' },
            { role: 'assistant', content: 'C' },
        ];
        const result = mod.convertClaudeMessages(messages, '', false, false, names);
        // Two user messages should be merged
        expect(result.messages.filter(m => m.role === 'user')).toHaveLength(1);
    });

    test('converts string content to array of text parts', () => {
        const messages = [
            { role: 'user', content: 'Hello' },
        ];
        const result = mod.convertClaudeMessages(messages, '', false, false, names);
        expect(Array.isArray(result.messages[0].content)).toBe(true);
        expect(result.messages[0].content[0]).toEqual({ type: 'text', text: 'Hello' });
    });

    test('converts image_url content to Claude base64 format', () => {
        const messages = [
            { role: 'user', content: [
                { type: 'text', text: 'Look' },
                { type: 'image_url', image_url: { url: 'data:image/png;base64,abc123' } },
            ] },
        ];
        const result = mod.convertClaudeMessages(messages, '', false, false, names);
        const imagePart = result.messages[0].content.find(c => c.type === 'image');
        expect(imagePart).toBeDefined();
        expect(imagePart.source.type).toBe('base64');
        expect(imagePart.source.media_type).toBe('image/png');
        expect(imagePart.source.data).toBe('abc123');
    });

    test('moves images from assistant to next user message', () => {
        const messages = [
            { role: 'assistant', content: [
                { type: 'text', text: 'Here is an image' },
                { type: 'image_url', image_url: { url: 'data:image/png;base64,abc' } },
            ] },
            { role: 'user', content: 'Thanks' },
        ];
        const result = mod.convertClaudeMessages(messages, '', false, false, names);
        // Assistant message should not have images
        const assistantImages = result.messages
            .filter(m => m.role === 'assistant')
            .flatMap(m => m.content)
            .filter(c => c.type === 'image');
        expect(assistantImages).toHaveLength(0);
    });

    test('adds prefill as trailing assistant message', () => {
        const messages = [
            { role: 'user', content: 'Hello' },
        ];
        const result = mod.convertClaudeMessages(messages, 'Sure, I will ', false, false, names);
        const last = result.messages[result.messages.length - 1];
        expect(last.role).toBe('assistant');
        // Prefill should be trimmed on the right
        expect(last.content[0].text).toBe('Sure, I will');
    });

    test('converts tool_calls to tool_use format', () => {
        const messages = [
            { role: 'user', content: 'search for cats' },
            { role: 'assistant', content: '', tool_calls: [
                { id: 'tc1', function: { name: 'search', arguments: '{"q":"cats"}' } },
            ] },
        ];
        const result = mod.convertClaudeMessages(messages, '', false, true, names);
        const assistantContent = result.messages.find(m => m.role === 'assistant')?.content;
        const toolUse = assistantContent?.find(c => c.type === 'tool_use');
        expect(toolUse).toBeDefined();
        expect(toolUse.name).toBe('search');
        expect(toolUse.input).toEqual({ q: 'cats' });
    });

    test('converts tool messages to tool_result format', () => {
        const messages = [
            { role: 'user', content: 'search' },
            { role: 'assistant', content: '', tool_calls: [
                { id: 'tc1', function: { name: 'search', arguments: '{}' } },
            ] },
            { role: 'tool', content: 'Found results', tool_call_id: 'tc1' },
        ];
        const result = mod.convertClaudeMessages(messages, '', false, true, names);
        const userContent = result.messages
            .filter(m => m.role === 'user')
            .flatMap(m => m.content);
        const toolResult = userContent.find(c => c.type === 'tool_result');
        expect(toolResult).toBeDefined();
        expect(toolResult.content).toBe('Found results');
    });

    test('drops messages whose only content is empty or whitespace-only text', () => {
        const messages = [
            { role: 'user', content: [{ type: 'text', text: '' }] },
        ];
        const result = mod.convertClaudeMessages(messages, '', false, false, names);
        // Empty text leaves the message with zero content blocks, so the message
        // is dropped and the placeholder takes its place to keep Anthropic happy.
        expect(result.messages).toHaveLength(1);
        expect(result.messages[0].role).toBe('user');
        expect(result.messages[0].content[0].text).not.toBe('');
        expect(result.messages[0].content[0].text.trim()).not.toBe('');
    });

    test('drops whitespace-only string user message and re-merges neighbours', () => {
        const messages = [
            { role: 'user', content: 'Hello' },
            { role: 'assistant', content: '   \n\t  ' },
            { role: 'user', content: 'Still there?' },
        ];
        const result = mod.convertClaudeMessages(messages, '', false, false, names);
        // The whitespace assistant turn is dropped; the two user turns become
        // neighbours and get merged into a single user message.
        expect(result.messages).toHaveLength(1);
        expect(result.messages[0].role).toBe('user');
        const texts = result.messages[0].content.map(c => c.text);
        expect(texts).toEqual(['Hello', 'Still there?']);
    });

    test('strips whitespace-only blocks but keeps the message when other blocks survive', () => {
        const messages = [
            { role: 'user', content: [
                { type: 'text', text: '   ' },
                { type: 'text', text: 'real content' },
                { type: 'text', text: '\n\n' },
            ] },
        ];
        const result = mod.convertClaudeMessages(messages, '', false, false, names);
        expect(result.messages).toHaveLength(1);
        expect(result.messages[0].content).toEqual([{ type: 'text', text: 'real content' }]);
    });

    test('falls back to placeholder when every message is whitespace-only', () => {
        const messages = [
            { role: 'user', content: '   ' },
            { role: 'assistant', content: '\n' },
        ];
        const result = mod.convertClaudeMessages(messages, '', false, false, names);
        expect(result.messages).toHaveLength(1);
        expect(result.messages[0].role).toBe('user');
        expect(result.messages[0].content[0].type).toBe('text');
        expect(result.messages[0].content[0].text.trim()).not.toBe('');
    });

    test('prepends example_assistant name with charName in system prompt', () => {
        const messages = [
            { role: 'system', name: 'example_assistant', content: 'Greetings' },
            { role: 'user', content: 'Hi' },
        ];
        const result = mod.convertClaudeMessages(messages, '', true, false, names);
        expect(result.systemPrompt[0].text).toBe('Bot: Greetings');
    });

    test('removes name, tool_calls, and tool_call_id properties from output', () => {
        const messages = [
            { role: 'user', name: 'Alice', content: 'Hello' },
        ];
        const result = mod.convertClaudeMessages(messages, '', false, false, names);
        const msg = result.messages[0];
        expect(msg.name).toBeUndefined();
        expect(msg.tool_calls).toBeUndefined();
        expect(msg.tool_call_id).toBeUndefined();
    });

    test('prepends thinking blocks with signature ahead of tool_use blocks on assistant', () => {
        const messages = [
            { role: 'user', content: 'search please' },
            {
                role: 'assistant',
                content: '',
                reasoning_blocks: [
                    { type: 'thinking', thinking: 'let me plan', signature: 'sig-1' },
                ],
                tool_calls: [
                    { id: 'tc1', function: { name: 'search', arguments: '{"q":"cats"}' } },
                ],
            },
        ];
        const result = mod.convertClaudeMessages(messages, '', false, true, names);
        const assistant = result.messages.find(m => m.role === 'assistant');
        expect(assistant.content[0]).toEqual({
            type: 'thinking',
            thinking: 'let me plan',
            signature: 'sig-1',
        });
        // tool_use must follow thinking blocks per Anthropic Extended Thinking contract
        const toolUse = assistant.content.find(c => c.type === 'tool_use');
        expect(toolUse).toBeDefined();
        const thinkingIdx = assistant.content.findIndex(c => c.type === 'thinking');
        const toolUseIdx = assistant.content.findIndex(c => c.type === 'tool_use');
        expect(thinkingIdx).toBeLessThan(toolUseIdx);
    });

    test('preserves redacted_thinking data field on assistant content', () => {
        const messages = [
            { role: 'user', content: 'ok' },
            {
                role: 'assistant',
                content: [{ type: 'text', text: 'reply' }],
                reasoning_blocks: [
                    { type: 'redacted_thinking', data: 'encrypted-blob' },
                ],
            },
        ];
        const result = mod.convertClaudeMessages(messages, '', false, false, names);
        const assistant = result.messages.find(m => m.role === 'assistant');
        expect(assistant.content[0]).toEqual({ type: 'redacted_thinking', data: 'encrypted-blob' });
    });

    test('drops thinking block with empty thinking string but keeps type marker', () => {
        // Anthropic requires the block to be sent back verbatim, including empty thinking.
        // Signature is what carries the state; the block itself must exist even if thinking is ''.
        const messages = [
            { role: 'user', content: 'q' },
            {
                role: 'assistant',
                content: [{ type: 'text', text: 'reply' }],
                reasoning_blocks: [
                    { type: 'thinking', thinking: '', signature: 'sig-only' },
                ],
            },
        ];
        const result = mod.convertClaudeMessages(messages, '', false, false, names);
        const assistant = result.messages.find(m => m.role === 'assistant');
        expect(assistant.content[0]).toEqual({
            type: 'thinking',
            thinking: '',
            signature: 'sig-only',
        });
    });

    test('preserves order of multiple reasoning_blocks entries', () => {
        const messages = [
            { role: 'user', content: 'x' },
            {
                role: 'assistant',
                content: [{ type: 'text', text: 'y' }],
                reasoning_blocks: [
                    { type: 'thinking', thinking: 'first', signature: 's1' },
                    { type: 'redacted_thinking', data: 'blob' },
                    { type: 'thinking', thinking: 'second', signature: 's2' },
                ],
            },
        ];
        const result = mod.convertClaudeMessages(messages, '', false, false, names);
        const assistant = result.messages.find(m => m.role === 'assistant');
        const types = assistant.content.slice(0, 3).map(c => c.type);
        expect(types).toEqual(['thinking', 'redacted_thinking', 'thinking']);
        expect(assistant.content[0].thinking).toBe('first');
        expect(assistant.content[2].thinking).toBe('second');
    });

    test('deletes reasoning_blocks from output message', () => {
        const messages = [
            { role: 'user', content: 'q' },
            {
                role: 'assistant',
                content: [{ type: 'text', text: 'a' }],
                reasoning_blocks: [{ type: 'thinking', thinking: 't', signature: 's' }],
            },
        ];
        const result = mod.convertClaudeMessages(messages, '', false, false, names);
        const assistant = result.messages.find(m => m.role === 'assistant');
        expect(assistant.reasoning_blocks).toBeUndefined();
    });

    test('does not forward reasoning metadata from chat history to Claude', () => {
        const messages = [
            { role: 'user', content: 'q' },
            {
                role: 'assistant',
                content: 'a',
                reasoning: 'plain reasoning',
                reasoning_content: 'provider reasoning',
                reasoning_details: [{ type: 'reasoning.text', text: 'provider detail' }],
                reasoning_blocks: [{ type: 'thinking', thinking: 'signed thought', signature: 's' }],
            },
        ];
        const result = mod.convertClaudeMessages(messages, '', false, false, names);

        expect(result.messages[1]).toEqual({
            role: 'assistant',
            content: [
                { type: 'thinking', thinking: 'signed thought', signature: 's' },
                { type: 'text', text: 'a' },
            ],
        });
    });

    test('ignores reasoning_blocks on non-assistant messages', () => {
        // Only assistant turns can carry thinking blocks per Anthropic spec.
        // User-role reasoning_blocks (nonsensical shape) must not leak into content.
        const messages = [
            {
                role: 'user',
                content: 'question',
                reasoning_blocks: [{ type: 'thinking', thinking: 'should-be-ignored', signature: 'x' }],
            },
        ];
        const result = mod.convertClaudeMessages(messages, '', false, false, names);
        const user = result.messages.find(m => m.role === 'user');
        const hasThinking = user.content.some(c => c.type === 'thinking');
        expect(hasThinking).toBe(false);
    });

    test('leaves content unchanged when reasoning_blocks is missing or empty', () => {
        const messages = [
            { role: 'user', content: 'q' },
            { role: 'assistant', content: [{ type: 'text', text: 'a' }] },
            { role: 'user', content: 'q2' },
            { role: 'assistant', content: [{ type: 'text', text: 'a2' }], reasoning_blocks: [] },
        ];
        const result = mod.convertClaudeMessages(messages, '', false, false, names);
        const assistants = result.messages.filter(m => m.role === 'assistant');
        for (const assistant of assistants) {
            const types = assistant.content.map(c => c.type);
            expect(types).not.toContain('thinking');
            expect(types).not.toContain('redacted_thinking');
        }
    });

    test('drops malformed blocks (non-object entries and unknown types)', () => {
        const messages = [
            { role: 'user', content: 'q' },
            {
                role: 'assistant',
                content: [{ type: 'text', text: 'a' }],
                reasoning_blocks: [
                    null,
                    { type: 'unknown', payload: 'x' },
                    { type: 'thinking', thinking: 'kept', signature: 'sig' },
                    'not-an-object',
                ],
            },
        ];
        const result = mod.convertClaudeMessages(messages, '', false, false, names);
        const assistant = result.messages.find(m => m.role === 'assistant');
        const thinkingBlocks = assistant.content.filter(c => c.type === 'thinking');
        expect(thinkingBlocks).toHaveLength(1);
        expect(thinkingBlocks[0].thinking).toBe('kept');
    });

    test('drops redacted_thinking block missing data field', () => {
        const messages = [
            { role: 'user', content: 'q' },
            {
                role: 'assistant',
                content: [{ type: 'text', text: 'a' }],
                reasoning_blocks: [
                    { type: 'redacted_thinking' },
                    { type: 'redacted_thinking', data: '' },
                    { type: 'redacted_thinking', data: 'valid' },
                ],
            },
        ];
        const result = mod.convertClaudeMessages(messages, '', false, false, names);
        const assistant = result.messages.find(m => m.role === 'assistant');
        const redacted = assistant.content.filter(c => c.type === 'redacted_thinking');
        expect(redacted).toHaveLength(1);
        expect(redacted[0].data).toBe('valid');
    });

    test('deletes root-level reasoning/signature/reasoning_details sidecars from output', () => {
        // Anthropic /v1/messages rejects any property outside its message schema
        // (`messages.N.reasoning: Extra inputs are not permitted`). OAI-shaped root
        // sidecars must never survive conversion regardless of what the client sent.
        const messages = [
            { role: 'user', content: 'q' },
            {
                role: 'assistant',
                content: [{ type: 'text', text: 'a' }],
                reasoning: 'chain-of-thought-text',
                signature: 'sig-abc',
                reasoning_details: [{ type: 'reasoning', text: 'detail' }],
                reasoning_blocks: [{ type: 'thinking', thinking: 't', signature: 's' }],
            },
        ];
        const result = mod.convertClaudeMessages(messages, '', false, false, names);
        for (const message of result.messages) {
            expect(message.reasoning).toBeUndefined();
            expect(message.signature).toBeUndefined();
            expect(message.reasoning_details).toBeUndefined();
        }
    });

    test('deletes root-level sidecars even when reasoning_blocks is absent', () => {
        const messages = [
            { role: 'user', content: 'q' },
            {
                role: 'assistant',
                content: 'a',
                reasoning: 'stray-root-reasoning',
                signature: 'stray-root-signature',
            },
        ];
        const result = mod.convertClaudeMessages(messages, '', false, false, names);
        for (const message of result.messages) {
            expect(message.reasoning).toBeUndefined();
            expect(message.signature).toBeUndefined();
            expect(message.reasoning_details).toBeUndefined();
        }
    });

    test('replays native_content_blocks verbatim in original interleaved order and strips internal replay fields', () => {
        const blocks = [
            { type: 'thinking', thinking: 'step 1', signature: 'sig-1' },
            { type: 'text', text: 'Searching now.', citations: [{ type: 'char_location', cited_text: 'fact' }] },
            { type: 'server_tool_use', id: 'srv_1', name: 'web_search', input: { query: 'news' } },
            { type: 'web_search_tool_result', tool_use_id: 'srv_1', content: [{ type: 'web_search_result', url: 'https://example.com' }] },
            { type: 'thinking', thinking: 'step 2', signature: 'sig-2' },
            { type: 'tool_use', id: 'toolu_1', name: 'lookup', input: { q: 'x' } },
        ];
        const messages = [
            { role: 'user', content: 'q' },
            {
                role: 'assistant',
                content: 'Searching now.',
                native_content_blocks: blocks,
                tool_calls: [{ id: 'toolu_1', type: 'function', function: { name: 'lookup', arguments: '{"q":"x"}' } }],
            },
            { role: 'tool', tool_call_id: 'toolu_1', content: '{"ok":true}' },
        ];
        const result = mod.convertClaudeMessages(messages, '', false, true, names);
        const assistant = result.messages.find(m => m.role === 'assistant');
        expect(assistant.content).toEqual(blocks);
        expect(assistant.native_content_blocks).toBeUndefined();
        expect(assistant.native_parts).toBeUndefined();
        expect(assistant.responses_output_items).toBeUndefined();
    });

    test('preserves assistant text prefix alongside tool_calls when native_content_blocks is absent', () => {
        const messages = [
            { role: 'user', content: 'q' },
            {
                role: 'assistant',
                content: 'Let me check that for you.',
                reasoning_blocks: [{ type: 'thinking', thinking: 'plan', signature: 'sig-p' }],
                tool_calls: [{ id: 'toolu_2', type: 'function', function: { name: 'lookup', arguments: '{"k":"v"}' } }],
            },
            { role: 'tool', tool_call_id: 'toolu_2', content: 'done' },
        ];
        const result = mod.convertClaudeMessages(messages, '', false, true, names);
        const assistant = result.messages.find(m => m.role === 'assistant');
        expect(assistant.content).toEqual([
            { type: 'thinking', thinking: 'plan', signature: 'sig-p' },
            { type: 'text', text: 'Let me check that for you.' },
            { type: 'tool_use', id: 'toolu_2', name: 'lookup', input: { k: 'v' } },
        ]);
    });
});


describe('convertGooglePrompt', () => {
    const names = makeNames('Bot', 'User');

    test('extracts leading system messages into system_instruction', () => {
        const messages = [
            { role: 'system', content: 'Be helpful' },
            { role: 'system', content: 'Be concise' },
            { role: 'user', content: 'Hello' },
        ];
        const result = mod.convertGooglePrompt(messages, 'gemini-2.0-flash', true, names);
        expect(result.system_instruction.parts).toEqual([
            { text: 'Be helpful' },
            { text: 'Be concise' },
        ]);
    });

    test('converts assistant role to model role', () => {
        const messages = [
            { role: 'user', content: 'Hi' },
            { role: 'assistant', content: 'Hello' },
        ];
        const result = mod.convertGooglePrompt(messages, 'gemini-2.0-flash', false, names);
        expect(result.contents[1].role).toBe('model');
    });

    test('converts system and tool roles to user role', () => {
        const messages = [
            { role: 'system', content: 'System' },
            { role: 'tool', content: 'Tool result', tool_call_id: 'tc1' },
            { role: 'user', content: 'Hi' },
        ];
        const result = mod.convertGooglePrompt(messages, 'gemini-2.0-flash', false, names);
        // Both system and tool should become user
        const roles = result.contents.map(c => c.role);
        expect(roles).not.toContain('system');
        expect(roles).not.toContain('tool');
    });

    test('does not merge consecutive same-role messages (users get to choose via postProcessPrompt)', () => {
        // convertGooglePrompt is a pure format converter: role name mapping
        // (assistant -> model) and content shape (string -> parts:[{text}]).
        // It must NOT collapse consecutive same-role messages: the Google
        // API does not require alternating roles, and users who want that
        // behavior can pick a "Merge consecutive roles" prompt post-
        // processing option in Settings (postProcessPrompt runs in the
        // handler preamble before this converter).
        const messages = [
            { role: 'user', content: 'A' },
            { role: 'user', content: 'B' },
            { role: 'assistant', content: 'Reply' },
        ];
        const result = mod.convertGooglePrompt(messages, 'gemini-2.0-flash', false, names);
        const userContents = result.contents.filter(c => c.role === 'user');
        expect(userContents).toHaveLength(2);
        expect(userContents[0].parts).toEqual([{ text: 'A' }]);
        expect(userContents[1].parts).toEqual([{ text: 'B' }]);
        expect(result.contents.find(c => c.role === 'model').parts).toEqual([{ text: 'Reply' }]);
    });

    test('postProcessPrompt MERGE, run before this converter, does collapse consecutive same-role messages', () => {
        // Documents the composition path: users who want the old "merge
        // consecutive user messages" Google behavior get it by selecting
        // PROMPT_PROCESSING_TYPE.MERGE, which the handler applies before
        // dispatching to convertGooglePrompt.
        const messages = [
            { role: 'user', content: 'A' },
            { role: 'user', content: 'B' },
            { role: 'assistant', content: 'Reply' },
        ];
        const merged = mod.postProcessPrompt(messages, mod.PROMPT_PROCESSING_TYPE.MERGE, names);
        const result = mod.convertGooglePrompt(merged, 'gemini-2.0-flash', false, names);
        expect(result.contents.filter(c => c.role === 'user')).toHaveLength(1);
        expect(result.contents[0].parts[0].text).toBe('A\n\nB');
    });

    for (const model of ['gemini-3.7-flash', 'gemini-3.6-flash', 'gemini-3.5-flash-lite', 'gemini-4-argon']) {
        test(`converts a trailing prefill to a user turn on ${model}`, () => {
            const messages = [
                { role: 'user', content: 'Hi' },
                { role: 'assistant', content: 'Prefill' },
            ];
            const result = mod.convertGooglePrompt(messages, model, false, names);
            expect(result.contents.map(c => c.role)).toEqual(['user', 'user']);
            expect(result.contents[1].parts[0].text).toBe('Prefill');
        });
    }

    test('keeps non-trailing model turns on models without prefill support', () => {
        const messages = [
            { role: 'user', content: 'Hi' },
            { role: 'assistant', content: 'Hello' },
            { role: 'user', content: 'How are you?' },
        ];
        const result = mod.convertGooglePrompt(messages, 'gemini-3.6-flash', false, names);
        expect(result.contents.map(c => c.role)).toEqual(['user', 'model', 'user']);
    });

    test('converts image_url to inlineData', () => {
        const messages = [
            { role: 'user', content: [
                { type: 'text', text: 'Look' },
                { type: 'image_url', image_url: { url: 'data:image/jpeg;base64,/9j/abc' } },
            ] },
        ];
        const result = mod.convertGooglePrompt(messages, 'gemini-2.0-flash', false, names);
        const parts = result.contents[0].parts;
        const inlineData = parts.find(p => p.inlineData);
        expect(inlineData).toBeDefined();
        expect(inlineData.inlineData.mimeType).toBe('image/jpeg');
        expect(inlineData.inlineData.data).toBe('/9j/abc');
    });

    test('converts tool_calls to functionCall parts', () => {
        const messages = [
            { role: 'user', content: 'search cats' },
            { role: 'assistant', tool_calls: [
                { id: 'tc1', function: { name: 'search', arguments: '{"q":"cats"}' } },
            ] },
        ];
        const result = mod.convertGooglePrompt(messages, 'gemini-2.0-flash', false, names);
        const modelParts = result.contents.find(c => c.role === 'model')?.parts;
        const funcCall = modelParts?.find(p => p.functionCall);
        expect(funcCall).toBeDefined();
        expect(funcCall.functionCall.name).toBe('search');
    });

    test('converts tool_call_id to functionResponse parts', () => {
        const messages = [
            { role: 'user', content: 'search' },
            { role: 'assistant', tool_calls: [
                { id: 'tc1', function: { name: 'search', arguments: '{}' } },
            ] },
            { role: 'tool', content: 'Results here', tool_call_id: 'tc1' },
        ];
        const result = mod.convertGooglePrompt(messages, 'gemini-2.0-flash', false, names);
        const userParts = result.contents
            .filter(c => c.role === 'user')
            .flatMap(c => c.parts);
        const funcResp = userParts.find(p => p.functionResponse);
        expect(funcResp).toBeDefined();
        expect(funcResp.functionResponse.name).toBe('search');
    });

    test('preserves tool call ids on functionCall and functionResponse parts', () => {
        const messages = [
            { role: 'user', content: 'search cats' },
            { role: 'assistant', tool_calls: [
                { id: 'gemini-call-1', function: { name: 'search', arguments: '{"q":"cats"}' } },
            ] },
            { role: 'tool', content: 'Results here', tool_call_id: 'gemini-call-1' },
        ];
        const result = mod.convertGooglePrompt(messages, 'gemini-4-argon', false, names);
        const parts = result.contents.flatMap(c => c.parts);
        const funcCall = parts.find(p => p.functionCall);
        const funcResp = parts.find(p => p.functionResponse);
        expect(funcCall.functionCall.id).toBe('gemini-call-1');
        expect(funcResp.functionResponse.id).toBe('gemini-call-1');
    });

    test('omits synthetic gemini_call_N ids on wire and resolves repeated ids chronologically', () => {
        const messages = [
            { role: 'user', content: 'step 1' },
            { role: 'assistant', tool_calls: [
                { id: 'gemini_call_1', function: { name: 'first_tool', arguments: '{"a":1}' } },
            ] },
            { role: 'tool', content: 'res1', tool_call_id: 'gemini_call_1' },
            { role: 'assistant', tool_calls: [
                { id: 'gemini_call_1', function: { name: 'second_tool', arguments: '{"b":2}' } },
            ] },
            { role: 'tool', content: 'res2', tool_call_id: 'gemini_call_1' },
        ];
        const result = mod.convertGooglePrompt(messages, 'gemini-2.5-flash', false, names);
        const parts = result.contents.flatMap(c => c.parts);
        const calls = parts.filter(p => p.functionCall);
        const resps = parts.filter(p => p.functionResponse);
        expect(calls).toHaveLength(2);
        expect(resps).toHaveLength(2);
        expect(calls[0].functionCall).toEqual({ name: 'first_tool', args: { a: 1 } });
        expect(calls[1].functionCall).toEqual({ name: 'second_tool', args: { b: 2 } });
        expect(resps[0].functionResponse).toEqual({ name: 'first_tool', response: { name: 'first_tool', content: 'res1' } });
        expect(resps[1].functionResponse).toEqual({ name: 'second_tool', response: { name: 'second_tool', content: 'res2' } });
    });

    test('keeps ids distinct for parallel calls to the same function', () => {
        const messages = [
            { role: 'user', content: 'search both' },
            { role: 'assistant', tool_calls: [
                { id: 'gemini-call-1', function: { name: 'search', arguments: '{"q":"cats"}' } },
                { id: 'gemini-call-2', function: { name: 'search', arguments: '{"q":"dogs"}' } },
            ] },
            { role: 'tool', content: 'cat results', tool_call_id: 'gemini-call-1' },
            { role: 'tool', content: 'dog results', tool_call_id: 'gemini-call-2' },
        ];
        const result = mod.convertGooglePrompt(messages, 'gemini-4-argon', false, names);
        const parts = result.contents.flatMap(c => c.parts);
        expect(parts.filter(p => p.functionCall).map(p => p.functionCall.id))
            .toEqual(['gemini-call-1', 'gemini-call-2']);
        expect(parts.filter(p => p.functionResponse).map(p => p.functionResponse.id))
            .toEqual(['gemini-call-1', 'gemini-call-2']);
    });

    test('groups parallel tool responses into a single user turn', () => {
        const messages = [
            { role: 'user', content: 'do two things' },
            { role: 'assistant', tool_calls: [
                { id: 'tc1', function: { name: 'alpha', arguments: '{}' } },
                { id: 'tc2', function: { name: 'beta', arguments: '{}' } },
            ] },
            { role: 'tool', content: 'r1', tool_call_id: 'tc1' },
            { role: 'tool', content: 'r2', tool_call_id: 'tc2' },
        ];
        const result = mod.convertGooglePrompt(messages, 'gemini-2.5-pro', false, names);

        const modelContent = result.contents.find(c => c.role === 'model');
        expect(modelContent.parts.filter(p => p.functionCall)).toHaveLength(2);

        const modelIndex = result.contents.indexOf(modelContent);
        const responseContent = result.contents[modelIndex + 1];
        expect(responseContent.role).toBe('user');
        const responseNames = responseContent.parts
            .filter(p => p.functionResponse)
            .map(p => p.functionResponse.name);
        expect(responseNames).toEqual(['alpha', 'beta']);
    });

    test('does not merge a following user text turn into the tool response turn', () => {
        const messages = [
            { role: 'user', content: 'hi' },
            { role: 'assistant', tool_calls: [
                { id: 'tc1', function: { name: 'alpha', arguments: '{}' } },
                { id: 'tc2', function: { name: 'beta', arguments: '{}' } },
            ] },
            { role: 'tool', content: 'r1', tool_call_id: 'tc1' },
            { role: 'tool', content: 'r2', tool_call_id: 'tc2' },
            { role: 'user', content: 'next question' },
        ];
        const result = mod.convertGooglePrompt(messages, 'gemini-2.5-pro', false, names);

        const responseContent = result.contents.find(c => c.parts.some(p => p.functionResponse));
        expect(responseContent.parts.filter(p => p.functionResponse)).toHaveLength(2);

        const last = result.contents[result.contents.length - 1];
        expect(last.parts.some(p => p.functionResponse)).toBe(false);
        expect(last.parts.some(p => typeof p.text === 'string')).toBe(true);
    });

    test('prepends example names when useSysPrompt is true', () => {
        const messages = [
            { role: 'system', name: 'example_assistant', content: 'Greetings' },
            { role: 'user', content: 'Hi' },
        ];
        const result = mod.convertGooglePrompt(messages, 'gemini-2.0-flash', true, names);
        expect(result.system_instruction.parts[0].text).toBe('Bot: Greetings');
    });

    test('does not extract system if useSysPrompt is false', () => {
        const messages = [
            { role: 'system', content: 'System' },
            { role: 'user', content: 'Hi' },
        ];
        const result = mod.convertGooglePrompt(messages, 'gemini-2.0-flash', false, names);
        expect(result.system_instruction.parts).toHaveLength(0);
        // System message should be in contents as user
        expect(result.contents[0].role).toBe('user');
    });

    test('replays native_parts verbatim preserving per-part thoughtSignature and functionCall/functionResponse id mapping', () => {
        const nativeParts = [
            { thought: true, text: 'thinking step', thoughtSignature: 'sig-thought-1' },
            { text: 'Let me run two tools.' },
            { functionCall: { id: 'gem_c1', name: 'lookup', args: { q: 'a' } }, thoughtSignature: 'sig-call-1' },
            { functionCall: { id: 'gem_c2', name: 'lookup', args: { q: 'b' } } },
        ];
        const messages = [
            { role: 'user', content: 'check both' },
            {
                role: 'assistant',
                content: 'Let me run two tools.',
                native_parts: nativeParts,
                tool_calls: [
                    { id: 'gem_c1', type: 'function', function: { name: 'lookup', arguments: '{"q":"a"}' } },
                    { id: 'gem_c2', type: 'function', function: { name: 'lookup', arguments: '{"q":"b"}' } },
                ],
            },
            { role: 'tool', tool_call_id: 'gem_c1', content: '{"a":1}' },
            { role: 'tool', tool_call_id: 'gem_c2', content: '{"b":2}' },
        ];
        const result = mod.convertGooglePrompt(messages, 'gemini-3-pro', false, names);
        const modelTurn = result.contents.find(c => c.role === 'model');
        expect(modelTurn.parts).toEqual(nativeParts);
        const toolTurn = result.contents[result.contents.indexOf(modelTurn) + 1];
        expect(toolTurn.role).toBe('user');
        expect(toolTurn.parts.map(p => p.functionResponse)).toEqual([
            { id: 'gem_c1', name: 'lookup', response: { name: 'lookup', content: '{"a":1}' } },
            { id: 'gem_c2', name: 'lookup', response: { name: 'lookup', content: '{"b":2}' } },
        ]);
    });

    test('preserves assistant text prefix before functionCall and never overwrites existing thoughtSignature', () => {
        const messages = [
            { role: 'user', content: 'search' },
            {
                role: 'assistant',
                content: 'Checking now.',
                tool_calls: [
                    {
                        id: 'tc_sig',
                        type: 'function',
                        signature: 'real-call-signature',
                        function: { name: 'search', arguments: '{"q":"cats"}' },
                    },
                ],
            },
            { role: 'tool', tool_call_id: 'tc_sig', content: 'ok' },
        ];
        const result = mod.convertGooglePrompt(messages, 'gemini-3-pro', false, names);
        const modelTurn = result.contents.find(c => c.role === 'model');
        expect(modelTurn.parts[0]).toEqual({ text: 'Checking now.' });
        expect(modelTurn.parts[1]).toEqual({
            functionCall: { id: 'tc_sig', name: 'search', args: { q: 'cats' } },
            thoughtSignature: 'real-call-signature',
        });
    });
});


describe('convertMistralMessages', () => {
    const names = makeNames('Bot', 'User');

    test('returns empty array for non-array input', () => {
        expect(mod.convertMistralMessages(null, names)).toEqual([]);
    });

    test('prepends charName to example_assistant system messages', () => {
        const messages = [
            { role: 'system', name: 'example_assistant', content: 'Greetings' },
            { role: 'user', content: 'Hi' },
        ];
        const result = mod.convertMistralMessages(messages, names);
        expect(result[0].content).toBe('Bot: Greetings');
        expect(result[0].name).toBeUndefined();
    });

    test('prepends userName to example_user system messages', () => {
        const messages = [
            { role: 'system', name: 'example_user', content: 'Hello there' },
            { role: 'user', content: 'Hi' },
        ];
        const result = mod.convertMistralMessages(messages, names);
        expect(result[0].content).toBe('User: Hello there');
    });

    test('prepends name to non-system messages', () => {
        const messages = [
            { role: 'assistant', name: 'NPC', content: 'dialogue' },
        ];
        const result = mod.convertMistralMessages(messages, names);
        expect(result[0].content).toBe('NPC: dialogue');
        expect(result[0].name).toBeUndefined();
    });

    test('hashes tool call IDs', () => {
        const messages = [
            { role: 'assistant', content: 'calling', tool_calls: [{ id: 'original-id', function: { name: 'f' } }] },
            { role: 'tool', content: 'result', tool_call_id: 'original-id' },
        ];
        const result = mod.convertMistralMessages(messages, names);
        // IDs should be hashed to 9-char hex
        expect(result[0].tool_calls[0].id).toMatch(/^[a-f0-9]{9}$/);
        expect(result[1].tool_call_id).toMatch(/^[a-f0-9]{9}$/);
        // Both should match (same input -> same hash)
        expect(result[0].tool_calls[0].id).toBe(result[1].tool_call_id);
    });

    test('changes system to user when following assistant', () => {
        const messages = [
            { role: 'user', content: 'Hi' },
            { role: 'assistant', content: 'Hello' },
            { role: 'system', content: 'Narrator text' },
        ];
        const result = mod.convertMistralMessages(messages, names);
        expect(result[2].role).toBe('user');
    });

    test('merges user message after tool into previous user message', () => {
        const messages = [
            { role: 'user', content: 'search cats' },
            { role: 'assistant', content: 'calling', tool_calls: [{ id: 'tc1', function: { name: 'f' } }] },
            { role: 'tool', content: 'result', tool_call_id: 'tc1' },
            { role: 'user', content: 'thanks' },
        ];
        const result = mod.convertMistralMessages(messages, names);
        // The 'thanks' user message should be merged into the first user message
        expect(result[0].content).toContain('search cats');
        expect(result[0].content).toContain('thanks');
    });
});


describe('cachingAtDepthForClaude', () => {
    test('adds cache_control at specified depth', () => {
        const messages = [
            { role: 'user', content: [{ type: 'text', text: 'A' }] },
            { role: 'assistant', content: [{ type: 'text', text: 'B' }] },
            { role: 'user', content: [{ type: 'text', text: 'C' }] },
            { role: 'assistant', content: [{ type: 'text', text: 'D' }] },
            { role: 'user', content: [{ type: 'text', text: 'E' }] },
        ];
        mod.cachingAtDepthForClaude(messages, 0, '300');
        // Depth 0 should be the last non-assistant message (working backwards)
        const cached = messages.filter(m =>
            m.content.some(c => c.cache_control),
        );
        expect(cached.length).toBeGreaterThan(0);
        const cacheControl = cached[0].content[cached[0].content.length - 1].cache_control;
        expect(cacheControl).toEqual({ type: 'ephemeral', ttl: '300' });
    });

    test('skips trailing assistant messages (prefill)', () => {
        const messages = [
            { role: 'user', content: [{ type: 'text', text: 'A' }] },
            { role: 'assistant', content: [{ type: 'text', text: 'B' }] },
            { role: 'assistant', content: [{ type: 'text', text: 'Prefill' }] },
        ];
        mod.cachingAtDepthForClaude(messages, 0, '300');
        // The trailing assistant prefill should not get cache_control
        const lastMsg = messages[messages.length - 1];
        expect(lastMsg.content[0].cache_control).toBeUndefined();
    });

    test('does not modify messages when depth exceeds message count', () => {
        const messages = [
            { role: 'user', content: [{ type: 'text', text: 'A' }] },
        ];
        mod.cachingAtDepthForClaude(messages, 10, '300');
        expect(messages[0].content[0].cache_control).toBeUndefined();
    });
});


describe('cachingAtDepthForOpenRouterClaude', () => {
    test('adds cache_control to string content by wrapping in array', () => {
        const messages = [
            { role: 'user', content: 'A' },
            { role: 'assistant', content: 'B' },
            { role: 'user', content: 'C' },
        ];
        mod.cachingAtDepthForOpenRouterClaude(messages, 0, '300');
        // Find which message got cached
        const cached = messages.find(m =>
            Array.isArray(m.content) && m.content.some(c => c.cache_control),
        );
        expect(cached).toBeDefined();
        expect(cached.content[0].type).toBe('text');
        expect(cached.content[0].cache_control).toEqual({ type: 'ephemeral', ttl: '300' });
    });

    test('adds cache_control to array content on last part', () => {
        const messages = [
            { role: 'user', content: [{ type: 'text', text: 'A' }, { type: 'text', text: 'B' }] },
            { role: 'assistant', content: [{ type: 'text', text: 'Reply' }] },
            { role: 'user', content: [{ type: 'text', text: 'C' }] },
        ];
        mod.cachingAtDepthForOpenRouterClaude(messages, 0, '300');
        const cached = messages.find(m =>
            m.content.some?.(c => c.cache_control),
        );
        expect(cached).toBeDefined();
    });

    test('skips system messages for depth counting', () => {
        const messages = [
            { role: 'system', content: 'System prompt' },
            { role: 'user', content: 'A' },
            { role: 'assistant', content: 'B' },
            { role: 'user', content: 'C' },
        ];
        mod.cachingAtDepthForOpenRouterClaude(messages, 0, '300');
        // System message should not get cache_control
        expect(messages[0].content).toBe('System prompt');
    });

    test('skips trailing assistant prefill', () => {
        const messages = [
            { role: 'user', content: 'A' },
            { role: 'assistant', content: 'Prefill' },
        ];
        mod.cachingAtDepthForOpenRouterClaude(messages, 0, '300');
        expect(typeof messages[1].content).toBe('string');
    });
});

describe('Gemini native_parts fallback tool-call id mapping and opaque metadata stripping', () => {
    test('convertGooglePrompt resolves functionResponse.name when native_parts omits functionCall.id', () => {
        const prompt = mod.convertGooglePrompt([
            { role: 'user', content: 'Check weather' },
            {
                role: 'assistant',
                content: '',
                native_parts: [
                    { text: 'Thinking...', thought: true, thoughtSignature: 'sig-1' },
                    { functionCall: { name: 'get_weather', args: { city: 'Bryn' } }, thoughtSignature: 'sig-2' },
                ],
                tool_calls: [
                    { id: 'gemini_call_1', type: 'function', function: { name: 'get_weather', arguments: '{"city":"Bryn"}' } },
                ],
            },
            { role: 'tool', tool_call_id: 'gemini_call_1', content: 'Sunny 20C' },
        ], 'gemini-2.5-pro', true, { userName: 'User', charName: 'Char', startsWithGroupName: () => false });

        const toolRespTurn = prompt.contents[2];
        expect(toolRespTurn.role).toBe('user');
        expect(toolRespTurn.parts[0].functionResponse.name).toBe('get_weather');
        expect(toolRespTurn.parts[0].functionResponse.id).toBeUndefined();
    });

    test('convertCohereMessages, convertAI21Messages, and convertMistralMessages strip opaque replay fields', () => {
        const names = { userName: 'User', charName: 'Char', startsWithGroupName: () => false };
        const sample = () => ([
            { role: 'user', content: 'Hello' },
            {
                role: 'assistant',
                content: 'Reply',
                native_parts: [{ text: 'Reply' }],
                native_content_blocks: [{ type: 'text', text: 'Reply' }],
                responses_output_items: [{ type: 'message' }],
                reasoning_blocks: [{ type: 'thinking', thinking: 'hmm' }],
            },
        ]);

        const cohereMsg = mod.convertCohereMessages(sample(), names).chatHistory[1];
        const ai21Msg = mod.convertAI21Messages(sample(), names)[1];
        const mistralMsg = mod.convertMistralMessages(sample(), names)[1];
        for (const msg of [cohereMsg, ai21Msg, mistralMsg]) {
            expect(msg.native_parts).toBeUndefined();
            expect(msg.native_content_blocks).toBeUndefined();
            expect(msg.responses_output_items).toBeUndefined();
            expect(msg.reasoning_blocks).toBeUndefined();
        }
    });

    test('convertClaudeMessages falls back when merged tool_calls or modified content diverges from native_content_blocks', () => {
        const names = { userName: 'User', charName: 'Char', startsWithGroupName: () => false };
        const toolMerged = mod.convertClaudeMessages([
            { role: 'user', content: 'Run tool' },
            {
                role: 'assistant',
                content: 'Final answer after tool',
                native_content_blocks: [{ type: 'text', text: 'Final answer after tool' }],
                reasoning_blocks: [{ type: 'thinking', thinking: 'plan', signature: 'sig-1' }],
                tool_calls: [{ id: 'toolu_merged', type: 'function', function: { name: 'lookup', arguments: '{"q":"a"}' } }],
            },
            { role: 'tool', tool_call_id: 'toolu_merged', content: '{"ok":true}' },
        ], '', false, true, names);
        const assistantMerged = toolMerged.messages.find(m => m.role === 'assistant');
        expect(assistantMerged.content.some(b => b.type === 'tool_use' && b.id === 'toolu_merged')).toBe(true);
        expect(assistantMerged.native_content_blocks).toBeUndefined();

        const contentEdited = mod.convertClaudeMessages([
            { role: 'user', content: 'Hi' },
            {
                role: 'assistant',
                content: 'Regex-rewritten text',
                native_content_blocks: [{ type: 'text', text: 'Original raw text' }],
            },
        ], '', false, true, names);
        const assistantEdited = contentEdited.messages.find(m => m.role === 'assistant');
        expect(assistantEdited.content).toEqual([{ type: 'text', text: 'Regex-rewritten text' }]);
    });

    test('convertGooglePrompt falls back when merged tool_calls or modified content diverges from native_parts', () => {
        const names = { userName: 'User', charName: 'Char', startsWithGroupName: () => false };
        const toolMerged = mod.convertGooglePrompt([
            { role: 'user', content: 'Run tool' },
            {
                role: 'assistant',
                content: 'Final answer after tool',
                native_parts: [{ text: 'Final answer after tool' }],
                tool_calls: [{ id: 'gem_merged', type: 'function', function: { name: 'lookup', arguments: '{"q":"a"}' } }],
            },
            { role: 'tool', tool_call_id: 'gem_merged', content: '{"ok":true}' },
        ], 'gemini-2.5-pro', false, names);
        const modelMerged = toolMerged.contents.find(c => c.role === 'model');
        expect(modelMerged.parts.some(p => p.functionCall?.name === 'lookup')).toBe(true);

        const contentEdited = mod.convertGooglePrompt([
            { role: 'user', content: 'Hi' },
            {
                role: 'assistant',
                content: 'Continued prefix + suffix',
                native_parts: [{ text: 'suffix' }],
            },
        ], 'gemini-2.5-pro', false, names);
        const modelEdited = contentEdited.contents.find(c => c.role === 'model');
        expect(modelEdited.parts).toEqual([{ text: 'Continued prefix + suffix' }]);
    });
});
