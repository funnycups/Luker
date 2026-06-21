# 前端外掛開發

Luker 的外掛系統基於 SillyTavern 的擴充功能架構，並在此基礎上進行了增強。本文件面向希望為 Luker 開發第三方外掛的開發者，涵蓋外掛的檔案結構、生命週期、事件系統、UI 整合和除錯技巧。

## 術語說明

Luker 中「外掛」和「擴充功能」（Extension）指同一概念。內建擴充功能位於 `public/scripts/extensions/` 目錄下，第三方外掛安裝到 `public/scripts/extensions/third-party/` 目錄。

## 外掛檔案結構

一個標準的 Luker 外掛包含以下檔案：

```
third-party/my-plugin/
├── manifest.json      # 外掛中繼資料（必需）
├── index.js           # 入口腳本（必需）
├── style.css          # 樣式檔案（可選）
├── settings.html      # 設定面板 HTML（可選）
└── assets/            # 靜態資源（可選）
```

### manifest.json

`manifest.json` 是外掛的中繼資料檔案，定義了外掛的基本資訊和載入方式：

```json
{
  "display_name": "My Plugin",
  "loading_order": 100,
  "requires": [],
  "optional": [],
  "js": "index.js",
  "css": "style.css",
  "author": "Your Name",
  "version": "1.0.0",
  "homePage": "https://github.com/your-repo",
  "auto_update": true
}
```

| 欄位 | 類型 | 說明 |
|------|------|------|
| `display_name` | string | 外掛在 UI 中顯示的名稱 |
| `loading_order` | number | 載入順序，數字越小越先載入 |
| `requires` | string[] | 必需的依賴擴充功能列表 |
| `optional` | string[] | 可選的依賴擴充功能列表 |
| `js` | string | 入口 JavaScript 檔案路徑 |
| `css` | string | 樣式檔案路徑 |
| `author` | string | 作者資訊 |
| `version` | string | 版本號 |
| `homePage` | string | 專案首頁 URL |
| `auto_update` | boolean | 是否支援自動更新 |

### index.js

入口腳本是外掛的核心檔案。Luker 使用 ES Module 動態匯入載入外掛，因此入口檔案應使用 `import`/`export` 語法。

一個最小的入口腳本結構：

```js
import { extension_settings, getContext } from '../../../extensions.js';
import { eventSource, event_types } from '../../../../script.js';

const EXTENSION_NAME = 'my-plugin';

// 外掛設定的預設值
const defaultSettings = {
  enabled: true,
  someOption: 'default',
};

// 載入設定
function loadSettings() {
  extension_settings[EXTENSION_NAME] = extension_settings[EXTENSION_NAME] || {};
  Object.assign(extension_settings[EXTENSION_NAME], {
    ...defaultSettings,
    ...extension_settings[EXTENSION_NAME],
  });
}

// 外掛入口
jQuery(async () => {
  loadSettings();

  // 載入設定面板 HTML
  const settingsHtml = await $.get(`${extensionFolderPath}/settings.html`);
  $('#extensions_settings').append(settingsHtml);

  // 綁定事件
  eventSource.on(event_types.CHAT_CHANGED, onChatChanged);
});
```

### style.css

樣式檔案會被自動載入。建議使用帶有外掛前綴的 CSS 類別名稱，避免與其他外掛或 Luker 核心樣式衝突：

```css
.my-plugin-container {
  padding: 10px;
}

.my-plugin-container .status {
  color: var(--SmartThemeBodyColor);
}
```

### settings.html

設定面板的 HTML 片段，會被插入到擴充功能設定區域。使用 `data-extension-name` 屬性標識所屬外掛：

```html
<div class="my-plugin-settings" data-extension-name="my-plugin">
  <div class="inline-drawer">
    <div class="inline-drawer-toggle inline-drawer-header">
      <b>My Plugin</b>
      <div class="inline-drawer-icon fa-solid fa-circle-chevron-down"></div>
    </div>
    <div class="inline-drawer-content">
      <label>
        <input type="checkbox" id="my_plugin_enabled" />
        啟用外掛
      </label>
    </div>
  </div>
</div>
```

## 全域物件

### Luker.getContext()

`Luker.getContext()` 是外掛與 Luker 互動的主要介面。它回傳一個包含豐富 API 的上下文物件：

```js
const context = Luker.getContext();
```

> [!NOTE]
> `SillyTavern.getContext()` 和 `st.getContext()` 是相容別名，新外掛應使用 `Luker.getContext()`。

上下文物件包含以下主要類別的 API：

- **聊天資料** — `context.chat`、`context.characters`、`context.groups` 等
- **訊息操作** — `addMessages()`、`updateMessages()`、`deleteMessages()`、`getMessage()`、`getMessageCount()`
- **聊天持久化** — `saveChatMetadata()` 等（底層的 `appendChatMessages()`、`patchChatMessages()` 已棄用，請使用訊息 API）
- **聊天狀態** — `getChatState()`、`updateChatState()` 等
- **預設** — `context.presets.list()`、`context.presets.resolve()` 等
- **提示詞/世界書組裝** — `buildPresetAwarePromptMessages()`、`simulateWorldInfoActivation()` 等
- **事件系統** — `context.eventSource`、`context.eventTypes`
- **角色狀態** — `getCharacterState()`、`setCharacterState()`
- **擴充功能間通訊** — `registerExtensionApi()`

完整的 API 列表請參閱 [擴充 API 參考](/zh-TW/development/extension-api/)。

## 事件系統

Luker 的事件系統是外掛開發的核心機制。外掛透過監聽事件來回應使用者操作和系統狀態變化。

### 基本用法

```js
const context = Luker.getContext();

// 監聽事件
context.eventSource.on(context.eventTypes.CHAT_CHANGED, (chatId) => {
  console.log('聊天已切換:', chatId);
});

// 帶優先順序的監聽
context.eventSource.on(context.eventTypes.MESSAGE_RECEIVED, handler, { priority: 10 });

// 確保最先/最後執行
context.eventSource.makeFirst(context.eventTypes.CHAT_CHANGED, handler);
context.eventSource.makeLast(context.eventTypes.CHAT_CHANGED, handler);
```

### 監聽器執行順序

Luker 的事件監聽器按以下優先順序**串行**執行（每個監聽器會被 `await`）：

1. **顯式外掛排序**（`pluginOrder`）— 透過 `eventSource.setOrderConfig()` 或內建的 Hook Order 擴充功能設定
2. **監聽器優先順序**（`priority`）— `eventSource.on()` 的第三個參數，數字越大越先執行
3. **註冊順序** — 先註冊的先執行

### 聊天生命週期事件

| 事件 | 觸發時機 | 回呼參數 |
|------|----------|----------|
| `CHAT_CHANGED` | 聊天切換完成 | `(chatId)` |
| `CHAT_CREATED` | 新聊天建立 | `(chatId)` |
| `GROUP_CHAT_CREATED` | 群組聊天建立 | `(chatId)` |
| `CHAT_BRANCH_CREATED` | 聊天分支建立 | `(payload)` — 見下文 |

### 訊息事件

| 事件 | 觸發時機 | 回呼參數 |
|------|----------|----------|
| `USER_MESSAGE_RENDERED` | 使用者訊息渲染完成 | `(messageId)` |
| `CHARACTER_MESSAGE_RENDERED` | 角色訊息渲染完成 | `(messageId)` |
| `MESSAGE_SENT` | 使用者訊息傳送 | `(messageId)` |
| `MESSAGE_RECEIVED` | 收到 AI 回覆 | `(messageId, type?)` |
| `MESSAGE_EDITED` | 訊息被編輯 | `(messageId, meta?)` |
| `MESSAGE_UPDATED` | 訊息區塊重新整理 | `(messageId)` |
| `MESSAGE_DELETED` | 訊息被刪除 | `(chatLength, meta?)` |
| `MESSAGE_SWIPED` | 訊息被滑動切換 | `(messageId, meta?)` |
| `MESSAGE_SWIPE_DELETED` | 滑動選項被刪除 | `({ messageId, swipeId, newSwipeId })` |

#### MESSAGE_RECEIVED 的 type 參數

`MESSAGE_RECEIVED` 的第二個參數 `type` 表示訊息來源類型：

- 標準生成模式：`swipe`、`continue`、`append`、`appendfinal`
- 非標準來源：`first_message`、`command`、`extension`

#### MESSAGE_EDITED 的 meta 參數

```ts
(messageId: number, meta?: {
  messageId: number,
  playableSeq: number | null,
  assistantSeq: number | null,
  isUser: boolean,
  isAssistant: boolean,
  isSystem: boolean,
})
```

`meta` 參數是向後相容的，可能不存在。當外掛需要根據被編輯訊息的位置或類型做出回應時使用。

#### MESSAGE_DELETED 的 meta

```ts
(
  chatLength: number,
  meta?: {
    kind: 'delete',
    deletedPlayableSeqFrom: number | null,
    deletedPlayableSeqTo: number | null,
    deletedAssistantSeqFrom: number | null,
    deletedAssistantSeqTo: number | null,
  },
)
```

#### MESSAGE_SWIPED 的 meta

```ts
(
  messageId: number,
  meta?: {
    pendingGeneration: boolean,
    previousSwipeId: number | null,
    nextSwipeId: number | null,
  },
)
```

#### CHAT_BRANCH_CREATED 的 payload

```ts
{
  mesId: number,                  // 分支點訊息索引
  branchName: string,             // 新分支聊天 ID / 檔名
  assistantMessageCount: number,  // 分支中包含的助手訊息數
  sourceTarget: {
    is_group: boolean,
    id?: string,
    avatar_url?: string,
    file_name?: string,
  },
  targetTarget: {
    is_group: boolean,
    id?: string,
    avatar_url?: string,
    file_name?: string,
  },
}
```

`CHAT_BRANCH_CREATED` 在新分支聊天檔案儲存後、UI 切換到新分支之前觸發。如果你的外掛儲存了聊天綁定的狀態資料，應在此事件中將狀態複製或截斷到新分支。

### 生成鉤子事件

生成鉤子是外掛介入 AI 生成流程的關鍵機制。它們按以下順序觸發：

```
GENERATION_STARTED
  ↓
GENERATION_CONTEXT_READY        ← 可調整 coreChat 和 maxContext
  ↓
GENERATION_BEFORE_WORLD_INFO_SCAN  ← 可影響世界書掃描
  ↓
GENERATION_AFTER_WORLD_INFO_SCAN   ← 世界書掃描完成
  ↓
GENERATION_WORLD_INFO_FINALIZED    ← 世界書最終確定
  ↓
GENERATION_BEFORE_API_REQUEST      ← 最終請求檢查
  ↓
（API 請求傳送）
  ↓
GENERATION_ENDED / GENERATION_STOPPED
```

#### 鉤子選擇指南

| 鉤子 | 適合做什麼 | 不適合做什麼 |
|------|-----------|-------------|
| `GENERATION_CONTEXT_READY` | 裁剪/替換 `coreChat`，調整上下文限制 | 依賴世界書輸出的邏輯 |
| `GENERATION_BEFORE_WORLD_INFO_SCAN` | 影響世界書掃描的臨時修改 | 最終請求體編輯 |
| `GENERATION_WORLD_INFO_FINALIZED` | 讀取最終世界書結果、深度注入 | 重建掃描前的聊天切片假設 |
| `GENERATION_BEFORE_API_REQUEST` | 最終請求檢查、工具注入、Provider 特定附加 | 需要影響世界書啟動的修改 |

#### GENERATION_CONTEXT_READY payload

```ts
{
  type: string,           // normal/continue/regenerate/swipe/...
  dryRun: boolean,
  isContinue: boolean,
  isImpersonate: boolean,
  coreChat: ChatMessage[],
  maxContext: number,
}
```

### 圖像生成事件

`IMAGE_GENERATION_STARTED` 與 `IMAGE_GENERATION_ENDED` 在每一次圖像生成請求上各觸發一次。無論請求是正常完成、被中止還是出錯，每個 STARTED 都恰好對應一個 ENDED；並行請求各自配對。兩者都不攜帶任何參數。需要維護「當前是否在生成」狀態的監聽者應當做引用計數：STARTED 時 +1，ENDED 時 -1。

該契約涵蓋通過內建圖像生成擴充功能（Automatic1111、ComfyUI、NovelAI、Horde、OpenAI Images 等）調度的所有後端。提供自有圖像生成管線的外掛應遵循同樣的契約：每次請求各 emit 一次 STARTED 與 ENDED；這樣跨外掛的功能（例如後台保活）就能統一處理任何來源的圖像生成。

### APP_READY 事件

`APP_READY` 是一個特殊事件——它具有自動觸發特性。如果監聽器在應用啟動後才註冊，仍然會立即收到最後一次 `APP_READY` 的參數。這確保了延遲載入的外掛也能正確初始化。

## 聊天狀態

Luker 提供了聊天狀態機制，讓外掛可以將資料綁定到特定聊天，而不是塞進 `chat_metadata`。

### 基本用法

```js
const context = Luker.getContext();
const NAMESPACE = 'my-plugin';

// 讀取狀態
const state = await context.getChatState(NAMESPACE);

// 更新狀態（推薦方式）
await context.updateChatState(NAMESPACE, (current = {}) => ({
  ...current,
  lastUpdated: Date.now(),
  counter: (current.counter || 0) + 1,
}));

// 刪除狀態
await context.deleteChatState(NAMESPACE);
```

### 最佳實踐

- 使用 `updateChatState()` 進行讀-改-寫操作，而不是手動鏈式呼叫 `getChatState()` + `patchChatState()`
- 保持命名空間 payload 為可 JSON 序列化的純物件
- 對於大型外掛資料，優先使用聊天狀態而非 `chat_metadata`
- 處理 `ok: false` 回傳值，保持外掛 UI 的彈性

### 分支場景下的狀態處理

```js
context.eventSource.on(context.eventTypes.CHAT_BRANCH_CREATED, async (payload) => {
  const sourceState = await context.getChatState(NAMESPACE, {
    target: payload.sourceTarget,
  });
  if (!sourceState) return;

  await context.updateChatState(NAMESPACE, () => ({
    ...sourceState,
    branch: {
      sourceMesId: payload.mesId,
      branchName: payload.branchName,
      copiedAt: Date.now(),
    },
  }), {
    target: payload.targetTarget,
  });
});
```

## UI 整合

### 設定面板

外掛的設定面板透過 HTML 片段注入到擴充功能設定區域。使用 `inline-drawer` 類別實現可折疊的設定面板：

```js
jQuery(async () => {
  const settingsHtml = await $.get(`${extensionFolderPath}/settings.html`);
  $('#extensions_settings').append(settingsHtml);

  // 綁定設定控制項事件
  $('#my_plugin_enabled').on('change', function () {
    extension_settings[EXTENSION_NAME].enabled = $(this).prop('checked');
    saveSettingsDebounced();
  });

  // 初始化控制項狀態
  $('#my_plugin_enabled').prop('checked', extension_settings[EXTENSION_NAME].enabled);
});
```

### 彈窗對話框

Luker 提供了 `callGenericPopup` 等彈窗 API，用於顯示自訂對話框：

```js
import { callGenericPopup, POPUP_TYPE } from '../../../popup.js';

const result = await callGenericPopup(
  '<div>自訂內容</div>',
  POPUP_TYPE.CONFIRM,
  '標題',
);
```

### 斜線命令

外掛可以註冊自訂的斜線命令：

```js
import { registerSlashCommand } from '../../../slash-commands.js';

registerSlashCommand(
  'myplugin',
  async (args, value) => {
    // 命令邏輯
    return '命令執行結果';
  },
  [],
  '執行 My Plugin 操作',
);
```

## 外掛間通訊

### registerExtensionApi

外掛可以透過 `registerExtensionApi` 註冊命名 API，供其他外掛查找和呼叫：

```js
// 註冊方
const context = Luker.getContext();
context.registerExtensionApi('my-plugin', {
  doSomething: () => { /* ... */ },
  getData: () => myData,
});

// 呼叫方
const myPluginApi = context.getExtensionApi('my-plugin');
if (myPluginApi) {
  myPluginApi.doSomething();
}
```

## 除錯技巧

### 瀏覽器開發者工具

- 在瀏覽器主控台中使用 `Luker.getContext()` 直接檢查上下文物件
- 使用 `context.eventSource.getListenersMeta(eventName)` 查看某個事件的所有監聽器資訊
- 外掛身分在排序/除錯中透過擴充功能路徑推斷，包括第三方擴充功能（`third-party/<name>`）

### 前端日誌管理器

Luker 內建了前端日誌管理器，會攔截 `console` 輸出和 `fetch` 請求。透過 `getFrontendLogsSnapshot()` 取得日誌快照，支援按時間範圍和 ID 過濾。詳見[日誌系統](/zh-TW/features/logging)。

### 常見問題排查

| 問題 | 排查方向 |
|------|----------|
| 外掛未載入 | 檢查 `manifest.json` 格式是否正確，`js` 路徑是否存在 |
| 設定未儲存 | 確認呼叫了 `saveSettingsDebounced()` |
| 事件未觸發 | 使用 `getListenersMeta()` 確認監聽器已註冊 |
| 樣式衝突 | 使用帶外掛前綴的 CSS 類別名稱 |
| 狀態遺失 | 確認使用了正確的命名空間，檢查聊天狀態是否寫入成功 |

### 熱重載

在開發過程中，可以透過擴充功能管理面板停用/啟用外掛來觸發重新載入。修改 `style.css` 後通常需要重新整理頁面。

## 相關頁面

- [後端外掛開發](/zh-TW/development/server-plugin) — 伺服端外掛開發指南（檔案系統、API 代理、憑證儲存）
- [擴充 API 參考](/zh-TW/development/extension-api/) — 完整的 API 列表和詳細參數說明
- [角色卡開發](/zh-TW/development/card-developers) — 角色卡擴充欄位和 CardApp 開發
- [貢獻指南](/zh-TW/development/contributing) — 如何向 Luker 提交程式碼
