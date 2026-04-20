# 搜尋外掛

搜尋外掛（Search Tools）為 AI 角色提供聯網搜尋能力，讓角色在對話中可以檢索即時資訊並將搜尋結果注入上下文。搜尋外掛支援多種搜尋引擎後端，並提供兩種工作模式以適應不同的使用場景。

## 兩種工作模式

### 工具模式（Tool Mode）

搜尋功能作為創作 LLM 的可呼叫工具註冊到[函式呼叫執行時](/zh-TW/improvements/function-call-runtime)中。當 AI 判斷需要搜尋資訊時，會主動發起工具呼叫。

- 透過 `enabled` 設定項開啟
- 註冊 `luker_web_search` 和 `luker_web_visit` 兩個函式工具
- AI 自主決定何時搜尋、搜尋什麼內容
- 搜尋結果作為工具呼叫回傳值注入對話上下文

### 預請求 Agent 模式（Pre-request Agent Mode）

在創作 LLM 生成回覆之前，自動執行一個獨立的搜尋 Agent。Agent 會分析當前對話內容，判斷是否需要搜尋，並將搜尋結果寫入世界書條目。

- 透過 `preRequestEnabled` 設定項開啟
- Agent 使用獨立的 LLM 預設（`agentPresetName`）和 API 預設（`agentApiPresetName`），可以與創作 LLM 使用不同的模型
- Agent 最大執行輪次由 `agentMaxRounds` 控制
- 搜尋結果自動建立為世界書條目，創作 LLM 在生成時可以直接讀取
- 支援透過 toast 通知上的 Stop 按鈕中止 Agent 執行

::: tip 兩種模式的選擇
**工具模式**適合需要模型在對話中自主決定何時搜尋的場景——例如使用者問「最近有什麼新聞」時，模型會自動呼叫搜尋工具取得資訊。搜尋行為由模型根據對話內容自主觸發。

**預請求 Agent 模式**則是在每次 AI 生成前自動執行搜尋，搜尋過程與主對話完全分離。適合希望每次回覆都有最新資訊支撐的場景。
:::

## 支援的搜尋引擎

| 搜尋引擎 | 說明 | 設定要求 |
|----------|------|----------|
| **DuckDuckGo** | 預設搜尋引擎，無需 API 金鑰 | 開箱即用 |
| **SearXNG** | 自架的元搜尋引擎，隱私友好 | 需要提供自架實例的 URL |
| **Brave Search** | Brave 提供的搜尋 API | 需要 API 金鑰 |

搜尋引擎透過 `provider` 設定項選擇，各引擎的獨立設定儲存在 `providerSettings` 中。你還可以透過 `safeSearch` 設定安全搜尋級別。

## 世界書條目管理

在預請求 Agent 模式下，搜尋結果會被自動建立為世界書條目。這些條目的行為可以透過以下設定項控制：

| 設定項 | 說明 |
|--------|------|
| `lorebookDepth` | 條目在提示詞中的注入深度 |
| `lorebookRole` | 條目的角色標記（如 system、assistant） |
| `lorebookEntryOrder` | 條目的排序權重 |
| `lorebookPosition` | 條目的注入位置 |

搜尋結果條目可以設定為 `constant`（常駐啟用）或透過關鍵詞匹配啟用，具體取決於 Agent 的判斷和設定。

## 全域 API

搜尋外掛透過全域 API 供其他外掛整合使用。例如[角色卡編輯助手](/zh-TW/features/card-editor#與搜尋外掛的整合)已整合搜尋能力，可以在 Studio 中聯網搜尋資料輔助角色卡編輯。

### 屬性

| 屬性 | 類型 | 說明 |
|------|------|------|
| `toolNames` | `Object` | 工具名常數物件，包含 `SEARCH` 和 `VISIT` |

### 方法

| 方法 | 回傳值 | 說明 |
|------|--------|------|
| `getToolDefs()` | `Array` | 回傳搜尋工具的定義陣列，包含工具名、參數 schema 等資訊 |
| `isToolName(name)` | `boolean` | 判斷給定名稱是否為搜尋外掛註冊的工具名 |
| `invoke(call, options)` | `Promise` | 呼叫搜尋工具，`call` 包含工具名和參數 |
| `search(args)` | `Promise` | 直接執行搜尋，回傳搜尋結果 |
| `visit(args)` | `Promise` | 直接存取指定網頁，回傳頁面內容 |
| `getSettings()` | `Object` | 回傳當前搜尋外掛的設定快照 |

### 使用範例

```javascript
const api = Luker.searchTools;
if (api) {
  // 檢查是否為搜尋工具
  api.isToolName('luker_web_search'); // true

  // 取得工具定義
  const defs = api.getToolDefs();

  // 直接呼叫搜尋
  const results = await api.search({ query: '...', maxResults: 5 });

  // 存取網頁
  const page = await api.visit({ url: 'https://...', maxChars: 10000 });
}
```

## 結果複用

搜尋外掛實現了精細的結果複用機制，避免在不必要的場景下重複執行搜尋。

系統會自動判斷是否可以複用上次搜尋 Agent 的結果。複用需要同時滿足以下條件：

1. 當前聊天 key 與上次快照的聊天 key 匹配
2. 使用者錨點（最後一條使用者訊息的特徵）與上次快照匹配
3. 當前生成類型屬於可複用類型（如重新生成、繼續生成等場景）

當結果被複用時，UI 會顯示 `(reused)` 標記，提示使用者本次生成使用了快取的搜尋結果。

## 訊息操作的影響

搜尋外掛會監聽訊息的刪除和編輯事件，自動維護內部狀態的一致性：

- **訊息刪除** — 根據刪除的訊息範圍更新搜尋狀態，確保不會引用已刪除訊息的搜尋結果
- **訊息編輯** — 根據編輯的訊息位置更新搜尋狀態，可能使快取的搜尋結果失效

## 設定參考

| 設定項 | 說明 |
|--------|------|
| 啟用搜尋工具 | 開啟工具模式，讓模型在對話中自主呼叫搜尋 |
| 啟用預請求 Agent | 開啟預請求 Agent 模式，每次生成前自動搜尋 |
| 搜尋引擎 | 選擇搜尋引擎（DuckDuckGo / SearXNG / Brave Search） |
| 搜尋結果數量 | 每次搜尋回傳的結果筆數 |
| 頁面擷取字元數 | 存取網頁時擷取的最大文字長度 |
| 安全搜尋 | 搜尋結果的安全過濾級別 |
| Agent API 預設 | 預請求 Agent 使用的 API 連線預設（空值使用主連線） |
| Agent 預設 | 預請求 Agent 使用的預設（空值使用主預設） |
| Agent 最大輪次 | 預請求 Agent 的最大搜尋輪次 |

::: info 相關頁面
- [角色卡編輯助手](/zh-TW/features/card-editor) — Studio 中的聯網搜尋能力
- [CardApp](/zh-TW/features/cardapp) — 角色卡應用化概念
:::
