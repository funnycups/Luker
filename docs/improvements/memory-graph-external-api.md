# Memory Graph External API

The memory-graph extension exposes a **read-only** query interface through `public/scripts/extensions/memory-graph/external-api.js`, so other extensions (e.g., the orchestrator's loop mode) can query nodes on demand without poking at memory-graph's internal data structures or reimplementing recall logic.

## Design Contract

- **Read-only** — These exports do not mutate the store. Writes still go through memory-graph's main flow or the settings panel.
- **Caller loads the store** — The functions themselves don't trigger store loading. Callers obtain the store via memory-graph's existing paths (typically the floor-state instance or a helper export from the extension), then pass it into these query functions.
- **Graceful degradation when disabled** — If the user disables memory-graph, the store is usually empty or unavailable. These functions return empty results for `null/undefined` stores and empty queries instead of throwing, so callers can call them unconditionally.

## API

### `getCurrentlyInjectedNodeIds(context)`

Returns the set of node ids that the memory-graph main flow has **already injected** into the main context for the current chat turn. Two groups:

- `alwaysInjectIds`: nodes flagged with `alwaysInject` (persistently injected)
- `recallSelectedIds`: nodes selected by this turn's recall pipeline

```js
import { getCurrentlyInjectedNodeIds } from '../memory-graph/external-api.js';

const { alwaysInjectIds, recallSelectedIds } = getCurrentlyInjectedNodeIds(context);
const allInjected = new Set([...alwaysInjectIds, ...recallSelectedIds]);
// Pass the union as excludeIds for downstream queries, so we don't return
// nodes that are already in the main context.
```

The two returned `Set`s are defensive copies: the caller's modifications won't affect future `getCurrentlyInjectedNodeIds` results. Memory-graph's main flow writes both id groups after each recall settles; when the main flow reused a snapshot and skipped full recall, the previous full-recall values are preserved — since snapshot reuse means the same anchor's injection result hasn't changed.

### `searchNodesLexical(store, query, options?)`

Case-insensitive substring lexical search. **Doesn't depend on vector configuration** — intentional, so users without vector embedding configured can still call it.

```js
import { searchNodesLexical } from '../memory-graph/external-api.js';

const result = searchNodesLexical(store, 'autumn', {
    limit: 5,
    excludeIds: new Set(['n42']),
});
// → { nodes: [{ id, preview, type?, time? }] }
```

The match scope matches the recall pipeline's `computeLexicalScore`: a node's `title` plus the concatenation of `fields.title / fields.name / fields.summary / fields.state / fields.traits / fields.constraint / fields.key_sentences / fields.aliases`. The `preview` returned on a hit is truncated to 300 characters; `time` comes from `node.seqTo`. Archived (`archived`) nodes are skipped.

`options.excludeIds` accepts a `Set` or any iterable.

### `listRecentNodes(store, options?)`

Browse nodes in reverse chronological order, reusing `graph-ops.js`'s `compareNodesByTimeline`. Suited for "browse the timeline and pick a node" scenarios — e.g., a loop agent wanting to know what happened recently.

```js
const result = listRecentNodes(store, { limit: 10, excludeIds });
// → { nodes: [{ id, preview, time?, type? }] }
```

Default `limit=10`. Also skips `archived` nodes.

### `getNodeById(store, id, options?)`

Fetch a node by id, with optional adjacent neighbors. Neighbors are returned as `{id, edgeType?, relation?}` — references only, not inlined full nodes; if the caller needs them, another `getNodeById` call retrieves them.

```js
const result = getNodeById(store, 'n42', { includeNeighbors: true });
// → { node, neighbors: [{ id, edgeType, relation? }] } | null
```

`includeNeighbors` defaults to `true`. Returns `null` when the store is missing or the id doesn't exist. `store.nodes` supports both plain object maps (production form) and `Map` (for tests).

## Call Example: Orchestrator Loop Mode

The orchestrator's loop-mode tools `memory.search` / `memory.list_recent` / `memory.get` are thin shells around these APIs; the key dedup logic is taking the union of the two "already-injected" id groups:

```js
// orchestrator/loop-tools/memory.js
import {
    searchNodesLexical,
    getCurrentlyInjectedNodeIds,
} from '../../memory-graph/external-api.js';

export async function memorySearch({ query, limit }, context) {
    const store = await loadStore(context);   // caller's responsibility
    if (!store) return { nodes: [] };          // empty result if disabled
    const { alwaysInjectIds, recallSelectedIds } = getCurrentlyInjectedNodeIds(context);
    const excludeIds = new Set([...alwaysInjectIds, ...recallSelectedIds]);
    return searchNodesLexical(store, query, { limit, excludeIds });
}
```

This way the loop agent's search results never overlap with what the main model has already received — saves tokens and avoids the agent restating what the main context already has in its capsule.
