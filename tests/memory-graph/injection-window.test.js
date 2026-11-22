/**
 * Regression tests confirming recent-window suppression (`recentRawTurns` /
 * `seqWindowFrom`) has been completely removed from persistent injection and
 * recall candidate collection, while `seqCutoffFrom` (recency horizon) stays
 * intact.
 */

import { describe, test, expect, beforeAll } from '@jest/globals';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve as resolvePath } from 'node:path';
import './_mocks/main-module-stack.js';

const __dir = dirname(fileURLToPath(import.meta.url));
const MG_MAIN_SOURCE = readFileSync(
    resolvePath(__dir, '..', '..', 'public', 'scripts', 'extensions', 'memory-graph', 'main.js'),
    'utf8',
);

function makeNode({ id, seqTo, type = 'event', level = 'semantic', archived = false }) {
    return {
        id,
        type,
        level,
        seqTo,
        archived,
        title: id,
        fields: {},
        parentId: '',
        childrenIds: [],
        semanticRollup: false,
        semanticDepth: 0,
    };
}

describe('collectAlwaysInjectNodes — recent-window suppression removed', () => {
    let collectAlwaysInjectNodes;
    let collectRootCandidates;

    beforeAll(async () => {
        const mainMod = await import('../../public/scripts/extensions/memory-graph/main.js');
        collectAlwaysInjectNodes = mainMod.collectAlwaysInjectNodes;
        collectRootCandidates = mainMod.collectRootCandidates;
    });

    test('never drops newest events even when legacy seqWindowFrom or recentRawTurns is supplied', () => {
        const store = {
            nodes: {
                evt_old: makeNode({ id: 'evt_old', seqTo: 1 }),
                evt_new: makeNode({ id: 'evt_new', seqTo: 14 }),
            },
            edges: [],
            appliedSeqTo: 15,
            loggedSeqTo: 0,
        };
        const settings = {
            recentRawTurns: 5,
            nodeTypeSchema: [
                {
                    id: 'event',
                    tableName: 'event_table',
                    alwaysInject: true,
                    latestOnly: false,
                    compression: { mode: 'none' },
                },
            ],
        };

        const out = collectAlwaysInjectNodes(store, settings, null, { seqWindowFrom: 10 });
        expect(out.map((n) => n.id)).toEqual(['evt_old', 'evt_new']);
    });

    test('still enforces seqCutoffFrom (persistentInjectionMaxSeqDistance horizon)', () => {
        const store = {
            nodes: {
                evt_old: makeNode({ id: 'evt_old', seqTo: 1 }),
                evt_recent: makeNode({ id: 'evt_recent', seqTo: 14 }),
            },
            edges: [],
            appliedSeqTo: 15,
            loggedSeqTo: 0,
        };
        const settings = {
            nodeTypeSchema: [
                {
                    id: 'event',
                    tableName: 'event_table',
                    alwaysInject: true,
                    latestOnly: false,
                    compression: { mode: 'none' },
                },
            ],
        };

        const out = collectAlwaysInjectNodes(store, settings, null, { seqCutoffFrom: 10 });
        expect(out.map((n) => n.id)).toEqual(['evt_recent']);
    });

    test('collectRootCandidates retains freshly updated character_sheet nodes (no recent exclusion)', () => {
        const store = {
            nodes: {
                char_alice: makeNode({ id: 'char_alice', type: 'character_sheet', seqTo: 15 }),
                evt_old: makeNode({ id: 'evt_old', type: 'event', seqTo: 1 }),
            },
            edges: [],
            appliedSeqTo: 15,
            loggedSeqTo: 0,
        };
        const settings = {
            nodeTypeSchema: [
                { id: 'character_sheet', tableName: 'character_table', alwaysInject: false, latestOnly: true, compression: { mode: 'none' } },
                { id: 'event', tableName: 'event_table', alwaysInject: true, latestOnly: false, compression: { mode: 'none' } },
            ],
        };

        const out = collectRootCandidates(store, settings, { fullText: '' }, [], null, { latestSeqIndex: 15, excludeMessages: 2 });
        expect(out.map((n) => n.id)).toContain('char_alice');
    });

    test('syncRuntimeLorebookProjection reads getLastRecallProjection, not collectAlwaysInjectNodes', () => {
        const fnMatch = MG_MAIN_SOURCE.match(/async function syncRuntimeLorebookProjection\([^)]*\)\s*\{([\s\S]*?)\n\}\n/);
        expect(fnMatch).not.toBeNull();
        const body = fnMatch[1];
        expect(body).toMatch(/getLastRecallProjection\s*\(/);
        expect(body).toMatch(/focusPacket/);
        expect(body).not.toMatch(/collectAlwaysInjectNodes/);
    });
});
