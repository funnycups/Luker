# 擴充 API 參考

本文件是 Luker 擴充功能 API 的完整參考，面向外掛開發者。所有 API 均透過 `Luker.getContext()` 暴露。完整參考分為以下子頁面：

| 頁面 | 涵蓋內容 |
| --- | --- |
| [聊天與狀態](/zh-TW/development/extension-api/chat-and-state) | 聊天資料、統一訊息 API、聊天持久化、聊天狀態、樓層狀態、角色狀態 |
| [預設與提示詞](/zh-TW/development/extension-api/presets-and-prompts) | `context.presets.*`、`buildPresetAwarePromptMessages`、`resolveWorldInfoForMessages` |
| [生成請求](/zh-TW/development/extension-api/generation) | `sendOpenAIRequest`、工具註冊、連線設定解析 |
| [外掛整合](/zh-TW/development/extension-api/plugin-integration) | 正規執行時、搜尋工具、擴充功能間通訊、事件系統 |
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

## 與 SillyTavern 的 API 差異

Luker 基於 SillyTavern 建構，但在 API 層面有以下主要差異：

| 領域 | SillyTavern | Luker |
|------|-------------|-------|
| 聊天持久化 | 整檔覆寫 | Patch-first（RFC 6902 增量更新） |
| 聊天綁定狀態 | 僅 `chat_metadata` | 新增聊天狀態機制 |
| 預設管理 | 直接匯入內部模組 | `context.presets.*` 統一 API |
| 提示詞組裝 | 需要手動拼接 | `buildPresetAwarePromptMessages()` |
| 世界書模擬 | 無 | `simulateWorldInfoActivation()` |
| 生成鉤子 | 基礎事件 | 新增 `GENERATION_CONTEXT_READY`、`GENERATION_BEFORE_WORLD_INFO_SCAN` 等細粒度鉤子 |
| 事件排序 | 註冊順序 | 支援 `priority`、`pluginOrder`、`makeFirst`/`makeLast` |
| 正則執行時 | 無外掛 API | `registerManagedRegexProvider()` |
| 搜尋工具 | 無外掛 API | `Luker.searchTools` 全域 API |
| 函數呼叫 | 基礎 `ToolManager` | 純文字模式支援 + 連線級獨立開關 + `sendOpenAIRequest` 預設覆寫 |
| 連線設定 | 全域單一 | `context.presets.resolve()` 支援按預設解析連線設定 |

> [!IMPORTANT]
> 優先使用 `Luker.getContext()` 提供的 API，而非直接呼叫底層 HTTP 端點。Context API 封裝了 patch-first 語義、衝突處理和重試邏輯，直接呼叫端點需要自行處理這些細節。

## 相關頁面

- [前端外掛開發](/zh-TW/development/frontend-plugin) — 外掛結構、事件系統、UI 整合
- [角色卡開發](/zh-TW/development/card-developers) — 角色卡擴充功能欄位和 CardApp
- [增量同步](/zh-TW/improvements/incremental-sync) — 增量儲存的技術細節
- [預設解耦](/zh-TW/improvements/preset-decoupling) — 預設與 API 選擇的解耦機制
