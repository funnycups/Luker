# Memory Graph 外部 API

记忆图（memory-graph）扩展通过 `public/scripts/extensions/memory-graph/external-api.js` 暴露**只读**查询接口，供其他扩展（例如 orchestrator 的 loop 模式）按需查询节点，而不必直接读取 memory-graph 的内部数据结构或重复实现召回逻辑。

## 设计契约

- **只读** — 这些 export 不修改 store。需要写图请走 memory-graph 的主流程或设置面板。
- **由调用方加载 store** — 函数本身不会触发存储加载。调用方先通过 memory-graph 的现有路径取到 store（典型做法：从 floor-state 实例或扩展导出的 helper），再传入这些查询函数。
- **未启用时优雅降级** — 当用户停用 memory-graph 时，store 通常为空或不可用。这些函数对 `null/undefined` store 与空查询都返回空结果，而不是抛错；调用方可以照常调用，不必预先做存在性判断。

## API

### `getCurrentlyInjectedNodeIds(context)`

返回 memory-graph 主流程在当前聊天回合**已注入**主上下文的节点 id 集合。两类：

- `alwaysInjectIds`：标记为 `alwaysInject` 的常驻节点
- `recallSelectedIds`：本回合召回管线选出的节点

```js
import { getCurrentlyInjectedNodeIds } from '../memory-graph/external-api.js';

const { alwaysInjectIds, recallSelectedIds } = getCurrentlyInjectedNodeIds(context);
const allInjected = new Set([...alwaysInjectIds, ...recallSelectedIds]);
// 把并集作为 excludeIds 传给后续查询，避免再次返回主上下文已有的节点
```

返回的两个 `Set` 是防御性副本：调用方对它们做任何修改都不会影响下次 `getCurrentlyInjectedNodeIds` 的结果。memory-graph 主流程在每次召回结算后写入这两组 id；当主流程触发了 snapshot 复用、跳过了完整召回时，保留上一次完整召回写入的值——因为 snapshot 复用意味着相同 anchor 的注入结果未变。

### `searchNodesLexical(store, query, options?)`

按子串做大小写不敏感的词法搜索。**不依赖向量配置**——这是有意为之，确保未启用 vector embedding 的用户也能调用。

```js
import { searchNodesLexical } from '../memory-graph/external-api.js';

const result = searchNodesLexical(store, 'autumn', {
    limit: 5,
    excludeIds: new Set(['n42']),
});
// → { nodes: [{ id, preview, type?, time? }] }
```

匹配范围与召回管线 `computeLexicalScore` 一致：节点的 `title` 加上 `fields.title / fields.name / fields.summary / fields.state / fields.traits / fields.constraint / fields.key_sentences / fields.aliases` 的拼接结果。命中后返回的 `preview` 截断到 300 字符；`time` 取自 `node.seqTo`。已归档（`archived`）节点会被跳过。

`options.excludeIds` 接受 `Set` 或任意可迭代对象。

### `listRecentNodes(store, options?)`

按时间倒序浏览节点，复用 `graph-ops.js` 的 `compareNodesByTimeline`。适合"看时间线挑节点"的场景，例如 loop agent 想知道最近发生了什么。

```js
const result = listRecentNodes(store, { limit: 10, excludeIds });
// → { nodes: [{ id, preview, time?, type? }] }
```

默认 `limit=10`。同样跳过 `archived` 节点。

### `getNodeById(store, id, options?)`

按 id 取节点，可选附带直连邻居。邻居返回 `{id, edgeType?, relation?}`——只是引用，不内联完整节点；调用方需要时再用一次 `getNodeById`。

```js
const result = getNodeById(store, 'n42', { includeNeighbors: true });
// → { node, neighbors: [{ id, edgeType, relation? }] } | null
```

`includeNeighbors` 默认 `true`。store 缺失或 id 不存在返回 `null`。`store.nodes` 既支持普通对象映射（生产形态），也兼容 `Map`（便于测试）。

## 预留接口（不在 MVP 范围）

以下 export 已在文件顶部注释列出，计划在有具体场景需求时再加，目前不实现：

- `searchNodesHybrid(store, query, options)` — 调 `runHybridRecall`，需要向量索引配置
- `hasNode(store, id) -> boolean` — 存在性检查
- `findNodesByEntity(store, entityName)` — 按实体浏览
- `getNeighbors(store, id, {edgeTypes})` — 独立取邻居 + 边类型过滤

## 调用示例：orchestrator loop 模式

orchestrator 的 loop 模式工具 `memory.search` / `memory.list_recent` / `memory.get` 都是这些 API 的薄壳，关键的 dedup 逻辑就是把"已注入"的两组 id 取并集：

```js
// orchestrator/loop-tools/memory.js
import {
    searchNodesLexical,
    getCurrentlyInjectedNodeIds,
} from '../../memory-graph/external-api.js';

export async function memorySearch({ query, limit }, context) {
    const store = await loadStore(context);   // 调用方负责
    if (!store) return { nodes: [] };          // 未启用时直接空返回
    const { alwaysInjectIds, recallSelectedIds } = getCurrentlyInjectedNodeIds(context);
    const excludeIds = new Set([...alwaysInjectIds, ...recallSelectedIds]);
    return searchNodesLexical(store, query, { limit, excludeIds });
}
```

这样 loop agent 看到的搜索结果，永远不会和主模型已有的注入内容重叠——既省 token，也避免它在 capsule 里重复主上下文已有的信息。
