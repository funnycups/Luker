# Memory Graph Extension API

> Status: experimental (subject to breaking changes for 2-3 minor versions per spec §9)
>
> Entry points:
> - **Recommended:** `getExtensionApi('memory-graph').openSession(context)` from `public/scripts/extensions.js` (session facade)
> - Lower-level: `getMemoryGraphReadApi(store, context)` from `public/scripts/extensions/memory-graph/read-api.js` (read factory)
> - Lower-level: `getMemoryGraphWriteApi(store, context, options?)` from `public/scripts/extensions/memory-graph/write-api.js` (write factory; `options.onCommit` flushes mutations to floor-state)

## Session API (recommended entry)

Open a chat-scoped session through Luker's extension registry:

```js
import { getExtensionApi } from '/scripts/extensions.js';

const memoryApi = getExtensionApi('memory-graph');
const session = await memoryApi?.openSession?.(context);
if (!session) {
    // memory-graph not loaded, or context lacks createFloorState
    return;
}

// Read
const candidates = session.listVisibleCandidates({ types: ['character_sheet'], limit: 20 });
const brief = session.getNodeBrief('node_42');
const edges = session.getEdgeSummary('node_42');
const matches = session.findByName({ query: 'Alice' });
const ranked = session.keywordSearch({ query: 'sword fight in the inn', k: 5 });
const semantic = await session.vectorSearch({ query: 'betrayal', k: 5 });

// Write — every write method is async; await the promise to get the result.
const { id } = await session.createNode({ type: 'event', title: 'Alice draws her sword', fields: { what: '...' } });
await session.editNode({ id, setFields: { who: ['Alice', 'Bob'] } });
await session.upsertLinks({ source: { id }, links: [{ target: { id: 'alice_node' }, relation: 'about' }] });
await session.deleteLinks({ source: { id }, target: { id: 'bob_node' }, relation: 'about' });
await session.compactNodes({ type: 'event', childIds: [...], summary: '...' });
```

The `'memory-graph'` extension api is published via Luker's `registerExtensionApi(name, api)` mechanism — the same one `card-app` and other Luker extensions use. Third-party extensions that integrate with memory-graph should always go through `getExtensionApi('memory-graph')`, never import `memory-graph/*.js` directly.

### Lifetime

Each `openSession` call resolves the current chat's store snapshot. If the user switches chats, or you want a fresh read of in-flight edits made by another path, call `openSession` again — sessions are cheap to open.

### Empty store

A chat that has never had extraction run still gets a writable session. Read methods return empty arrays; write methods populate the store and persist through the same floor-state path the native extraction pipeline uses. This means the first write on a fresh chat works without any precondition setup.

### When `openSession` returns `null`

- Memory-graph extension is not loaded (`getExtensionApi('memory-graph')` returned `undefined`).
- The context cannot be resolved to a chat target (no `chatId`, or `createFloorState` is missing — typical for test runners that didn't mock the SillyTavern context fully).
- The runtime store failed to load from floor-state (rare; logged as `console.warn`).

The orchestrator's `memory_*` loop tools translate a `null` session into `ToolError(MEMORY_DISABLED)` so agents can pivot.

### Method reference

All 16 methods on the returned session object:

| Method | Returns | Notes |
| --- | --- | --- |
| `listVisibleCandidates(opts)` | `NodeView[]` | The pool the native recall LLM sees |
| `getEdgeSummary(id, opts)` | `EdgeSummaryView` | Degree + relations + sample neighbours |
| `getNodeBrief(id, opts)` | `NodeBriefView \| null` | Full brief incl. fields + edges |
| `expandFromSeeds(ids, opts)` | `NodeView[]` | BFS-expand a small seed set |
| `getSchema()` | `SchemaView` | Active node-type schema |
| `keywordSearch(opts)` | `RankedView[]` | Token-overlap over visible nodes |
| `vectorSearch(opts)` | `Promise<RankedView[]>` | Embedding search; throws `NO_EMBEDDING_PROFILE` |
| `findByName(opts)` | `{ matches: NodeView[] }` | Exact / substring title + primary-key match |
| `compactionCandidates(opts)` | `{ groups: ... }` | Semantic roots ready for rollup |
| `createNode(op)` | `{ id }` | Create a node |
| `editNode(op)` | `{ ok }` | Patch fields / rename |
| `deleteNode(op)` | `{ ok }` | Archive (soft-delete) |
| `upsertLinks(op)` | `{ applied }` | Add or update edges |
| `deleteLinks(op)` | `{ removed }` | Remove a specific edge |
| `compactNodes(op)` | `{ rollupNodeId }` | Roll children into a semantic parent |
| `applyExtractionBatch(input)` | `{ applied, rejected }` | One-shot multi-op batch |

For full signatures of each method, see the **Read API** and **Write API** sections below — `openSession` delegates to those internally.

### Lower-level access

`getMemoryGraphReadApi(store, context)` and `getMemoryGraphWriteApi(store, context)` remain exported for internal callers that already hold a store reference (e.g. the native `chooseRecallRoute` pipeline). Third-party extensions should prefer `openSession` — the session facade handles store loading, fresh-chat fallback, and registration through Luker's standard extension api in one place.

## Overview

The memory-graph extension drives Luker's long-term recall by feeding a curated pool of nodes (`character_sheet`, `event`, `relationship`, ...) plus a per-node `edge_summary` to a "route" LLM that picks which memories to inject into the next turn. The native pipeline (`chooseRecallRoute` / `collectRootCandidates` in `main.js`) constructs that LLM input from internal helpers — `buildProjectedEdges`, `getNearestVisibleAncestorId`, `formatNodeBrief`, etc.

`getMemoryGraphReadApi(store, context)` exposes the same data, topology, and recall primitives as a frozen, caller-safe API surface. The intended consumer is an agent-style plugin that wants to run its own LLM-driven recall — for example the orchestrator's `memory_scout` sub-agent — with whatever model / preset its operator prefers, against the exact same candidate pool and field projection the native router sees.

`getMemoryGraphWriteApi(store, context)` is the companion mutation surface: an extractor-style agent (or a curator agent that edits the graph between turns) goes through it instead of touching store internals. The Write API is documented in [Write API](#write-api) below.

The read surface is strictly read-only:

- Returned views are deep-frozen plain objects / arrays / Sets. The factory never returns store-internal references.
- Views are synthesised per call from the supplied store, so a single API instance stays valid for the lifetime of that store reference.
- Every mutation goes through the Write API; the read factory never exposes a write path.

## Quick Start

```js
import { getExtensionApi } from '/scripts/extensions.js';

const session = await getExtensionApi('memory-graph')?.openSession?.(Luker.getContext());
if (!session) return;

// Enumerate the visible candidate pool the native recall LLM sees.
const candidates = session.listVisibleCandidates();

// Get a brief for one node — id, summary, edge_summary, exposure, always_inject.
const brief = session.getNodeBrief(candidates[0].id);
```

If you already hold a store reference (internal callers only), you can construct a read factory directly:

```js
import { getMemoryGraphReadApi } from '/scripts/extensions/memory-graph/read-api.js';

const api = getMemoryGraphReadApi(store, context);
const candidates = api.listVisibleCandidates();
// ... onInjectionChanged, listNodes, projectEdges, etc. live here.
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
    sample_neighbors: ReadonlyArray<{ id: string; type: string; title: string; to_seq: number }>;
}
```

The compact edge view the native recall LLM sees per candidate row. Counts are aggregated per `(relation, direction)` pair; `sample_neighbors` is a bounded sample (default 8) of distinct neighbour nodes, each carrying a `to_seq` so callers can sort by recency. Field names are snake_case to match the native LLM prompt block.

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

### keywordSearch(options)

**Signature:** `keywordSearch(options: { query: string, types?: string[], k?: number }): ReadonlyArray<NodeView & { score: number, scoreMode: 'keyword' }>`

**Contract:**

- Token-intersection search across each node's `title` and schema-projected fields. Case-insensitive.
- `score` is `matches / queryTokenCount` per node; results are sorted by `score` descending and capped at `k` (default `20`).
- Empty / whitespace-only `query` returns an empty array (no throw).
- Always available — no embedding profile required, no async work, no recency fallback.

**When to use:** the safe default when you need a query-prefiltered shortlist of candidate ids and cannot rely on an embedding profile being configured. Also the recommended fallback when `vectorSearch` throws `NO_EMBEDDING_PROFILE`.

**Minimal example:**

```js
const hits = api.keywordSearch({
    query: 'Eileen',
    types: ['character_sheet'],
});
// hits: [{ id, title, ..., score: 0.5, scoreMode: 'keyword' }, ...]
```

### vectorSearch(options)

**Signature:** `vectorSearch(options: { query: string, types?: string[], k?: number }): Promise<ReadonlyArray<NodeView & { score: number, scoreMode: 'vector' }>>`

**Contract:**

- Semantic vector search using the configured embedding profile. Default `k: 20`.
- `score` is the vector-index similarity; results are sorted by `score` descending and capped at `k`.
- Throws `{ code: 'NO_EMBEDDING_PROFILE' }` when no embedding profile is configured. The method does **not** silently fall back — callers choose their own fallback strategy (typically `keywordSearch`).
- Empty / whitespace-only `query` resolves to an empty array (no throw).

**When to use:** when the consumer wants the semantic ranking the vector index provides and is prepared to handle the no-profile case explicitly.

**Minimal example:**

```js
try {
    const hits = await api.vectorSearch({
        query: 'the woman who healed me',
        types: ['character_sheet'],
    });
    // hits: [{ id, title, ..., score: 0.83, scoreMode: 'vector' }, ...]
} catch (err) {
    if (err.code === 'NO_EMBEDDING_PROFILE') {
        const fallback = api.keywordSearch({ query: 'the woman who healed me' });
    }
}
```

### findByName(options)

**Signature:** `findByName(options: { query: string, types?: string[] }): { matches: ReadonlyArray<NodeView> }`

**Contract:**

- Case-insensitive substring matching against each candidate's `title` and primary-key columns (which typically include `aliases`).
- Returns `{ matches: ReadonlyArray<NodeView> }` with no `score` field; matches are sorted by timeline (seqTo ascending).
- Empty / whitespace-only `query` returns `{ matches: [] }` (no throw).

**When to use:** the entity-identity probe — call **before** creating a `character_sheet` or `location_state` so the consumer can detect that the entity is already in the graph and edit it instead of duplicating.

**Minimal example:**

```js
const { matches } = api.findByName({
    query: '艾琳',
    types: ['character_sheet'],
});
// matches: [{ id: 'n_eileen', title: 'Eileen', ... }]
```

### compactionCandidates(options)

**Signature:** `compactionCandidates(options: { type: string, depth?: number }): { groups: ReadonlyArray<{ depth: number, childIds: ReadonlyArray<string>, fanIn: number }> }`

**Contract:**

- Pure structural query — no LLM calls — returning the set of node groups currently eligible for hierarchical compaction at `depth` (default `0`).
- Returns `{ groups: [] }` when:
    - The `type` does not exist in the active schema.
    - The type's `compression.mode` is `'none'` (or anything other than `'hierarchical'`).
    - The number of available candidates is below `compression.threshold` (after applying `keepRecentLeaves`).
    - The requested `depth` is at or above `compression.maxDepth`.
- Each group's `childIds` are the candidate child node ids; `fanIn` is the group size; `depth` is the rollup tier that would be produced.

**When to use:** driving an agent-side compaction workflow — enumerate groups, build a summary per group via your own LLM, then call `writeApi.compactNodes` with the same `type` / `childIds`.

**Minimal example:**

```js
const { groups } = api.compactionCandidates({ type: 'event' });
for (const group of groups) {
    const briefs = group.childIds.map(id => api.getNodeBrief(id));
    // summarise briefs via your LLM, then writeApi.compactNodes({ type: 'event', childIds: group.childIds, summary })
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
import { getExtensionApi } from '/scripts/extensions.js';

const api = await getExtensionApi('memory-graph')?.openSession?.(Luker.getContext());
if (!api) return;

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

## Write API

The write API is the Layer-1 entry for third-party agents that want to edit the memory graph directly — for example a curator agent that runs between turns instead of relying on the built-in extractor. The session facade exposes the common write methods; the lower-level `getMemoryGraphWriteApi(store, context)` factory is what `openSession` wraps internally.

### Factory: getMemoryGraphWriteApi(store, context, options?)

```js
import { getMemoryGraphWriteApi } from '/scripts/extensions/memory-graph/write-api.js';

const writeApi = getMemoryGraphWriteApi(store, context);
// Optional: pass an onCommit hook to persist after each successful mutation —
// `openSession` wires this to `commitSessionMutation` internally so writes
// flush through the same floor-state path as the native extraction pipeline.
const persistingApi = getMemoryGraphWriteApi(store, context, {
    onCommit: async (s) => { await myFlush(s); },
});
```

Returns a frozen object exposing the methods documented below. The factory binds to the supplied `store` reference — pass the live store you obtained from the floor-state loader. Methods throw `{ code: 'MEMORY_STORE_MISSING' }` when invoked against a `null` store. Third-party extensions should normally use `openSession` instead of constructing this factory directly — it wires `onCommit` for you. Callers that omit `onCommit` get the legacy in-memory semantics (mutations stay in `store` but are never persisted).

### Recommended entry: applyExtractionBatch(options)

**Signature:** `applyExtractionBatch(options: { ops: ExtractionOp[], maxSeq?: number }): { applied: ExtractionOp[], rejected: Array<{ op: ExtractionOp, error: { code: string, message: string } }> }`

**Contract:**

- The recommended entry for multi-op intents (e.g. create + link in the same logical action). Provides a single rollback / persist boundary, resolves same-batch `ref`s within the call, and surfaces failures in `rejected` rather than throwing midway.
- Default `maxSeq` is the store's current `seqCounter`.
- `ExtractionOp` is a discriminated union:
    - `{ op: 'create', type, title?, fields, links?, ref? }` — create a new semantic node.
    - `{ op: 'edit', nodeId, setFields?, clearFields?, title? }` — patch fields on an existing node.
    - `{ op: 'delete', nodeId }` — delete a node.
    - `{ op: 'link_upsert', sourceNodeId? | sourceRef?, links: [{ targetNodeId? | targetRef?, relation, direction? }] }` — add relation edges. Same-batch `ref`s resolve within the call.
    - `{ op: 'link_delete', sourceNodeId, targetNodeId, relation, direction? }` — remove a relation edge.
- The per-op primitives below are convenience wrappers that build a one-op batch and apply it through the same pipeline.

**When to use:** any agent that produces more than one op per logical action — atomicity, batch-level `ref` resolution, and predictable failure reporting all live at this level.

**Minimal example:**

```js
const { applied, rejected } = await writeApi.applyExtractionBatch({
    ops: [
        { op: 'create', type: 'character_sheet', ref: 'c1', fields: { name: 'Eileen', aliases: ['艾琳'] } },
        { op: 'link_upsert', sourceRef: 'c1', links: [{ targetNodeId: 'event_42', relation: 'mentions' }] },
    ],
});
console.log(applied.length, 'applied;', rejected.length, 'rejected');
```

### createNode(options)

**Signature:** `createNode(options: { type: string, title?: string, fields?: Record<string, unknown>, links?: LinkSpec[], ref?: string }): { id: string, ref?: string }`

**Contract:**

- Throws synchronously when `type` is missing.
- Returns the new node's `id`. When `ref` is supplied, the same `ref` is echoed back so the caller can refer to it in a follow-up `upsertLinks` call within a batch.
- Throws `{ code: 'OP_FAILED', rejected }` when the underlying batch rejects the op (for example a schema validation failure).

**When to use:** a one-shot node creation. For create-plus-link in the same logical action, prefer `applyExtractionBatch` so the link resolution and rollback boundary apply to the whole intent.

**Minimal example:**

```js
const { id } = await writeApi.createNode({
    type: 'character_sheet',
    title: 'Eileen',
    fields: { name: 'Eileen', aliases: ['艾琳'] },
});
```

### editNode(options)

**Signature:** `editNode(options: { id: string, setFields?: Record<string, unknown>, clearFields?: string[], title?: string }): { ok: boolean }`

**Contract:**

- Throws synchronously when `id` is missing.
- `setFields` patches columns; `clearFields` resets the listed columns; passing `title` updates the node title.
- `ok: true` when the node was found and the patch was applied; `ok: false` when the node was missing, archived, or otherwise skipped (silent skip — no throw).

**When to use:** mutating an existing node in place. Always check `ok` to confirm the patch landed.

**Minimal example:**

```js
const { ok } = await writeApi.editNode({
    id: 'n_eileen',
    setFields: { profession: 'healer' },
});
```

### deleteNode(options)

**Signature:** `deleteNode(options: { id: string }): { ok: boolean }`

**Contract:**

- Throws synchronously when `id` is missing.
- `ok: true` when the node existed and was deleted; `ok: false` otherwise.

**When to use:** removing a node the agent has decided is no longer relevant or was created in error.

**Minimal example:**

```js
const { ok } = await writeApi.deleteNode({ id: 'n_obsolete' });
```

### upsertLinks(options)

**Signature:** `upsertLinks(options: { source: { id?: string, ref?: string }, links: Array<{ target: { id?: string, ref?: string }, relation: string, direction?: 'outgoing' | 'incoming' | 'bidirectional' }> }): { applied: number }`

**Contract:**

- Adds relation edges from `source` to each `target`. `direction` defaults to `'bidirectional'`.
- Source / target may be addressed by `id` (live node id) or `ref` (batch-local reference). Refs only resolve within an `applyExtractionBatch` call; the per-primitive wrapper is intended for the live-id case.
- Multiple edges between the same pair with different `relation`s are allowed (composite states).
- `applied` is the number of ops the underlying pipeline accepted.

**When to use:** attaching relation edges to existing nodes. For create-plus-link, prefer `applyExtractionBatch` so the create's `ref` resolves inside the same call.

**Minimal example:**

```js
const { applied } = await writeApi.upsertLinks({
    source: { id: 'n_eileen' },
    links: [
        { target: { id: 'event_42' }, relation: 'mentions' },
        { target: { id: 'n_garden' }, relation: 'located_in', direction: 'outgoing' },
    ],
});
```

### deleteLinks(options)

**Signature:** `deleteLinks(options: { source: { id: string }, target: { id: string }, relation: string, direction?: 'outgoing' | 'incoming' | 'bidirectional' }): { removed: number }`

**Contract:**

- Throws synchronously when `source`, `target`, or `relation` is missing.
- `direction` defaults to `'bidirectional'`. `relation` is lower-cased before lookup.
- `removed` is the count of edges that disappeared from the store as a result of the op.

**When to use:** retracting a relation edge the agent previously added (or that the extractor produced and the curator now wants to undo).

**Minimal example:**

```js
const { removed } = await writeApi.deleteLinks({
    source: { id: 'n_eileen' },
    target: { id: 'event_42' },
    relation: 'mentions',
});
```

### compactNodes(options)

**Signature:** `compactNodes(options: { type: string, childIds: string[], summary: string, fields?: Record<string, unknown> }): { rollupNodeId: string }`

**Contract:**

- Creates a higher-tier rollup node of `type`, reparents the given `childIds` to it, and adds the `semantic_contains` edges. Shares the rollup builder (`createRollupWithChildren`) with the internal compression loop, so the agent-driven and native paths produce identical rollup shapes.
- Throws:
    - `{ code: 'BAD_ARGS' }` when `type` is missing, `childIds` is empty, or `summary` is empty.
    - `{ code: 'CHILD_NOT_FOUND' }` when a `childId` is not in the store.
    - `{ code: 'CHILD_HAS_PARENT' }` when a child already has a rollup parent of the same type.
- Returns the new rollup node id.

**When to use:** the agent-side compaction workflow — pair with `readApi.compactionCandidates` to enumerate eligible groups, build a summary per group via your own LLM, then call `compactNodes` to install the rollup.

**Minimal example:**

```js
const { groups } = readApi.compactionCandidates({ type: 'event' });
if (groups.length > 0) {
    const group = groups[0];
    const briefs = group.childIds.map(id => readApi.getNodeBrief(id));
    const summary = await myLLM.summarize(briefs);
    const { rollupNodeId } = await writeApi.compactNodes({
        type: 'event',
        childIds: group.childIds,
        summary,
    });
}
```

## Compatibility

- `external-api.js` legacy exports (`getCurrentlyInjectedNodeIds`, `__recordInjectedNodeIds`, `applyMemoryGraphInjectionUpdate`, `createEmptyInjectionState`) remain in place — existing plugins do not need to change.
- `getMemoryGraphInjectionState(context)` is re-exported from `read-api.js` for symmetry: it returns the same shape (`alwaysInjectIds`, `recallSelectedIds`, `visibleIds`) as `getInjectionState()`.
- The factories `getMemoryGraphReadApi(store, context)` and `getMemoryGraphWriteApi(store, context, options?)` do not pollute the legacy namespace; importing them has no side effects beyond loading the respective module.
- Both APIs are marked `@experimental` for 2-3 minor versions per spec §9. Breaking changes during that window are permitted; field semantics will be preserved, but field names and signatures may shift in response to real-world plugin usage before the API is frozen.

## Performance

- `listNodes` / `listEdges` iterate the full store — use for offline / one-shot analysis only. Cost grows linearly with the node / edge count.
- `listVisibleCandidates` is the hot-path equivalent — equivalent cost to one native `collectRootCandidates` call. Pre-applies the recall-side filters so callers do not pay for them again.
- `getEdgeSummary` / `projectEdges` are not cached — each call recomputes from raw edges. This is acceptable for typical recall workloads (1-2 calls per turn) per spec §7. If you find yourself calling `getEdgeSummary` per candidate in a hot loop, consider caching the result yourself keyed on the visible-id set.
- `keywordSearch` is pure token-overlap over the candidate pool — synchronous, always available, no recency fallback. `vectorSearch` depends on the vector index being built and an embedding profile being configured; it throws `NO_EMBEDDING_PROFILE` rather than falling back silently, so callers pick their own fallback (typically `keywordSearch`).
- Write-API ops persist the store and rebuild downstream indices (vector / edge summaries) at the batch boundary. Prefer `applyExtractionBatch` over a sequence of per-primitive calls when several ops belong to the same logical action — the rollback / persist boundary then applies to the whole batch.
- All returned views are frozen lazily during construction. Re-freezing already-frozen objects is a no-op, so repeated reads of the same node are cheap on the consumer side.

## See Also

- Native recall path: `public/scripts/extensions/memory-graph/main.js` (`chooseRecallRoute`, `collectRootCandidates`, `expandRouteCandidates`)
- Companion: the orchestrator opens a session via `getExtensionApi('memory-graph').openSession(context)` and stashes the resulting session on `__memoryGraphSession` for its `memory_*` loop tools — see [Director runtime](/features/orchestrator/director).
- Related extension API: [Plugin Integration](/development/extension-api/plugin-integration) for the broader extension API registry that publishes `'memory-graph'` alongside other extension entry points.
- To register custom orchestration tools (memory-graph itself does this for its read and write tools), see [Orchestrator Tools API](./orchestrator-tools.md).
