# 擴充 API 參考

本文件是 Luker 擴充功能 API 的完整參考，面向外掛開發者。所有 API 均透過 `Luker.getContext()` 暴露。完整參考分為以下子頁面：

| 頁面 | 涵蓋內容 |
| --- | --- |
| [聊天與狀態](/zh-TW/development/extension-api/chat-and-state) | 聊天資料、統一訊息 API、聊天持久化、聊天狀態、樓層狀態、角色狀態、聊天生命週期、swipe API、擴充提示詞、媒體輔助函式 |
| [角色卡](/zh-TW/development/extension-api/characters) | 角色卡、V2 / 傳統 Proxy 語義、標籤、匯入 / 匯出、角色狀態 |
| [世界書](/zh-TW/development/extension-api/world-info) | 世界書 CRUD、啟動掃描、角色輔助世界書 |
| [預設與提示詞](/zh-TW/development/extension-api/presets-and-prompts) | `context.presets.*`、`buildPresetAwarePromptMessages`、`resolveWorldInfoForMessages`、信封檢視、推理輔助函式、設定視圖 |
| [生成請求](/zh-TW/development/extension-api/generation) | `generateTask`、工具註冊、`generateRaw` / `generateQuietPrompt`、Service 類別、connection profile |
| [斜線指令](/zh-TW/development/extension-api/slash-commands) | 註冊與執行斜線指令、具名 / 不具名引數、列舉 |
| [巨集與變數](/zh-TW/development/extension-api/macros-and-variables) | 巨集註冊、內建巨集參考、`substituteParams`、本地與全域變數 |
| [Skill](/zh-TW/development/extension-api/skills) | `context.skills.*` —— 安裝、讀取、寫入、搜尋、遷移作用域、嵌入打包 / 抽取；CardApp ctx 對等 |
| [UI 與彈窗](/zh-TW/development/extension-api/ui-and-popups) | 彈窗、載入器、範本、訊息格式化 |
| [IterationStudio](/zh-TW/development/extension-api/iteration-studio) | AI 驅動迭代編輯的共享彈窗框架 —— 對話、會話、diff 預覽、批准 / 拒絕生命週期。adapter 提供工件形狀和工具 |
| [外掛整合](/zh-TW/development/extension-api/plugin-integration) | 正則執行時、搜尋工具、擴充 API 註冊表、事件系統、i18n、設定儲存、除錯與 scraper 註冊、tokenization、工具函式、symbols 與常數 |
| [底層端點](/zh-TW/development/extension-api/low-level-endpoints) | 原始 HTTP 路由（僅供進階 / 除錯場景使用） |

## 全局入口

```js
const context = Luker.getContext();
```

| 別名 | 說明 |
|------|------|
| `Luker.getContext()` | 推薦使用 |
| `SillyTavern.getContext()` | 相容別名 |
| `st.getContext()` | 相容別名 |

新外掛應統一使用 `Luker.getContext()`。相容別名僅為遷移期保留。

## 命名空間速查

要快速找到某個 API 在哪裡，context 物件把相關 API 分組到命名空間下：

| 命名空間 | 內容 |
|------|------|
| `context.presets` | `list`、`getSelected`、`getLive`、`getStored`、`save`、`resolve`、`readExtensions`、`writeExtensions`、`state.*` |
| `context.connectionProfiles` | `list`、`resolve`（不推薦直接使用） |
| `context.variables.local` | `get`、`set`、`add`、`inc`、`dec`、`del`、`has` |
| `context.variables.global` | `get`、`set`、`add`、`inc`、`dec`、`del`、`has` |
| `context.swipe` | `left`、`right`、`to`、`show`、`hide`、`refresh`、`isAllowed`、`state` |
| `context.symbols` | `ignore`（`IGNORE_SYMBOL` 哨兵） |
| `context.constants` | `unset`、`promptRoles`、`promptTypes`、`wiAnchor`、`wiPosition` |
| `context.macros` | `register`、`registerAlias`、`registry`、`engine`、`category`、`envBuilder` |
| `context.loader` | `show`、`hide`、`active`、`get`、`isBlocking`、`ToastMode`、`Handle` |
| `context.skills` | `list`、`get`、`readFile`、`listFiles`、`search`、`writeFile`、`editFile`、`deleteFile`、`install`、`delete`、`rename`、`moveScope`、`importBundled`、`listBundledManifest`、`packForEmbed`、`previewExtractEmbed`、`executeExtractEmbed`、`importFromUrl` |
| `context.worldInfoEntry` | `template`、`create`、`delete`、`setButtonClass`、`setGlobalSelection`、`getSorted` |
| `context.chatWorldInfo` | `getNames`、`setSelection`、`globalSelection` |
| `context.openai` | `proxies`、`ZAI_ENDPOINT`、`stripPresetConnectionFields` |
| `context.textCompletion` | `types` |
| `context.secrets` | `KEYS`、`state` |
| `context.lib` | `DOMPurify`、`lodash`、`DiffMatchPatch`、`showdown`、`yaml` |

## 與 SillyTavern 的 API 差異

Luker 基於 SillyTavern 建構，但在 API 層面有以下主要差異：

| 領域 | SillyTavern | Luker |
|------|-------------|-------|
| 聊天持久化 | 整檔覆寫 | Patch-first（RFC 6902 增量更新） |
| 聊天綁定狀態 | 僅 `chat_metadata` | 新增聊天狀態機制 + 樓層狀態 |
| 角色狀態 | 無 | `getCharacterState` / `setCharacterState`（與卡 JSON 分離） |
| 預設管理 | 直接匯入內部模組 | `context.presets.*` 統一 API |
| 提示詞組裝 | 需要手動拼接 | `buildPresetAwarePromptMessages()` |
| 世界書模擬 | 無 | `simulateWorldInfoActivation()` |
| 角色輔助世界書 | 無 | `getCharaAuxWorlds()` |
| 生成鉤子 | 基礎事件 | 新增 `GENERATION_CONTEXT_READY`、`GENERATION_BEFORE_WORLD_INFO_SCAN` 等細粒度鉤子 |
| 事件排序 | 註冊順序 | 支援 `priority`、`pluginOrder`、`makeFirst`/`makeLast` |
| 正則執行時 | 無外掛 API | `registerManagedRegexProvider()` |
| 搜尋工具 | 無外掛 API | `Luker.searchTools` 全域 API |
| 函數呼叫 | 基礎 `ToolManager` | 純文字模式支援 + 連線級獨立開關 + `sendOpenAIRequest` 預設覆寫 |
| 連線設定 | 全域單一 | `context.presets.resolve()` 支援按預設解析連線設定 |
| 巨集引擎 | 字串替換 | 結構化的 `macros.register()`，帶處理器上下文、引數、分類 |
| 角色物件 | 純 V1/V2 欄位 | 帶 V2 標準化與傳統寫入棄用警告的 Proxy |

> [!IMPORTANT]
> 優先使用 `Luker.getContext()` 提供的 API，而非直接呼叫底層 HTTP 端點。Context API 封裝了 patch-first 語義、衝突處理和重試邏輯，直接呼叫端點需要自行處理這些細節。

## 相關頁面

- [前端外掛開發](/zh-TW/development/frontend-plugin) — 外掛結構、事件系統、UI 整合
- [角色卡開發](/zh-TW/development/card-developers) — 角色卡擴充功能欄位和 CardApp
- [增量同步](/zh-TW/improvements/incremental-sync) — 增量儲存的技術細節
- [預設解耦](/zh-TW/improvements/preset-decoupling) — 預設與 API 選擇的解耦機制
