# 记忆图只读 API

> 状态:实验性(按规范 §9,会在 2-3 个 minor 版本内出现破坏性变更)
>
> 入口:`getMemoryGraphReadApi(context)`,来自 `public/scripts/extensions/memory-graph/read-api.js`

## 概览

memory-graph 扩展驱动 Luker 的长期召回 —— 它把精选后的节点池(`character_sheet`、`event`、`relationship`、……)加上每个节点的 `edge_summary` 喂给一个"路由"LLM,由它挑出下一轮要注入哪些记忆。原生流水线(`main.js` 中的 `chooseRecallRoute` / `collectRootCandidates`)通过一组内部 helper —— `buildProjectedEdges`、`getNearestVisibleAncestorId`、`formatNodeBrief` 等等 —— 构造出 LLM 输入,而这些 helper 此前都是私有的。

`getMemoryGraphReadApi(context)` 把同一份数据、拓扑和召回原语暴露成一个深冻结、对调用方安全的 API 面。预期消费者是 agent 风格的插件,自己跑一遍 LLM 驱动的召回 —— 比如 orchestrator 的 `memory_scout` 子代理 —— 用操作者偏好的模型 / preset,对着原生路由器看到的完全一样的候选池和字段投影来工作。

API 是严格只读的:

- 返回的视图都是深冻结的纯对象 / 数组 / Set。工厂从不返回 store 内部引用。
- 没有写入路径:节点、边、schema 的变更仍由 `extractionInstructions` 工具调用与 memory-graph 运行时负责。
- 视图在每次调用时从当前 store 合成,所以单个 API 实例在切聊天 / 切角色卡之后仍然有效。

## 快速开始

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

## 类型参考

所有接口都以深冻结的纯对象返回(标注为 `ReadonlySet` 的字段会被冻结 `Set` 包一层)。字段语义对齐规范 §4.1。

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

单个节点的标准视图。`fields` 是对齐 schema `tableColumns` 的行 payload;取值可以是字符串、数字或数组,取决于列定义。

### EdgeView

```ts
interface EdgeView {
    from: string;
    to: string;
    type: string;                     // 'related' / 'mentions' / 'contains' / 'semantic_contains' / ...
    weight?: number;                  // present only on projectEdges() output
}
```

两个节点之间的有向关系。原始边(`listEdges`、`getNeighbors`)从不带 `weight`;投影后的边(`projectEdges`)携带聚合权重 —— 来自同源同向边折叠后的计数。

### NeighborView

```ts
interface NeighborView {
    node: NodeView;
    edgeType: string;
    direction: 'in' | 'out';
}
```

从某个具体源节点视角看到的一个邻居。`direction` 相对源节点而言:`'out'` 表示一条 `source -> neighbor` 边;`'in'` 表示 `neighbor -> source`。

### EdgeSummaryView

```ts
interface EdgeSummaryView {
    degree: number;
    relations: ReadonlyArray<{ relation: string; direction: 'in' | 'out'; count: number }>;
    sample_neighbors: ReadonlyArray<{ id: string; type: string; title: string }>;
}
```

原生召回 LLM 每行候选看到的紧凑边视图。按 `(relation, direction)` 配对聚合计数;`sample_neighbors` 是去重后的邻居节点的有限采样(默认 8 个)。字段名用 snake_case 以匹配原生 LLM prompt 区块。

### ScoredNodeView

```ts
interface ScoredNodeView extends NodeView {
    score: number;
    scoreMode: 'recency' | 'vector' | 'keyword' | 'hybrid';
}
```

带分数及打分模式的 `NodeView`。`scoreMode` 反映的是 fallback 之后**实际**使用的模式(见 `rankNodes`)。

### InjectionState

```ts
interface InjectionState {
    alwaysInjectIds: ReadonlySet<string>;
    recallSelectedIds: ReadonlySet<string>;
    visibleIds: ReadonlySet<string>;
}
```

注入侧的观察面。`alwaysInjectIds` 是被节点类型 `alwaysInject` 标志固定下来的节点。`recallSelectedIds` 是路由 LLM 为上一轮选中的节点。`visibleIds` 是路由 LLM 看到的候选池 —— *在召回流水线至少跑过一次之前为空*。

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

某个节点类型的角色卡生效后 schema 规格。与内部 `getEffectiveNodeTypeSchema` 返回的内容完全一致;角色卡 override(若有)已经应用。用来组装 `schema_overview` LLM prompt 区块。

### SchemaView

```ts
interface SchemaView {
    types: ReadonlyArray<SchemaSpecView>;
}
```

`getSchema()` 返回的容器。`types` 的顺序遵循 schema 的自然定义顺序。

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

原生召回 LLM 每行候选看到的单节点"brief"。等价于 `formatNodeBrief` 的输出,加上路由器在序列化前补的几个召回侧字段(`exposure`、`edgeSummary`、`alwaysInject`)。插件复刻原生召回输入时,就是把它当作 `candidateRows` 块的最小单元来组装。

## Layer A: 数据访问

### listNodes(filter?)

**签名:** `listNodes(filter?: { types?: string[], levels?: Array<'episodic' | 'semantic'>, activeOnly?: boolean, seqRange?: { from?: number, to?: number } }): ReadonlyArray<NodeView>`

**契约:**

- 默认 `activeOnly: true` —— 排除归档节点和召回诊断节点(过滤规则与原生 `collectAlwaysInjectNodes` 一致)。
- 按 `compareNodesByTimeline` 排序(seqTo 升序,id 平手)—— 用于离线分析的稳定时间线顺序。这与 `listVisibleCandidates` **不同**,后者按 `compareNodesByRecency` 排序(seqTo 降序、depth 降序、id 字典序)。
- 返回冻结的 `NodeView` 对象的冻结数组。数组本身、每个视图、每个 `fields` record、每个 `childrenIds` 数组都是冻结的。

**何时使用:** 对整个 store 做离线扫描 —— 调试、一次性统计、穷举遍历。复刻召回的热路径调用方应改用 `listVisibleCandidates`,它的顺序跟路由 LLM 输入对齐,且已经应用了召回侧过滤。

**最小示例:**

```js
const events = api.listNodes({ types: ['event'], seqRange: { from: 100 } });
console.log(events.length, 'events on or after seq 100');
```

### getNode(id)

**签名:** `getNode(id: string): NodeView | null`

**契约:**

- 返回给定 id 对应的冻结 `NodeView`;若 store 中不存在该 id,返回 `null`。
- **不**按 `archived` 过滤 —— 归档节点会以 `archived: true` 的形式返回,允许显式需要查看的调用方拿到它们。
- 纯空白 / 空字符串 id 返回 `null`。

**何时使用:** 解引用从其他 API 调用拿到的 id(child id、neighbor id、injection state id)。

**最小示例:**

```js
const node = api.getNode('node_42');
if (node) console.log(node.type, node.title);
```

### listEdges(filter?)

**签名:** `listEdges(filter?: { from?: string, to?: string, types?: string[], excludeInternal?: boolean }): ReadonlyArray<EdgeView>`

**契约:**

- 返回**存储侧原始边**,非投影(没有 weight 聚合、没有 rollup 替换)。
- `excludeInternal: true` 剥除层级 bookkeeping 边 `contains` 和 `semantic_contains` —— 只想要语义关系时有用。
- 返回的边没有 weight 字段。要拿到带权重的投影边,用 `projectEdges`。

**何时使用:** 离线边检查、构建自定义拓扑索引,或者给非召回类的分析器供数据。要构造 LLM 召回输入,优先用 `projectEdges` 或 `getEdgeSummary`。

**最小示例:**

```js
const mentions = api.listEdges({ types: ['mentions'], excludeInternal: true });
console.log(mentions.length, 'semantic mention edges');
```

### getSchema()

**签名:** `getSchema(): SchemaView`

**契约:**

- 返回角色卡生效后的 schema(即 `getEffectiveNodeTypeSchema(context, settings)`)。角色卡 override(若有)已经应用。
- 每个 `SchemaSpecView` 都是冻结的,内部数组(`tableColumns`、`requiredColumns`、`primaryKeyColumns`)也都是冻结的。
- 这是原生召回 LLM 输入中 `schema_overview` 区块的源数据。

**何时使用:** 构造 `schema_overview` prompt 区块时,或基于 schema 派生信息(哪些列是主键、哪些是必填等)做反射时。

**最小示例:**

```js
const schema = api.getSchema();
for (const spec of schema.types) {
    console.log(spec.type, spec.tableName, [...spec.tableColumns]);
}
```

## Layer B: 拓扑导航

### getNeighbors(id, options?)

**签名:** `getNeighbors(id: string, options?: { edgeTypes?: string[], direction?: 'in' | 'out' | 'both', projectTo?: 'raw' | 'visible' | string[] }): ReadonlyArray<NeighborView>`

**契约:**

- 默认 `direction: 'both'`,默认 `projectTo: 'raw'`。
- `projectTo: 'raw'` 时返回存储原貌的邻居(不做 rollup 替换)。
- `projectTo: 'visible'` 时,每个原始邻居 id 都会用当前 `visibleIds` 跑一次 `getNearestVisibleAncestorId`;不能 rollup 到可见集合内的邻居会被丢弃。
- `projectTo: string[]` 时,用调用方提供的 visible 集合做同样的替换。
- 归档邻居总是被过滤。
- 按 `(neighborId, edgeType, direction)` 去重。

**何时使用:** 给自定义 LLM prompt 区块构造一个围绕焦点节点的邻居环。用 `projectTo: 'visible'` 与路由 LLM 看到的视图对齐。

**最小示例:**

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

**签名:** `getAncestor(id: string, options?: { activeOnly?: boolean, predicate?: (node: NodeView) => boolean }): NodeView | null`

**契约:**

- 沿 `parentId` 严格向上行走(高于输入节点),输入节点自身永远不会成为结果。
- 默认 `activeOnly: true` —— 遇到归档祖先时返回 `null`(视为未匹配)。
- 提供 `predicate` 时,返回第一个让 `predicate(view)` 为 truthy 的祖先。未提供 `predicate` 时,返回直接父节点(若有)。
- 防环:已访问 id 会被记录。

**何时使用:** 找最近的指定 level / type 祖先,例如"给我这条 `event` 上方的 `character_sheet` rollup"。

**最小示例:**

```js
const rollup = api.getAncestor('event_99', {
    predicate: n => n.level === 'semantic' && n.type === 'character_sheet',
});
```

### getDescendants(id, options?)

**签名:** `getDescendants(id: string, options?: { activeOnly?: boolean, maxDepth?: number }): ReadonlyArray<NodeView>`

**契约:**

- 对 `childrenIds` 做 BFS。
- 默认 `activeOnly: true` 过滤归档子节点。默认 `maxDepth: Infinity`。
- 按 BFS 顺序返回后代(第 1 层在前,然后第 2 层……)。
- 不包含根节点自身。

**何时使用:** 枚举一个 rollup 的内容,或者抓出挂在某个 `character_sheet` 下面的所有 event。

**最小示例:**

```js
const events = api.getDescendants('character_sheet_alice', { maxDepth: 2 });
console.log(events.length, 'descendants within depth 2');
```

### getNearestVisibleAncestor(id, options)

**签名:** `getNearestVisibleAncestor(id: string, options: { visibleNodeIds: Iterable<string> }): NodeView | null`

**契约:**

- `visibleNodeIds` **必填**。
- 行为与内部的 `getNearestVisibleAncestorId` 一致:从 `id` 向上行走,返回第一个 id 在 `visibleNodeIds` 中的节点。如果在匹配之前遇到归档祖先,或者从未在可见集合中找到任何祖先(包括输入节点自身),返回 `null`。
- 输入节点本身**也**可以作为它自己的"祖先",前提是它在 `visibleNodeIds` 里。

**何时使用:** 把一个叶子 id(例如某条 event)上卷到代表它的可见 rollup。`projectEdges` 用来投影原始边的就是这个原语。

**最小示例:**

```js
const visibleIds = new Set(api.listVisibleCandidates().map(n => n.id));
const rollup = api.getNearestVisibleAncestor('event_99', { visibleNodeIds: visibleIds });
```

### projectEdges(options)

**签名:** `projectEdges(options: { visibleNodeIds: Iterable<string>, edgeTypes?: string[], excludeInternal?: boolean }): ReadonlyArray<EdgeView>`

**契约:**

- `visibleNodeIds` **必填**。
- 默认 `excludeInternal: true` —— 剥除 `contains` / `semantic_contains` 边(与 `expandFromSeeds` 不同,后者默认 `false`,以对齐 `expandRouteCandidates`)。
- 对每条原始边,两端都会被上卷到最近的可见祖先;两端中任何一端 rollup 不到可见集合的边会被丢弃。
- 投影后 `(from, to, type)` 相同的边会被折叠;`weight` 是底层原始边的计数。
- 返回带 `weight` 的冻结 `EdgeView` 对象。
- 实现直接 re-export 内部的 `buildProjectedEdges` —— 没有偏移风险。

**何时使用:** 给路由 LLM(或自定义 LLM)构造一份尊重可见候选池的图快照。和 `listVisibleCandidates` 配对就能拿到路由 LLM 看到的 (节点, 边) 对。

**最小示例:**

```js
const visibleIds = new Set(api.listVisibleCandidates().map(n => n.id));
const projected = api.projectEdges({
    visibleNodeIds: visibleIds,
    edgeTypes: ['mentions', 'related'],
});
console.log(projected.length, 'projected semantic edges');
```

## Layer C: 召回原语

### listVisibleCandidates(options?)

**签名:** `listVisibleCandidates(options?: { seqWindow?: { from?: number, to?: number }, types?: string[], excludeRecentMessages?: number }): ReadonlyArray<NodeView>`

**契约:**

- 返回与 `chooseRecallRoute` 通过 `collectRootCandidates` 构造的同一份候选池 —— 但形式是深冻结的 `NodeView`。
- `excludeRecentMessages` 与原生 `isNodeInRecentExcludeWindow` 语义一致:过滤掉最近 N 条用户消息窗口内的节点。默认 0。
- `seqWindow` 与 `types` 在原生候选构造**之后**生效,用来收窄结果池。
- **按 `compareNodesByRecency` 排序**(seqTo 降序 → semanticDepth 降序 → id 字典序)—— 这是路由 LLM 看到的顺序,与 `listNodes` **不同**。

**何时使用:** 任何自定义召回插件的热路径入口。配合 `getNodeBrief` 按 id 调用来组装 `candidateRows` 区块。

**最小示例:**

```js
const candidates = api.listVisibleCandidates();
console.log(candidates.length, 'visible candidates');
```

### getNodeExposure(id)

**签名:** `getNodeExposure(id: string): 'high_only' | 'full' | null`

**契约:**

- 返回给定节点的 `getNodeRecallExposure(settings, node, context)`。
- 层级压缩类型的 semantic 节点返回 `'high_only'`(它们的字段被门控到仅"高重要性")。
- 其他任何活跃节点返回 `'full'`。
- 节点不存在或已归档时返回 `null`。
- 每次调用都重新计算,因此角色卡 override 立即生效。

**何时使用:** 决定自定义 prompt 中要渲染节点字段 payload 的哪一部分。镜像原生路由器的门控。

**最小示例:**

```js
const exposure = api.getNodeExposure('character_sheet_alice');
if (exposure === 'high_only') {
    // render only high-importance columns
}
```

### getEdgeSummary(id, options?)

**签名:** `getEdgeSummary(id: string, options?: { visibleNodeIds?: Iterable<string>, edgeTypes?: string[], limit?: number }): EdgeSummaryView`

**契约:**

- 直接包装内部的 `buildEdgeSummary` —— 行为没有偏移。
- 默认 `visibleNodeIds` 取当前 injection-state 的 `visibleIds`。**在召回流水线至少跑过一次之前为空。** 需要保证覆盖时显式传一个集合进来。
- 默认 `limit: 8`,与原生路由器一致。
- 总是返回冻结的 `EdgeSummaryView`;缺失 / 未知节点返回零度数 summary,绝不返回 `null`。

**何时使用:** 给自定义候选行附上紧凑的边视图,或者在不付出完整拓扑遍历代价的前提下查看节点邻域。

**最小示例:**

```js
const summary = api.getEdgeSummary('character_sheet_alice', { limit: 6 });
console.log(summary.degree, summary.sample_neighbors.length);
```

### getNodeBrief(id, options?)

**签名:** `getNodeBrief(id: string, options?: { visibleNodeIds?: Iterable<string>, includeEdgeSummary?: boolean, edgeSummaryLimit?: number }): NodeBriefView | null`

**契约:**

- 等价于路由 LLM `candidateRows` 区块中的一行:`formatNodeBrief` 投影,加上召回侧的几个字段(`exposure`、`edgeSummary`、`alwaysInject`)。
- 节点不存在或已归档时返回 `null`。
- 默认 `includeEdgeSummary: true`,默认 `edgeSummaryLimit: 8`。
- 默认 `visibleNodeIds` 取当前 injection-state 的 `visibleIds`。需要确定性投影时显式传集合。
- `alwaysInject` 反映当前 injection state 的 `alwaysInjectIds`。

**何时使用:** 自定义召回 LLM 输入的标准构件 —— 每个候选 id 调一次。

**最小示例:**

```js
const visibleIds = new Set(api.listVisibleCandidates().map(n => n.id));
const brief = api.getNodeBrief('character_sheet_alice', {
    visibleNodeIds: visibleIds,
    edgeSummaryLimit: 8,
});
console.log(brief.summary, brief.exposure, brief.alwaysInject);
```

### expandFromSeeds(seedIds, options?)

**签名:** `expandFromSeeds(seedIds: Iterable<string>, options?: { hops?: number, edgeTypes?: string[], projectTo?: 'raw' | 'visible' | string[], includeChildren?: boolean, excludeInternal?: boolean }): ReadonlyArray<NodeView>`

**契约:**

- 包装内部的 `expandRouteCandidates` —— 路由 LLM 决定继续深挖某个 seed 时触发的 BFS drill 扩张。
- 默认 `hops: 1`、`includeChildren: true`、`projectTo: 'visible'`,**`excludeInternal: false`**(与原生 `expandRouteCandidates` 对齐,在 drill 中 `contains` / `semantic_contains` 也会参与)。
- `projectTo: 'visible'` 时,drill 在当前 `visibleIds` 池内扩张(seed 自身永远准入)。
- `projectTo: 'raw'` 时,drill 跨整个 store 扩张。
- `projectTo: string[]` 时,drill 在调用方提供的集合内扩张。
- 设置 `excludeInternal: true` 会让行为对齐 `projectEdges` 的默认值(`contains` / `semantic_contains` 不参与)。

**何时使用:** 自定义召回流水线想"展开"一个 seed(例如某张 `character_sheet`),把它的子节点和一跳语义邻居拉进来。

**最小示例:**

```js
const expanded = api.expandFromSeeds(['character_sheet_alice'], {
    hops: 2,
    includeChildren: true,
});
console.log(expanded.length, 'nodes reachable');
```

### rankNodes(options)

**签名:** `rankNodes(options: { query: string, mode?: 'recency' | 'vector' | 'keyword' | 'hybrid', types?: string[], k?: number }): Promise<ReadonlyArray<ScoredNodeView>>`

**契约:**

- 为了 API 对称性总是返回 `Promise`;`'recency'` 与 `'keyword'` 同步 resolve,`'vector'` 与 `'hybrid'` 会 await 向量索引。
- 默认 `mode: 'recency'`,默认 `k: 20`。
- `query` 为空 / 缺失时,无论请求什么模式都强制走 `'recency'`(没有 query 可以排序)。
- 返回的 `scoreMode` 反映的是 fallback 之后**实际**使用的模式(见下)。

**模式:**

- `'recency'` —— 把活跃节点按 `seqTo` 降序排。`score` 等于 `seqTo`。与 query 无关;纯 LLM 召回最安全的默认值。
- `'keyword'` —— 用简单的 token 交集匹配每个节点的 `title` + 投影列 + spec 关键词。`score` 是归一化后的 matches / query-tokens。
- `'vector'` —— 委托给 `findSimilarNodes`(vector-index-core)。需要已构建好的向量索引和有效的 embedding profile。profile 无效或没命中时**回退到 `'recency'`**;此时 `scoreMode` 会是 `'recency'`。
- `'hybrid'` —— 归一化向量分与关键词分各占 50% 的混合。两端都为空时回退到 `'recency'`。

**何时使用:** 生成一个小而精的候选 id 排序短名单,再喂给 `getNodeBrief`。注意:即便有 `rankNodes`,LLM 召回的标准输入仍然是 `listVisibleCandidates` —— `rankNodes` 是给那些想拿 query 预过滤的短名单代替(或补充)完整候选池的插件用的。

**最小示例:**

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

## Layer D: 注入观察

### getInjectionState()

**签名:** `getInjectionState(): InjectionState`

**契约:**

- 返回一个冻结的 `InjectionState`,包含当前的 `alwaysInjectIds`、`recallSelectedIds`、`visibleIds`。
- `visibleIds` **在召回流水线至少跑过一次之前为空** —— 因此默认取"当前 visibleIds"的方法在首次使用时拿到的会是空集合。如果需要确保有候选池,先调用 `listVisibleCandidates()`,或显式传 `visibleNodeIds` 参数。
- 底层用 `Object.freeze` 包了 Set(JS 里 Set 内容严格说不是不可变的,但 API 文档把它视为只读;不要 mutate)。

**何时使用:** 同步查询当前注入状态 —— 例如渲染一个"该节点当前已注入"的 UI 徽章。

**最小示例:**

```js
const state = api.getInjectionState();
console.log(state.alwaysInjectIds.size, state.recallSelectedIds.size, state.visibleIds.size);
```

### onInjectionChanged(callback)

**签名:** `onInjectionChanged(callback: (state: InjectionState) => void): () => void`

**契约:**

- 把 `callback` 订阅到注入状态变更。callback 收到的是与 `getInjectionState()` 同形态的冻结 `InjectionState`。
- 返回一个 unsubscribe 函数。unsubscribe 是幂等的。
- 监听器异常会被 `console.warn` 捕获并记录 —— 不会打断 listener 链,也不会影响其他订阅者。
- 没有 debounce;一轮中 listener 可能多次触发(always-inject pass、recall pass、……)。

**何时使用:** 让 UI 或 sidekick 状态机与召回流水线保持同步。例如,在聊天侧边栏高亮当前活跃 rollup 的扩展可以在这里订阅。

**最小示例:**

```js
const unsubscribe = api.onInjectionChanged(state => {
    refreshInjectionUI(state.recallSelectedIds);
});
// Later:
unsubscribe();
```

## 实战示例:复刻原生召回 LLM 输入

`chooseRecallRoute` 构造的两个 LLM 输入区块是 `schema_overview` 和 `candidateRows`。用本 API 复刻它们非常直接:

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

完整的等价性保证 —— `candidateRows` 在字段层面和顺序层面都与原生路由器的输入一致 —— 由 dogfood 测试(`tests/memory-graph/read-api-dogfood.test.js`)强制保证,它通过 API 构造出相同的区块,并对原生 `chooseRecallRoute` 的内部状态断言结构相等。

## 兼容性

- `external-api.js` 的旧导出(`getCurrentlyInjectedNodeIds`、`__recordInjectedNodeIds`、`applyMemoryGraphInjectionUpdate`、`createEmptyInjectionState`)仍然保留 —— 现有插件无需改动。
- `getMemoryGraphInjectionState(context)` 也从 `read-api.js` 重新导出以保持对称:它返回与 `getInjectionState()` 同形态(`alwaysInjectIds`、`recallSelectedIds`、`visibleIds`)的结果。
- 工厂 `getMemoryGraphReadApi(context)` 不污染旧命名空间;import 它除了加载 read-api 模块之外没有任何副作用。
- API 按规范 §9 被标记为 `@experimental`,持续 2-3 个 minor 版本。该窗口内允许破坏性变更;字段语义会保留,但字段名和签名可能根据真实插件使用反馈而调整,直到 API 冻结为止。

## 性能

- `listNodes` / `listEdges` 会遍历整个 store —— 仅用于离线 / 一次性分析。开销随节点 / 边数线性增长。
- `listVisibleCandidates` 是热路径上的对应物 —— 开销与一次原生 `collectRootCandidates` 调用相当。它已预先应用召回侧过滤,调用方不必再付这部分代价。
- `getEdgeSummary` / `projectEdges` 不缓存 —— 每次调用都从原始边重新计算。按规范 §7,对典型召回 workload(每轮 1-2 次调用)这是可接受的。如果发现自己在热循环里按候选逐个调 `getEdgeSummary`,可以自己以 visible-id 集合为 key 缓存结果。
- `rankNodes(mode: 'vector' | 'hybrid')` 依赖向量索引已构建。两者在 profile 无效时都回退到 `'recency'`;返回的 `scoreMode` 反映的是实际用到的模式。
- 所有返回的视图都在构造时惰性冻结。对已冻结对象再次冻结是 no-op,因此对同一节点的重复读取在消费方一侧成本很低。

## 参见

- 原生召回路径:`public/scripts/extensions/memory-graph/main.js`(`chooseRecallRoute`、`collectRootCandidates`、`expandRouteCandidates`)
- 配套:orchestrator 的 `memory_scout` 子代理使用本 API —— 见 [Director 运行时](/zh-CN/features/orchestrator/director)。
- 相关扩展 API:[插件集成](/zh-CN/development/extension-api/plugin-integration),介绍了把 `getMemoryGraphReadApi` 和其他扩展入口一并暴露的扩展 API 注册表。
