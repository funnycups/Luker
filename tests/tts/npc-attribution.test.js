/**
 * Unit tests for the TTS NPC dialogue-attribution core module
 * (public/scripts/extensions/tts/npc-attribution.js).
 *
 * Structural assertions only — no prompt-text grepping. Real-chain
 * behaviour (LLM-driven parse, floor-state persistence) is covered by
 * the Task 6 e2e; these tests exercise the pure alignment / roster /
 * voiceMap logic plus the parse-and-cache orchestration against mocked
 * LLM + floor-state boundaries.
 *
 * Mock preamble follows the unstable_mockModule + dynamic-import pattern
 * from tests/regex-engine/lane-semantics.test.js.
 */

import { describe, test, expect, beforeEach, jest } from '@jest/globals';

jest.unstable_mockModule('../../public/script.js', () => ({
    saveSettingsDebounced: jest.fn(),
}));
jest.unstable_mockModule('../../public/scripts/extensions.js', () => ({
    extension_settings: { tts: {} },
    getContext: () => { throw new Error('not used in unit tests'); },
}));
jest.unstable_mockModule('../../public/scripts/lib/iter-tool-calling.js', () => ({
    requestToolCallWithRetry: jest.fn(async () => ({})),
}));
jest.unstable_mockModule('../../public/scripts/extensions/tts/index.js', () => ({
    enqueueSegmentPlayback: jest.fn(),
    initVoiceMap: jest.fn(async () => {}),
}));
jest.unstable_mockModule('../../public/scripts/i18n.js', () => ({
    translate: (s) => s,
}));
jest.unstable_mockModule('../../public/scripts/extensions/connection-manager/profile-resolver.js', () => ({
    getChatCompletionConnectionProfiles: () => [],
}));
// utils.js's real import chain drags the whole UI shell under jest; stub
// the module but re-export the REAL getStringHash — readAttributionFor's
// cache-invalidation contract needs the true hash values. The real
// implementation is a small pure function; copy it verbatim rather than
// loading utils.js (whose import chain can't resolve under jest).
jest.unstable_mockModule('../../public/scripts/utils.js', () => {
    // eslint-disable-next-line no-inner-declarations
    function getStringHash(str, seed = 0) {
        if (typeof str !== 'string') {
            return 0;
        }

        let h1 = 0xdeadbeef ^ seed,
            h2 = 0x41c6ce57 ^ seed;
        for (let i = 0, ch; i < str.length; i++) {
            ch = str.charCodeAt(i);
            h1 = Math.imul(h1 ^ ch, 2654435761);
            h2 = Math.imul(h2 ^ ch, 1597334677);
        }

        h1 = Math.imul(h1 ^ (h1 >>> 16), 2246822507) ^ Math.imul(h2 ^ (h2 >>> 13), 3266489909);
        h2 = Math.imul(h2 ^ (h2 >>> 16), 2246822507) ^ Math.imul(h1 ^ (h1 >>> 13), 3266489909);

        return 4294967296 * (2097151 & h2) + (h1 >>> 0);
    }
    return { getStringHash };
});

const {
    alignAttribution,
    buildRoster,
    ensureNpcVoiceMapEntries,
    parseAndCacheAttribution,
    resetFloorStateInstanceForTesting,
} = await import('../../public/scripts/extensions/tts/npc-attribution.js');
const { extension_settings } = await import('../../public/scripts/extensions.js');
const { saveSettingsDebounced } = await import('../../public/script.js');
const { requestToolCallWithRetry } = await import('../../public/scripts/lib/iter-tool-calling.js');

function makeFakeFloorState() {
    const ops = [];
    const state = {};
    return {
        ops,
        async ready() { return { ok: true }; },
        async get() { return { ok: true, state: Object.keys(state).length ? structuredClone(state) : null }; },
        async patch(operations, options) {
            for (const op of operations) {
                if (op.op === 'add') state[op.path.slice(1)] = op.value;
            }
            ops.push({ operations, options });
            return { ok: true, updated: true };
        },
    };
}

function makeContext({ chat, providerName = 'Stub' } = {}) {
    const fs = makeFakeFloorState();
    return {
        chat,
        createFloorState: async () => fs,
        _fs: fs,
        groupId: null,
        name1: 'User',
        name2: 'Seraphina',
        characters: [{ name: 'Seraphina' }, { name: 'Marta' }],
        groups: [],
    };
}

beforeEach(() => {
    extension_settings.tts = { npcAttributionEnabled: true, npcAttributionRetryMax: 2, npcAttributionApiPresetName: '', npcAttributionPresetName: '', currentProvider: 'Stub' };
    extension_settings.tts.Stub = { voiceMap: { Seraphina: 'StubVoice' } };
    resetFloorStateInstanceForTesting();
    jest.clearAllMocks();
});

describe('npc-attribution', () => {
    test('alignAttribution matches by equality then containment, nulls elsewhere', () => {
        const toolSegments = [
            { quote_text: 'hello there', speaker: 'Marta' },
            { quote_text: 'no match at all', speaker: 'Someone' },
            { quote_text: 'exact words', speaker: null },
        ];
        const quoteWindow = [
            { qIndex: 0, start: 0, end: 13, full: '"hello there"', content: 'hello there' },
            { qIndex: 1, start: 20, end: 33, full: '"exact words"', content: 'exact words' },
            { qIndex: 2, start: 40, end: 52, full: '"paraphrase of exact words inside"', content: 'paraphrase of exact words inside' },
        ];
        const out = alignAttribution(toolSegments, quoteWindow);
        expect(out).toEqual([
            { qIndex: 0, speaker: 'Marta' },
            { qIndex: 1, speaker: null },
            { qIndex: 2, speaker: null },
        ]);
    });

    test('buildRoster merges chat participants and cached NPC names', () => {
        const context = makeContext({ chat: [] });
        const map = { 3: { mesHash: 'x', segments: [{ qIndex: 0, speaker: 'Marta' }, { qIndex: 1, speaker: null }] } };
        const roster = buildRoster(context, map);
        expect(roster).toContain('Seraphina');
        expect(roster).toContain('User');
        expect(roster).toContain('Marta');
        expect(new Set(roster).size).toBe(roster.length);
    });

    test('buildRoster includes manually pre-configured voiceMap names and strips multi-voice suffixes', () => {
        extension_settings.tts.currentProvider = 'Stub';
        extension_settings.tts.Stub.voiceMap = {
            'Bryn the Harbourmaster': 'StubVoice',
            'Bryn the Harbourmaster ("Quotes")': 'StubVoice',
            '[Default Voice]': 'StubVoice',
        };
        const context = makeContext({ chat: [] });
        const roster = buildRoster(context, {});
        expect(roster).toContain('Bryn the Harbourmaster');
        expect(roster).not.toContain('Bryn the Harbourmaster ("Quotes")');
        expect(new Set(roster).size).toBe(roster.length);
    });

    test('ensureNpcVoiceMapEntries adds only missing names', async () => {
        const added = await ensureNpcVoiceMapEntries('Stub', ['Marta', 'Seraphina', '', '[Default Voice]']);
        expect(added).toEqual(['Marta']);
        expect(extension_settings.tts.Stub.voiceMap.Marta).toBe('[Default Voice]');
        expect(extension_settings.tts.Stub.voiceMap.Seraphina).toBe('StubVoice');
        expect(saveSettingsDebounced).toHaveBeenCalledTimes(1);
        const addedAgain = await ensureNpcVoiceMapEntries('Stub', ['Marta']);
        expect(addedAgain).toEqual([]);
        expect(saveSettingsDebounced).toHaveBeenCalledTimes(1);
    });

    test('ensureNpcVoiceMapEntries expands four multi-voice keys per new NPC', async () => {
        extension_settings.tts.multi_voice_enabled = true;
        const added = await ensureNpcVoiceMapEntries('Stub', ['Marta']);
        expect(added).toEqual(['Marta']);
        expect(Object.keys(extension_settings.tts.Stub.voiceMap)).toEqual(expect.arrayContaining([
            'Marta',
            'Marta ("Quotes")',
            'Marta (*Text inside asterisks*)',
            'Marta (Other text)',
        ]));
        for (const key of ['Marta', 'Marta ("Quotes")', 'Marta (*Text inside asterisks*)', 'Marta (Other text)']) {
            expect(extension_settings.tts.Stub.voiceMap[key]).toBe('[Default Voice]');
        }
    });

    test('parseAndCacheAttribution parses, caches, and adds voice keys; second call hits cache', async () => {
        const message = { name: 'Seraphina', mes: 'text "line one" more "line two"', swipe_id: 0, is_user: false };
        const context = makeContext({ chat: [message] });
        requestToolCallWithRetry.mockImplementation(async () => ({
            segments: [
                { quote_text: 'line one', speaker: 'Seraphina' },
                { quote_text: 'line two', speaker: 'Marta' },
            ],
        }));

        const first = await parseAndCacheAttribution(context, 0);
        expect(requestToolCallWithRetry).toHaveBeenCalledTimes(1);
        expect(first.segments).toEqual([
            { qIndex: 0, speaker: 'Seraphina' },
            { qIndex: 1, speaker: 'Marta' },
        ]);
        expect(first.addedVoices).toEqual(['Marta']);
        expect(extension_settings.tts.Stub.voiceMap.Marta).toBe('[Default Voice]');
        // commit tagged with the message's floor + swipe
        const commit = context._fs.ops.at(-1);
        expect(commit.options).toEqual({ floor: 0, swipeId: 0 });
        expect(commit.operations[0].path).toBe('/0');
        expect(commit.operations[0].value.segments).toHaveLength(2);

        const second = await parseAndCacheAttribution(context, 0);
        expect(requestToolCallWithRetry).toHaveBeenCalledTimes(1); // cache hit, no LLM
        expect(second.segments).toEqual(first.segments);
    });

    test('hash mismatch invalidates cache entry and triggers re-parse', async () => {
        const message = { name: 'Seraphina', mes: 'a "quote" b', swipe_id: 0 };
        const context = makeContext({ chat: [message] });
        requestToolCallWithRetry.mockImplementation(async () => ({ segments: [{ quote_text: 'quote', speaker: 'Marta' }] }));
        await parseAndCacheAttribution(context, 0);
        expect(requestToolCallWithRetry).toHaveBeenCalledTimes(1);

        message.mes = 'a "quote" b EDITED';
        requestToolCallWithRetry.mockClear();
        await parseAndCacheAttribution(context, 0);
        expect(requestToolCallWithRetry).toHaveBeenCalledTimes(1); // re-parsed due to hash mismatch
    });

    test('message without quotes skips the LLM entirely', async () => {
        const context = makeContext({ chat: [{ name: 'Seraphina', mes: 'plain narration', swipe_id: 0 }] });
        const result = await parseAndCacheAttribution(context, 0);
        expect(result).toBe(null);
        expect(requestToolCallWithRetry).not.toHaveBeenCalled();
        expect(context._fs.ops).toHaveLength(0);
    });

    test('floor-state commit rejection still returns segments and warns once', async () => {
        const message = { name: 'Seraphina', mes: 'text "line one" more', swipe_id: 0 };
        const context = makeContext({ chat: [message] });
        context._fs.patch = async () => ({ ok: false, reason: 'validation_commit', hint: 'floor below log tail' });
        requestToolCallWithRetry.mockImplementation(async () => ({ segments: [{ quote_text: 'line one', speaker: 'Marta' }] }));
        const warnSpy = jest.spyOn(console, 'warn').mockImplementation(() => { });

        const first = await parseAndCacheAttribution(context, 0);
        expect(first.segments).toEqual([{ qIndex: 0, speaker: 'Marta' }]);
        expect(first.addedVoices).toEqual(['Marta']);
        expect(warnSpy).toHaveBeenCalledTimes(1);
        expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining('validation_commit'));

        await parseAndCacheAttribution(context, 0, { force: true });
        expect(warnSpy).toHaveBeenCalledTimes(1); // warnedMessages dedupes per message
        warnSpy.mockRestore();
    });
});
