/**
 * Tests for memory-graph persistent-injection recency horizon.
 *
 * A `persistentInjectionMaxSeqDistance` (N, default 0 = unlimited) setting
 * defines how many trailing assistant turns' worth of always-inject nodes
 * flow into the main-context lorebook projection. Nodes older than the
 * horizon (seqTo < latestSeq − N + 1) fall back to recall-only.
 *
 * This is a FLOOR-DISTANCE cutoff, not a count. K = 3 doesn't mean "keep 3
 * nodes per type"; it means "only inject nodes touched in the last 3
 * assistant turns". Applies uniformly to ALL always-inject types
 * INCLUDING latestOnly (character_sheet etc.) AND event_table: a latestOnly
 * entity not written to within the horizon becomes recall-only.
 *
 * `collectAlwaysInjectNodes` is not exported from main.js (main.js touches
 * DOM at module load). We mirror the small post-filter contract here as a
 * reference helper, matching production semantics verbatim.
 *
 * Structural assertions at the bottom pin the property that the recall
 * pipeline never observes `seqCutoffFrom`.
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

    // POST-filter 1: seqWindowFrom — drop nodes NEWER than window (latestOnly exempt)
    const seqWindowFromRaw = Number(options?.seqWindowFrom);
    const windowed = Number.isFinite(seqWindowFromRaw)
        ? picked.filter((node) => {
            const nodeType = String(node?.type || '').toLowerCase();
            if (latestOnlyTypes.has(nodeType)) return true;
            return Number.isFinite(Number(node?.seqTo)) && Number(node.seqTo) < seqWindowFromRaw;
        })
        : picked;

    // POST-filter 2: seqCutoffFrom — drop nodes OLDER than horizon (all types)
    const seqCutoffFromRaw = Number(options?.seqCutoffFrom);
    const capped = Number.isFinite(seqCutoffFromRaw)
        ? windowed.filter((node) => {
            const toSeq = Number(node?.seqTo);
            if (!Number.isFinite(toSeq)) return false;
            return toSeq >= seqCutoffFromRaw;
        })
        : windowed;

    return capped.sort(_compareNodesByTimeline);
}

// ---------------------------------------------------------------------------
// Settings clamp reference — mirrors normalizeAdvancedSettings
// ---------------------------------------------------------------------------

function clampPersistentInjectionMaxSeqDistanceRef(input, fallback = 0) {
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
// Tests: seqCutoffFrom semantics
// ---------------------------------------------------------------------------

describe('seqCutoffFrom unset / non-finite — full always-inject set', () => {
    test('options omitted → all always-inject nodes returned', () => {
        const out = collectAlwaysInjectNodesRef(buildMixedStore(), mixedSchema());
        const ids = out.map((n) => n.id);
        expect(ids).toEqual([
            'evt_1', 'rule_2', 'evt_3', 'sheet_4', 'rule_5', 'evt_7', 'rule_10', 'evt_11', 'sheet_12', 'evt_15',
        ]);
    });

    test('options.seqCutoffFrom = undefined → identical to omitted', () => {
        const a = collectAlwaysInjectNodesRef(buildMixedStore(), mixedSchema());
        const b = collectAlwaysInjectNodesRef(buildMixedStore(), mixedSchema(), { seqCutoffFrom: undefined });
        expect(b.map((n) => n.id)).toEqual(a.map((n) => n.id));
    });

    test('options.seqCutoffFrom = NaN → identical to omitted', () => {
        const a = collectAlwaysInjectNodesRef(buildMixedStore(), mixedSchema());
        const b = collectAlwaysInjectNodesRef(buildMixedStore(), mixedSchema(), { seqCutoffFrom: NaN });
        expect(b.map((n) => n.id)).toEqual(a.map((n) => n.id));
    });
});

describe('seqCutoffFrom finite — drop nodes with seqTo < cutoff (all types)', () => {
    test('seqCutoffFrom = 10 → keep only seqTo >= 10 across all types (including latestOnly)', () => {
        const out = collectAlwaysInjectNodesRef(buildMixedStore(), mixedSchema(), { seqCutoffFrom: 10 });
        const ids = out.map((n) => n.id);
        // Keep: rule_10 (10), evt_11 (11), sheet_12 (12), evt_15 (15).
        // Drop: sheet_4 (4 < 10) — latestOnly is NOT exempt from cutoff.
        expect(ids).toEqual(['rule_10', 'evt_11', 'sheet_12', 'evt_15']);
    });

    test('seqCutoffFrom = 12 → boundary inclusive on lower bound', () => {
        const out = collectAlwaysInjectNodesRef(buildMixedStore(), mixedSchema(), { seqCutoffFrom: 12 });
        const ids = out.map((n) => n.id);
        // Keep: sheet_12 (12 >= 12), evt_15 (15 >= 12). Drop rest.
        expect(ids).toEqual(['sheet_12', 'evt_15']);
    });

    test('seqCutoffFrom = 100 (larger than any node) → empty result', () => {
        const out = collectAlwaysInjectNodesRef(buildMixedStore(), mixedSchema(), { seqCutoffFrom: 100 });
        expect(out).toEqual([]);
    });

    test('seqCutoffFrom = 0 → keep everything (all seqTo >= 0)', () => {
        const out = collectAlwaysInjectNodesRef(buildMixedStore(), mixedSchema(), { seqCutoffFrom: 0 });
        const full = collectAlwaysInjectNodesRef(buildMixedStore(), mixedSchema());
        expect(out.map((n) => n.id)).toEqual(full.map((n) => n.id));
    });

    test('latestOnly types participate — old sheet is dropped even though it is current truth for its entity', () => {
        // Two character sheets updated at different floors. Cutoff drops the
        // older one — Carol has not been written to recently, so her sheet
        // becomes recall-only.
        const store = { nodes: {} };
        store.nodes.sheet_alice = makeNode({ id: 'sheet_alice', seqTo: 200, type: 'character_sheet' });
        store.nodes.sheet_bob = makeNode({ id: 'sheet_bob', seqTo: 150, type: 'character_sheet' });
        store.nodes.sheet_carol = makeNode({ id: 'sheet_carol', seqTo: 30, type: 'character_sheet' });
        const schema = [{ id: 'character_sheet', tableName: 'sheet_table', alwaysInject: true, latestOnly: true }];
        const out = collectAlwaysInjectNodesRef(store, schema, { seqCutoffFrom: 100 });
        expect(out.map((n) => n.id)).toEqual(['sheet_bob', 'sheet_alice']);
    });

    test('event_table participates in cutoff even if alwaysInject=false (forced by tableName)', () => {
        const schema = [
            { id: 'event', tableName: 'event_table', alwaysInject: false, latestOnly: false },
        ];
        const store = { nodes: {} };
        for (const s of [1, 2, 3, 4, 5]) store.nodes[`evt_${s}`] = makeNode({ id: `evt_${s}`, seqTo: s });
        const out = collectAlwaysInjectNodesRef(store, schema, { seqCutoffFrom: 4 });
        expect(out.map((n) => n.id)).toEqual(['evt_4', 'evt_5']);
    });

    test('nodes without seqTo are dropped when cutoff is finite (undefined seqTo cannot satisfy >= threshold)', () => {
        const store = { nodes: {} };
        store.nodes.evt_5 = makeNode({ id: 'evt_5', seqTo: 5 });
        store.nodes.evt_noseq = makeNode({ id: 'evt_noseq', seqTo: undefined });
        const schema = [{ id: 'event', tableName: 'event_table', alwaysInject: true, latestOnly: false }];
        const out = collectAlwaysInjectNodesRef(store, schema, { seqCutoffFrom: 3 });
        expect(out.map((n) => n.id)).toEqual(['evt_5']);
    });
});

describe('seqCutoffFrom composed with seqWindowFrom — both post-filters apply', () => {
    test('seqWindowFrom = 12 (drop new for non-latestOnly) + seqCutoffFrom = 5 (drop old for all)', () => {
        const out = collectAlwaysInjectNodesRef(
            buildMixedStore(),
            mixedSchema(),
            { seqWindowFrom: 12, seqCutoffFrom: 5 },
        );
        const ids = out.map((n) => n.id);
        // After seqWindowFrom=12 (non-latestOnly drop seqTo >= 12):
        //   event: {1,3,7,11}; world_constants: {2,5,10}; character_sheet: {4,12} (exempt)
        // After seqCutoffFrom=5 (drop seqTo < 5, all types):
        //   event: {7,11}; world_constants: {5,10}; character_sheet: {12}
        // Final asc: rule_5, evt_7, rule_10, evt_11, sheet_12
        expect(ids).toEqual(['rule_5', 'evt_7', 'rule_10', 'evt_11', 'sheet_12']);
    });

    test('seqCutoffFrom higher than seqWindowFrom → cutoff wins', () => {
        const out = collectAlwaysInjectNodesRef(
            buildMixedStore(),
            mixedSchema(),
            { seqWindowFrom: 6, seqCutoffFrom: 10 },
        );
        const ids = out.map((n) => n.id);
        // After window=6 (non-latestOnly keep seqTo < 6):
        //   event: {1,3}; world_constants: {2,5}; character_sheet: {4,12} (exempt)
        // After cutoff=10 (keep seqTo >= 10):
        //   event: {}; world_constants: {}; character_sheet: {12}
        expect(ids).toEqual(['sheet_12']);
    });
});

// ---------------------------------------------------------------------------
// Settings clamp
// ---------------------------------------------------------------------------

describe('persistentInjectionMaxSeqDistance settings clamp', () => {
    test('3 stays 3', () => {
        expect(clampPersistentInjectionMaxSeqDistanceRef(3)).toBe(3);
    });
    test('0 stays 0 (default)', () => {
        expect(clampPersistentInjectionMaxSeqDistanceRef(0)).toBe(0);
    });
    test('negative → 0', () => {
        expect(clampPersistentInjectionMaxSeqDistanceRef(-4)).toBe(0);
    });
    test('non-finite string → fallback (0)', () => {
        expect(clampPersistentInjectionMaxSeqDistanceRef('abc')).toBe(0);
    });
    test('null → fallback (0)', () => {
        expect(clampPersistentInjectionMaxSeqDistanceRef(null)).toBe(0);
    });
    test('floating point floored', () => {
        expect(clampPersistentInjectionMaxSeqDistanceRef(2.9)).toBe(2);
    });
    test('non-finite input with explicit fallback uses fallback', () => {
        expect(clampPersistentInjectionMaxSeqDistanceRef('xyz', 5)).toBe(5);
    });
});

// ---------------------------------------------------------------------------
// Structural assertions — recall pipeline must not observe seqCutoffFrom
// ---------------------------------------------------------------------------

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve as resolvePath } from 'node:path';

const __testDir = dirname(fileURLToPath(import.meta.url));
const MG_MAIN_SOURCE = readFileSync(
    resolvePath(__testDir, '..', '..', 'public', 'scripts', 'extensions', 'memory-graph', 'main.js'),
    'utf8',
);

describe('recall pipeline is unaffected by seqCutoffFrom (structural)', () => {
    test('only syncPersistentLorebookProjection references seqCutoffFrom', () => {
        const mainSiteFn = MG_MAIN_SOURCE.match(
            /async function syncPersistentLorebookProjection\([^)]*\)\s*\{([\s\S]*?)\n\}\n/,
        );
        expect(mainSiteFn).not.toBeNull();
        const mainSiteBody = mainSiteFn[1];
        // Main-context site must reference seqCutoffFrom.
        expect(mainSiteBody).toMatch(/seqCutoffFrom/);

        // No OTHER site in main.js should write seqCutoffFrom into a
        // collectAlwaysInjectNodes options object. The function's own
        // parameter destructuring / doc comment is fine — but no object-key
        // assignment outside the main-context body should appear.
        const sourceWithoutMainSite = MG_MAIN_SOURCE.replace(mainSiteFn[0], '/* main-context site stripped */');
        const stray = sourceWithoutMainSite.match(/\bseqCutoffFrom\s*:/g);
        expect(stray).toBeNull();
    });

    test('persistentInjectionMaxSeqDistance exists in defaultSettings', () => {
        expect(MG_MAIN_SOURCE).toMatch(/persistentInjectionMaxSeqDistance\s*:\s*0/);
    });

    test('ensureSettings clamps persistentInjectionMaxSeqDistance (Math.max(0, ...))', () => {
        expect(MG_MAIN_SOURCE).toMatch(
            /extension_settings\[MODULE_NAME\]\.persistentInjectionMaxSeqDistance\s*=\s*Math\.max\(\s*0/,
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
        const labelKey = "'Persistent injection recency horizon (assistant turns; 0 = no limit)':";
        const aboutKey = "'About Persistent injection recency horizon':";
        const helpKey = "'Persistent injection recency horizon help body':";
        for (const block of [zhCnBlock, zhTwBlock]) {
            expect(block).toContain(labelKey);
            expect(block).toContain(aboutKey);
            expect(block).toContain(helpKey);
        }
    });
});
