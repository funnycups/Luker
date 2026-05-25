# 更新日誌

> 🚧 完整的更新日誌正在整理中。以下是 Luker 主要版本的功能概覽。

## 當前版本

### 核心功能

- **記憶圖**：基於知識圖譜的長期記憶系統，9 層混合召回管線
- **多 Agent 編排**：三種執行模式（Spec 工作流、單 Agent、Agenda 規劃器）
- **角色卡編輯助手**：AI 驅動的對話式角色卡編輯，7 個工具
- **搜尋外掛**：DuckDuckGo、SearXNG、Brave Search 三引擎支援
- **補全預設助手**：AI 輔助預設參數理解和最佳化
- **CardApp**：角色卡內嵌互動式應用

### 架構改進

- **預設解耦**：連線參數與預設獨立管理
- **增量同步**：RFC 6902 格式的增量資料傳輸
- **後端即時儲存**：資料變更即時持久化
- **函式呼叫執行時**：原生 + 純文字兩種模式
- **統一生成層**：多後端統一封裝
- **請求檢查器**：生成請求全生命週期追蹤
- **認證與配額**：GitHub/Discord OAuth + 儲存配額管理

### 使用者體驗

- 角色卡綁定預設與人設
- 提示詞分組 & 預設分組
- 鉤子執行排序
- 世界書啟動鏈路追蹤
- 聊天人設鎖定
- 撤銷 Toast 系統
- 動態模型列表
- 圖像生成增強
- 行動裝置適配最佳化
- 啟動效能最佳化

## 近期破壞性變更

- **CardApp Studio 回滾到獨立全屏 UI**（2026 年 5 月短暫上線的「接入迭代工作台外殼」版本失去了 viewport 所有權，UX 明顯退化）。Studio 現在透過兩塊 `position:fixed` 面板再次接管 viewport，配合行動端 tab、檔案樹、CodeMirror 6 編輯器與對話流內聯的審批卡片 —— 跟 SP-2 之前使用者熟悉的 UX 一致。檔案操作仍然享受 edits-lib 的漂移檢測與單條 inverse —— 這是原獨立版本沒有的新能力。短暫期間的 session 桶（`cardapp_studio_sessions_v2`）首次打開時清空；磁碟上的 CardApp 檔案不受影響。

- **edits-lib 現在支援兩種整合方式**：套上 iteration-studio 外殼適配器適合彈窗形式的介面；直接用函式庫原語適合全屏 / 自定義 UI。CardApp Studio 是直接用法的倉庫內參考實作。

- **CPA 基於迭代工作台外殼重構**（適配器遷移 SP-4，Plan 2 收官）。309 行的 `dialog-ui.js` 被刪除；CPA 既有的 IDE 風格業務輔助函式（`handleApplyDraft`、`handleRollbackToMessage`、`handleMessageDiff`）保持不變，現在執行於共享外殼之上。SP-4 落地後，Luker 中全部五個 AI 驅動的編輯面（編排器、記憶圖、CEA CardApp Studio、CEA 角色編輯器、CPA）共享同一個外殼、同一種儲存模型、同一套 edits-lib 與同一個衝突解決 UI。
- **CEA 角色編輯器基於迭代工作台外殼重構**（適配器遷移 SP-3）。世界書同步分析彈窗被多輪迭代會話替代。一個適配器同時編輯角色卡與世界書；新增 3 個 CEA 自有的 edits-lib 自定義 op（`lorebook_entry_add / update / remove`），以條目 uid 為鍵。外殼現每次開啟時呼叫一次 `adapter.registerCustomOps(registry)`。舊的 `lorebookSyncHistory` 設定項會在首次開啟時被清除；磁碟上的角色卡與世界書資料不受影響。
- **迭代工作台適配器合約 v2（IDE 風格）。** Shell 不再持有 `workingProfile` 快照；適配器的 `live()` 為唯一權威源。已遷移內建 orchestrator + memory-graph 適配器。外部適配器需要相應升級（參見 `docs/zh-TW/development/extension-api/iteration-studio.md`）。升級後首次打開時按適配器清空一次舊的迭代工作台會話數據；實時數據（預設文件、角色卡、設定）不受影響。CEA 與 CPA 適配器將在後續版本提供。

---

詳細的逐版本更新日誌將在後續補充。如需了解具體功能的詳細資訊，請參閱對應的文件頁面。
