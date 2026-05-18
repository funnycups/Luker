# 記憶圖唯讀 API

> 狀態:實驗性(依規範 §9,會在 2-3 個 minor 版本內出現破壞性變更)
>
> 入口:`getMemoryGraphReadApi(context)`,來自 `public/scripts/extensions/memory-graph/read-api.js`

## 概覽

memory-graph 擴充驅動 Luker 的長期召回 —— 它把精選後的節點池(`character_sheet`、`event`、`relationship`、……)加上每個節點的 `edge_summary` 餵給一個「路由」LLM,由它挑出下一輪要注入哪些記憶。原生流水線(`main.js` 中的 `chooseRecallRoute` / `collectRootCandidates`)透過一組內部 helper —— `buildProjectedEdges`、`getNearestVisibleAncestorId`、`formatNodeBrief` 等等 —— 構造出 LLM 輸入,而這些 helper 此前都是私有的。

`getMemoryGraphReadApi(context)` 把同一份資料、拓撲與召回原語暴露成一個深凍結、對呼叫端安全的 API 介面。預期消費者是 agent 風格的外掛,自己跑一遍 LLM 驅動的召回 —— 例如 orchestrator 的 `memory_scout` 子代理 —— 用操作者偏好的模型 / preset,對著原生路由器看到的完全一樣的候選池與欄位投影來工作。

API 是嚴格唯讀的:

- 回傳的 view 都是深凍結的純物件 / 陣列 / Set。工廠從不回傳 store 內部參照。
- 沒有寫入路徑:節點、邊、schema 的變更仍由 `extractionInstructions` 工具呼叫與 memory-graph 執行期負責。
- View 在每次呼叫時從目前 store 合成,所以單個 API 實例在切聊天 / 切角色卡之後仍然有效。

## 快速開始

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

### ScoredNodeView

```ts
interface ScoredNodeView extends NodeView {
    score: number;
    scoreMode: 'recency' | 'vector' | 'keyword' | 'hybrid';
}
```

帶分數及打分模式的 `NodeView`。`scoreMode` 反映的是 fallback 之後**實際**使用的模式(見 `rankNodes`)。

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

### rankNodes(options)

**簽名:** `rankNodes(options: { query: string, mode?: 'recency' | 'vector' | 'keyword' | 'hybrid', types?: string[], k?: number }): Promise<ReadonlyArray<ScoredNodeView>>`

**契約:**

- 為了 API 對稱性總是回傳 `Promise`;`'recency'` 與 `'keyword'` 同步 resolve,`'vector'` 與 `'hybrid'` 會 await 向量索引。
- 預設 `mode: 'recency'`,預設 `k: 20`。
- `query` 為空 / 缺失時,無論請求什麼模式都強制走 `'recency'`(沒有 query 可以排序)。
- 回傳的 `scoreMode` 反映的是 fallback 之後**實際**使用的模式(見下)。

**模式:**

- `'recency'` —— 把活躍節點按 `seqTo` 降序排。`score` 等於 `seqTo`。與 query 無關;純 LLM 召回最安全的預設值。
- `'keyword'` —— 用簡單的 token 交集比對每個節點的 `title` + 投影欄位 + spec 關鍵字。`score` 是歸一化後的 matches / query-tokens。
- `'vector'` —— 委派給 `findSimilarNodes`(vector-index-core)。需要已建構好的向量索引與有效的 embedding profile。profile 無效或沒命中時**回退到 `'recency'`**;此時 `scoreMode` 會是 `'recency'`。
- `'hybrid'` —— 歸一化向量分與關鍵字分各佔 50% 的混合。兩端都為空時回退到 `'recency'`。

**何時使用:** 產生一個小而精的候選 id 排序短名單,再餵給 `getNodeBrief`。注意:即便有 `rankNodes`,LLM 召回的標準輸入仍然是 `listVisibleCandidates` —— `rankNodes` 是給那些想拿 query 預過濾的短名單代替(或補充)完整候選池的外掛使用的。

**最小範例:**

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

完整的等價性保證 —— `candidateRows` 在欄位層面與順序層面都與原生路由器的輸入一致 —— 由 dogfood 測試(`tests/memory-graph/read-api-dogfood.test.js`)強制保證,它透過 API 建構出相同的區塊,並對原生 `chooseRecallRoute` 的內部狀態斷言結構相等。

## 相容性

- `external-api.js` 的舊匯出(`getCurrentlyInjectedNodeIds`、`__recordInjectedNodeIds`、`applyMemoryGraphInjectionUpdate`、`createEmptyInjectionState`)仍然保留 —— 既有外掛無需更動。
- `getMemoryGraphInjectionState(context)` 也從 `read-api.js` 重新匯出以保持對稱:它回傳與 `getInjectionState()` 同形態(`alwaysInjectIds`、`recallSelectedIds`、`visibleIds`)的結果。
- 工廠 `getMemoryGraphReadApi(context)` 不汙染舊命名空間;import 它除了載入 read-api 模組之外沒有任何副作用。
- API 依規範 §9 被標記為 `@experimental`,持續 2-3 個 minor 版本。該視窗內允許破壞性變更;欄位語意會保留,但欄位名與簽名可能根據真實外掛使用回饋而調整,直到 API 凍結為止。

## 效能

- `listNodes` / `listEdges` 會走訪整個 store —— 僅用於離線 / 一次性分析。開銷隨節點 / 邊數線性成長。
- `listVisibleCandidates` 是熱路徑上的對應物 —— 開銷與一次原生 `collectRootCandidates` 呼叫相當。它已預先套用召回側過濾,呼叫端不必再付這部分代價。
- `getEdgeSummary` / `projectEdges` 不快取 —— 每次呼叫都從原始邊重新計算。依規範 §7,對典型召回 workload(每輪 1-2 次呼叫)這是可接受的。如果發現自己在熱迴圈裡按候選逐個呼叫 `getEdgeSummary`,可以自己以 visible-id 集合為 key 快取結果。
- `rankNodes(mode: 'vector' | 'hybrid')` 依賴向量索引已建構。兩者在 profile 無效時都回退到 `'recency'`;回傳的 `scoreMode` 反映的是實際用到的模式。
- 所有回傳的 view 都在建構時惰性凍結。對已凍結物件再次凍結是 no-op,因此對同一節點的重複讀取在消費端一側成本很低。

## 參見

- 原生召回路徑:`public/scripts/extensions/memory-graph/main.js`(`chooseRecallRoute`、`collectRootCandidates`、`expandRouteCandidates`)
- 搭配:orchestrator 的 `memory_scout` 子代理使用本 API —— 見 [Director 執行期](/zh-TW/features/orchestrator/director)。
- 相關擴充 API:[外掛整合](/zh-TW/development/extension-api/plugin-integration),介紹了把 `getMemoryGraphReadApi` 與其他擴充入口一併暴露的擴充 API 註冊表。
