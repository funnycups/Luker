# 角色卡開發者指南

本指南面向角色卡創作者，介紹如何利用 Luker 的擴充能力建立更豐富、更智慧的角色卡。Luker 在保持與 SillyTavern 角色卡格式完全相容的基礎上，提供了多項增強功能。

## 角色卡擴充欄位

Luker 使用角色卡 `data.extensions` 中的多個命名空間儲存擴充資料。這些欄位不會影響角色卡在 SillyTavern 中的正常使用——不識別的欄位會被忽略。

### data.extensions 擴充欄位結構

```json
{
  "data": {
    "extensions": {
      "luker": {
        "memoryGraphSchema": {
          "nodeTypes": [
            { "name": "string", "label": "string", "color": "#hex" }
          ]
        }
      },
      "card_app": {
        "enabled": true,
        "html": "string",
        "script": "string",
        "style": "string"
      }
    }
  }
}
```

| 欄位路徑 | 類型 | 說明 |
|---------|------|------|
| `luker.memoryGraphSchema` | object | 記憶圖的自訂節點類型 schema |
| `luker.memoryGraphSchema.nodeTypes` | array | 節點類型定義列表 |
| `luker.memoryGraphSchema.nodeTypes[].name` | string | 節點類型識別碼（英文，用於內部引用） |
| `luker.memoryGraphSchema.nodeTypes[].label` | string | 節點類型顯示名稱 |
| `luker.memoryGraphSchema.nodeTypes[].color` | string | 節點顏色（十六進位色值） |
| `card_app.enabled` | boolean | 是否啟用 CardApp |
| `card_app.html` | string | 應用的 HTML 範本 |
| `card_app.script` | string | 應用的 JavaScript 程式碼 |
| `card_app.style` | string | 應用的 CSS 樣式 |

> [!NOTE]
> 綁定預設和人設的資料儲存在角色卡的狀態檔案中，不在 `data.extensions` 內。這樣設計是為了避免修改角色卡本身的 JSON 資料。

## 綁定預設和人設

Luker 支援在角色卡中綁定推薦的生成預設和使用者人設。當使用者載入角色卡時，可以一鍵套用創作者推薦的設定，確保最佳的角色扮演體驗。

綁定資訊儲存在角色卡的狀態檔案中：

- **推薦預設**：指定最適合該角色的生成預設（溫度、取樣參數等）
- **推薦人設**：指定與角色互動時建議使用的使用者人設

這些綁定透過[角色卡編輯助手](/zh-TW/features/card-editor/)的「綁定預設」面板進行設定。

## 設定編排工作流

[編排器](/zh-TW/features/orchestrator/)允許角色卡創作者定義複雜的提示詞編排工作流。透過編排器，你可以：

- 定義多步驟的提示詞處理管線
- 在生成前後插入自訂邏輯
- 根據對話狀態動態調整提示詞結構

編排工作流可以綁定到角色卡，當使用者載入角色卡時自動啟動。

## 自訂記憶圖 Schema

[記憶圖](/zh-TW/features/memory-graph)支援角色卡級別的節點類型 schema 自訂。透過在角色卡的擴充資料中定義 `luker.memoryGraphSchema`，你可以為角色定製專屬的記憶結構。

例如，一個奇幻世界的角色卡可以定義如下 schema：

```json
{
  "data": {
    "extensions": {
      "luker": {
        "memoryGraphSchema": {
          "nodeTypes": [
            { "name": "character", "label": "角色", "color": "#4A90D9" },
            { "name": "location", "label": "地點", "color": "#7ED321" },
            { "name": "quest", "label": "任務", "color": "#F5A623" },
            { "name": "magic", "label": "魔法", "color": "#BD10E0" },
            { "name": "faction", "label": "陣營", "color": "#D0021B" }
          ]
        }
      }
    }
  }
}
```

自訂 schema 會覆蓋預設的節點類型集合，讓記憶圖的提取和組織更貼合角色的世界觀。

## CardApp 開發

[CardApp](/zh-TW/features/cardapp) 是 Luker 的角色卡內嵌應用系統，允許你在角色卡中嵌入互動式 JavaScript 應用。

### 適用場景

- **狀態追蹤**：好感度、體力值、庫存等遊戲化元素
- **互動元素**：骰子、卡牌、小遊戲
- **視覺化**：關係圖、時間線、地圖
- **自訂 UI**：角色專屬的介面元件

### 應用定義結構

CardApp 定義在角色卡的 `data.extensions.card_app` 欄位中：

```json
{
  "data": {
    "extensions": {
      "card_app": {
        "enabled": true,
        "html": "<div id='fav-tracker'><span id='fav-value'>0</span></div>",
        "script": "export default function(ctx) { ... }",
        "style": "#fav-tracker { padding: 10px; }"
      }
    }
  }
}
```

### 入口函式

CardApp 的 `script` 欄位應匯出一個預設函式，該函式接收上下文物件 `ctx`：

```javascript
export default function (ctx) {
  const container = ctx.container;

  // 初始化：讀取持久化狀態
  async function init() {
    const state = ctx.getChatState('my_app');
    render(state);
  }

  // 渲染 UI
  function render(state) {
    const fav = state?.favorability ?? 0;
    container.innerHTML = `
      <div class="fav-panel">
        <h3>好感度</h3>
        <div class="fav-bar">
          <div class="fav-fill" style="width: ${Math.min(fav, 100)}%"></div>
        </div>
        <span>${fav} / 100</span>
      </div>
    `;
  }

  init();
}
```

### 上下文 API（ctx）

CardApp 的上下文物件提供以下 API：

#### 訊息與生成

| API | 說明 |
|-----|------|
| `ctx.container` | 應用的DOM容器元素 |
| `ctx.charId` | 當前角色ID |
| `ctx.sendMessage(text, options?)` | 傳送訊息（內部呼叫`sendTextareaMessage`） |
| `ctx.stopGeneration()` | 停止當前生成 |
| `ctx.continueGeneration()` | 繼續生成 |
| `ctx.getHistory(limit?, offset?)` | 取得聊天歷史記錄，支援限制條數和偏移 |
| `ctx.editMessage(messageId, newText)` | 編輯指定訊息 |
| `ctx.deleteMessage(messageId)` | 刪除指定訊息 |
| `ctx.deleteLastMessage()` | 刪除最後一條訊息 |
| `ctx.swipe()` | 切換到下一個回覆變體 |
| `ctx.regenerate()` | 重新生成最後一條AI訊息（呼叫`Generate('regenerate')`） |

#### 資料與狀態

| API | 說明 |
|-----|------|
| `ctx.getCharacterData()` | 取得當前角色資料（唯讀） |
| `ctx.updateCharacterFields(fields)` | 更新角色欄位並儲存。支援name、description、personality、scenario、first_mes、mes_example、system_prompt、post_history_instructions、creator_notes、creator、character_version、tags（逗號分隔字串）、talkativeness（數字）、depth_prompt相關欄位 |
| `ctx.getChatState(namespace)` | 讀取聊天綁定的持久化狀態 |
| `ctx.setChatState(namespace, key, value)` | 設定聊天狀態 |
| `ctx.getVariable(key)` | 取得聊天變數 |
| `ctx.setVariable(key, value)` | 設定聊天變數並持久化 |

#### 聊天管理

| API | 說明 |
|-----|------|
| `ctx.getChatList()` | 取得當前角色的聊天列表 |
| `ctx.switchChat(chatName)` | 切換到指定聊天 |
| `ctx.newChat()` | 建立新聊天 |
| `ctx.closeChat()` | 關閉當前聊天 |

#### 世界書操作

| API | 說明 |
|-----|------|
| `ctx.getWorldBooks()` | 取得當前角色關聯的世界書名稱列表（角色綁定+全域啟用） |
| `ctx.getWorldBookEntries(bookName)` | 取得指定世界書的所有條目 |
| `ctx.createWorldBookEntry(bookName, fields?)` | 建立世界書條目，回傳新條目物件（含 uid） |
| `ctx.updateWorldBookEntry(bookName, uid, patch)` | 更新世界書條目（淺合併） |
| `ctx.deleteWorldBookEntry(bookName, uid)` | 刪除世界書條目 |

### 安全限制

CardApp 運行在受限環境中：

- ✅ 可以操作 `ctx.container` 內的 DOM
- ✅ 可以透過 `ctx` API 讀寫聊天狀態
- ✅ 可以傳送訊息和控制生成
- ❌ 不應直接操作沙箱外的 DOM
- ❌ 不應直接發起網路請求
- ❌ 不應直接存取其他擴充功能的資料

### CardApp Studio

[CardApp Studio](/zh-TW/features/card-editor/studio) 是開發 CardApp 的完整環境，提供基於 CodeMirror 6 的程式碼編輯器、即時預覽、AI 輔助和 Git 版本歷史。建議透過 Studio 開發 CardApp，而非手動編輯 JSON。

## 世界書最佳實踐

世界書（World Info / Lorebook）是角色卡的重要組成部分。以下是在 Luker 中使用世界書的最佳實踐：

### 1. 合理組織條目

- 按主題分組：角色背景、世界設定、重要事件等
- 使用清晰的關鍵詞觸發條件
- 避免條目之間的內容重疊

### 2. 利用預設綁定世界書

Luker 支援將世界書綁定到預設。當使用者切換預設時，關聯的世界書會自動啟動。這適用於需要不同世界觀設定的場景。

### 3. 搜尋工具與世界書整合

[搜尋工具](/zh-TW/features/search-tools)的搜尋代理可以將搜尋結果自動寫入世界書條目，實現即時資訊注入。創作者可以利用這一機制為角色提供即時知識更新能力。

### 4. 控制注入深度和順序

合理設定世界書條目的注入深度（depth）和排序（order），確保關鍵設定在提示詞中的位置合理。Luker 的搜尋工具提供了 `lorebookDepth`、`lorebookRole`、`lorebookEntryOrder` 等設定項來精細控制。

### 5. 與記憶圖配合

世界書提供靜態的世界設定，記憶圖提供動態的對話記憶。兩者互補：

- 世界書：不變的背景設定、角色關係、世界規則
- 記憶圖：對話中產生的事件、情感變化、新發現

## 角色卡分發注意事項

### 相容性

- `data.extensions.luker` 和 `data.extensions.card_app` 中的欄位在 SillyTavern 中會被忽略，不影響角色卡的正常使用
- 綁定預設和人設儲存在狀態檔案中，不包含在角色卡檔案內，分發時不會攜帶
- 編排工作流需要使用者手動匯入或透過其他方式分發

### 建議

- 在角色卡描述中註明推薦使用 Luker 以獲得完整體驗
- 如果角色卡依賴 CardApp，說明所需的 Luker 版本
- 提供不依賴 Luker 擴充功能的基礎體驗，將 Luker 特性作為增強

## 相關頁面

- [CardApp Studio](/zh-TW/features/card-editor/studio) — CardApp 的完整開發環境
- [角色卡編輯助手](/zh-TW/features/card-editor/) — 編輯助手概覽（含彈窗 / Studio 兩種模式）
- [記憶圖](/zh-TW/features/memory-graph) — 長期記憶系統
- [編排器](/zh-TW/features/orchestrator/) — 提示詞編排工作流
- [CardApp](/zh-TW/features/cardapp) — 角色卡內嵌應用詳細說明
- [擴充 API 參考](/zh-TW/development/extension-api/) — API 詳細文件
