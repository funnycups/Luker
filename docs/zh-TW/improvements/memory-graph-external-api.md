# Memory Graph 外部 API

記憶圖(memory-graph)擴充功能透過 `public/scripts/extensions/memory-graph/external-api.js` 暴露**唯讀**查詢介面,供其他擴充功能(例如 orchestrator 的 loop 模式)按需查詢節點,而不必直接讀取 memory-graph 的內部資料結構或重複實作召回邏輯。

## 設計契約

- **唯讀** — 這些 export 不修改 store。需要寫圖請走 memory-graph 的主流程或設定面板。
- **由呼叫方載入 store** — 函數本身不會觸發儲存載入。呼叫方先透過 memory-graph 的現有路徑取到 store(典型做法:從 floor-state 執行個體或擴充功能匯出的 helper),再傳入這些查詢函數。
- **未啟用時優雅降級** — 當使用者停用 memory-graph 時,store 通常為空或不可用。這些函數對 `null/undefined` store 與空查詢都回傳空結果,而不是拋錯;呼叫方可以照常呼叫,不必預先做存在性判斷。

## API

### `getCurrentlyInjectedNodeIds(context)`

回傳 memory-graph 主流程在當前聊天回合**已注入**主上下文的節點 id 集合。兩類:

- `alwaysInjectIds`:標記為 `alwaysInject` 的常駐節點
- `recallSelectedIds`:本回合召回管線選出的節點

```js
import { getCurrentlyInjectedNodeIds } from '../memory-graph/external-api.js';

const { alwaysInjectIds, recallSelectedIds } = getCurrentlyInjectedNodeIds(context);
const allInjected = new Set([...alwaysInjectIds, ...recallSelectedIds]);
// 把聯集作為 excludeIds 傳給後續查詢,避免再次回傳主上下文已有的節點
```

回傳的兩個 `Set` 是防禦性副本:呼叫方對它們做任何修改都不會影響下次 `getCurrentlyInjectedNodeIds` 的結果。memory-graph 主流程在每次召回結算後寫入這兩組 id;當主流程觸發了 snapshot 複用、跳過了完整召回時,保留上一次完整召回寫入的值——因為 snapshot 複用意味著相同 anchor 的注入結果未變。

### `searchNodesLexical(store, query, options?)`

按子字串做大小寫不敏感的詞法搜尋。**不依賴向量配置**——這是有意為之,確保未啟用 vector embedding 的使用者也能呼叫。

```js
import { searchNodesLexical } from '../memory-graph/external-api.js';

const result = searchNodesLexical(store, 'autumn', {
    limit: 5,
    excludeIds: new Set(['n42']),
});
// → { nodes: [{ id, preview, type?, time? }] }
```

匹配範圍與召回管線 `computeLexicalScore` 一致:節點的 `title` 加上 `fields.title / fields.name / fields.summary / fields.state / fields.traits / fields.constraint / fields.key_sentences / fields.aliases` 的拼接結果。命中後回傳的 `preview` 截斷到 300 字元;`time` 取自 `node.seqTo`。已封存(`archived`)節點會被跳過。

`options.excludeIds` 接受 `Set` 或任意可迭代物件。

### `listRecentNodes(store, options?)`

按時間倒序瀏覽節點,複用 `graph-ops.js` 的 `compareNodesByTimeline`。適合"看時間軸挑節點"的場景,例如 loop agent 想知道最近發生了什麼。

```js
const result = listRecentNodes(store, { limit: 10, excludeIds });
// → { nodes: [{ id, preview, time?, type? }] }
```

預設 `limit=10`。同樣跳過 `archived` 節點。

### `getNodeById(store, id, options?)`

按 id 取節點,可選附帶直連鄰居。鄰居回傳 `{id, edgeType?, relation?}`——只是引用,不內聯完整節點;呼叫方需要時再用一次 `getNodeById`。

```js
const result = getNodeById(store, 'n42', { includeNeighbors: true });
// → { node, neighbors: [{ id, edgeType, relation? }] } | null
```

`includeNeighbors` 預設 `true`。store 缺失或 id 不存在回傳 `null`。`store.nodes` 既支援普通物件對映(生產形態),也相容 `Map`(便於測試)。

## 呼叫範例:orchestrator loop 模式

orchestrator 的 loop 模式工具 `memory_search` / `memory_list_recent` / `memory_get` 都是這些 API 的薄殼,關鍵的 dedup 邏輯就是把"已注入"的兩組 id 取聯集:

```js
// orchestrator/loop-tools/memory.js
import {
    searchNodesLexical,
    getCurrentlyInjectedNodeIds,
} from '../../memory-graph/external-api.js';

export async function memorySearch({ query, limit }, context) {
    const store = await loadStore(context);   // 呼叫方負責
    if (!store) return { nodes: [] };          // 未啟用時直接空回傳
    const { alwaysInjectIds, recallSelectedIds } = getCurrentlyInjectedNodeIds(context);
    const excludeIds = new Set([...alwaysInjectIds, ...recallSelectedIds]);
    return searchNodesLexical(store, query, { limit, excludeIds });
}
```

這樣 loop agent 看到的搜尋結果,永遠不會和主模型已有的注入內容重疊——既省 token,也避免它在 capsule 裡重複主上下文已有的資訊。
