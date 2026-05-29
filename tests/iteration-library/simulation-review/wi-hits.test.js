import { extractWorldInfoHitsFromRuntime } from '../../../public/scripts/iteration-library/simulation-review/wi-hits.js';

describe('extractWorldInfoHitsFromRuntime', () => {
    test('extracts hits from activatedEntries[] when present', () => {
        const runtime = {
            // Legacy buckets should be IGNORED when activatedEntries[] is present.
            worldInfoBeforeEntries: ['ignored-pre-formatted-text'],
            activatedEntries: [
                { world: 'City Lore', comment: 'Geography', uid: 'g1', position: 4, depth: 4, role: 0 },
                { world: 'NPC Sheets', comment: 'NPC Alice', uid: 'a1', position: 0 },
                { world: 'Notes', comment: 'AN top', uid: 'n1', position: 2 },
            ],
        };
        const hits = extractWorldInfoHitsFromRuntime(runtime);
        expect(hits).toEqual([
            { book: 'City Lore', entry: 'Geography', comment: 'Geography', position: 'depth-4/system' },
            { book: 'NPC Sheets', entry: 'NPC Alice', comment: 'NPC Alice', position: 'before-char' },
            { book: 'Notes', entry: 'AN top', comment: 'AN top', position: 'AN-top' },
        ]);
    });

    test('normalizes numeric roles into system/user/assistant labels', () => {
        const runtime = {
            activatedEntries: [
                { world: 'Book', comment: 'sys', position: 4, depth: 0, role: 0 },
                { world: 'Book', comment: 'user', position: 4, depth: 1, role: 1 },
                { world: 'Book', comment: 'asst', position: 4, depth: 2, role: 2 },
            ],
        };
        const hits = extractWorldInfoHitsFromRuntime(runtime);
        expect(hits.map(h => h.position)).toEqual([
            'depth-0/system',
            'depth-1/user',
            'depth-2/assistant',
        ]);
    });

    test('labels every world_info_position bucket', () => {
        const runtime = {
            activatedEntries: [
                { world: 'B', comment: 'before', position: 0 },
                { world: 'B', comment: 'after', position: 1 },
                { world: 'B', comment: 'antop', position: 2 },
                { world: 'B', comment: 'anbot', position: 3 },
                { world: 'B', comment: 'depth', position: 4, depth: 7, role: 1 },
                { world: 'B', comment: 'emtop', position: 5 },
                { world: 'B', comment: 'embot', position: 6 },
                { world: 'B', comment: 'outlet', position: 7, outletName: 'recap' },
            ],
        };
        const hits = extractWorldInfoHitsFromRuntime(runtime);
        expect(hits.map(h => h.position)).toEqual([
            'before-char',
            'after-char',
            'AN-top',
            'AN-bottom',
            'depth-7/user',
            'EM-top',
            'EM-bottom',
            'outlet/recap',
        ]);
    });

    test('falls back to legacy pre-formatted strings when activatedEntries[] absent', () => {
        const runtime = {
            worldInfoBeforeEntries: ['City lore text'],
            worldInfoAfterEntries: ['After block'],
            worldInfoDepth: [{ depth: 4, role: 'assistant', entries: ['NPC alice text'] }],
        };
        const hits = extractWorldInfoHitsFromRuntime(runtime);
        expect(hits).toHaveLength(3);
        expect(hits[0]).toEqual({ book: '', entry: 'City lore text', comment: '', position: 'before-char' });
        expect(hits[1]).toEqual({ book: '', entry: 'After block', comment: '', position: 'after-char' });
        expect(hits[2]).toEqual({ book: '', entry: 'NPC alice text', comment: '', position: 'depth-4/assistant' });
    });

    test('falls back to legacy strings when activatedEntries[] is an empty array', () => {
        const runtime = {
            worldInfoBeforeEntries: ['Some text'],
            activatedEntries: [],
        };
        const hits = extractWorldInfoHitsFromRuntime(runtime);
        expect(hits).toEqual([
            { book: '', entry: 'Some text', comment: '', position: 'before-char' },
        ]);
    });

    test('skips empty / non-object entries gracefully', () => {
        const runtime = {
            activatedEntries: [
                null,
                undefined,
                'not an object',
                { world: 'Real', comment: 'real entry', position: 0 },
            ],
        };
        const hits = extractWorldInfoHitsFromRuntime(runtime);
        expect(hits).toEqual([
            { book: 'Real', entry: 'real entry', comment: 'real entry', position: 'before-char' },
        ]);
    });

    test('skips empty pre-formatted strings in legacy fallback', () => {
        const runtime = {
            worldInfoBeforeEntries: ['', '   ', 'real entry'],
            worldInfoDepth: [{ depth: 0, role: 0, entries: ['', 'real depth'] }],
        };
        const hits = extractWorldInfoHitsFromRuntime(runtime);
        expect(hits).toEqual([
            { book: '', entry: 'real entry', comment: '', position: 'before-char' },
            { book: '', entry: 'real depth', comment: '', position: 'depth-0/system' },
        ]);
    });

    test('handles null / undefined / non-object input', () => {
        expect(extractWorldInfoHitsFromRuntime(null)).toEqual([]);
        expect(extractWorldInfoHitsFromRuntime(undefined)).toEqual([]);
        expect(extractWorldInfoHitsFromRuntime('not an object')).toEqual([]);
        expect(extractWorldInfoHitsFromRuntime(42)).toEqual([]);
    });
});
