# 搜尋外掛

搜尋外掛（Search Tools）為 AI 角色提供聯網搜尋能力，讓角色在對話中檢索即時資訊並將結果注入上下文。搜尋外掛支援多種搜尋引擎後端，並提供多種工作模式以適應不同使用場景。

## 工作模式

```d2
direction: right

TOOL: "工具模式" {
  T_USER: "使用者提問"
  T_LLM: "創作 LLM"
  T_DECIDE: "LLM 判斷\n需要搜尋嗎" {
    shape: diamond
  }
  T_TOOL: "呼叫 luker_web_search\n/ luker_web_visit" {
    style.fill: "#e1f5ff"
  }
  T_RESULT: "結果作為工具呼叫回傳值\n注入對話上下文"
  T_FINAL: "LLM 生成最終回覆"

  T_USER -> T_LLM -> T_DECIDE
  T_DECIDE -> T_TOOL: "是"
  T_TOOL -> T_RESULT
  T_RESULT -> T_LLM
  T_DECIDE -> T_FINAL: "否"
}

AGENT: "預請求 Agent 模式" {
  A_USER: "使用者提問"
  A_AGENT: "搜尋 Agent\n獨立 LLM 預設"
  A_DECIDE: "分析對話\n需要搜尋嗎" {
    shape: diamond
  }
  A_SEARCH: "執行搜尋\n多輪可循環"
  A_WRITE: "結果寫入世界書條目" {
    style.fill: "#fff3e0"
  }
  A_LLM: "創作 LLM"
  A_FINAL: "LLM 生成最終回覆\n世界書條目作為參考資料注入"

  A_USER -> A_AGENT -> A_DECIDE
  A_DECIDE -> A_SEARCH: "是"
  A_SEARCH -> A_WRITE -> A_LLM -> A_FINAL
  A_DECIDE -> A_LLM: "否"
}
```

### 工具模式

搜尋功能作為創作 LLM 的可呼叫工具註冊到[函式呼叫執行時](/zh-TW/improvements/function-call-runtime)中，涵蓋網頁搜尋、網頁正文擷取、圖片搜尋與網頁圖片擷取。當 AI 判斷需要檢索資料或視覺參考時，主動發起工具呼叫，並將結果送入上下文。

### 預請求 Agent 模式

在創作 LLM 生成回覆之前，自動執行一個獨立的搜尋 Agent。Agent 分析目前對話內容，判斷是否需要搜尋，並將結果寫入世界書條目：

- 透過**請求前執行搜尋 Agent** 開關啟用
- 可使用獨立的提示詞預設與 API 連線，與創作模型分開
- 執行工具呼叫循環，直到不再呼叫工具並回傳純文字為止
- 可回讀、更新和刪除自己建立的條目，修訂既有筆記以保持整潔
- 搜尋結果自動儲存為世界書條目，供創作 LLM 在生成時讀取
- 執行過程即時串流顯示在共享**執行面板**懸浮窗中（預設開啟**執行時自動開啟**，也可在執行面板選單裡切換）

![預請求搜尋 Agent 在執行面板中的執行](/images/search-tools/run-panel.png)

::: tip 模式的選擇
**工具模式**適合模型在對話中自主決定何時搜尋的場景——例如使用者詢問近期新聞時。

**預請求 Agent 模式**則在 AI 生成前自動執行搜尋，使檢索過程與主對話分離。
:::

## 設定面板

搜尋外掛的設定位於**擴充功能 → 搜尋工具**：

![搜尋工具設定面板](/images/search-tools/search-tools-settings.png)

頂部開關對應兩種工作模式：**暴露工具給主模型**為工具模式，**請求前執行搜尋 Agent** 為預請求 Agent 模式，兩者可單獨或同時啟用。下方可設定搜尋引擎、Agent 專用預設與世界書注入參數；點擊**顯示搜尋執行面板**可隨時開啟共享執行面板。

## 支援的搜尋引擎

| 搜尋引擎 | 說明 | 設定要求 |
|----------|------|----------|
| **DuckDuckGo** | 預設搜尋引擎，無需 API 金鑰 | 開箱即用 |
| **SearXNG** | 自架元搜尋引擎 | 需要提供自架實例 URL |
| **Brave Search** | Brave 提供的搜尋 API | 需要 API 金鑰 |
| **Tavily** | 面向 LLM 的搜尋 API | 需要 API 金鑰 |
| **Exa** | 神經 / 語意搜尋 API | 需要 API 金鑰 |
| **Serper** | 透過 serper.dev 取得 Google 結果 | 需要 API 金鑰 |
| **SerpApi** | 透過 SerpApi 取得 Google 結果 | 需要 API 金鑰 |
| **Z.AI** | Z.AI 網頁搜尋 | 需要 API 金鑰 |
| **DeepSeek** | DeepSeek 原生網頁搜尋 | 需要 DeepSeek API 金鑰 |

DuckDuckGo、SearXNG、Brave Search、Tavily、Exa 和 SerpApi 支援安全搜尋過濾。

## 圖片搜尋與網頁圖片擷取

DuckDuckGo、SearXNG、Brave Search、Tavily、Serper 與 SerpApi 支援圖片搜尋，回傳原圖連結、縮圖、標題、來源頁面與尺寸資訊。Exa、Z.AI 與 DeepSeek 屬於純文字檢索後端，發起圖片搜尋時會直接報錯提示目前引擎不支援圖片搜尋。

網頁圖片擷取從公開網頁解析社群卡片封面與正文圖片候選連結，並自動過濾追蹤像素與微小裝飾圖示。

## 世界書條目管理

在預請求 Agent 模式下，搜尋結果自動寫入世界書條目。可以在設定面板中調整**注入位置**、**注入深度**、**注入角色**與**注入順序**，並透過**管理已儲存的搜尋條目**檢視或清理記錄。

## 供其他功能使用

圖像生成角色探索 agent、工作台 AI 迭代、CardApp Studio 與角色卡編輯助手彈窗同樣支援呼叫搜尋能力，用於聯網查閱設定資料與角色參考圖。開發者介面見[擴充 API](/zh-TW/development/extension-api/)。

## 結果複用

滿足以下全部條件時，系統複用上一次搜尋 Agent 的結果：

1. 目前聊天與上次快照為同一聊天
2. 最後一條使用者訊息與上次快照一致
3. 目前生成類型支援複用（如重新生成、繼續生成）

結果複用時，執行面板會顯示已沿用標記。

## 訊息操作的影響

聊天內容變化時，外掛會同步維護已儲存的搜尋條目：

- **刪除訊息** —— 被刪除訊息所在輪次及其後的搜尋結果一併清除
- **切換分支** —— 被切換輪次的搜尋結果清除
- **編輯訊息** —— 已儲存的結果保留；編輯某次搜尋對應的輪次後，下次生成將重新執行搜尋

## 設定參考

| 設定項 | 說明 |
|--------|------|
| **暴露工具給主模型** | 開啟工具模式，讓模型在對話中自主呼叫搜尋 |
| **請求前執行搜尋 Agent** | 開啟預請求 Agent 模式，生成前自動搜尋 |
| **搜尋引擎** | 選擇使用的搜尋引擎 |
| **預設最大搜尋結果數** | 單次搜尋回傳的結果筆數 |
| **預設頁面摘要最大字元數** | 存取網頁時擷取的最大文字長度（`0` 為不截斷） |
| **安全搜尋** | 搜尋結果的安全過濾級別 |
| **Agent API 預設** | 預請求 Agent 使用的 API 連線預設（留空使用主連線） |
| **Agent 預設** | 預請求 Agent 使用的預設，留空使用主預設。下拉選單下方的操作可匯入內建的 `plugin-only` 示例，或開啟預設工作台從現有預設派生 |

::: info 相關頁面
- [圖像生成與 AI 插圖](/zh-TW/features/image-generation) —— 結合圖片搜尋自動探索同人角色設定與參考圖
- [工作台](/zh-TW/features/workbench) —— 在工作台 AI 迭代中結合聯網搜尋
- [角色卡編輯助手](/zh-TW/features/card-editor/) —— 編輯助手概覽
- [CardApp Studio](/zh-TW/features/card-editor/studio) —— Studio 中的聯網搜尋能力
- [執行面板 API](/zh-TW/development/extension-api/run-panel) —— 共享執行面板開發參考
:::
