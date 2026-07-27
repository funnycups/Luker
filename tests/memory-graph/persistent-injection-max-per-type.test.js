/**
 * Tests for memory-graph persistent-injection per-type cap.
 *
 * A `persistentInjectionMaxPerType` (K, default 0 = unlimited) setting caps
 * the number of always-inject nodes per type that flow into the main-context
 * lorebook projection. Older siblings beyond K remain in the recall
 * candidate pool — they simply lose their persistent-injection status.
 *
 * `collectAlwaysInjectNodes` is not exported from main.js (main.js touches
 * DOM at module load). We mirror the small post-filter contract here as a
 * reference helper, matching production semantics in
 * public/scripts/extensions/memory-graph/main.js verbatim:
 *
 *   1. Filter schema specs to those with alwaysInject: true OR
 *      tableName === 'event_table'.
 *   2. Pick active non-diagnostic semantic nodes of each surviving type.
 *   3. POST-filter 1: if `options.seqWindowFrom` finite, drop nodes with
 *      seqTo >= seqWindowFrom (latestOnly types exempt).
 *   4. POST-filter 2 (NEW): if `options.maxPerType` > 0, bucket the survivors
 *      by type, sort each bucket by seqTo DESC (id ASC tiebreak), keep the
 *      first K of each. latestOnly types bypass the K cap.
 *   5. Sort by compareNodesByTimeline (seqTo asc → id asc tiebreak).
 *
 * The point of this test file is to lock the CONTRACT of the K cap, not
 * exercise the internal implementation. Structural assertions at the bottom
 * assert that the recall pipeline sites do NOT pass `maxPerType` (spec:
 * recall pool unaffected).
 */

import { describe, test, expect } from '@jest/globals';

// ---------------------------------------------------------------------------
// Reference implementation — mirrors main.js#collectAlwaysInjectNodes
// ---------------------------------------------------------------------------

function _isRecallDiagnosticNode(node) {
    const type = String(node?.type || '').trim().toLowerCase();
    return type === 'recall' || type.startsWith('recall_');
}

function _compareNodesByTimeline(a, b) {
    const aSeq = Number(a?.seqTo ?? Number.MAX_SAFE_INTEGER);
    const bSeq = Number(b?.seqTo ?? Number.MAX_SAFE_INTEGER);
    if (aSeq !== bSeq) return aSeq - bSeq;
    return String(a?.id || '').localeCompare(String(b?.id || ''));
}

function collectAlwaysInjectNodesRef(store, schema, options = {}) {
    const alwaysSpecsRaw = (Array.isArray(schema) ? schema : [])
        .filter((spec) => {
            const tableName = String(spec?.tableName || '').trim().toLowerCase();
            return Boolean(spec?.alwaysInject) || tableName === 'event_table';
        });
    const alwaysSpecs = alwaysSpecsRaw
        .map((spec) => ({
            type: String(spec.id || '').toLowerCase(),
            latestOnly: Boolean(spec?.latestOnly),
        }))
        .filter((s) => s.type);
    if (alwaysSpecs.length === 0) return [];

    const latestOnlyTypes = new Set(alwaysSpecs.filter((s) => s.latestOnly).map((s) => s.type));

    const allNodes = Object.values(store?.nodes || {});
    const picked = [];
    const seen = new Set();
    for (const spec of alwaysSpecs) {
        const nodes = allNodes.filter((node) => Boolean(node)
            && node.level === 'semantic'
            && !node.archived
            && !_isRecallDiagnosticNode(node)
            && String(node.type || '').toLowerCase() === spec.type);
        for (const node of nodes) {
            const id = String(node.id || '');
            if (!id || seen.has(id)) continue;
            seen.add(id);
            picked.push(node);
        }
    }

    // POST-filter 1: seqWindowFrom
    const seqWindowFromRaw = Number(options?.seqWindowFrom);
    const windowed = Number.isFinite(seqWindowFromRaw)
        ? picked.filter((node) => {
            const nodeType = String(node?.type || '').toLowerCase();
            if (latestOnlyTypes.has(nodeType)) return true;
            return Number.isFinite(Number(node?.seqTo)) && Number(node.seqTo) < seqWindowFromRaw;
        })
        : picked;

    // POST-filter 2: maxPerType top-K per type
    const maxPerTypeRaw = Number(options?.maxPerType);
    const maxPerType = Number.isFinite(maxPerTypeRaw) && maxPerTypeRaw > 0 ? Math.floor(maxPerTypeRaw) : 0;
    let capped = windowed;
    if (maxPerType > 0) {
        const byType = new Map();
        for (const node of windowed) {
            const t = String(node?.type || '').toLowerCase();
            if (!byType.has(t)) byType.set(t, []);
            byType.get(t).push(node);
        }
        const kept = [];
        for (const [t, nodes] of byType.entries()) {
            if (latestOnlyTypes.has(t)) {
                for (const n of nodes) kept.push(n);
                continue;
            }
            const sorted = nodes.slice().sort((a, b) => {
                const aTo = Number.isFinite(Number(a?.seqTo)) ? Number(a.seqTo) : -Infinity;
                const bTo = Number.isFinite(Number(b?.seqTo)) ? Number(b.seqTo) : -Infinity;
                if (aTo !== bTo) return bTo - aTo;
                return String(a?.id || '').localeCompare(String(b?.id || ''));
            });
            for (let i = 0; i < Math.min(maxPerType, sorted.length); i += 1) {
                kept.push(sorted[i]);
            }
        }
        capped = kept;
    }

    return capped.sort(_compareNodesByTimeline);
}

// ---------------------------------------------------------------------------
// Settings clamp reference — mirrors normalizeAdvancedSettings semantics
// ---------------------------------------------------------------------------

function clampPersistentInjectionMaxPerTypeRef(input, fallback = 0) {
    const raw = Number(input);
    return Math.max(
        0,
        Math.floor(Number.isFinite(raw) ? raw : Number(fallback ?? 0)),
    );
}

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

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

function buildMixedStore() {
    // 5 events, 3 rules (world_constants), 2 character_sheets (latestOnly),
    // 1 archived event, 1 recall diagnostic node.
    const nodes = {};
    for (const s of [1, 3, 7, 11, 15]) nodes[`evt_${s}`] = makeNode({ id: `evt_${s}`, seqTo: s, type: 'event' });
    for (const s of [2, 5, 10]) nodes[`rule_${s}`] = makeNode({ id: `rule_${s}`, seqTo: s, type: 'world_constants' });
    for (const s of [4, 12]) nodes[`sheet_${s}`] = makeNode({ id: `sheet_${s}`, seqTo: s, type: 'character_sheet' });
    nodes.evt_arch = makeNode({ id: 'evt_arch', seqTo: 6, type: 'event', archived: true });
    nodes.recall_state = makeNode({ id: 'recall_state', seqTo: 9, type: 'recall_state' });
    return { nodes, edges: [] };
}

function mixedSchema() {
    return [
        { id: 'event', tableName: 'event_table', alwaysInject: true, latestOnly: false },
        { id: 'world_constants', tableName: 'constants_table', alwaysInject: true, latestOnly: false },
        { id: 'character_sheet', tableName: 'sheet_table', alwaysInject: true, latestOnly: true },
    ];
}

// ---------------------------------------------------------------------------
// Tests: maxPerType semantics
// ---------------------------------------------------------------------------

describe('maxPerType default (0 / unset) — full always-inject set', () => {
    test('options omitted → all always-inject nodes returned', () => {
        const out = collectAlwaysInjectNodesRef(buildMixedStore(), mixedSchema());
        const ids = out.map((n) => n.id);
        // seqTo ascending: rule_2, evt_3, sheet_4, rule_5, evt_7, rule_10, evt_11, sheet_12, evt_15, plus evt_1
        expect(ids).toEqual([
            'evt_1', 'rule_2', 'evt_3', 'sheet_4', 'rule_5', 'evt_7', 'rule_10', 'evt_11', 'sheet_12', 'evt_15',
        ]);
    });

    test('options.maxPerType = 0 → identical to omitted', () => {
        const a = collectAlwaysInjectNodesRef(buildMixedStore(), mixedSchema());
        const b = collectAlwaysInjectNodesRef(buildMixedStore(), mixedSchema(), { maxPerType: 0 });
        expect(b.map((n) => n.id)).toEqual(a.map((n) => n.id));
    });

    test('options.maxPerType = undefined → identical to omitted', () => {
        const a = collectAlwaysInjectNodesRef(buildMixedStore(), mixedSchema());
        const b = collectAlwaysInjectNodesRef(buildMixedStore(), mixedSchema(), { maxPerType: undefined });
        expect(b.map((n) => n.id)).toEqual(a.map((n) => n.id));
    });

    test('options.maxPerType = NaN → identical to omitted', () => {
        const a = collectAlwaysInjectNodesRef(buildMixedStore(), mixedSchema());
        const b = collectAlwaysInjectNodesRef(buildMixedStore(), mixedSchema(), { maxPerType: NaN });
        expect(b.map((n) => n.id)).toEqual(a.map((n) => n.id));
    });

    test('options.maxPerType negative → treated as unlimited (clamp to 0)', () => {
        const a = collectAlwaysInjectNodesRef(buildMixedStore(), mixedSchema());
        const b = collectAlwaysInjectNodesRef(buildMixedStore(), mixedSchema(), { maxPerType: -3 });
        expect(b.map((n) => n.id)).toEqual(a.map((n) => n.id));
    });
});

describe('maxPerType > 0 — per-type top-K by seqTo desc', () => {
    test('K = 2 → each non-latestOnly type keeps 2 most recent; latestOnly type keeps all its picks', () => {
        const out = collectAlwaysInjectNodesRef(buildMixedStore(), mixedSchema(), { maxPerType: 2 });
        const ids = out.map((n) => n.id);
        // event: {1,3,7,11,15} → keep 15, 11
        // world_constants: {2,5,10} → keep 10, 5
        // character_sheet (latestOnly): {4, 12} → keep both (bypass K)
        // Final sort ascending by seqTo: rule_5, evt_11, sheet_4, rule_10, sheet_12, evt_15
        expect(ids).toEqual(['sheet_4', 'rule_5', 'rule_10', 'evt_11', 'sheet_12', 'evt_15']);
    });

    test('K = 1 → each non-latestOnly type keeps only its most recent', () => {
        const out = collectAlwaysInjectNodesRef(buildMixedStore(), mixedSchema(), { maxPerType: 1 });
        const ids = out.map((n) => n.id);
        // event: 15; world_constants: 10; character_sheet: both (exempt)
        expect(ids).toEqual(['sheet_4', 'rule_10', 'sheet_12', 'evt_15']);
    });

    test('K larger than any bucket → no drops', () => {
        const out = collectAlwaysInjectNodesRef(buildMixedStore(), mixedSchema(), { maxPerType: 100 });
        const full = collectAlwaysInjectNodesRef(buildMixedStore(), mixedSchema());
        expect(out.map((n) => n.id)).toEqual(full.map((n) => n.id));
    });

    test('event_table participates in K even if alwaysInject=false (forced by tableName)', () => {
        const schema = [
            { id: 'event', tableName: 'event_table', alwaysInject: false, latestOnly: false },
        ];
        const store = { nodes: {} };
        for (const s of [1, 2, 3, 4, 5]) store.nodes[`evt_${s}`] = makeNode({ id: `evt_${s}`, seqTo: s });
        const out = collectAlwaysInjectNodesRef(store, schema, { maxPerType: 2 });
        expect(out.map((n) => n.id)).toEqual(['evt_4', 'evt_5']);
    });

    test('floating point K is floored', () => {
        // K = 2.9 → floor to 2
        const out = collectAlwaysInjectNodesRef(buildMixedStore(), mixedSchema(), { maxPerType: 2.9 });
        const eventIds = out.filter((n) => n.type === 'event').map((n) => n.id);
        expect(eventIds).toEqual(['evt_11', 'evt_15']);
    });

    test('id-asc tiebreak when seqTo equal', () => {
        const store = { nodes: {} };
        // Same seqTo=5 across a,b,c. K=2 → keep a, b (asc); drop c.
        store.nodes.evt_a = makeNode({ id: 'evt_a', seqTo: 5 });
        store.nodes.evt_b = makeNode({ id: 'evt_b', seqTo: 5 });
        store.nodes.evt_c = makeNode({ id: 'evt_c', seqTo: 5 });
        store.nodes.evt_old = makeNode({ id: 'evt_old', seqTo: 1 });
        const schema = [{ id: 'event', tableName: 'event_table', alwaysInject: true, latestOnly: false }];
        const out = collectAlwaysInjectNodesRef(store, schema, { maxPerType: 2 });
        const ids = out.map((n) => n.id);
        // Bucket sort: [evt_a(5), evt_b(5), evt_c(5), evt_old(1)] → keep first 2 = evt_a, evt_b
        expect(ids).toEqual(['evt_a', 'evt_b']);
    });

    test('nodes without seqTo sort to the back of the DESC bucket (dropped first when K limits)', () => {
        const store = { nodes: {} };
        store.nodes.evt_5 = makeNode({ id: 'evt_5', seqTo: 5 });
        store.nodes.evt_3 = makeNode({ id: 'evt_3', seqTo: 3 });
        store.nodes.evt_noseq = makeNode({ id: 'evt_noseq', seqTo: undefined });
        const schema = [{ id: 'event', tableName: 'event_table', alwaysInject: true, latestOnly: false }];
        const out = collectAlwaysInjectNodesRef(store, schema, { maxPerType: 2 });
        // Bucket sort desc treats missing seqTo as -Infinity → last. K=2 keeps evt_5, evt_3.
        expect(out.map((n) => n.id)).toEqual(['evt_3', 'evt_5']);
    });
});

describe('maxPerType composed with seqWindowFrom — window applies FIRST, then K', () => {
    test('seqWindowFrom = 10 (drops seqTo >= 10 for non-latestOnly) then K = 2', () => {
        const out = collectAlwaysInjectNodesRef(
            buildMixedStore(),
            mixedSchema(),
            { seqWindowFrom: 10, maxPerType: 2 },
        );
        const ids = out.map((n) => n.id);
        // After seqWindowFrom=10:
        //   event: {1,3,7} (11, 15 dropped by window); world_constants: {2, 5} (10 dropped);
        //   character_sheet (latestOnly): {4, 12} (both exempt from window)
        // After K=2:
        //   event: {7, 3}; world_constants: {5, 2}; character_sheet: {4, 12} (K exempt)
        // Final asc sort: rule_2, evt_3, sheet_4, rule_5, evt_7, sheet_12
        expect(ids).toEqual(['rule_2', 'evt_3', 'sheet_4', 'rule_5', 'evt_7', 'sheet_12']);
    });

    test('seqWindowFrom drops everything → K has nothing to work on', () => {
        const out = collectAlwaysInjectNodesRef(
            buildMixedStore(),
            [{ id: 'event', tableName: 'event_table', alwaysInject: true, latestOnly: false }],
            { seqWindowFrom: 0, maxPerType: 3 },
        );
        expect(out).toEqual([]);
    });
});

describe('latestOnly types bypass the K cap unconditionally', () => {
    test('character_sheet with 5 picks and K=2 still keeps all 5', () => {
        const store = { nodes: {} };
        for (const s of [1, 2, 3, 4, 5]) store.nodes[`sheet_${s}`] = makeNode({ id: `sheet_${s}`, seqTo: s, type: 'character_sheet' });
        const schema = [{ id: 'character_sheet', tableName: 'sheet_table', alwaysInject: true, latestOnly: true }];
        const out = collectAlwaysInjectNodesRef(store, schema, { maxPerType: 2 });
        expect(out.map((n) => n.id)).toEqual(['sheet_1', 'sheet_2', 'sheet_3', 'sheet_4', 'sheet_5']);
    });
});

// ---------------------------------------------------------------------------
// Settings clamp
// ---------------------------------------------------------------------------

describe('persistentInjectionMaxPerType settings clamp (matches normalizeAdvancedSettings)', () => {
    test('3 stays 3', () => {
        expect(clampPersistentInjectionMaxPerTypeRef(3)).toBe(3);
    });
    test('0 stays 0 (default)', () => {
        expect(clampPersistentInjectionMaxPerTypeRef(0)).toBe(0);
    });
    test('negative → 0', () => {
        expect(clampPersistentInjectionMaxPerTypeRef(-4)).toBe(0);
    });
    test('non-finite string → fallback (0)', () => {
        expect(clampPersistentInjectionMaxPerTypeRef('abc')).toBe(0);
    });
    test('null → fallback (0)', () => {
        expect(clampPersistentInjectionMaxPerTypeRef(null)).toBe(0);
    });
    test('floating point floored', () => {
        expect(clampPersistentInjectionMaxPerTypeRef(2.9)).toBe(2);
    });
    test('non-finite input with explicit fallback uses fallback', () => {
        expect(clampPersistentInjectionMaxPerTypeRef('xyz', 5)).toBe(5);
    });
});

// ---------------------------------------------------------------------------
// Structural assertions against the actual main.js source — recall pipeline
// sites must NOT pass maxPerType, only syncPersistentLorebookProjection does.
// ---------------------------------------------------------------------------

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve as resolvePath } from 'node:path';

const __testDir = dirname(fileURLToPath(import.meta.url));
const MG_MAIN_SOURCE = readFileSync(
    resolvePath(__testDir, '..', '..', 'public', 'scripts', 'extensions', 'memory-graph', 'main.js'),
    'utf8',
);

describe('recall pipeline is unaffected by maxPerType (structural)', () => {
    test('only syncPersistentLorebookProjection references maxPerType', () => {
        // Grab syncPersistentLorebookProjection body.
        const mainSiteFn = MG_MAIN_SOURCE.match(
            /async function syncPersistentLorebookProjection\([^)]*\)\s*\{([\s\S]*?)\n\}\n/,
        );
        expect(mainSiteFn).not.toBeNull();
        const mainSiteBody = mainSiteFn[1];
        // The main-context site must reference maxPerType (that's the whole
        // point of this feature landing).
        expect(mainSiteBody).toMatch(/maxPerType/);

        // Now assert no OTHER site in main.js writes `maxPerType` into
        // a collectAlwaysInjectNodes options object. Strip the main-context
        // fn body, then search for the literal `maxPerType` — should not
        // appear as an object-key assignment elsewhere.
        const sourceWithoutMainSite = MG_MAIN_SOURCE.replace(mainSiteFn[0], '/* main-context site stripped */');
        const stray = sourceWithoutMainSite.match(/\bmaxPerType\s*:/g);
        // Ref implementation is in test file, not main.js. Any hit here is
        // a stray in main.js itself.
        expect(stray).toBeNull();
    });

    test('persistentInjectionMaxPerType exists in defaultSettings', () => {
        expect(MG_MAIN_SOURCE).toMatch(/persistentInjectionMaxPerType\s*:\s*0/);
    });

    test('ensureSettings clamps persistentInjectionMaxPerType (Math.max(0, ...))', () => {
        // Look for the ensureSettings assignment that clamps to non-negative int.
        expect(MG_MAIN_SOURCE).toMatch(
            /extension_settings\[MODULE_NAME\]\.persistentInjectionMaxPerType\s*=\s*Math\.max\(\s*0/,
        );
    });
});

describe('i18n coverage — new label + help entries present in zh-CN and zh-TW', () => {
    test('English keys exist in both locale maps', async () => {
        const fs = await import('node:fs/promises');
        const path = await import('node:path');
        const url = await import('node:url');
        const here = path.dirname(url.fileURLToPath(import.meta.url));
        const i18nPath = path.resolve(here, '../../public/scripts/extensions/memory-graph/i18n.js');
        const content = await fs.readFile(i18nPath, 'utf8');
        const zhCnIdx = content.indexOf("addLocaleData('zh-cn'");
        const zhTwIdx = content.indexOf("addLocaleData('zh-tw'");
        expect(zhCnIdx).toBeGreaterThan(-1);
        expect(zhTwIdx).toBeGreaterThan(zhCnIdx);
        const zhCnBlock = content.slice(zhCnIdx, zhTwIdx);
        const zhTwBlock = content.slice(zhTwIdx);
        const labelKey = "'Persistent injection: keep only latest K per type (0 = no limit)':";
        const aboutKey = "'About Persistent injection max per type':";
        const helpKey = "'Persistent injection max per type help body':";
        for (const block of [zhCnBlock, zhTwBlock]) {
            expect(block).toContain(labelKey);
            expect(block).toContain(aboutKey);
            expect(block).toContain(helpKey);
        }
    });
});
