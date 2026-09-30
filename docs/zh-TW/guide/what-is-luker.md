# Luker 是什麼

Luker 是基於 [SillyTavern](https://github.com/SillyTavern/SillyTavern) 深度重構的角色扮演聊天平台。它保留了 SillyTavern 成熟的角色卡生態和資料格式相容性，同時在資料傳輸架構、擴充能力和內建工具鏈上進行了大量創新，為角色扮演場景提供更高效、更強大的體驗。

Luker 完全相容 SillyTavern 的資料——角色卡、世界書、預設均可直接使用，遷移成本為零。如果你不想繼續使用 Luker，也可以隨時降級回 SillyTavern，資料不會被破壞。

## 為什麼選擇 Luker

SillyTavern 是一款優秀的角色扮演前端，擁有活躍的社群和豐富的角色卡生態。Luker 在此基礎上，針對以下方向做了系統性改進：

### 更高效的資料傳輸

SillyTavern 的大部分儲存操作採用全量傳輸——每次編輯訊息、切換設定、修改世界書，都會將完整資料傳送到後端。對於雲端部署的使用者，這意味著顯著的流量消耗。

Luker 引入了增量同步機制，統一使用遵循 [RFC 6902](https://datatracker.ietf.org/doc/html/rfc6902) 標準的 patch 端點。以前切換一個外掛設定需要傳輸 3MB 資料，現在不到 200 位元組。儲存操作還支援延遲觸發和衝突偵測，從根本上避免了並行寫入導致的資料損壞。

### 更強的擴充能力

Luker 為外掛開發者提供了更豐富的基礎設施：角色/預設狀態 API、託管正則提供者、統一的擴充注入設定、函式呼叫執行環境等。外掛可以方便地複用使用者已有的 API 預設和聊天補全預設，無需重複設定。

### 內建專業工具鏈

Luker 內建了多個面向角色扮演場景的專業工具——記憶圖、多 Agent 編排、角色卡編輯助手、搜尋外掛等，開箱即用，無需額外安裝第三方擴充。

## 核心特性概覽

### 記憶圖（Memory Graph）

基於知識圖譜的角色記憶系統。角色扮演中的事件、人物、地點、主線等資訊會被提取成帶類型的節點並互相連邊。每次回覆寫出之前，召回環節會選出與當前場景最相關的節點，並將其注入創作上下文。召回有兩種方式：**LLM 召回**（預設，由模型從記憶庫中選出相關節點，支援多輪探索）和 **RAG 召回**（在嵌入庫上做向量檢索，可選交叉編碼器重排，可選 LLM 查詢改寫）。提取在每次回覆後獨立執行，可以走內建管線，也可以交給編排器的子 agent。

→ [記憶圖詳細文件](/zh-TW/features/memory-graph)

### 多 Agent 編排（Orchestrator）

在創作 LLM 生成回覆之前，agent 團隊會先完成場景規劃：其中一個壓縮最近上下文，另一個草擬這一回合應完成的內容，再有一個負責審校方案，最後將規劃結果打包成一份簡短說明交給寫作模型。提供五種執行模式：**Spec**（固定的 Stage → Node 流水線，預設）、**單 Agent**、**Agenda**（規劃器透過工具呼叫派遣 agent）、**Loop**（單一 agent 進行迴圈迭代）、**Director**（主 agent 帶一支子 agent 團隊直接寫正文）。無論採用哪種模式，agent 的全部操作都會以執行時 trace 的形式保留，供你展開查看。編排設定可綁定到角色卡並隨角色卡匯入匯出。

→ [多 Agent 編排詳細文件](/zh-TW/features/orchestrator/)

### 技能（Skills）

可重用的知識包，供 agent 按需讀取，用來代替一份巨型系統提示詞。技能支援 Anthropic Claude Skills 格式，與 Claude Code 雙向互通無需轉換。預設 Director profile 自帶 24 個內建技能，技能也可以隨角色卡或預設一起分發——分發角色卡時，也會一併分發讓這張卡正常運作的寫作規則。

→ [技能文件](/zh-TW/features/skills/)

### 角色卡編輯助手（CEA / CardApp Studio）

整合 CodeMirror 6 程式碼編輯器的 AI 輔助角色卡編輯工具。它透過自然語言對話編輯角色卡、世界書和 CardApp 程式碼，以結構化工具呼叫提交真實改動，每一批都經過 diff 審批——沒被批准的改動不會生效。替換或更新角色卡時，它會發現世界書變更，並給出三個選項：匯入新書、保留舊書、或借 AI 之力合併。普通角色卡用彈窗版編輯助手，含 CardApp 的角色卡進入功能更完整的 Studio。

→ [角色卡編輯助手概覽](/zh-TW/features/card-editor/)　·　[普通彈窗](/zh-TW/features/card-editor/popup)　·　[CardApp Studio](/zh-TW/features/card-editor/studio)

### 補全預設助手（Preset Assistant）

面向聊天補全預設的 AI 助手。它會讀取目前預設的真實取值，解釋每個參數的作用，既能改取樣參數也能改提示詞條目，還能和參考預設做對比——每一批改動都以 diff 形式讓你審批。下游消費者為編排器的預設，也走同一套流程。

→ [補全預設助手詳細文件](/zh-TW/features/preset-assistant)

### 搜尋外掛（Search Tools）

為 AI 提供聯網搜尋能力，支援 DuckDuckGo、SearXNG、Brave Search 等搜尋引擎後端。提供兩種工作模式：作為創作 LLM 的可呼叫工具，或作為預請求 Agent 在生成前自動搜尋並將結果寫入世界書。

→ [搜尋外掛詳細文件](/zh-TW/features/search-tools)

### TTS NPC 對白歸屬

開啟 TTS 之後，一則回覆裡每一句引號台詞都可以用說話者自己的聲音唸出來。後台會有一個 AI 環節判斷每句台詞是誰說的——它發現的 NPC 會自動出現在語音映射裡；你事先手動加入的名字，從第一次播放起就能被辨識。

→ [TTS NPC 對白歸屬詳細文件](/zh-TW/features/tts-npc-attribution)

### 聊天合併與拆分

任意位置拆開一條聊天，或者把兩條聊天合併成一條；兩邊的分支歷史都保持一致。

→ [聊天合併與拆分詳細文件](/zh-TW/features/chat-merge-split)

### 區域網路同步

把同一網路下的兩台 Luker 實例配對，聊天、角色卡、世界書、設定在兩者之間保持一致——不需要把任何東西推到雲端。

→ [區域網路同步詳細文件](/zh-TW/improvements/lan-sync)

### Android 應用

後端完全在 Android 應用內執行，一支手機同時充當伺服端和介面。安裝 APK 即可使用——不需要 Termux、不需要手動安裝 Node、不需要連接埠轉送。

→ [Android 應用指南](/zh-TW/guide/android)

### 換模型不必重配提示詞

SillyTavern 中 API 預設和聊天補全預設是連動切換的，換一個模型可能悄悄覆蓋掉你的 API 位址、金鑰或提示詞設定。Luker 把連線欄位和生成參數分開，你可以自由搭配不同的 LLM 後端和提示詞預設。

→ [預設解耦](/zh-TW/improvements/preset-decoupling)

### 關閉分頁，回覆仍會繼續生成

生成在後端執行，並串流推送到介面；資料變更到達伺服器即在後端落盤。重新整理分頁、蓋上筆電、回覆寫到一半斷網：生成會繼續在伺服端執行，你回來時自動重連。資料改動以增量 patch 寫入而非全量覆蓋，多分頁、多裝置同時寫入也不會互相覆蓋。

→ [後端即時儲存](/zh-TW/improvements/backend-storage)

### 函式呼叫執行環境（Function Call Runtime）

統一的函式呼叫 / 工具呼叫執行環境，支援兩種模式：

- **原生工具呼叫**：相容 OpenAI、Claude、Gemini 等 API 的原生 tool call 格式
- **純文字函式呼叫**：透過文字協定實現工具呼叫，適用於不支援原生工具呼叫的模型

→ [函式呼叫執行環境](/zh-TW/improvements/function-call-runtime)

### CardApp

角色卡內嵌應用執行環境。允許角色卡攜帶自訂應用邏輯，提供上下文 API 和生命週期管理。

→ [CardApp](/zh-TW/features/cardapp)

### 角色卡綁定預設與人設

角色卡可以綁定專屬的聊天補全預設和使用者人設（Persona）。綁定的預設和人設獨立於全域列表，不會污染使用者的全域設定，關閉角色卡聊天後自動消失，並可隨角色卡匯入匯出。角色卡開發者不必再要求使用者手動匯入專屬預設。

→ [角色卡綁定預設與人設](/zh-TW/improvements/card-bound-presets)

### 請求檢查器（Request Inspector）

每位使用者的生成請求診斷工具，可追蹤所有後端（包括圖像生成和向量嵌入 / 重排呼叫）的請求詳情，方便除錯和排查問題。

→ [請求檢查器](/zh-TW/improvements/request-inspector)

### 認證與配額

支援 GitHub / Discord OAuth 登入，管理員可為每位使用者設定空間大小配額。Discord 登入可額外要求使用者必須在指定伺服器中或擁有特定身分組。

→ [認證與配額](/zh-TW/improvements/auth-and-quota)

::: tip 更多特性

- **備份、儲存與遷移**——按資料類別[備份與還原](/zh-TW/features/user-settings-additions)，查看[伺服端](/zh-TW/features/storage-inspector)和瀏覽器端的儲存佔用，還能透過區域網路把整套環境遷移到新裝置。
- **給角色卡作者的結構化資料**——[逐樓層變數](/zh-TW/features/variable-op-log)和[狀態系統](/zh-TW/features/state-system)。
- **排查問題**——[日誌系統](/zh-TW/features/logging)可切換前端與後端來源，另有一鍵匯出除錯包。
- **日常體驗**——[沉浸模式、行動端後台保活、回覆完成通知、訊息媒體延遲載入](/zh-TW/features/user-settings-additions)、復原 Toast、聊天人設鎖定、預設與提示詞的分組摺疊、從提供商即時拉取的模型列表、世界書啟動鏈路追蹤、預設關聯世界書、外掛註冊正則。
:::

## 相容性

Luker 與 SillyTavern 保持資料格式層面的完全相容：

| 資料類型 | 相容性 |
|---------|--------|
| 角色卡（PNG/JSON） | ✅ 完全相容，可雙向匯入匯出 |
| 世界書 / Lorebook | ✅ 完全相容 |
| 聊天記錄 | ✅ 完全相容 |
| 聊天補全預設 | ✅ 完全相容 |
| 第三方擴充 | ✅ 相容，支援 isomorphic-git 回退 |
| 使用者設定 | ✅ 完全相容 |

::: info 雙向遷移
你可以隨時從 SillyTavern 遷移到 Luker，也可以從 Luker 降級回 SillyTavern。Luker 新增的功能資料（如記憶圖、編排設定等）儲存在獨立的狀態檔案中，不會影響 SillyTavern 的核心資料結構。但仍建議在遷移前做好備份。
:::

## 下一步

準備好開始使用了嗎？

→ [快速開始](/zh-TW/guide/getting-started) — 安裝和部署 Luker
