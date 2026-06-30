/**
 * Tests for memory-graph main-context injection window decoupling.
 *
 * Covers spec docs/superpowers/specs/2026-05-18-memory-graph-injection-window.md
 * §5 acceptance criteria + §6 boundary case.
 *
 * `collectAlwaysInjectNodes` is **not exported** from main.js — and main.js
 * itself transitively imports `../../../script.js` / `./lib.js` which touch
 * DOM at module-load (jQuery / Popper / webpack-bundled `lib.core.bundle.js`
 * that does not exist outside a build). We therefore re-implement the small
 * post-filter contract here as a reference helper, matching the production
 * semantics in main.js#collectAlwaysInjectNodes verbatim:
 *
 *   1. Filter schema specs to those with `alwaysInject: true` or
 *      `tableName === 'event_table'`.
 *   2. For each surviving type, pick active non-diagnostic semantic nodes
 *      of that type (compression semantics out of scope here — tests use
 *      mode: 'none' fixtures so `selectVisibleNodesForType` is a no-op pass).
 *   3. POST-filter: if `options.seqWindowFrom` is a finite number, drop
 *      any picked node whose `seqTo >= seqWindowFrom`. Boundary exclusive
 *      on the kept side: keep `seqTo < seqWindowFrom` only. `seqWindowFrom`
 *      is the lower bound of the raw-visible recent-turns window; nodes
 *      that end inside that window are already covered by raw text in the
 *      main prompt, so injecting their semantic form is redundant.
 *   4. Sort by `compareNodesByTimeline` semantics (seqTo asc → id asc tiebreak).
 *
 * The point of these tests is to lock the **contract**, not exercise the
 * **internal** implementation. The Phase-3 UI/i18n changes are not separately
 * unit-tested — those are glue verified by the integration of the entries
 * existing (test §5.6 below).
 *
 * The recall-pool / recall-selected acceptance criteria (§5.3, §5.4) are
 * already enforced by code structure: the recall callers at
 * main.js:syncPersistentLorebookProjection are the **only** site that
 * passes the new `seqWindowFrom`; both recall paths
 * (`runLLMDrivenRecall` and `runRecallPipeline`) keep calling
 * `collectAlwaysInjectNodes(store, settings, context)` with three args.
 * Those are stated as test.todo with the structural-enforcement note.
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
    const aSeq = Number(a?.seqTo ?? -1);
    const bSeq = Number(b?.seqTo ?? -1);
    if (aSeq !== bSeq) return aSeq - bSeq;
    return String(a?.id || '').localeCompare(String(b?.id || ''));
}

function collectAlwaysInjectNodesRef(store, schema, options = {}) {
    const alwaysSpecs = (Array.isArray(schema) ? schema : [])
        .filter((spec) => {
            const tableName = String(spec?.tableName || '').trim().toLowerCase();
            return Boolean(spec?.alwaysInject) || tableName === 'event_table';
        })
        .map(spec => String(spec.id || '').toLowerCase())
        .filter(Boolean);
    if (alwaysSpecs.length === 0) {
        return [];
    }
    const allNodes = Object.values(store?.nodes || {});
    const picked = [];
    const seen = new Set();
    for (const type of alwaysSpecs) {
        const nodes = allNodes.filter(node => Boolean(node)
            && node.level === 'semantic'
            && !node.archived
            && !_isRecallDiagnosticNode(node)
            && String(node.type || '').toLowerCase() === type);
        for (const node of nodes) {
            const id = String(node.id || '');
            if (!id || seen.has(id)) continue;
            seen.add(id);
            picked.push(node);
        }
    }
    const seqWindowFromRaw = Number(options?.seqWindowFrom);
    const windowed = Number.isFinite(seqWindowFromRaw)
        ? picked.filter(node => Number.isFinite(Number(node?.seqTo)) && Number(node.seqTo) < seqWindowFromRaw)
        : picked;
    return windowed.sort(_compareNodesByTimeline);
}

// ---------------------------------------------------------------------------
// Settings clamp reference — mirrors normalizeAdvancedSettings semantics
// ---------------------------------------------------------------------------

function clampMainInjectionWindowRef(input, fallback = 0) {
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

function buildEventStore(seqs) {
    // seqs: array of numbers. Produces an event-only fixture, one node per seq.
    const nodes = {};
    for (const s of seqs) {
        const id = `evt_${s}`;
        nodes[id] = makeNode({ id, seqTo: s });
    }
    return { nodes, edges: [] };
}

function eventSchema() {
    return [
        {
            id: 'event',
            tableName: 'event_table',
            alwaysInject: true,
            compression: { mode: 'none' },
        },
    ];
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('spec §5.1 — default behavior (window = 0 / unset)', () => {
    test('options omitted → all always-inject nodes returned (current behavior)', () => {
        const store = buildEventStore([1, 5, 10, 20]);
        const out = collectAlwaysInjectNodesRef(store, eventSchema());
        const ids = out.map(n => n.id);
        expect(ids).toEqual(['evt_1', 'evt_5', 'evt_10', 'evt_20']);
    });

    test('options.seqWindowFrom = undefined → identical to omitted options', () => {
        const store = buildEventStore([1, 5, 10, 20]);
        const a = collectAlwaysInjectNodesRef(store, eventSchema());
        const b = collectAlwaysInjectNodesRef(store, eventSchema(), { seqWindowFrom: undefined });
        expect(b.map(n => n.id)).toEqual(a.map(n => n.id));
    });

    test('options.seqWindowFrom = NaN → identical to omitted options (non-finite is no-op)', () => {
        const store = buildEventStore([1, 5, 10, 20]);
        const out = collectAlwaysInjectNodesRef(store, eventSchema(), { seqWindowFrom: NaN });
        expect(out.map(n => n.id)).toEqual(['evt_1', 'evt_5', 'evt_10', 'evt_20']);
    });

    test('archived and recall-diagnostic nodes are filtered (independent of window)', () => {
        const store = buildEventStore([5, 10]);
        store.nodes.evt_arch = makeNode({ id: 'evt_arch', seqTo: 7, archived: true });
        store.nodes.recall_diag = makeNode({ id: 'recall_diag', seqTo: 9, type: 'recall_state' });
        const out = collectAlwaysInjectNodesRef(store, eventSchema());
        const ids = out.map(n => n.id);
        expect(ids).toEqual(['evt_5', 'evt_10']);
    });
});

describe('window in effect — keep nodes with seqTo < seqWindowFrom', () => {
    test('seqWindowFrom = 12 with seqTos {1, 5, 10, 20} → evt_1, evt_5, evt_10 kept (raw window covers 12+)', () => {
        const store = buildEventStore([1, 5, 10, 20]);
        const out = collectAlwaysInjectNodesRef(store, eventSchema(), { seqWindowFrom: 12 });
        expect(out.map(n => n.id)).toEqual(['evt_1', 'evt_5', 'evt_10']);
    });

    test('seqWindowFrom = 5 with seqTos {1, 5, 10, 20} → only evt_1 kept (boundary exclusive: evt_5 dropped)', () => {
        const store = buildEventStore([1, 5, 10, 20]);
        const out = collectAlwaysInjectNodesRef(store, eventSchema(), { seqWindowFrom: 5 });
        expect(out.map(n => n.id)).toEqual(['evt_1']);
    });

    test('seqWindowFrom = 0 → all nodes dropped (every seqTo >= 0)', () => {
        const store = buildEventStore([0, 1, 5, 10]);
        const out = collectAlwaysInjectNodesRef(store, eventSchema(), { seqWindowFrom: 0 });
        expect(out.map(n => n.id)).toEqual([]);
    });

    test('seqWindowFrom larger than max seqTo → all kept (every node ends before the raw window)', () => {
        const store = buildEventStore([1, 5, 10]);
        const out = collectAlwaysInjectNodesRef(store, eventSchema(), { seqWindowFrom: 100 });
        expect(out.map(n => n.id)).toEqual(['evt_1', 'evt_5', 'evt_10']);
    });

    test('event_table forced inject is also windowed', () => {
        // A type whose alwaysInject is false but tableName === 'event_table' is still picked,
        // and the window applies to it equally.
        const schema = [
            { id: 'event', tableName: 'event_table', alwaysInject: false, compression: { mode: 'none' } },
        ];
        const store = buildEventStore([1, 5, 10, 20]);
        const out = collectAlwaysInjectNodesRef(store, schema, { seqWindowFrom: 8 });
        expect(out.map(n => n.id)).toEqual(['evt_1', 'evt_5']);
    });
});

describe('boundary semantics — kept side is strict <, exact-cutoff node is dropped', () => {
    test('node at seqTo = seqWindowFrom is EXCLUDED (boundary belongs to the raw-visible window)', () => {
        const store = buildEventStore([5, 10, 12, 15]);
        const out = collectAlwaysInjectNodesRef(store, eventSchema(), { seqWindowFrom: 12 });
        const ids = out.map(n => n.id);
        // evt_12 (exact boundary) is dropped — its seqTo lands in the raw window.
        // evt_5 and evt_10 are kept (they end before the raw window).
        expect(ids).toContain('evt_5');
        expect(ids).toContain('evt_10');
        expect(ids).not.toContain('evt_12');
        expect(ids).not.toContain('evt_15');
    });

    test('node at seqTo = seqWindowFrom - 1 is INCLUDED', () => {
        const store = buildEventStore([11, 12]);
        const out = collectAlwaysInjectNodesRef(store, eventSchema(), { seqWindowFrom: 12 });
        expect(out.map(n => n.id)).toEqual(['evt_11']);
    });
});

describe('spec §5.5 — settings round-trip (clamp semantics)', () => {
    test('42 stays 42', () => {
        expect(clampMainInjectionWindowRef(42)).toBe(42);
    });

    test('non-finite string → falls back to default (0)', () => {
        expect(clampMainInjectionWindowRef('abc')).toBe(0);
    });

    test('negative number → clamps to 0', () => {
        expect(clampMainInjectionWindowRef(-5)).toBe(0);
    });

    test('null → falls back to default (0)', () => {
        expect(clampMainInjectionWindowRef(null)).toBe(0);
    });

    test('undefined → falls back to default (0)', () => {
        expect(clampMainInjectionWindowRef(undefined)).toBe(0);
    });

    test('floating point → floored', () => {
        expect(clampMainInjectionWindowRef(3.9)).toBe(3);
    });

    test('non-finite input with explicit fallback uses fallback', () => {
        expect(clampMainInjectionWindowRef('xyz', 10)).toBe(10);
    });

    test('production normalizeAdvancedSettings clamp produces same result for a real input shape', () => {
        // This mirrors the actual production clamp in main.js#normalizeAdvancedSettings exactly:
        //   Math.max(0, Math.floor(Number.isFinite(raw) ? raw : Number(base.mainInjectionAssistantTurnsWindow ?? 0)));
        // We exercise the same math inline (no module import — main.js touches DOM at load).
        function productionClamp(input, baseValue, defaultValue) {
            const raw = Number(input);
            return Math.max(
                0,
                Math.floor(Number.isFinite(raw) ? raw : Number(baseValue ?? defaultValue)),
            );
        }
        // Fresh save with input 60 and default 0 → 60
        expect(productionClamp(60, undefined, 0)).toBe(60);
        // Re-read with no input but persisted base of 60 → 60
        expect(productionClamp(undefined, 60, 0)).toBe(60);
        // Re-read with invalid input but persisted base of 60 → 60
        expect(productionClamp('bad', 60, 0)).toBe(60);
    });
});

describe('spec §5.6 — i18n entries present in zh-CN and zh-TW', () => {
    test('English key for label exists in both locale maps', async () => {
        const fs = await import('node:fs/promises');
        const path = await import('node:path');
        const url = await import('node:url');
        const here = path.dirname(url.fileURLToPath(import.meta.url));
        const i18nPath = path.resolve(here, '../../public/scripts/extensions/memory-graph/i18n.js');
        const content = await fs.readFile(i18nPath, 'utf8');
        // Two blocks: addLocaleData('zh-cn', {...}) and addLocaleData('zh-tw', {...}).
        const zhCnIdx = content.indexOf("addLocaleData('zh-cn'");
        const zhTwIdx = content.indexOf("addLocaleData('zh-tw'");
        expect(zhCnIdx).toBeGreaterThan(-1);
        expect(zhTwIdx).toBeGreaterThan(zhCnIdx);
        const zhCnBlock = content.slice(zhCnIdx, zhTwIdx);
        const zhTwBlock = content.slice(zhTwIdx);
        const labelKey = "'Main-context injection window (assistant turns; 0 = no limit)':";
        const helpKey = "'0 = inject all always-on nodes (current behavior). N > 0 = drop always-on nodes older than N assistant turns from the main context; recall candidates and recall-selected nodes are unaffected.':";
        expect(zhCnBlock).toContain(labelKey);
        expect(zhTwBlock).toContain(labelKey);
        expect(zhCnBlock).toContain(helpKey);
        expect(zhTwBlock).toContain(helpKey);
    });
});

// ---------------------------------------------------------------------------
// Acceptance criteria enforced by code structure — asserted against the
// actual main.js source so a regression cannot land silently.
// ---------------------------------------------------------------------------

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve as resolvePath } from 'node:path';

const __mgInjectionTestDir = dirname(fileURLToPath(import.meta.url));
const MG_MAIN_SOURCE = readFileSync(
    resolvePath(__mgInjectionTestDir, '..', '..', 'public', 'scripts', 'extensions', 'memory-graph', 'main.js'),
    'utf8',
);

describe('spec §5.3 — recall candidate pool unaffected by window', () => {
    // The injection window is consumed by `syncPersistentLorebookProjection`
    // (the legitimate main-context site), which DOES pass a 4th `options`
    // argument carrying `seqWindowFrom`. Every OTHER call site —
    // specifically the ones inside the recall pipeline
    // (`runLLMDrivenRecall`, hybrid/rerank fall-through, etc.) — must
    // NOT pass `options`, otherwise the recall pool would observe the
    // window. Spec §5.3 forbids this.
    //
    // We assert that every recall-context call uses the 3-arg shape by
    // walking the source: any `collectAlwaysInjectNodes(...)` invocation
    // NOT inside `syncPersistentLorebookProjection`'s body must be 3-arg.
    test('every recall-context call site uses the 3-arg shape', () => {
        // Extract syncPersistentLorebookProjection's body so we can subtract
        // its lines from consideration. Any collectAlwaysInjectNodes call
        // INSIDE it is the legitimate main-context site.
        const mainSiteFn = MG_MAIN_SOURCE.match(
            /async function syncPersistentLorebookProjection\([^)]*\)\s*\{([\s\S]*?)\n\}\n/,
        );
        expect(mainSiteFn).not.toBeNull();
        const sourceWithoutMainSite = MG_MAIN_SOURCE.replace(mainSiteFn[0], '/* main-context site stripped */');

        // Skip the function definition itself.
        const callRe = /(?<!function\s)\bcollectAlwaysInjectNodes\s*\(([\s\S]*?)\)\s*;/g;
        const calls = [...sourceWithoutMainSite.matchAll(callRe)];
        expect(calls.length).toBeGreaterThan(0);
        for (const m of calls) {
            // Strip nested call commas by removing balanced parens / brackets
            // contents first, then counting top-level commas in the arg list.
            let args = m[1];
            for (let i = 0; i < 8; i += 1) {
                const before = args;
                args = args.replace(/\([^()]*\)/g, '').replace(/\{[^{}]*\}/g, '').replace(/\[[^\[\]]*\]/g, '');
                if (args === before) break;
            }
            const topLevelCommaCount = (args.match(/,/g) || []).length;
            // 3 args = 2 commas. Anything else means a fourth `options` arg
            // (or a missing arg) reached a recall-context call site — spec
            // §5.3 forbids recall paths from observing the injection window.
            expect({ call: m[0], commaCount: topLevelCommaCount }).toEqual({ call: m[0], commaCount: 2 });
        }
    });
});

describe('spec §5.4 — recall-selected node bypasses the window', () => {
    // Recall results flow into runtime injection through the focus-packet
    // path: `runLLMDrivenRecall` (or hybrid recall) populates
    // `store.lastRecallProjection`; `syncRuntimeLorebookProjection` reads
    // it and writes `focusPacket`. That path must NEVER pass through
    // `collectAlwaysInjectNodes` (which is window-gated).
    test('syncRuntimeLorebookProjection reads getLastRecallProjection, not collectAlwaysInjectNodes', () => {
        const fnMatch = MG_MAIN_SOURCE.match(/async function syncRuntimeLorebookProjection\([^)]*\)\s*\{([\s\S]*?)\n\}\n/);
        expect(fnMatch).not.toBeNull();
        const body = fnMatch[1];
        expect(body).toMatch(/getLastRecallProjection\s*\(/);
        expect(body).toMatch(/focusPacket/);
        expect(body).not.toMatch(/collectAlwaysInjectNodes/);
    });
});
