# 記憶圖擴充 API

> 狀態:實驗性(依規範 §9,會在 2-3 個 minor 版本內出現破壞性變更)
>
> 入口:
> - **推薦:** `getExtensionApi('memory-graph').openSession(context)`,來自 `public/scripts/extensions.js`(會話外觀)
> - 底層:`getMemoryGraphReadApi(store, context)`,來自 `public/scripts/extensions/memory-graph/read-api.js`(讀工廠)
> - 底層:`getMemoryGraphWriteApi(store, context)`,來自 `public/scripts/extensions/memory-graph/write-api.js`(寫工廠)

## 會話 API(推薦入口)

透過 Luker 的擴充註冊表開啟一個聊天作用域的會話:

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

// Write
const { id } = session.createNode({ type: 'event', title: 'Alice draws her sword', fields: { what: '...' } });
session.editNode({ id, setFields: { who: ['Alice', 'Bob'] } });
session.upsertLinks({ source: { id }, links: [{ to: 'alice_node', relation: 'about' }] });
session.deleteLinks({ source: { id }, target: { id: 'bob_node' }, relation: 'about' });
session.compactNodes({ type: 'event', childIds: [...], summary: '...' });
```

`'memory-graph'` 這個 extension api 透過 Luker 的 `registerExtensionApi(name, api)` 機制發布 —— `card-app` 等其他 Luker 擴充用的是同一套。第三方擴充接入 memory-graph 時應統一走 `getExtensionApi('memory-graph')`,不要直接 import `memory-graph/*.js`。

### 生命週期

每次 `openSession` 呼叫都會解析目前聊天的 store 快照。如果使用者切換聊天,或者你想讀取另一條路徑剛做出的改動,再呼叫一次 `openSession` 即可 —— 會話開銷很低,可以放心多開。

### 空 store

從未跑過 extraction 的聊天仍然可以拿到一個可寫會話。讀方法回傳空陣列;寫方法會填充 store,並透過原生 extraction 流水線相同的 floor-state 路徑完成持久化。這意味著在一個全新聊天上的第一次寫入不需要任何前置準備。

### `openSession` 回傳 `null` 的情境

- memory-graph 擴充沒載入(`getExtensionApi('memory-graph')` 回傳了 `undefined`)。
- context 缺少 `createFloorState`(典型情況是測試執行器沒有把 SillyTavern context mock 完整)。

orchestrator 的 `memory_*` loop 工具會把 `null` 會話翻譯成 `ToolError(MEMORY_DISABLED)`,以便 agent 改走別的路線。

### 方法參考

回傳的 session 物件上一共 16 個方法:

| 方法 | 回傳 | 備註 |
| --- | --- | --- |
| `listVisibleCandidates(opts)` | `NodeView[]` | 原生召回 LLM 看到的候選池 |
| `getEdgeSummary(id, opts)` | `EdgeSummaryView` | 度數 + 關係 + 鄰居取樣 |
| `getNodeBrief(id, opts)` | `NodeBriefView \| null` | 含欄位與邊的完整 brief |
| `expandFromSeeds(ids, opts)` | `NodeView[]` | 對一組種子做 BFS 擴張 |
| `getSchema()` | `SchemaView` | 目前生效的節點類型 schema |
| `keywordSearch(opts)` | `RankedView[]` | 可見節點上的 token 重疊搜尋 |
| `vectorSearch(opts)` | `Promise<RankedView[]>` | 向量搜尋;丟出 `NO_EMBEDDING_PROFILE` |
| `findByName(opts)` | `{ matches: NodeView[] }` | 按 title + 主鍵欄位做精確 / 子字串比對 |
| `compactionCandidates(opts)` | `{ groups: ... }` | 準備好 rollup 的語意根節點 |
| `createNode(op)` | `{ id }` | 建立節點 |
| `editNode(op)` | `{ ok }` | 改欄位 / 改名 |
| `deleteNode(op)` | `{ ok }` | 歸檔(軟刪除) |
| `upsertLinks(op)` | `{ applied }` | 新增或更新邊 |
| `deleteLinks(op)` | `{ removed }` | 刪除一條具體邊 |
| `compactNodes(op)` | `{ rollupNodeId }` | 把子節點捲入一個語意父節點 |
| `applyExtractionBatch(input)` | `{ applied, rejected }` | 一次性多 op 批次處理 |

各方法的完整簽名見下文 **Read API** 與 **Write API** 段落 —— `openSession` 內部就是委派給那些工廠的。

### 底層存取

`getMemoryGraphReadApi(store, context)` 與 `getMemoryGraphWriteApi(store, context)` 仍然匯出,供已經持有 store 參照的內部呼叫端使用(例如原生 `chooseRecallRoute` 流水線)。第三方擴充應優先使用 `openSession` —— 會話外觀把 store 載入、空聊天兜底、透過 Luker 標準 extension api 的註冊都收在了一處。

## 概覽

memory-graph 擴充驅動 Luker 的長期召回 —— 它把精選後的節點池(`character_sheet`、`event`、`relationship`、……)加上每個節點的 `edge_summary` 餵給一個「路由」LLM,由它挑出下一輪要注入哪些記憶。原生流水線(`main.js` 中的 `chooseRecallRoute` / `collectRootCandidates`)透過一組內部 helper —— `buildProjectedEdges`、`getNearestVisibleAncestorId`、`formatNodeBrief` 等等 —— 構造出 LLM 輸入。

`getMemoryGraphReadApi(store, context)` 把同一份資料、拓撲與召回原語暴露成一個深凍結、對呼叫端安全的 API 介面。預期消費者是 agent 風格的外掛,自己跑一遍 LLM 驅動的召回 —— 例如 orchestrator 的 `memory_scout` 子代理 —— 用操作者偏好的模型 / preset,對著原生路由器看到的完全一樣的候選池與欄位投影來工作。

`getMemoryGraphWriteApi(store, context)` 是與之配套的變更介面:一個 extractor 風格的 agent(或在兩輪對話之間編輯圖的 curator agent)透過它寫入,而不是去碰 store 內部。Write API 詳見下文 [Write API](#write-api)。

讀 API 是嚴格唯讀的:

- 回傳的 view 都是深凍結的純物件 / 陣列 / Set。工廠從不回傳 store 內部參照。
- View 在每次呼叫時從傳入的 store 合成,所以單個 API 實例在該 store 參照的生命週期內始終有效。
- 所有變更都走 Write API;讀工廠不暴露寫路徑。

## 快速開始

```js
import { getExtensionApi } from '/scripts/extensions.js';

const session = await getExtensionApi('memory-graph')?.openSession?.(Luker.getContext());
if (!session) return;

// Enumerate the visible candidate pool the native recall LLM sees.
const candidates = session.listVisibleCandidates();

// Get a brief for one node — id, summary, edge_summary, exposure, always_inject.
const brief = session.getNodeBrief(candidates[0].id);
```

如果你已經持有一個 store 參照(僅限內部呼叫端),可以直接建構讀工廠:

```js
import { getMemoryGraphReadApi } from '/scripts/extensions/memory-graph/read-api.js';

const api = getMemoryGraphReadApi(store, context);
const candidates = api.listVisibleCandidates();
// ... onInjectionChanged、listNodes、projectEdges 等方法都掛在這裡。
const unsubscribe = api.onInjectionChanged(state => {
    console.log('injection changed', state.alwaysInjectIds.size, state.recallSelectedIds.size);
});
```

## 型別參考

所有介面都以深凍結的純物件回傳(標注為 `ReadonlySet` 的欄位會被凍結 `Set` 包一層)。欄位語意對齊規範 §4.1。

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

單個節點的標準 view。`fields` 是對齊 schema `tableColumns` 的列 payload;取值可以是字串、數字或陣列,取決於欄位定義。

### EdgeView

```ts
interface EdgeView {
    from: string;
    to: string;
    type: string;                     // 'related' / 'mentions' / 'contains' / 'semantic_contains' / ...
    weight?: number;                  // present only on projectEdges() output
}
```

兩個節點之間的有向關係。原始邊(`listEdges`、`getNeighbors`)從不帶 `weight`;投影後的邊(`projectEdges`)攜帶聚合權重 —— 來自同源同向邊折疊後的計數。

### NeighborView

```ts
interface NeighborView {
    node: NodeView;
    edgeType: string;
    direction: 'in' | 'out';
}
```

從某個具體源節點視角看到的一個鄰居。`direction` 相對源節點而言:`'out'` 表示一條 `source -> neighbor` 邊;`'in'` 表示 `neighbor -> source`。

### EdgeSummaryView

```ts
interface EdgeSummaryView {
    degree: number;
    relations: ReadonlyArray<{ relation: string; direction: 'in' | 'out'; count: number }>;
    sample_neighbors: ReadonlyArray<{ id: string; type: string; title: string }>;
}
```

原生召回 LLM 每列候選看到的精簡邊 view。按 `(relation, direction)` 配對聚合計數;`sample_neighbors` 是去重後的鄰居節點的有限取樣(預設 8 個)。欄位名用 snake_case 以匹配原生 LLM prompt 區塊。

### InjectionState

```ts
interface InjectionState {
    alwaysInjectIds: ReadonlySet<string>;
    recallSelectedIds: ReadonlySet<string>;
    visibleIds: ReadonlySet<string>;
}
```

注入側的觀察面。`alwaysInjectIds` 是被節點類型 `alwaysInject` 旗標固定下來的節點。`recallSelectedIds` 是路由 LLM 為上一輪選中的節點。`visibleIds` 是路由 LLM 看到的候選池 —— *在召回流水線至少跑過一次之前為空*。

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

某個節點類型的角色卡生效後 schema 規格。與內部 `getEffectiveNodeTypeSchema` 回傳的內容完全一致;角色卡 override(若有)已經套用。用來組裝 `schema_overview` LLM prompt 區塊。

### SchemaView

```ts
interface SchemaView {
    types: ReadonlyArray<SchemaSpecView>;
}
```

`getSchema()` 回傳的容器。`types` 的順序遵循 schema 的自然定義順序。

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

原生召回 LLM 每列候選看到的單節點「brief」。等價於 `formatNodeBrief` 的輸出,加上路由器在序列化前補的幾個召回側欄位(`exposure`、`edgeSummary`、`alwaysInject`)。外掛複刻原生召回輸入時,就是把它當作 `candidateRows` 區塊的最小單元來組裝。

## Layer A: 資料存取

### listNodes(filter?)

**簽名:** `listNodes(filter?: { types?: string[], levels?: Array<'episodic' | 'semantic'>, activeOnly?: boolean, seqRange?: { from?: number, to?: number } }): ReadonlyArray<NodeView>`

**契約:**

- 預設 `activeOnly: true` —— 排除歸檔節點與召回診斷節點(過濾規則與原生 `collectAlwaysInjectNodes` 一致)。
- 按 `compareNodesByTimeline` 排序(seqTo 升序,id 平手)—— 用於離線分析的穩定時間軸順序。這與 `listVisibleCandidates` **不同**,後者按 `compareNodesByRecency` 排序(seqTo 降序、depth 降序、id 字典序)。
- 回傳凍結的 `NodeView` 物件的凍結陣列。陣列本身、每個 view、每個 `fields` record、每個 `childrenIds` 陣列都是凍結的。

**何時使用:** 對整個 store 做離線掃描 —— 除錯、一次性統計、窮舉走訪。複刻召回的熱路徑呼叫端應改用 `listVisibleCandidates`,它的順序跟路由 LLM 輸入對齊,且已經套用了召回側過濾。

**最小範例:**

```js
const events = api.listNodes({ types: ['event'], seqRange: { from: 100 } });
console.log(events.length, 'events on or after seq 100');
```

### getNode(id)

**簽名:** `getNode(id: string): NodeView | null`

**契約:**

- 回傳給定 id 對應的凍結 `NodeView`;若 store 中不存在該 id,回傳 `null`。
- **不**按 `archived` 過濾 —— 歸檔節點會以 `archived: true` 的形式回傳,允許明確需要檢視的呼叫端拿到它們。
- 純空白 / 空字串 id 回傳 `null`。

**何時使用:** 解參照從其他 API 呼叫拿到的 id(child id、neighbor id、injection state id)。

**最小範例:**

```js
const node = api.getNode('node_42');
if (node) console.log(node.type, node.title);
```

### listEdges(filter?)

**簽名:** `listEdges(filter?: { from?: string, to?: string, types?: string[], excludeInternal?: boolean }): ReadonlyArray<EdgeView>`

**契約:**

- 回傳**儲存側原始邊**,非投影(沒有 weight 聚合、沒有 rollup 替換)。
- `excludeInternal: true` 剝除層級 bookkeeping 邊 `contains` 與 `semantic_contains` —— 只想要語意關係時有用。
- 回傳的邊沒有 weight 欄位。要拿到帶權重的投影邊,用 `projectEdges`。

**何時使用:** 離線邊檢查、建構自訂拓撲索引,或給非召回類的分析器供資料。要建構 LLM 召回輸入,優先用 `projectEdges` 或 `getEdgeSummary`。

**最小範例:**

```js
const mentions = api.listEdges({ types: ['mentions'], excludeInternal: true });
console.log(mentions.length, 'semantic mention edges');
```

### getSchema()

**簽名:** `getSchema(): SchemaView`

**契約:**

- 回傳角色卡生效後的 schema(即 `getEffectiveNodeTypeSchema(context, settings)`)。角色卡 override(若有)已經套用。
- 每個 `SchemaSpecView` 都是凍結的,內部陣列(`tableColumns`、`requiredColumns`、`primaryKeyColumns`)也都是凍結的。
- 這是原生召回 LLM 輸入中 `schema_overview` 區塊的源資料。

**何時使用:** 建構 `schema_overview` prompt 區塊時,或基於 schema 衍生的投影(哪些欄位是主鍵、哪些是必填等)做反射時。

**最小範例:**

```js
const schema = api.getSchema();
for (const spec of schema.types) {
    console.log(spec.type, spec.tableName, [...spec.tableColumns]);
}
```

## Layer B: 拓撲導覽

### getNeighbors(id, options?)

**簽名:** `getNeighbors(id: string, options?: { edgeTypes?: string[], direction?: 'in' | 'out' | 'both', projectTo?: 'raw' | 'visible' | string[] }): ReadonlyArray<NeighborView>`

**契約:**

- 預設 `direction: 'both'`,預設 `projectTo: 'raw'`。
- `projectTo: 'raw'` 時回傳儲存原貌的鄰居(不做 rollup 替換)。
- `projectTo: 'visible'` 時,每個原始鄰居 id 都會用目前 `visibleIds` 跑一次 `getNearestVisibleAncestorId`;無法 rollup 到可見集合內的鄰居會被丟棄。
- `projectTo: string[]` 時,用呼叫端提供的 visible 集合做同樣的替換。
- 歸檔鄰居總是被過濾。
- 按 `(neighborId, edgeType, direction)` 去重。

**何時使用:** 給自訂 LLM prompt 區塊建構一個圍繞焦點節點的鄰居環。用 `projectTo: 'visible'` 與路由 LLM 看到的視角對齊。

**最小範例:**

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

**簽名:** `getAncestor(id: string, options?: { activeOnly?: boolean, predicate?: (node: NodeView) => boolean }): NodeView | null`

**契約:**

- 沿 `parentId` 嚴格向上走訪(高於輸入節點),輸入節點自身永遠不會成為結果。
- 預設 `activeOnly: true` —— 遇到歸檔祖先時回傳 `null`(視為未匹配)。
- 提供 `predicate` 時,回傳第一個讓 `predicate(view)` 為 truthy 的祖先。未提供 `predicate` 時,回傳直接父節點(若有)。
- 防迴圈:已走訪 id 會被記錄。

**何時使用:** 尋找最近的指定 level / type 祖先,例如「給我這條 `event` 上方的 `character_sheet` rollup」。

**最小範例:**

```js
const rollup = api.getAncestor('event_99', {
    predicate: n => n.level === 'semantic' && n.type === 'character_sheet',
});
```

### getDescendants(id, options?)

**簽名:** `getDescendants(id: string, options?: { activeOnly?: boolean, maxDepth?: number }): ReadonlyArray<NodeView>`

**契約:**

- 對 `childrenIds` 做 BFS。
- 預設 `activeOnly: true` 過濾歸檔子節點。預設 `maxDepth: Infinity`。
- 按 BFS 順序回傳後代(第 1 層在前,然後第 2 層……)。
- 不包含根節點自身。

**何時使用:** 列舉一個 rollup 的內容,或抓出掛在某個 `character_sheet` 下面的所有 event。

**最小範例:**

```js
const events = api.getDescendants('character_sheet_alice', { maxDepth: 2 });
console.log(events.length, 'descendants within depth 2');
```

### getNearestVisibleAncestor(id, options)

**簽名:** `getNearestVisibleAncestor(id: string, options: { visibleNodeIds: Iterable<string> }): NodeView | null`

**契約:**

- `visibleNodeIds` **必填**。
- 行為與內部的 `getNearestVisibleAncestorId` 一致:從 `id` 向上走訪,回傳第一個 id 在 `visibleNodeIds` 中的節點。如果在匹配之前遇到歸檔祖先,或從未在可見集合中找到任何祖先(包括輸入節點自身),回傳 `null`。
- 輸入節點本身**也**可以作為它自己的「祖先」,前提是它在 `visibleNodeIds` 裡。

**何時使用:** 把一個葉節點 id(例如某條 event)上捲到代表它的可見 rollup。`projectEdges` 用來投影原始邊的就是這個原語。

**最小範例:**

```js
const visibleIds = new Set(api.listVisibleCandidates().map(n => n.id));
const rollup = api.getNearestVisibleAncestor('event_99', { visibleNodeIds: visibleIds });
```

### projectEdges(options)

**簽名:** `projectEdges(options: { visibleNodeIds: Iterable<string>, edgeTypes?: string[], excludeInternal?: boolean }): ReadonlyArray<EdgeView>`

**契約:**

- `visibleNodeIds` **必填**。
- 預設 `excludeInternal: true` —— 剝除 `contains` / `semantic_contains` 邊(與 `expandFromSeeds` 不同,後者預設 `false`,以對齊 `expandRouteCandidates`)。
- 對每條原始邊,兩端都會被上捲到最近的可見祖先;兩端中任何一端 rollup 不到可見集合的邊會被丟棄。
- 投影後 `(from, to, type)` 相同的邊會被折疊;`weight` 是底層原始邊的計數。
- 回傳帶 `weight` 的凍結 `EdgeView` 物件。
- 實作直接 re-export 內部的 `buildProjectedEdges` —— 沒有偏移風險。

**何時使用:** 給路由 LLM(或自訂 LLM)建構一份尊重可見候選池的圖快照。與 `listVisibleCandidates` 配對就能拿到路由 LLM 看到的 (節點, 邊) 對。

**最小範例:**

```js
const visibleIds = new Set(api.listVisibleCandidates().map(n => n.id));
const projected = api.projectEdges({
    visibleNodeIds: visibleIds,
    edgeTypes: ['mentions', 'related'],
});
console.log(projected.length, 'projected semantic edges');
```

## Layer C: 召回原語

### listVisibleCandidates(options?)

**簽名:** `listVisibleCandidates(options?: { seqWindow?: { from?: number, to?: number }, types?: string[], excludeRecentMessages?: number }): ReadonlyArray<NodeView>`

**契約:**

- 回傳與 `chooseRecallRoute` 透過 `collectRootCandidates` 建構的同一份候選池 —— 但形式是深凍結的 `NodeView`。
- `excludeRecentMessages` 與原生 `isNodeInRecentExcludeWindow` 語意一致:過濾掉最近 N 條使用者訊息視窗內的節點。預設 0。
- `seqWindow` 與 `types` 在原生候選建構**之後**生效,用來收窄結果池。
- **按 `compareNodesByRecency` 排序**(seqTo 降序 → semanticDepth 降序 → id 字典序)—— 這是路由 LLM 看到的順序,與 `listNodes` **不同**。

**何時使用:** 任何自訂召回外掛的熱路徑入口。配合 `getNodeBrief` 按 id 呼叫來組裝 `candidateRows` 區塊。

**最小範例:**

```js
const candidates = api.listVisibleCandidates();
console.log(candidates.length, 'visible candidates');
```

### getNodeExposure(id)

**簽名:** `getNodeExposure(id: string): 'high_only' | 'full' | null`

**契約:**

- 回傳給定節點的 `getNodeRecallExposure(settings, node, context)`。
- 層級壓縮類型的 semantic 節點回傳 `'high_only'`(它們的欄位被閘控到僅「高重要性」)。
- 其他任何活躍節點回傳 `'full'`。
- 節點不存在或已歸檔時回傳 `null`。
- 每次呼叫都重新計算,因此角色卡 override 立即生效。

**何時使用:** 決定自訂 prompt 中要渲染節點欄位 payload 的哪一部分。鏡像原生路由器的閘控。

**最小範例:**

```js
const exposure = api.getNodeExposure('character_sheet_alice');
if (exposure === 'high_only') {
    // render only high-importance columns
}
```

### getEdgeSummary(id, options?)

**簽名:** `getEdgeSummary(id: string, options?: { visibleNodeIds?: Iterable<string>, edgeTypes?: string[], limit?: number }): EdgeSummaryView`

**契約:**

- 直接包裝內部的 `buildEdgeSummary` —— 行為沒有偏移。
- 預設 `visibleNodeIds` 取目前 injection-state 的 `visibleIds`。**在召回流水線至少跑過一次之前為空。** 需要保證覆蓋時明確傳一個集合進來。
- 預設 `limit: 8`,與原生路由器一致。
- 總是回傳凍結的 `EdgeSummaryView`;缺失 / 未知節點回傳零度數 summary,絕不回傳 `null`。

**何時使用:** 給自訂候選列附上精簡的邊 view,或在不付出完整拓撲走訪代價的前提下檢視節點鄰域。

**最小範例:**

```js
const summary = api.getEdgeSummary('character_sheet_alice', { limit: 6 });
console.log(summary.degree, summary.sample_neighbors.length);
```

### getNodeBrief(id, options?)

**簽名:** `getNodeBrief(id: string, options?: { visibleNodeIds?: Iterable<string>, includeEdgeSummary?: boolean, edgeSummaryLimit?: number }): NodeBriefView | null`

**契約:**

- 等價於路由 LLM `candidateRows` 區塊中的一列:`formatNodeBrief` 投影,加上召回側的幾個欄位(`exposure`、`edgeSummary`、`alwaysInject`)。
- 節點不存在或已歸檔時回傳 `null`。
- 預設 `includeEdgeSummary: true`,預設 `edgeSummaryLimit: 8`。
- 預設 `visibleNodeIds` 取目前 injection-state 的 `visibleIds`。需要決定性投影時明確傳集合。
- `alwaysInject` 反映目前 injection state 的 `alwaysInjectIds`。

**何時使用:** 自訂召回 LLM 輸入的標準組件 —— 每個候選 id 呼叫一次。

**最小範例:**

```js
const visibleIds = new Set(api.listVisibleCandidates().map(n => n.id));
const brief = api.getNodeBrief('character_sheet_alice', {
    visibleNodeIds: visibleIds,
    edgeSummaryLimit: 8,
});
console.log(brief.summary, brief.exposure, brief.alwaysInject);
```

### expandFromSeeds(seedIds, options?)

**簽名:** `expandFromSeeds(seedIds: Iterable<string>, options?: { hops?: number, edgeTypes?: string[], projectTo?: 'raw' | 'visible' | string[], includeChildren?: boolean, excludeInternal?: boolean }): ReadonlyArray<NodeView>`

**契約:**

- 包裝內部的 `expandRouteCandidates` —— 路由 LLM 決定繼續深挖某個 seed 時觸發的 BFS drill 擴張。
- 預設 `hops: 1`、`includeChildren: true`、`projectTo: 'visible'`,**`excludeInternal: false`**(與原生 `expandRouteCandidates` 對齊,在 drill 中 `contains` / `semantic_contains` 也會參與)。
- `projectTo: 'visible'` 時,drill 在目前 `visibleIds` 池內擴張(seed 自身永遠准入)。
- `projectTo: 'raw'` 時,drill 跨整個 store 擴張。
- `projectTo: string[]` 時,drill 在呼叫端提供的集合內擴張。
- 設定 `excludeInternal: true` 會讓行為對齊 `projectEdges` 的預設值(`contains` / `semantic_contains` 不參與)。

**何時使用:** 自訂召回流水線想「展開」一個 seed(例如某張 `character_sheet`),把它的子節點與一跳語意鄰居拉進來。

**最小範例:**

```js
const expanded = api.expandFromSeeds(['character_sheet_alice'], {
    hops: 2,
    includeChildren: true,
});
console.log(expanded.length, 'nodes reachable');
```

### keywordSearch(options)

**簽名:** `keywordSearch(options: { query: string, types?: string[], k?: number }): ReadonlyArray<NodeView & { score: number, scoreMode: 'keyword' }>`

**契約:**

- 在每個節點的 `title` 與 schema 投影欄位上做 token 交集搜尋。大小寫不敏感。
- `score` 為每個節點的 `matches / queryTokenCount`;結果按 `score` 降序排,並在 `k`(預設 `20`)處截斷。
- `query` 為空 / 僅含空白時回傳空陣列(不丟錯)。
- 永遠可用 —— 不需要 embedding profile,不做非同步,不會回退到 recency。

**何時使用:** 當你需要一份按 query 預過濾的候選 id 短名單、又不能依賴 embedding profile 已設定時的安全預設值。也是 `vectorSearch` 丟出 `NO_EMBEDDING_PROFILE` 時推薦的回退方案。

**最小範例:**

```js
const hits = api.keywordSearch({
    query: 'Eileen',
    types: ['character_sheet'],
});
// hits: [{ id, title, ..., score: 0.5, scoreMode: 'keyword' }, ...]
```

### vectorSearch(options)

**簽名:** `vectorSearch(options: { query: string, types?: string[], k?: number }): Promise<ReadonlyArray<NodeView & { score: number, scoreMode: 'vector' }>>`

**契約:**

- 使用已設定的 embedding profile 做語意向量搜尋。預設 `k: 20`。
- `score` 為向量索引相似度;結果按 `score` 降序排,並在 `k` 處截斷。
- 未設定 embedding profile 時丟出 `{ code: 'NO_EMBEDDING_PROFILE' }`。本方法**不會**靜默回退 —— 由呼叫端自行選擇回退策略(通常是 `keywordSearch`)。
- `query` 為空 / 僅含空白時 resolve 成空陣列(不丟錯)。

**何時使用:** 消費端想要向量索引提供的語意排名,並且準備好明確處理「無 profile」這種情況時。

**最小範例:**

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

**簽名:** `findByName(options: { query: string, types?: string[] }): { matches: ReadonlyArray<NodeView> }`

**契約:**

- 在每個候選的 `title` 與主鍵欄位(通常包含 `aliases`)上做大小寫不敏感的子字串比對。
- 回傳 `{ matches: ReadonlyArray<NodeView> }`,不帶 `score` 欄位;匹配按時間軸(seqTo 升序)排序。
- `query` 為空 / 僅含空白時回傳 `{ matches: [] }`(不丟錯)。

**何時使用:** 實體身份探針 —— 在建立 `character_sheet` 或 `location_state` **之前**呼叫,這樣消費端就能發現該實體已經在圖裡,直接編輯而不是重複建立。

**最小範例:**

```js
const { matches } = api.findByName({
    query: '艾琳',
    types: ['character_sheet'],
});
// matches: [{ id: 'n_eileen', title: 'Eileen', ... }]
```

### compactionCandidates(options)

**簽名:** `compactionCandidates(options: { type: string, depth?: number }): { groups: ReadonlyArray<{ depth: number, childIds: ReadonlyArray<string>, fanIn: number }> }`

**契約:**

- 純結構查詢 —— 不呼叫任何 LLM —— 回傳目前在 `depth`(預設 `0`)上有資格做層級壓縮的節點分組。
- 以下情況回傳 `{ groups: [] }`:
    - `type` 在目前生效 schema 中不存在。
    - 該類型的 `compression.mode` 是 `'none'`(或除 `'hierarchical'` 之外的任何值)。
    - 可用候選數(在套用 `keepRecentLeaves` 之後)低於 `compression.threshold`。
    - 請求的 `depth` 大於等於 `compression.maxDepth`。
- 每個 group 的 `childIds` 是候選子節點 id;`fanIn` 是分組大小;`depth` 是會產出的 rollup 層級。

**何時使用:** 驅動 agent 側的壓縮工作流 —— 列舉分組,用你自己的 LLM 給每組寫 summary,然後用相同的 `type` / `childIds` 呼叫 `writeApi.compactNodes`。

**最小範例:**

```js
const { groups } = api.compactionCandidates({ type: 'event' });
for (const group of groups) {
    const briefs = group.childIds.map(id => api.getNodeBrief(id));
    // 用你的 LLM 彙總 briefs,然後 writeApi.compactNodes({ type: 'event', childIds: group.childIds, summary })
}
```

## Layer D: 注入觀察

### getInjectionState()

**簽名:** `getInjectionState(): InjectionState`

**契約:**

- 回傳一個凍結的 `InjectionState`,包含目前的 `alwaysInjectIds`、`recallSelectedIds`、`visibleIds`。
- `visibleIds` **在召回流水線至少跑過一次之前為空** —— 因此預設取「目前 visibleIds」的方法在首次使用時拿到的會是空集合。如果需要確保有候選池,先呼叫 `listVisibleCandidates()`,或明確傳 `visibleNodeIds` 參數。
- 底層用 `Object.freeze` 包了 Set(JS 裡 Set 內容嚴格說不是不可變的,但 API 文件把它視為唯讀;不要 mutate)。

**何時使用:** 同步查詢目前注入狀態 —— 例如渲染一個「該節點目前已注入」的 UI 徽章。

**最小範例:**

```js
const state = api.getInjectionState();
console.log(state.alwaysInjectIds.size, state.recallSelectedIds.size, state.visibleIds.size);
```

### onInjectionChanged(callback)

**簽名:** `onInjectionChanged(callback: (state: InjectionState) => void): () => void`

**契約:**

- 把 `callback` 訂閱到注入狀態變更。callback 收到的是與 `getInjectionState()` 同形態的凍結 `InjectionState`。
- 回傳一個 unsubscribe 函式。unsubscribe 是冪等的。
- 監聽器例外會被 `console.warn` 捕獲並記錄 —— 不會打斷 listener 鏈,也不會影響其他訂閱者。
- 沒有 debounce;一輪中 listener 可能多次觸發(always-inject pass、recall pass、……)。

**何時使用:** 讓 UI 或 sidekick 狀態機與召回流水線保持同步。例如,在聊天側邊欄高亮目前活躍 rollup 的擴充可以在這裡訂閱。

**最小範例:**

```js
const unsubscribe = api.onInjectionChanged(state => {
    refreshInjectionUI(state.recallSelectedIds);
});
// Later:
unsubscribe();
```

## 實戰範例:複刻原生召回 LLM 輸入

`chooseRecallRoute` 建構的兩個 LLM 輸入區塊是 `schema_overview` 與 `candidateRows`。用本 API 複刻它們非常直接:

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

完整的等價性保證 —— `candidateRows` 在欄位層面與順序層面都與原生路由器的輸入一致 —— 由 dogfood 測試(`tests/memory-graph/read-api-dogfood.test.js`)強制保證,它透過 API 建構出相同的區塊,並對原生 `chooseRecallRoute` 的內部狀態斷言結構相等。

## Write API

寫 API 是給想要直接編輯記憶圖的第三方 agent 準備的 Layer-1 入口 —— 例如在兩輪之間執行、不依賴內建 extractor 的 curator agent。會話外觀暴露了常用寫方法;底層的 `getMemoryGraphWriteApi(store, context)` 工廠就是 `openSession` 內部封裝的物件。

### 工廠:getMemoryGraphWriteApi(store, context)

```js
import { getMemoryGraphWriteApi } from '/scripts/extensions/memory-graph/write-api.js';

const writeApi = getMemoryGraphWriteApi(store, context);
```

回傳一個凍結物件,暴露下文記錄的方法。工廠綁定到傳入的 `store` 參照 —— 傳入你從 floor-state 載入器拿到的 live store。對 `null` store 呼叫方法會丟出 `{ code: 'MEMORY_STORE_MISSING' }`。第三方擴充通常應該用 `openSession`,而不是直接建構這個工廠。

### 推薦入口:applyExtractionBatch(options)

**簽名:** `applyExtractionBatch(options: { ops: ExtractionOp[], maxSeq?: number }): { applied: ExtractionOp[], rejected: Array<{ op: ExtractionOp, error: { code: string, message: string } }> }`

**契約:**

- 多 op 意圖(例如同一個邏輯動作裡 create + link)的推薦入口。提供單一的回滾 / 持久化邊界,在呼叫內解析同批次的 `ref`,失敗透過 `rejected` 透出而不是中途丟錯。
- 預設 `maxSeq` 為 store 目前的 `seqCounter`。
- `ExtractionOp` 是一個區分聯合:
    - `{ op: 'create', type, title?, fields, links?, ref? }` —— 建立一個新的語意節點。
    - `{ op: 'edit', nodeId, setFields?, clearFields?, title? }` —— patch 已有節點的欄位。
    - `{ op: 'delete', nodeId }` —— 刪除一個節點。
    - `{ op: 'link_upsert', sourceNodeId? | sourceRef?, links: [{ targetNodeId? | targetRef?, relation, direction? }] }` —— 新增關係邊。同批次 `ref` 在呼叫內解析。
    - `{ op: 'link_delete', sourceNodeId, targetNodeId, relation, direction? }` —— 移除一條關係邊。
- 下面的逐 op 原語都是便利封裝 —— 它們各自建構一個單 op 批次,然後走同一條流水線。

**何時使用:** 任何一個邏輯動作產生多 op 的 agent —— 原子性、批次級的 `ref` 解析、可預測的失敗報告都在這一層。

**最小範例:**

```js
const { applied, rejected } = writeApi.applyExtractionBatch({
    ops: [
        { op: 'create', type: 'character_sheet', ref: 'c1', fields: { name: 'Eileen', aliases: ['艾琳'] } },
        { op: 'link_upsert', sourceRef: 'c1', links: [{ targetNodeId: 'event_42', relation: 'mentions' }] },
    ],
});
console.log(applied.length, 'applied;', rejected.length, 'rejected');
```

### createNode(options)

**簽名:** `createNode(options: { type: string, title?: string, fields?: Record<string, unknown>, links?: LinkSpec[], ref?: string }): { id: string, ref?: string }`

**契約:**

- `type` 缺失時同步丟錯。
- 回傳新節點的 `id`。若提供了 `ref`,會把同一個 `ref` 一併回傳,以便呼叫端在同批次後續的 `upsertLinks` 中引用。
- 底層批次拒絕該 op(例如 schema 校驗失敗)時丟出 `{ code: 'OP_FAILED', rejected }`。

**何時使用:** 一次性的單節點建立。如果同一個邏輯動作裡要 create-plus-link,優先用 `applyExtractionBatch`,這樣 link 解析與回滾邊界對整個意圖都生效。

**最小範例:**

```js
const { id } = writeApi.createNode({
    type: 'character_sheet',
    title: 'Eileen',
    fields: { name: 'Eileen', aliases: ['艾琳'] },
});
```

### editNode(options)

**簽名:** `editNode(options: { id: string, setFields?: Record<string, unknown>, clearFields?: string[], title?: string }): { ok: boolean }`

**契約:**

- `id` 缺失時同步丟錯。
- `setFields` patch 欄位;`clearFields` 重置列出的欄位;傳 `title` 會更新節點標題。
- 節點被找到且 patch 已套用時 `ok: true`;節點缺失、已歸檔或被跳過時 `ok: false`(靜默跳過,不丟錯)。

**何時使用:** 原地變更已有節點。始終檢查 `ok` 以確認 patch 落地。

**最小範例:**

```js
const { ok } = writeApi.editNode({
    id: 'n_eileen',
    setFields: { profession: 'healer' },
});
```

### deleteNode(options)

**簽名:** `deleteNode(options: { id: string }): { ok: boolean }`

**契約:**

- `id` 缺失時同步丟錯。
- 節點存在且已刪除時 `ok: true`;否則 `ok: false`。

**何時使用:** 移除 agent 認定不再相關或建立錯誤的節點。

**最小範例:**

```js
const { ok } = writeApi.deleteNode({ id: 'n_obsolete' });
```

### upsertLinks(options)

**簽名:** `upsertLinks(options: { source: { id?: string, ref?: string }, links: Array<{ target: { id?: string, ref?: string }, relation: string, direction?: 'outgoing' | 'incoming' | 'bidirectional' }> }): { applied: number }`

**契約:**

- 從 `source` 到每個 `target` 新增關係邊。`direction` 預設 `'bidirectional'`。
- source / target 可用 `id`(live 節點 id)或 `ref`(批次內引用)定址。`ref` 只能在 `applyExtractionBatch` 呼叫內解析;逐原語封裝是為 live-id 情境準備的。
- 同一對節點之間不同 `relation` 的多條邊是允許的(複合狀態)。
- `applied` 是底層流水線接受的 op 數量。

**何時使用:** 給已有節點附上關係邊。如果要 create-plus-link,優先用 `applyExtractionBatch`,這樣 create 的 `ref` 能在同一次呼叫內解析。

**最小範例:**

```js
const { applied } = writeApi.upsertLinks({
    source: { id: 'n_eileen' },
    links: [
        { target: { id: 'event_42' }, relation: 'mentions' },
        { target: { id: 'n_garden' }, relation: 'located_in', direction: 'outgoing' },
    ],
});
```

### deleteLinks(options)

**簽名:** `deleteLinks(options: { source: { id: string }, target: { id: string }, relation: string, direction?: 'outgoing' | 'incoming' | 'bidirectional' }): { removed: number }`

**契約:**

- `source`、`target` 或 `relation` 缺失時同步丟錯。
- `direction` 預設 `'bidirectional'`。`relation` 在查找前會被轉為小寫。
- `removed` 是因為該 op 而從 store 中消失的邊數。

**何時使用:** 撤銷 agent 之前新增過的關係邊(或 extractor 產生過、curator 現在想撤銷的邊)。

**最小範例:**

```js
const { removed } = writeApi.deleteLinks({
    source: { id: 'n_eileen' },
    target: { id: 'event_42' },
    relation: 'mentions',
});
```

### compactNodes(options)

**簽名:** `compactNodes(options: { type: string, childIds: string[], summary: string, fields?: Record<string, unknown> }): { rollupNodeId: string }`

**契約:**

- 建立一個更高層級的 `type` rollup 節點,把指定的 `childIds` 重新掛為它的子節點,並新增 `semantic_contains` 邊。rollup 建構器(`createRollupWithChildren`)與內部壓縮迴圈共享,所以 agent 驅動的路徑與原生路徑產出形態完全一致的 rollup。
- 丟錯情況:
    - `type` 缺失、`childIds` 為空,或 `summary` 為空時丟出 `{ code: 'BAD_ARGS' }`。
    - 某個 `childId` 不在 store 中時丟出 `{ code: 'CHILD_NOT_FOUND' }`。
    - 某個 child 已經有同 type 的 rollup parent 時丟出 `{ code: 'CHILD_HAS_PARENT' }`。
- 回傳新 rollup 節點的 id。

**何時使用:** agent 側的壓縮工作流 —— 配合 `readApi.compactionCandidates` 列舉可用分組,用你自己的 LLM 給每組寫 summary,然後呼叫 `compactNodes` 落地 rollup。

**最小範例:**

```js
const { groups } = readApi.compactionCandidates({ type: 'event' });
if (groups.length > 0) {
    const group = groups[0];
    const briefs = group.childIds.map(id => readApi.getNodeBrief(id));
    const summary = await myLLM.summarize(briefs);
    const { rollupNodeId } = writeApi.compactNodes({
        type: 'event',
        childIds: group.childIds,
        summary,
    });
}
```

## 相容性

- `external-api.js` 的舊匯出(`getCurrentlyInjectedNodeIds`、`__recordInjectedNodeIds`、`applyMemoryGraphInjectionUpdate`、`createEmptyInjectionState`)仍然保留 —— 既有外掛無需更動。
- `getMemoryGraphInjectionState(context)` 也從 `read-api.js` 重新匯出以保持對稱:它回傳與 `getInjectionState()` 同形態(`alwaysInjectIds`、`recallSelectedIds`、`visibleIds`)的結果。
- 工廠 `getMemoryGraphReadApi(store, context)` 與 `getMemoryGraphWriteApi(store, context)` 不汙染舊命名空間;import 它們除了載入對應模組之外沒有任何副作用。
- 兩個 API 都依規範 §9 被標記為 `@experimental`,持續 2-3 個 minor 版本。該視窗內允許破壞性變更;欄位語意會保留,但欄位名與簽名可能根據真實外掛使用回饋而調整,直到 API 凍結為止。

## 效能

- `listNodes` / `listEdges` 會走訪整個 store —— 僅用於離線 / 一次性分析。開銷隨節點 / 邊數線性成長。
- `listVisibleCandidates` 是熱路徑上的對應物 —— 開銷與一次原生 `collectRootCandidates` 呼叫相當。它已預先套用召回側過濾,呼叫端不必再付這部分代價。
- `getEdgeSummary` / `projectEdges` 不快取 —— 每次呼叫都從原始邊重新計算。依規範 §7,對典型召回 workload(每輪 1-2 次呼叫)這是可接受的。如果發現自己在熱迴圈裡按候選逐個呼叫 `getEdgeSummary`,可以自己以 visible-id 集合為 key 快取結果。
- `keywordSearch` 在候選池上做純 token 重疊 —— 同步、永遠可用、不回退到 recency。`vectorSearch` 依賴向量索引已建構且 embedding profile 已設定;它會丟出 `NO_EMBEDDING_PROFILE` 而不是靜默回退,所以呼叫端自己決定回退策略(通常是 `keywordSearch`)。
- Write-API ops 會在批次邊界持久化 store 並重建下游索引(向量 / edge summary)。一組同屬一個邏輯動作的 op,優先用 `applyExtractionBatch` 而不是逐原語呼叫 —— 這樣回滾 / 持久化邊界對整個批次生效。
- 所有回傳的 view 都在建構時惰性凍結。對已凍結物件再次凍結是 no-op,因此對同一節點的重複讀取在消費端一側成本很低。

## 參見

- 原生召回路徑:`public/scripts/extensions/memory-graph/main.js`(`chooseRecallRoute`、`collectRootCandidates`、`expandRouteCandidates`)
- 搭配:orchestrator 透過 `getExtensionApi('memory-graph').openSession(context)` 開啟一個會話,並把它掛在 `__memoryGraphSession` 上供自身的 `memory_*` loop 工具消費 —— 見 [Director 執行期](/zh-TW/features/orchestrator/director)。
- 相關擴充 API:[外掛整合](/zh-TW/development/extension-api/plugin-integration),介紹了與其他擴充入口一併發布 `'memory-graph'` 的擴充 API 註冊表。
