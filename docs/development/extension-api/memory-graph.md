# Memory Graph Read-Only API

> Status: experimental (subject to breaking changes for 2-3 minor versions per spec §9)
>
> Entry point: `getMemoryGraphReadApi(context)` from `public/scripts/extensions/memory-graph/read-api.js`

## Overview

The memory-graph extension drives Luker's long-term recall by feeding a curated pool of nodes (`character_sheet`, `event`, `relationship`, ...) plus a per-node `edge_summary` to a "route" LLM that picks which memories to inject into the next turn. The native pipeline (`chooseRecallRoute` / `collectRootCandidates` in `main.js`) constructs that LLM input from internal helpers — `buildProjectedEdges`, `getNearestVisibleAncestorId`, `formatNodeBrief`, etc. — which were all private until now.

`getMemoryGraphReadApi(context)` exposes the same data, topology, and recall primitives as a frozen, caller-safe API surface. The intended consumer is an agent-style plugin that wants to run its own LLM-driven recall — for example the orchestrator's `memory_scout` sub-agent — with whatever model / preset its operator prefers, against the exact same candidate pool and field projection the native router sees.

The API is strictly read-only:

- Returned views are deep-frozen plain objects / arrays / Sets. The factory never returns store-internal references.
- There is no write path: nodes, edges, and schema mutations remain owned by `extractionInstructions` tool calls and the memory-graph runtime.
- Views are synthesised per call from the live store, so a single API instance stays valid across chat / character switches.

## Quick Start

```js
import { getMemoryGraphReadApi } from '/scripts/extensions/memory-graph/read-api.js';

const api = getMemoryGraphReadApi(Luker.getContext());

// Enumerate the visible candidate pool the native recall LLM sees.
const candidates = api.listVisibleCandidates();

// Get a brief for one node — id, summary, edge_summary, exposure, always_inject.
const brief = api.getNodeBrief(candidates[0].id);

// Observe injection state changes.
const unsubscribe = api.onInjectionChanged(state => {
    console.log('injection changed', state.alwaysInjectIds.size, state.recallSelectedIds.size);
});
```

## Type Reference

All interfaces are returned as deep-frozen plain objects (and frozen `Set` wrappers where annotated `ReadonlySet`). Field semantics mirror spec §4.1.

### NodeView

```ts
interface NodeView {
    id: string;
    type: string;                     // 'event' / 'character_sheet' / ...
    level: 'episodic' | 'semantic';
    title: string;
    fields: Readonly<Record<string, unknown>>; // tableColumns row payload
    seqTo: number;
    parentId: string;                 // '' when no parent
    childrenIds: ReadonlyArray<string>;
    archived: boolean;
    semanticRollup: boolean;
    semanticDepth: number;
}
```

The canonical view of a single node. `fields` is the row payload aligned with the schema's `tableColumns`; values can be strings, numbers, or arrays depending on the column definition.

### EdgeView

```ts
interface EdgeView {
    from: string;
    to: string;
    type: string;                     // 'related' / 'mentions' / 'contains' / 'semantic_contains' / ...
    weight?: number;                  // present only on projectEdges() output
}
```

A directed relation between two nodes. Raw edges (`listEdges`, `getNeighbors`) never carry `weight`; projected edges (`projectEdges`) carry the aggregated weight from collapsing same-source-same-direction edges.

### NeighborView

```ts
interface NeighborView {
    node: NodeView;
    edgeType: string;
    direction: 'in' | 'out';
}
```

A neighbour as seen from a specific source node. `direction` is relative to the source: `'out'` means an edge `source -> neighbor`; `'in'` means `neighbor -> source`.

### EdgeSummaryView

```ts
interface EdgeSummaryView {
    degree: number;
    relations: ReadonlyArray<{ relation: string; direction: 'in' | 'out'; count: number }>;
    sample_neighbors: ReadonlyArray<{ id: string; type: string; title: string }>;
}
```

The compact edge view the native recall LLM sees per candidate row. Counts are aggregated per `(relation, direction)` pair; `sample_neighbors` is a bounded sample (default 8) of distinct neighbour nodes. Field names are snake_case to match the native LLM prompt block.

### ScoredNodeView

```ts
interface ScoredNodeView extends NodeView {
    score: number;
    scoreMode: 'recency' | 'vector' | 'keyword' | 'hybrid';
}
```

A `NodeView` augmented with the score and the mode that produced it. `scoreMode` reflects the *actual* mode used after fallback (see `rankNodes`).

### InjectionState

```ts
interface InjectionState {
    alwaysInjectIds: ReadonlySet<string>;
    recallSelectedIds: ReadonlySet<string>;
    visibleIds: ReadonlySet<string>;
}
```

The injection-side observation surface. `alwaysInjectIds` are nodes pinned by their type's `alwaysInject` flag. `recallSelectedIds` are nodes the route LLM picked for the last turn. `visibleIds` is the candidate pool the route LLM saw — *empty until the recall pipeline has run at least once*.

### SchemaSpecView

```ts
interface SchemaSpecView {
    type: string;
    tableName: string;
    tableColumns: ReadonlyArray<string>;
    requiredColumns: ReadonlyArray<string>;
    primaryKeyColumns: ReadonlyArray<string>;
    forceUpdate: boolean;
    alwaysInject: boolean;
    editable: boolean;
    compressionMode: 'none' | 'hierarchical' | string;
}
```

The character-effective schema spec for one node type. Identical to what `getEffectiveNodeTypeSchema` returns internally; character overrides (if any) are already applied. Used to build the `schema_overview` LLM prompt block.

### SchemaView

```ts
interface SchemaView {
    types: ReadonlyArray<SchemaSpecView>;
}
```

Container returned by `getSchema()`. The order of `types` follows the schema's natural definition order.

### NodeBriefView

```ts
interface NodeBriefView {
    id: string;
    level: 'episodic' | 'semantic';
    type: string;
    tableName: string;
    title: string;
    summary: string;
    keyValues: Readonly<Record<string, unknown>>;  // primaryKeyColumns projection
    rowValues: Readonly<Record<string, unknown>>;  // remaining projection columns
    toSeq: number;
    childCount: number;                            // active (non-archived) children
    exposure: 'high_only' | 'full';
    edgeSummary: EdgeSummaryView | null;
    alwaysInject: boolean;
}
```

The single-node "brief" the native recall LLM sees per candidate row. Equivalent to `formatNodeBrief` output plus the recall-side fields (`exposure`, `edgeSummary`, `alwaysInject`) the router attaches before serialising. This is the unit a plugin assembles into a `candidateRows` block when replicating native recall input.

## Layer A: Data Access

### listNodes(filter?)

**Signature:** `listNodes(filter?: { types?: string[], levels?: Array<'episodic' | 'semantic'>, activeOnly?: boolean, seqRange?: { from?: number, to?: number } }): ReadonlyArray<NodeView>`

**Contract:**

- Default `activeOnly: true` — excludes archived nodes and recall-diagnostic nodes (same filter as the native `collectAlwaysInjectNodes`).
- Sorted by `compareNodesByTimeline` (seqTo ascending, id tiebreak) — the stable timeline order used for offline analysis. This is **different** from `listVisibleCandidates`, which sorts by `compareNodesByRecency` (seqTo desc, depth desc, id lex).
- Returns a frozen array of frozen `NodeView` objects. The array itself, every view, every `fields` record, and every `childrenIds` array are frozen.

**When to use:** offline scanning of the full store — debugging, one-shot statistics, exhaustive iteration. Hot-path callers replicating recall should use `listVisibleCandidates` instead, which is order-aligned with the route LLM input and applies the recall-side filters.

**Minimal example:**

```js
const events = api.listNodes({ types: ['event'], seqRange: { from: 100 } });
console.log(events.length, 'events on or after seq 100');
```

### getNode(id)

**Signature:** `getNode(id: string): NodeView | null`

**Contract:**

- Returns the frozen `NodeView` for the given id, or `null` if the id does not exist in the store.
- Does **not** filter on `archived` — archived nodes are returned with `archived: true`, allowing callers that need to inspect them to do so explicitly.
- Whitespace-only / empty ids return `null`.

**When to use:** dereferencing an id you obtained from another API call (a child id, a neighbour id, an injection state id).

**Minimal example:**

```js
const node = api.getNode('node_42');
if (node) console.log(node.type, node.title);
```

### listEdges(filter?)

**Signature:** `listEdges(filter?: { from?: string, to?: string, types?: string[], excludeInternal?: boolean }): ReadonlyArray<EdgeView>`

**Contract:**

- Returns **raw storage-side edges**, not projected (no weight aggregation, no rollup substitution).
- `excludeInternal: true` strips the hierarchical bookkeeping edges `contains` and `semantic_contains` — useful when you only want semantic relations.
- No weight field on returned edges. To get weighted projected edges, use `projectEdges`.

**When to use:** offline edge inspection, building custom topology indices, or feeding a non-recall analyser. For LLM-recall input building, prefer `projectEdges` or `getEdgeSummary`.

**Minimal example:**

```js
const mentions = api.listEdges({ types: ['mentions'], excludeInternal: true });
console.log(mentions.length, 'semantic mention edges');
```

### getSchema()

**Signature:** `getSchema(): SchemaView`

**Contract:**

- Returns the character-effective schema (i.e. `getEffectiveNodeTypeSchema(context, settings)`). Character overrides — if any — are already applied.
- Each `SchemaSpecView` is frozen, and arrays inside (`tableColumns`, `requiredColumns`, `primaryKeyColumns`) are frozen.
- This is the source data for the `schema_overview` block of the native recall LLM input.

**When to use:** when building a `schema_overview` prompt block, or when reflecting on schema-derived projections (which columns are primary-key, which are required, etc.).

**Minimal example:**

```js
const schema = api.getSchema();
for (const spec of schema.types) {
    console.log(spec.type, spec.tableName, [...spec.tableColumns]);
}
```

## Layer B: Topology Navigation

### getNeighbors(id, options?)

**Signature:** `getNeighbors(id: string, options?: { edgeTypes?: string[], direction?: 'in' | 'out' | 'both', projectTo?: 'raw' | 'visible' | string[] }): ReadonlyArray<NeighborView>`

**Contract:**

- Default `direction: 'both'`, default `projectTo: 'raw'`.
- With `projectTo: 'raw'`, returns neighbours as stored (no rollup substitution).
- With `projectTo: 'visible'`, every raw neighbour id is passed through `getNearestVisibleAncestorId` against the current `visibleIds`; neighbours that don't roll up into the visible set are dropped.
- With `projectTo: string[]`, the same substitution runs against the caller-supplied visible set.
- Archived neighbours are always filtered.
- Deduplicates by `(neighborId, edgeType, direction)`.

**When to use:** building a neighbour ring around a focus node when assembling a custom LLM prompt block. Use `projectTo: 'visible'` to align with what the route LLM sees.

**Minimal example:**

```js
const ring = api.getNeighbors('node_42', {
    edgeTypes: ['mentions', 'related'],
    direction: 'both',
    projectTo: 'visible',
});
for (const { node, edgeType, direction } of ring) {
    console.log(`${direction}-${edgeType}: ${node.title}`);
}
```

### getAncestor(id, options?)

**Signature:** `getAncestor(id: string, options?: { activeOnly?: boolean, predicate?: (node: NodeView) => boolean }): NodeView | null`

**Contract:**

- Walks `parentId` upward strictly above the input node. The input node itself is never a result.
- Default `activeOnly: true` — encountering an archived ancestor returns `null` (treated as no-match).
- With `predicate`, returns the first ancestor for which `predicate(view)` is truthy. Without `predicate`, returns the direct parent (if any).
- Cycle-safe: visited ids are tracked.

**When to use:** finding the nearest ancestor of a given level / type, e.g. "give me the `character_sheet` rollup above this `event`."

**Minimal example:**

```js
const rollup = api.getAncestor('event_99', {
    predicate: n => n.level === 'semantic' && n.type === 'character_sheet',
});
```

### getDescendants(id, options?)

**Signature:** `getDescendants(id: string, options?: { activeOnly?: boolean, maxDepth?: number }): ReadonlyArray<NodeView>`

**Contract:**

- BFS over `childrenIds`.
- Default `activeOnly: true` filters archived children. Default `maxDepth: Infinity`.
- Returns descendants in BFS order (level 1 first, then level 2, ...).
- Excludes the root node itself.

**When to use:** enumerating the contents of a rollup, or grabbing every event chained under a `character_sheet`.

**Minimal example:**

```js
const events = api.getDescendants('character_sheet_alice', { maxDepth: 2 });
console.log(events.length, 'descendants within depth 2');
```

### getNearestVisibleAncestor(id, options)

**Signature:** `getNearestVisibleAncestor(id: string, options: { visibleNodeIds: Iterable<string> }): NodeView | null`

**Contract:**

- `visibleNodeIds` is **required**.
- Behaves like the internal `getNearestVisibleAncestorId`: walks upward from `id`, returns the first node whose id is in `visibleNodeIds`. Returns `null` if an archived ancestor is encountered before a match, or if no ancestor (including the input itself) is in the visible set.
- The input node *is* eligible as its own "ancestor" if it's in `visibleNodeIds`.

**When to use:** rolling up a leaf id (e.g. an event) to the visible rollup that represents it. The same primitive `projectEdges` uses to project raw edges.

**Minimal example:**

```js
const visibleIds = new Set(api.listVisibleCandidates().map(n => n.id));
const rollup = api.getNearestVisibleAncestor('event_99', { visibleNodeIds: visibleIds });
```

### projectEdges(options)

**Signature:** `projectEdges(options: { visibleNodeIds: Iterable<string>, edgeTypes?: string[], excludeInternal?: boolean }): ReadonlyArray<EdgeView>`

**Contract:**

- `visibleNodeIds` is **required**.
- Default `excludeInternal: true` — strips `contains` / `semantic_contains` edges (different from `expandFromSeeds`, which defaults `false` to match `expandRouteCandidates`).
- For every raw edge, both endpoints are rolled up to their nearest visible ancestor; edges whose endpoint doesn't roll up into the visible set are dropped.
- Same-`(from, to, type)` edges after projection are collapsed; `weight` is the count of underlying raw edges.
- Returns frozen `EdgeView` objects with `weight` populated.
- Implementation re-exports the internal `buildProjectedEdges` directly — no risk of drift.

**When to use:** building a graph snapshot for the route LLM (or a custom LLM) that respects the visible candidate pool. Pair with `listVisibleCandidates` to get the (nodes, edges) pair the route LLM sees.

**Minimal example:**

```js
const visibleIds = new Set(api.listVisibleCandidates().map(n => n.id));
const projected = api.projectEdges({
    visibleNodeIds: visibleIds,
    edgeTypes: ['mentions', 'related'],
});
console.log(projected.length, 'projected semantic edges');
```

## Layer C: Recall Primitives

### listVisibleCandidates(options?)

**Signature:** `listVisibleCandidates(options?: { seqWindow?: { from?: number, to?: number }, types?: string[], excludeRecentMessages?: number }): ReadonlyArray<NodeView>`

**Contract:**

- Returns the same candidate pool `chooseRecallRoute` constructs via `collectRootCandidates` — but as deep-frozen `NodeView`.
- `excludeRecentMessages` matches the native `isNodeInRecentExcludeWindow` semantics: nodes within the last N user messages are filtered. Default 0.
- `seqWindow` and `types` apply *after* the native candidate construction, narrowing the pool.
- **Sorted by `compareNodesByRecency`** (seqTo desc → semanticDepth desc → id lex) — this is the order the route LLM sees, *different* from `listNodes`.

**When to use:** the hot-path entry point for any custom recall plugin. Pair with `getNodeBrief` per id to construct a `candidateRows` block.

**Minimal example:**

```js
const candidates = api.listVisibleCandidates();
console.log(candidates.length, 'visible candidates');
```

### getNodeExposure(id)

**Signature:** `getNodeExposure(id: string): 'high_only' | 'full' | null`

**Contract:**

- Returns `getNodeRecallExposure(settings, node, context)` for the given node.
- `'high_only'` for semantic-level nodes on hierarchical-compression types (their fields are gated to "high importance" only).
- `'full'` for any other active node.
- `null` if the node doesn't exist or is archived.
- Recomputed per call so character overrides take effect immediately.

**When to use:** deciding how much of a node's field payload to render in a custom prompt. Mirrors what the native router gates.

**Minimal example:**

```js
const exposure = api.getNodeExposure('character_sheet_alice');
if (exposure === 'high_only') {
    // render only high-importance columns
}
```

### getEdgeSummary(id, options?)

**Signature:** `getEdgeSummary(id: string, options?: { visibleNodeIds?: Iterable<string>, edgeTypes?: string[], limit?: number }): EdgeSummaryView`

**Contract:**

- Wraps the internal `buildEdgeSummary` directly — no behaviour drift.
- Default `visibleNodeIds` is the current injection-state `visibleIds`. **Empty until the recall pipeline has run at least once.** Pass an explicit set if you need guaranteed coverage.
- Default `limit: 8` matches the native router.
- Always returns a frozen `EdgeSummaryView`; missing / unknown nodes get a zero-degree summary, never `null`.

**When to use:** attaching a compact edge view to a custom candidate row, or inspecting a node's neighbourhood without paying for full topology traversal.

**Minimal example:**

```js
const summary = api.getEdgeSummary('character_sheet_alice', { limit: 6 });
console.log(summary.degree, summary.sample_neighbors.length);
```

### getNodeBrief(id, options?)

**Signature:** `getNodeBrief(id: string, options?: { visibleNodeIds?: Iterable<string>, includeEdgeSummary?: boolean, edgeSummaryLimit?: number }): NodeBriefView | null`

**Contract:**

- Equivalent to a single row of the route LLM's `candidateRows` block: `formatNodeBrief` projection plus the recall-side fields (`exposure`, `edgeSummary`, `alwaysInject`).
- `null` if the node doesn't exist or is archived.
- Default `includeEdgeSummary: true`, default `edgeSummaryLimit: 8`.
- Default `visibleNodeIds` is the current injection-state `visibleIds`. Pass an explicit set if you need a deterministic projection.
- `alwaysInject` reflects the current injection state's `alwaysInjectIds`.

**When to use:** the canonical building block for a custom recall LLM input — one call per candidate id.

**Minimal example:**

```js
const visibleIds = new Set(api.listVisibleCandidates().map(n => n.id));
const brief = api.getNodeBrief('character_sheet_alice', {
    visibleNodeIds: visibleIds,
    edgeSummaryLimit: 8,
});
console.log(brief.summary, brief.exposure, brief.alwaysInject);
```

### expandFromSeeds(seedIds, options?)

**Signature:** `expandFromSeeds(seedIds: Iterable<string>, options?: { hops?: number, edgeTypes?: string[], projectTo?: 'raw' | 'visible' | string[], includeChildren?: boolean, excludeInternal?: boolean }): ReadonlyArray<NodeView>`

**Contract:**

- Wraps the internal `expandRouteCandidates` — the BFS drill expansion the route LLM triggers when it decides to dig deeper into a seed.
- Default `hops: 1`, `includeChildren: true`, `projectTo: 'visible'`, **`excludeInternal: false`** (to match native `expandRouteCandidates`, where `contains` / `semantic_contains` participate in drill).
- With `projectTo: 'visible'`, the drill expands inside the current `visibleIds` pool (the seed itself is always admitted).
- With `projectTo: 'raw'`, the drill expands across the full store.
- With `projectTo: string[]`, the drill expands inside the supplied set.
- Setting `excludeInternal: true` aligns the behaviour with `projectEdges`' default (no `contains` / `semantic_contains` participation).

**When to use:** when a custom recall pipeline wants to "expand" a seed (e.g. a `character_sheet`) to pull in its children and one-hop semantic neighbours.

**Minimal example:**

```js
const expanded = api.expandFromSeeds(['character_sheet_alice'], {
    hops: 2,
    includeChildren: true,
});
console.log(expanded.length, 'nodes reachable');
```

### rankNodes(options)

**Signature:** `rankNodes(options: { query: string, mode?: 'recency' | 'vector' | 'keyword' | 'hybrid', types?: string[], k?: number }): Promise<ReadonlyArray<ScoredNodeView>>`

**Contract:**

- Always returns a `Promise` for API symmetry; `'recency'` and `'keyword'` resolve synchronously, `'vector'` and `'hybrid'` await the vector index.
- Default `mode: 'recency'`, default `k: 20`.
- Empty / missing `query` forces `'recency'` regardless of requested mode (no query to rank against).
- Returned `scoreMode` reflects the **actual** mode used after fallback (see below).

**Modes:**

- `'recency'` — sorts active nodes by `seqTo` descending. `score` equals `seqTo`. Query-independent; the safest default for pure LLM recall.
- `'keyword'` — simple token-overlap over each node's `title` + projection columns + spec keywords. `score` is normalised matches/query-tokens.
- `'vector'` — defers to `findSimilarNodes` (vector-index-core). Requires a built vector index and a valid embedding profile. **Falls back to `'recency'`** when the profile is invalid or no hits are returned; in that case `scoreMode` will be `'recency'`.
- `'hybrid'` — 50/50 blend of normalised vector and keyword scores. Falls back to `'recency'` when both pools are empty.

**When to use:** generating a small ranked shortlist of candidate ids to feed into `getNodeBrief`. Note: even though `rankNodes` exists, the canonical LLM-recall input is `listVisibleCandidates` — `rankNodes` is for plugins that want a query-prefiltered shortlist instead of (or in addition to) the full candidate pool.

**Minimal example:**

```js
const ranked = await api.rankNodes({
    query: 'who is Alice?',
    mode: 'hybrid',
    k: 10,
});
for (const view of ranked) {
    console.log(view.title, view.score.toFixed(3), view.scoreMode);
}
```

## Layer D: Injection Observation

### getInjectionState()

**Signature:** `getInjectionState(): InjectionState`

**Contract:**

- Returns a frozen `InjectionState` containing the current `alwaysInjectIds`, `recallSelectedIds`, and `visibleIds`.
- `visibleIds` is **empty until the recall pipeline has run at least once** — methods that default to "current visibleIds" therefore see an empty set on first use. If you need a guaranteed candidate pool, call `listVisibleCandidates()` first or pass an explicit `visibleNodeIds` argument.
- Wraps the underlying Sets in `Object.freeze` (Set contents are not technically immutable in JS, but the API documents them as read-only; do not mutate them).

**When to use:** querying current injection state synchronously — e.g. when rendering a UI badge for "this node is currently injected."

**Minimal example:**

```js
const state = api.getInjectionState();
console.log(state.alwaysInjectIds.size, state.recallSelectedIds.size, state.visibleIds.size);
```

### onInjectionChanged(callback)

**Signature:** `onInjectionChanged(callback: (state: InjectionState) => void): () => void`

**Contract:**

- Subscribes `callback` to injection state changes. The callback receives the same frozen `InjectionState` shape as `getInjectionState()`.
- Returns an unsubscribe function. The unsubscribe is idempotent.
- Listener exceptions are caught and logged via `console.warn` — they do not break the listener chain or affect other subscribers.
- No debounce; the listener may fire multiple times per turn (always-inject pass, recall pass, ...).

**When to use:** keeping a UI or sidekick state machine in sync with the recall pipeline. For example, an extension that highlights the active rollups in the chat margin would subscribe here.

**Minimal example:**

```js
const unsubscribe = api.onInjectionChanged(state => {
    refreshInjectionUI(state.recallSelectedIds);
});
// Later:
unsubscribe();
```

## Worked Example: replicate the native recall LLM input

The two LLM-input blocks that `chooseRecallRoute` constructs are `schema_overview` and `candidateRows`. With the API, replicating them is direct:

```js
const api = getMemoryGraphReadApi(Luker.getContext());

// schema_overview block (the LLM prompt segment that describes each node type).
const schemaOverview = api.getSchema().types.map(spec => ({
    id: spec.type,
    table_name: spec.tableName,
    table_columns: [...spec.tableColumns],
    required_columns: [...spec.requiredColumns],
    force_update: spec.forceUpdate,
    always_inject: spec.alwaysInject,
    editable: spec.editable,
    compression_mode: spec.compressionMode,
}));

// candidateRows block (one brief per visible candidate).
const candidates = api.listVisibleCandidates();
const candidateRows = candidates.map(view => api.getNodeBrief(view.id, {
    includeEdgeSummary: true,
    edgeSummaryLimit: 8,
}));

// You can now feed schemaOverview + candidateRows + always_inject_node_ids + your own
// recall_query_context to your own recall LLM (with whatever model / preset you prefer).
```

The full equivalence guarantee — `candidateRows` field-by-field and order-by-order matching the native router's input — is enforced by the dogfood test (`tests/memory-graph/read-api-dogfood.test.js`), which constructs the same blocks via the API and asserts structural equality against the native `chooseRecallRoute` internal state.

## Compatibility

- `external-api.js` legacy exports (`getCurrentlyInjectedNodeIds`, `__recordInjectedNodeIds`, `applyMemoryGraphInjectionUpdate`, `createEmptyInjectionState`) remain in place — existing plugins do not need to change.
- `getMemoryGraphInjectionState(context)` is re-exported from `read-api.js` for symmetry: it returns the same shape (`alwaysInjectIds`, `recallSelectedIds`, `visibleIds`) as `getInjectionState()`.
- The factory `getMemoryGraphReadApi(context)` does not pollute the legacy namespace; importing it has no side effects beyond loading the read-api module.
- The API is marked `@experimental` for 2-3 minor versions per spec §9. Breaking changes during that window are permitted; field semantics will be preserved, but field names and signatures may shift in response to real-world plugin usage before the API is frozen.

## Performance

- `listNodes` / `listEdges` iterate the full store — use for offline / one-shot analysis only. Cost grows linearly with the node / edge count.
- `listVisibleCandidates` is the hot-path equivalent — equivalent cost to one native `collectRootCandidates` call. Pre-applies the recall-side filters so callers do not pay for them again.
- `getEdgeSummary` / `projectEdges` are not cached — each call recomputes from raw edges. This is acceptable for typical recall workloads (1-2 calls per turn) per spec §7. If you find yourself calling `getEdgeSummary` per candidate in a hot loop, consider caching the result yourself keyed on the visible-id set.
- `rankNodes(mode: 'vector' | 'hybrid')` depends on the vector index being built. Both fall back to `'recency'` when the profile is invalid; the returned `scoreMode` reflects what was actually used.
- All returned views are frozen lazily during construction. Re-freezing already-frozen objects is a no-op, so repeated reads of the same node are cheap on the consumer side.

## See Also

- Native recall path: `public/scripts/extensions/memory-graph/main.js` (`chooseRecallRoute`, `collectRootCandidates`, `expandRouteCandidates`)
- Companion: the orchestrator's `memory_scout` sub-agent uses this API — see [Director runtime](/features/orchestrator/director).
- Related extension API: [Plugin Integration](/development/extension-api/plugin-integration) for the broader extension API registry that exposes `getMemoryGraphReadApi` alongside other extension entry points.
