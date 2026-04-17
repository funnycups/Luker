# 其他改進

除了前面介紹的主要架構改進外，Luker 還在連線管理、網路代理、UI 互動、擴充系統、效能最佳化等多個方面進行了增強。

## 連線管理器改進

Luker 對 SillyTavern 已有的 Connection Profiles 功能進行了增強，使其與[預設解耦](/zh-TW/improvements/preset-decoupling)體系配合工作。改進後的連線管理器將連線配置與聊天補全預設完全分離——連線配置僅管理「連到哪裡」（API 位址、金鑰、代理等），不再包含生成參數。

啟動時自動執行遷移，清理舊配置中殘留的預設欄位和正則欄位。新增了 plain-text Function Calling 的開關和重試配置，可按連線配置獨立設定。支援透過斜線命令 `/profile` 快速切換配置。


## 提示詞分組

Luker 在 PromptManager 中新增了提示詞條目的分組能力。使用者可以將多個提示詞條目歸入命名分組，在 UI 中以可摺疊的分組形式展示。分組支援建立、重新命名、刪除操作；刪除分組時，組內成員變為未分組狀態。分組資訊隨預設儲存和載入。

## 預設分組

預設選擇器同樣支援分組功能。使用者可以將預設歸入命名分組，在下拉選擇器中以分組 header + 成員的層級結構展示。分組 header 渲染為不可選取的視覺分隔行，透過自訂的 `select2-actionable-single.js` 適配器實現。

## 預設關聯世界書

Luker 支援將世界書（Lorebook）與預設關聯。切換預設時，系統自動啟用對應的世界書，無需手動切換。撤銷預設切換時，全域世界書的啟用狀態也會同步恢復。

## 撤銷 Toast 系統

Luker 為多種破壞性操作添加了撤銷 Toast 提示，允許使用者在誤操作後快速恢復：

- 聊天刪除撤銷
- 角色卡刪除撤銷
- 預設刪除撤銷
- 世界書條目刪除撤銷
- 提示詞刪除/切換撤銷
- 提示管理器順序切換撤銷

## 動態模型列表

Luker 支援動態載入多種 API 的模型列表，取代寫死的靜態列表。目前支援動態載入的 API 包括 OpenAI、Claude、Vertex AI 等，也適用於各類 OpenAI 相容的第三方服務。同時支援為每個 API 來源自訂模型列表，方便使用第三方相容 API 時配置可用模型。

## 擴充鉤子排序

Luker 新增了 Hook Order 擴充，允許使用者自訂擴充的鉤子執行順序。當多個擴充監聽同一事件時，可以透過優先順序設定控制執行順序，支援第三方擴充 ID 和訊息事件。

## 角色狀態 API

Luker 為擴充提供了角色級別的持久化狀態儲存能力：

- `getCharacterState(avatar, namespace)` — 取得指定角色在指定命名空間下的狀態資料
- `setCharacterState(avatar, namespace, data)` — 設定角色狀態資料
- `registerExtensionApi(name, api)` — 註冊命名 API，供其他擴充查詢和呼叫

這些 API 透過全域上下文物件暴露，支援擴充間的鬆耦合通訊。預設同樣支援狀態儲存，帶生命週期鉤子。

## 啟動效能最佳化

Luker 對啟動流程進行了多項效能最佳化，包括並行化資源載入、預載入最近聊天快照、懶載入聊天索引等。

詳見 [啟動效能最佳化](/zh-TW/improvements/performance)。

## 行動裝置適配

Luker 針對行動裝置和 Android WebView 進行了大量適配修復，涵蓋虛擬鍵盤、IME 輸入、觸控事件、小螢幕佈局等方面。

詳見 [Android App](/zh-TW/guide/android)。

## 前端日誌管理器

Luker 新增了前端日誌管理器，用於前端除錯和問題排查：

- 攔截 `console.trace/debug/log/info/warn/error` 六個級別，寫入記憶體緩衝區（最多 3000 條）
- 攔截 `fetch` 請求，記錄 API 呼叫的請求/回應摘要（method、path、status、duration 等）
- 捕獲 `window.error` 和 `unhandledrejection` 全域錯誤
- 對請求 body 進行智慧摘要，提取關鍵資訊而非記錄完整內容
- 安全處理 Header，僅記錄非敏感欄位

透過 `getFrontendLogsSnapshot()` 取得日誌快照，支援按時間範圍和 ID 過濾。

> [!TIP]
> 後端日誌系統的詳細說明請參閱[認證與配額](/zh-TW/improvements/auth-and-quota)頁面的日誌系統章節。
