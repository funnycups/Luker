# 改進總覽

Luker 對 SillyTavern 的改進不是簡單的功能堆疊，而是從資料傳輸架構、預設系統、擴充能力等多個維度進行的系統性重構。這些改進相互配合，共同構成了一個更高效、更靈活的角色扮演平台。

## 改進一覽

| 分類 | 改進項 | 簡要描述 |
| --- | --- | --- |
| 架構 | [預設解耦](/zh-TW/improvements/preset-decoupling) | 將連線參數與預設分離為獨立實體 |
| 架構 | [增量同步](/zh-TW/improvements/incremental-sync) | 基於增量 patch 的資料傳輸，替代全量覆蓋 |
| 架構 | [後端即時儲存](/zh-TW/improvements/backend-storage) | 資料變更即時持久化，完整性校驗防止並行衝突 |
| 功能 | [函數呼叫執行時](/zh-TW/improvements/function-call-runtime) | 原生與純文字兩種模式的統一函數呼叫支援 |
| 功能 | [角色卡綁定預設與人設](/zh-TW/improvements/card-bound-presets) | 角色卡可攜帶推薦預設和預設人設 |
| 功能 | [請求檢查器](/zh-TW/improvements/request-inspector) | 追蹤生成請求的完整生命週期與 Token 用量 |
| 功能 | [預設關聯世界書](/zh-TW/improvements/preset-world-info) | 切換預設時自動啟用對應的世界書 |
| 基礎設施 | [統一生成層](/zh-TW/improvements/generation-layer) | 多後端生成請求統一封裝與 Token 計量 |
| 基礎設施 | [效能最佳化](/zh-TW/improvements/performance) | 並行載入、懶載入、延遲初始化等啟動和執行時最佳化 |
| 基礎設施 | [WebSocket 代理](/zh-TW/improvements/ws-proxy) | 持久 WS 隧道傳輸，心跳保活與串流偏移恢復 |
| 基礎設施 | [認證與配額](/zh-TW/improvements/auth-and-quota) | OAuth 登入、多使用者認證與儲存配額管理 |
| 基礎設施 | [其他改進](/zh-TW/improvements/other) | 連線管理器增強、提示詞/預設分組、動態模型列表等 |

獨有功能模組（記憶圖、編排器、角色編輯助手、搜尋工具、CardApp 等）請參閱 [獨有功能](/zh-TW/features/memory-graph) 分類。

## 架構改進

### 預設解耦

SillyTavern 中，API 連線參數（如模型名稱、API 位址、代理設定）與預設（如溫度、Top-P、提示詞配置）耦合在同一個配置物件中。這意味著切換 API 提供商時，使用者不得不重新配置生成參數；反過來，調整取樣策略也可能意外影響連線設定。

Luker 將兩者拆分為獨立實體：**連線配置**負責「連到哪裡」，**預設**負責「怎麼生成」。在程式碼層面，每個設定欄位都透過 `isConnection` 標記進行分類，載入預設時自動跳過連線欄位。兩者可以自由組合——同一套預設可以搭配不同的 API 連線使用，反之亦然。

這一解耦也為角色卡綁定預設、連線管理器等下游功能奠定了基礎。詳見 [預設解耦](/zh-TW/improvements/preset-decoupling)。

### 增量同步

傳統的前後端資料同步採用全量覆蓋：每次修改都將完整物件傳送到伺服器端。當物件體積增長（如包含大量訊息的聊天記錄），這種方式會產生顯著的頻寬浪費和寫入衝突風險。

Luker 新增了三個增量端點：

- **`append`**：將新訊息追加到 `.jsonl` 檔案末尾，而非重寫整個檔案
- **`patch`**：按訊息索引修補指定行，只更新變更的訊息
- **`patch-metadata`**：使用深度合併更新聊天中繼資料，而非替換

每次寫入後，後端計算檔案的 integrity hash 並回傳給前端；後續請求攜帶該值進行校驗，不匹配時回傳 409 Conflict，從根本上防止並行寫入衝突。設定資料同樣支援增量 patch 儲存，帶衝突偵測和序列化寫入。詳見 [增量同步](/zh-TW/improvements/incremental-sync)。

### 後端即時儲存

SillyTavern 的部分資料依賴前端觸發儲存，存在「使用者已操作但資料未落盤」的時間窗口。一旦程序異常退出，這些變更就會遺失。

Luker 將儲存邏輯下沉到後端：資料變更在到達伺服器端的同時即刻持久化到磁碟。前端不再承擔「何時儲存」的職責，從根本上消除了資料遺失的窗口期。

此外，Luker 引入了以下機制保障資料安全：

- **聊天狀態檔案**：`.luker-state.<chat_id>.json` 檔案為每個聊天維護額外狀態，生命週期與聊天檔案綁定
- **Generation Acknowledge**：AI 生成完成後透過專用端點確認，確保生成結果被正確記錄
- **序列化聊天寫入**：防止並行寫入導致資料損壞，特別針對群組聊天場景
- **可配置備份策略**：支援聊天檔案的自動備份

詳見 [後端即時儲存](/zh-TW/improvements/backend-storage)。

## 功能增強

### 函數呼叫執行時

Luker 內建了統一的函數呼叫（Function Calling）執行時，支援兩種工作模式：

- **原生模式**：利用 API 提供商的原生工具呼叫能力（相容 OpenAI、Claude、Gemini 等格式），由模型直接輸出結構化呼叫指令，支援串流工具呼叫規範化
- **純文字模式**：透過提示詞引導模型在普通文字中輸出呼叫意圖，再由執行時解析執行，支援多工具呼叫和可配置的錯誤重試

兩種模式覆蓋了從高階商業 API 到本地小模型的全部場景。連線管理器中可按配置獨立設定純文字函數呼叫的開關和重試策略。詳見 [函數呼叫執行時](/zh-TW/improvements/function-call-runtime)。

### 角色卡綁定預設與人設

角色卡的創作者往往最清楚角色在什麼參數下表現最佳。Luker 允許角色卡攜帶**推薦預設**（已自動剝離連線欄位）和**預設人設**。使用者載入角色卡時，系統自動套用創作者推薦的配置並記錄之前的預設；離開角色時自動恢復。預設選擇器中，綁定預設以特殊徽章標識，與普通預設視覺區分。

聊天人設鎖定（Chat Persona Lock）功能則將使用者人設與特定聊天綁定，切換聊天時自動恢復對應的角色設定。這些功能建立在預設解耦的基礎之上——正因為預設是獨立實體，才能被角色卡引用和分發。詳見 [角色卡綁定預設與人設](/zh-TW/improvements/card-bound-presets)。

### 請求檢查器

除錯 AI 對話時，使用者經常需要知道「到底發了什麼給 API」。Luker 的請求檢查器追蹤每個 AI 生成請求從發起到完成的完整生命週期，記錄 prompt token、completion token 和總用量。它支援串流回應的 Token 統計（從 SSE 事件中提取 usage 資訊），也覆蓋圖像生成請求的追蹤。請求檢查器追蹤的 Token 用量是獨立的統計功能，與儲存配額管理是兩個獨立的系統。詳見 [請求檢查器](/zh-TW/improvements/request-inspector)。

## 基礎設施

### 統一生成層

SillyTavern 中，不同 AI 後端（OpenAI、Anthropic、Google、Kobold 等）的生成請求走各自獨立的程式碼路徑，導致功能支援不一致。Luker 新增了統一生成層，將多後端的生成請求統一封裝，共享 Token 計量、串流處理和錯誤處理邏輯。

該模組為所有 AI 後端提供統一的處理管線，確保無論使用哪種 AI 服務，使用者都能獲得一致的功能體驗（如請求檢查、Token 統計、生成確認等）。詳見 [統一生成層](/zh-TW/improvements/generation-layer)。

### 認證與配額

Luker 增加了 OAuth 登入支援（GitHub、Discord）和儲存配額管理：

- **OAuth 登入**：透過前端管理員面板配置（儲存在 `admin-settings.json` 的 `oauth` 配置段中），支援授權碼換取 access token、自動建立或關聯本地使用者帳戶
- **儲存配額**：管理員可為不同使用者設定儲存空間配額上限，系統在請求前自動檢查額度
- **日誌系統**：詳見 [日誌系統](/zh-TW/features/logging)

這使得 Luker 能夠在多人共享部署的場景下安全運行。詳見 [認證與配額](/zh-TW/improvements/auth-and-quota)。

### 其他改進

除上述核心改進外，Luker 還包含大量基礎設施最佳化：

- **連線管理器改進**：對 SillyTavern 已有的 Connection Profiles 進行增強，與預設解耦深度整合，支援獨立的純文字函數呼叫開關
- **WebSocket 代理**：透過持久 WS 隧道傳輸生成請求，包含心跳保活和串流偏移恢復
- **HTTP 請求代理**：支援 SOCKS5/HTTP 代理轉發出站請求
- **預設分組 & 提示詞分組**：預設選擇器和提示詞管理器支援可折疊的分組區段
- **預設關聯世界書**：切換預設時自動啟用對應的世界書
- **撤銷 Toast 系統**：為破壞性操作提供撤銷提示
- **動態模型列表**：Claude 和 Vertex 模型列表動態載入
- **擴充鉤子排序**：允許使用者自訂擴充的執行優先順序
- **角色狀態 API**：擴充可在角色和預設上儲存持久化狀態資料
- **啟動效能最佳化**：並行化資源載入、預載入最近聊天快照、懶載入聊天索引
- **行動裝置適配**：大量 Android WebView 和觸控互動修復

詳見 [其他改進](/zh-TW/improvements/other)。

## 與 SillyTavern 的關係

Luker 是 SillyTavern 的下游分支，而非獨立專案。所有改進都以**不破壞上游相容性**為前提進行設計：

- **定期同步**：Luker 持續追蹤 SillyTavern 上游的更新，定期合併上游變更
- **資料相容**：Luker 的資料格式在 SillyTavern 的基礎上進行擴充而非替換。新增的狀態檔案和配置項都有合理的預設值
- **功能疊加**：Luker 的改進是在上游功能之上的增量疊加，而非破壞性重寫。從 SillyTavern 遷移到 Luker 時，使用者的現有資料可以無縫使用
