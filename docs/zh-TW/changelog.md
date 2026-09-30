# Changelog

本更新日誌涵蓋 Luker 自 v1.0.0 起的每一個版本，直至目前開發版。已發布版本的條目取自 GitHub 上的版本發布說明，「未發布」一節記錄下一版的改動。

## 未發布

### 多智能體編排

- **新增兩個出廠導演預設**，每個模式都有預設說明，可一鍵匯入。
- **技能可以綁定到編排預設**，隨預設改名、刪除與匯出。
- **導演、循環與議程智能體可以用尋找取代工具修改自己的系統提示詞**。
- **自訂工具可以在迭代工作台裡編寫並試執行**。
- 每個預設可定義世界書過濾規則，在智能體讀取世界書的所有場景生效。
- spec 與 agenda 智能體現在會讀取 Open Notes。
- 使用者正規表示式會作用於智能體的輸入與輸出。
- 提升了智能體輪次上限，並移除了可設定項裡隱藏的數值上限。
- 編排器設定抽屜重組為「智能體」「工具與技能」「通用」三個分頁，所有改動自動儲存。
- 執行面板顯示每個智能體的用時，模擬審查會把最終輸出置頂並自動摺疊已完成回合。
- 停止執行現在立即生效，不再等當前輪次結束。
- 修復了新建或重新命名預設後選項不重新整理的問題，全域迭代儲存也不再重新出現已刪除的智能體。

### 記憶圖

- **新增圖譜修訂工作台**：AI 提出的修改以差異卡片預覽，可逐條批准或回退。
- **新增劇情線節點**，用於追蹤長期主線。
- 抽取新增爬取模式：抽取前先探索圖結構，初始只提供圖的大致樣貌，節省提示詞。
- 召回精簡為 LLM 與 RAG 兩種模式，並支援可選的重排與查詢改寫。
- 召回按節點類型均衡分桶，單一類型不再擠佔其他記憶。
- 長期注入的節點超出時間窗後回退到普通召回，不再直接丟棄。
- 事件抽取現在能區分角色親身經歷與單純提及，對稱關係合併為一條邊。
- 向量檢索只返回具體事件，彙總摘要不再干擾結果。
- 使用者正規表示式會作用於抽取讀入的文字。
- 設定抽屜重組為召回、抽取、圖譜、進階四個分頁，並全面補齊欄位說明。
- 修復了空重播清空圖譜、重置對話後舊向量殘留、讀取失敗靜默回傳空資料等問題。

### 角色卡編輯器（CardApp Studio）

- 修復了一批卡片編輯可靠性問題：已套用的修改不再自行回滾，回退按鈕恢復可用，重複的差異卡片不再出現。

### 迭代工作台

- **四個工作台的會話現在會儲存並重播工具呼叫與結果**，重新整理後不丟過程。
- **工具呼叫以差異形式展示**，訊息卡片顯示思考鏈。
- **重新生成會先撤銷已套用的修改**，每條使用者訊息都新增了編輯按鈕。
- AI 改為視需求讀取所需欄位，不再一次傾印全部內容，修改失敗時也會給出明確的定位診斷。
- 失敗的工具呼叫回傳真實錯誤與原因，不再靜默跳過。
- 會話歷史移到各角色獨立儲存，關閉彈窗立即儲存，不再遺失最後一輪。

### 預設與提示詞管理器

- **一張角色卡現在可以綁定多條聊天補全預設**，可設定預設值與覆蓋，並可一鍵清空。
- **提示詞可以附加到指定訊息**，不再只支援相對位置。
- 預設作用域的世界書支援匯出匯入往返。
- 提示詞條目可以拖入既有群組，並修復子群組的渲染問題。
- 外掛提示詞結構改為快取友好，重複請求更快更省。
- Claude 提示詞快取與壓縮後處理同時啟用時，連線管理器會給出警告。
- 卡片綁定預設的修改會儲存回卡片，不再因清除而遺失。
- 刪除預設會連帶清理所有關聯狀態。

### 連線與模型

- **每個連線設定可以設定獨立的請求逾時與重試策略**。
- **新增 OpenAI Responses 聊天補全來源**。
- Kimi 支援 partial prefill，並正確轉發推理內容。
- 識別較新的 Claude 5 與 Opus 4 模型，移除阻斷 Bedrock 的過時參數。
- 進階請求設定摺疊進側欄。
- Google AI Studio 的機率性安全攔截現在可重試，Vertex 模型列表修復。
- 模型選擇器不再選錯項，也不再憑空捏造選項。
- 修復了切換連線設定時模型欄位被覆蓋的問題。

### 生成與串流

- **聊天補全、文字補全、NovelAI、Kobold 與圖像生成統一了生成流程**，修復了 Bun 下的生成問題。
- **Claude 思考塊跨輪次保留並重播**，DeepSeek 與 OpenRouter 的推理內容同樣端對端保留。
- 停止請求即時送達供應商，ComfyUI 出圖可中途打斷。
- token 計數與 token 編碼可以獨立設定。
- 恢復生成的用戶端能重新看到即時串流文字。
- token 計數移到背景執行緒，長提示不再卡住介面；更多分詞器改為本地內建。
- 上游錯誤以正常錯誤回應回傳，不再掛起或被截斷。
- 空回應自動重試，Gemini 安全攔截仍按終態處理。
- WebSocket 串流不再在重新連線後重複收文字，大酬載不再受限。

### 聊天與角色

- **角色卡替換改為全螢幕差異總覽。**
- **聊天可以按所選順序合併，或在指定位置拆分。**
- 串流生成的 token 用量現在會顯示出來，並統一各供應商的格式。
- 對話搜尋現在能越過已載入視窗繼續查找。
- 關閉頁面前未儲存的對話會強制寫入磁碟，儲存衝突自動復原，失敗時顯示伺服器錯誤。
- 對話檔名不再累積重複副檔名。
- 快速切換角色時不再寫入錯誤的對話。
- 編輯訊息時推理塊的提交與取消乾淨俐落。
- 角色儲存失敗會顯示真實錯誤，內嵌世界書在編輯後保留。

### 世界書

- **行動裝置世界書編輯介面改造**，版面更精緻，切換視區後設定不會遺失。
- 卡內世界書重新載入後保持綁定，已刪除條目不再混入匯出資料。
- 陣列形式條目的世界書可以正常匯入和編輯。

### 請求檢查器

- **推理內容、思考塊與簽章以樣式化塊顯示在請求與回應檢視裡**。
- 上游原生結束原因與正規化結果並排顯示。
- 向量請求、重排請求與聊天請求一同被擷取。
- 非串流請求與早期失敗也會被記錄，串流回應逐塊檢查。

### 儲存與同步

- **新增 SQLite、MySQL 與 PostgreSQL 儲存引擎**，附帶遷移面板，遷移中斷後可從進度處繼續。
- **備份管理器支援在儲存模式之間轉換備份**。
- 新增伺服器端與瀏覽器端儲存檢查器，可逐層查看子目錄。
- 還原封裝分塊上傳，支援斷點續傳。
- LAN 同步改為串流傳輸。
- 檔案系統與資料庫雙向遷移保留對話完整性與時間戳記。
- 刪除對話或角色會連帶清理其媒體檔案。
- 不安全的儲存檔名會被拒絕。

### TTS

- NPC 台詞可以按說話角色朗讀，並支援逐句播放。

### 搜尋外掛

- 搜尋前置智能體不再與世界書操作相互衝突。
- 條目位置不是「聊天深度」時，注入深度與角色欄位自動隱藏，與其他介面保持一致。

### UI 與行動裝置

- **Android 新增可分享的當機診斷封裝**，當機迴圈時自動停用第三方擴充功能進入安全模式。
- Android 冷啟動更快，除錯版可直接覆蓋安裝正式版。
- iOS 鍵盤不再破壞視區版面。
- 修復了 Android 視區高度與全螢幕版面問題。

### 驗證與使用者

- 新 OAuth 帳戶以供應商頭像初始化，OAuth 專屬帳戶拒絕密碼登入，除錯匯出詳情僅管理員可見。

### 國際化

- 懶載入媒體設定、管理面板動態值與滑桿選擇器補齊簡繁中文翻譯。

### 平台

- 跟進 SillyTavern 1.19.0。

### 補全預設助手

- **迭代工作台可以匯入現有對話作為起點**。
- 修改衝突與已套用操作會明確回報，不再被靜默忽略。

### 背景保活

- 新增行動裝置保活開關，以子母畫面或音訊方式保持背景生成繼續執行，音訊僅在生成時播放。

### 擴充功能 API

- 新增角色狀態讀取、寫入與批次取得助手，公開 saveChatDebounced，並新增召回結果查詢與頁面內渲染記憶圖 UI 的介面。
- 角色替換的世界書處置邏輯移入核心替換流程。

## v2.7.0 (2026-06-13)

### 多智能體編排

- 新增預設庫——每種模式（spec / agenda / loop / director）都可以在全域與單角色兩種範圍下儲存多個預設，舊的單槽位配置會在首次開啟時遷移為預設的預設。
- 新增執行面板：執行開始的瞬間便會滑入聊天旁（行動裝置上則從底部滑入），即時串流顯示推理、文字、工具呼叫與子 agent 動態，關閉後可從懸浮膠囊重新開啟，並在標題列顯示累計 token 總數。
- 移除了舊的執行軌跡彈出視窗——現在所有場景都由執行面板接管。
- 子 agent 現在可以用正規表示式精確定位，並對聊天紀錄、世界書條目、SKILL 檔案以及 director 進行中的草稿取得逐行輸出。
- 全域範圍下的迭代工作台現在可以讀寫世界書，全域編排因此能夠稽核並編輯全域生效的條目。
- 補全預設助手的編排適配模式現在會執行結構性檢查，標記出落在錯誤層級上的 agent 身分內容、SKILL 參照以及越獄回應形態動詞。
- 修復了 director 模式的停止按鈕：點擊後會在工具之間以及子 agent 等待期間立即中止，而不再等待輪次邊界；同時消除了快速「停止 + 重新生成」可能讓兩個 agent 寫入同一槽位的問題。
- 提升了模擬彈出視窗中文字選取標記的效能。
- 修復了「清除角色覆蓋」和「重設為預設值」按鈕。

### 角色卡編輯助手

- 除非使用者明確點名，AI 不再寫入情境、系統提示詞或 post-history instructions 欄位——內容會被引導到世界書中。

### 迭代工作台

- 各彈出視窗中的每個葉節點 diff 卡片現在都經由同一條渲染路徑。
- 調色盤更明亮，更接近 GitHub 的風格。
- 改進了迭代工作台的提示詞。

### 記憶圖

- 記憶圖的提交現在會正確錨定在觸發操作的樓層上。

### 效能

- 長提示詞的 token 計數不再阻塞 UI。
- 提升了聊天檢視與提示詞管理器的效能。
- 將啟動時的版本檢查改為非阻塞，避免網路緩慢凍結首次繪製（感謝 @1362278443 提交的 PR）。

### 修復

- 一鍵除錯匯出包現在會包含完整的請求檢查器歷史；打包程序移到了伺服器端。
- 樓層狀態不再因歷史日誌損壞而卡死——損壞的樓層及其兄弟提交會被截斷，壞損部分歸檔為孤立日誌，更早的樓層狀態則完整保留。
- 修復了世界書抽屜在切換條目後重設的問題。
- 修復了 Claude 後端提示詞快取在系統內容經後處理合併進首條使用者訊息時的問題。
- 啟動後 uploads 目錄被刪除不再導致上傳永久報錯；目錄會在需要時自動重建。

### 預設 SKILL

- 反套路 SKILL 新增了數詞 + 量詞的禁用項。

### 說明文件

- 新增了 agent 預設說明文件。
- 新增了撰寫自訂編排工具的說明文件。
- 新增實戰指南「按卡片自訂編排」，透過三個步驟進行示範——從一句話生成該卡片專屬的編排、用模擬和註解標記套路與意外輸出以便工作台改進編排、讓 AI 撰寫一個驗證輸出格式的自訂工具。

### 新貢獻者

* @1362278443 在 https://github.com/funnycups/Luker/pull/12 中完成了第一次貢獻

**完整更新日誌**：https://github.com/funnycups/Luker/compare/v2.6.1...v2.7.0

## v2.6.1 (2026-06-07)

### 搜尋

- 編排工具不再受外掛 enabled / preRequestEnabled 開關的限制

**完整更新日誌**：https://github.com/funnycups/Luker/compare/v2.6.0...v2.6.1

## v2.6.0 (2026-06-07)

### 亮點

- 新增 Skill 子系統：將可複用的寫作方法、角色聲線、反套路規則與整理手冊收錄為 SKILL.md 檔案，按全域 / 角色 / 預設三種範圍儲存，在多智能體編排內以 chip 的形式為每個子 agent 掛載，並由執行環境將匹配到的 skill 目錄注入 agent 的上下文；自帶 21 個中文創作 skill（角色聲線、故事腦力激盪、反套路、記憶整理等），可以在迭代工作台或 CPA 對話框中互動式撰寫，並可透過打包匯入/匯出隨角色或預設一起遷移。
- 為多智能體編排新增自訂工具系統：註冊你自己的工具供 AI 在全部四種模式（Agenda、Spec、Director、Loop）中呼叫；內建的記憶、網路搜尋與預設管理以可自行開啟的工具形式提供；每個 agent 都有專屬的覆蓋面板用於選擇啟用哪些工具；隨匯入角色卡內嵌的工具則提供行內審核流程。
- 新增模擬審核彈出視窗：在多智能體編排或角色 / 預設助手中點擊「模擬」現在會執行一次真實的靜默生成，並展示完整的 agent 鏈、最終輸出以及被觸發的世界書條目；你可以選取文字加入行內註解，一鍵重新執行，註解會回流到工作台 AI，作為下一輪迭代的指引。模擬期間寫入類工具處於沙盒中，不會外洩任何內容到真實資料。

### 多智能體編排

- 在迭代工作台內新增世界書寫入工具：AI 可以停用或重寫目前角色上的世界書條目，每一處改動都會產生一張 diff 卡片，由你逐張核准或拒絕，且只有核准的部分會在你按下套用時提交。
- 在 director 模式為每個子 agent 新增工具呼叫輪次上限：批評者式的子 agent 可以收斂在一到兩輪，而記憶偵察者式的子 agent 可取得更寬裕的額度。
- 在每種模式的角色覆蓋配置旁新增啟用 / 停用開關，讓你可以暫時回退到全域配置而無需刪除整個覆蓋。
- 將推理軌跡擴展到 Spec、Agenda 與 Loop 模式（director 先前已具備），因此 Claude thinking、OpenAI o1 及類似的推理內容現在會顯示在多智能體編排全部四種模式的執行軌跡中。
- 執行軌跡現在會把每次工具呼叫與其結果以行內方式配對，放在 args / result / error 標籤之下，而不再散落在時間軸上。
- 強化了子 agent 的身分框架：子 agent 提示詞被重組為四段式元框架，不再因尾部的角色指令而漂移成「讓我以角色身分繼續場景」。
- 修復了 director 模式下角色覆蓋配置看似沒有儲存的問題。
- 修復了子 agent 在第一輪看不到進行中草稿的問題——這曾導致批評者針對錯誤的修訂版本給出回饋。
- 修復了記憶圖寫入遭拒時錯誤被靜默忽略的問題：AI 現在能看到實際的失敗原因，而不是無限重試。
- 修復了從已刪除訊息中擷取的記憶條目殘留為無效條目並在重新生成後被再次注入的問題。
- 修復了多智能體編排寫入記憶圖時未轉發進行中樓層，導致提交落在空佔位符上的問題。

### 角色 / 預設助手（CEA / CPA）

- CPA 的「編排最佳化」環節現在預設將重寫後的指引條目移到 chatHistory 之前，只把越獄 / 解鎖類的條目留在尾端，使產生的預設在結構上更穩定。
- 改進了 CPA 中關於在預設內管理 prompt_order 的指引，讓 AI 在修訂預設時能更好地塑造 RP 輸出。
- 修復了迭代對話框的停止按鈕在緩慢連線下毫無回饋的問題——它現在會立即變為停用並呈現中止狀態。

### 用戶端分詞器

- 將 OpenAI、Claude 與 HuggingFace 系列的 JSON 分詞器完全移到瀏覽器端，聊天輸入框旁的即時 token 計數器無需伺服器往返即可回應。
- 將用戶端分詞擴展到更多 sentencepiece 模型系列：gemma、gemini、llama、mistral、yi、jamba。
- 任意自訂模型名稱（OpenRouter ID、私有部署別名等）會在分發前正規化到正確的分詞器，僅在無匹配時才回退到伺服器。
- 不活躍的按聊天 token 快取會在切換聊天時被逐出，使長時間會話的記憶體占用保持平穩。

### 沉浸模式與行動裝置

- 沉浸模式狀態現在可跨重新載入與重新啟動保持，並在網頁用戶端與 Android 應用程式之間隨帳號同步。
- 在使用者設定中新增「沉浸模式下保留頂欄」開關；開啟後聊天區域會調整大小，為頂欄留出空間而不是與其重疊。
- 新增右上角懸浮離開按鈕：在沉浸模式開啟且頂欄隱藏時顯示，主要讓沒有 Esc / 返回鍵的 iOS 使用者也能離開沉浸模式。
- 改進了 Android 返回鍵行為：使用者手動開啟的沉浸模式不再被返回鍵強制關閉；返回鍵現在會先關閉已開啟的彈出視窗與對話框；在聊天內，返回鍵會先關閉目前聊天回到歡迎頁，需要再按一次才會真正退出應用程式。
- 修復了 Android 應用程式把使用者主動退出誤判為上次工作階段當機並在下次啟動時顯示當機報告對話框的問題。
- 改進了 Android 當機擷取，使 JVM 未捕捉例外與 WebView 轉譯器當機能確實把堆疊追蹤帶入下次啟動的當機報告。
- 在 Android 用戶端中，同源下載改用應用程式內串流取代系統 DownloadManager，並附帶進度通知與失敗原因提示，修復了登入工作階段與 DownloadManager 相互隔離導致備份下載失敗的問題。

### 第三方擴充功能

- 從 github.com/funnycups/ 安裝擴充功能不再觸發「第三方擴充功能」安全警告。
- 將第三方擴充功能安裝確認對話框（標題、「是，安裝」 / 「否，取消」按鈕、「不要再顯示」選項）完整翻譯為簡體中文與繁體中文。
- 修復了多個擴充功能同時啟用時的跨載入順序回歸——像 ST-Prompt-Template 與 JS-Slash-Runner 這樣的組合現在能正確渲染。

### 備份與檔案

- 使用者備份還原對話框現在會依序串流顯示分析、快照與逐檔案解壓縮階段的進度（第 X / Y 個檔案及百分比），而不再停留在靜態的「正在還原」訊息上。
- 修復了名稱首尾帶空格的角色卡世界書匯入會開啟空編輯器或顯示錯位條目的問題。

### 介面優化

- regex 擴充功能面板現在可以獨立摺疊與展開預設、全域、角色、聊天與作用域這幾個分區。
- 提示詞管理器與 regex 腳本清單在重建時會釋放分離的 DOM 節點，長時間會話不再因殘留的拖曳繫結而累積記憶體。

### 其他修復

- 修復了多個聊天補全來源同時啟用時，多來源 OpenAI 相容串流回應針對共享全域狀態進行解析的問題。
- 修復了 Takeover 外掛將上一個 swipe 的文字與推理帶入重新生成回應的問題。
- 修復了 Takeover 外掛在超出最後一個槽位的越界 swipe 被重新生成時遺失推理及其他附加內容的問題。
- 修復了 variable-op-log 無法辨識變數簡寫的問題：<span v-pre>`{{.x = v}}`</span>、<span v-pre>`{{.x++}}`</span>、<span v-pre>`{{$g}}`</span>、<span v-pre>`{{.x ??= 1}}`</span> 現在不會在訊息中留下字面量，並會以讀取或寫入的形式記入操作日誌。
- 修復了記憶圖在資料損壞時無法載入的問題：孤立節點現在會被自動修剪，狀態可以從備份快照還原，並移除了過時的「偵測到聊天變更，將在下次生成時重新同步」提示。
- 修復了連線管理器嘗試同步已不存在欄位的問題，消除了一處靜默設定漂移的來源。

### 說明文件

- 在 docs/development/extension-api/ 下新增了三語擴充功能 API 說明文件，涵蓋 character-overrides、Skill 的迭代工作台介面以及完整的角色卡編輯助手 API；儲存庫還新增了一條 lint，禁止外掛相互匯入或直接匯入核心——必須經由三層 getContext() / getExtensionApi() 介面。

**完整更新日誌**：https://github.com/funnycups/Luker/compare/v2.5.1...v2.6.0

## v2.5.1 (2026-05-27)
### 多智能體編排
- 最佳化了 Director 模式下 agent 召回記憶圖的預設提示詞。

### 修復
- 切換 OpenRouter API 連線配置後模型保持不變的問題。

**Full Changelog**: https://github.com/funnycups/Luker/compare/v2.5.0...v2.5.1

## v2.5.0 (2026-05-27)
### 預設與說明指南
- 新增「plugin-only」預設，將角色扮演設定（角色設計、角色卡、場景、世界書、對話範例）與外掛任務通道拆分為兩個獨立區塊。外掛指令不再被視為 AI 劇情的一部分。
- 在所有預設選擇器旁新增「?」說明按鈕：外掛與迭代 AI 預設可一鍵匯入「plugin-only」預設；多 Agent 預設會跳轉到多 Agent 入門指南。
- 預設助手的越獄模式會同步讓 AI 學會這套區塊劃分，產生的越獄預設直接遵循新的約定。

### 預設迭代
- 擴大了迭代 AI 可直接修改的欄位範圍。工具呼叫、agent 相關開關、取樣、多模態等欄位現在可由 AI 按使用者意圖調整。
- 在「參考預設」選擇器旁新增「?」說明按鈕，說明什麼是參考預設、何時應選「無」。

### 記憶圖
- 重寫事件摘要撰寫指南：採用編號大綱格式、按動作類型歸類、去掉引號與細節重複，摘要明顯更短、更聚焦。
- 事件壓縮階段現在會執行真正的主題合併（合併同主體、同動作的不同對象），消除機械的條目堆疊。
- 抽取階段現在要求 AI 在建立或編輯角色與地點前逐項核對圖中已有節點，減少重複建立。
- 修復建立分支聊天時記憶圖錯誤跟隨的問題。

### 多智能體編排
- 記憶整理模組現在採用新的事件摘要指南與主題合併規則，與記憶圖保持一致的品質。
- 修復切換聊天後 Director 編排面板顯示「目前聊天中沒有執行中的軌跡」的問題；軌跡現在會正確綁定到目前聊天。

### 文件
- 最佳化了 Agent 入門指南。

### 平台與體驗
- 使用者設定現在會顯示目前對應的 SillyTavern 相容版本，便於核對版本差異。
- Android 客戶端的狀態列與導覽列顏色現在跟隨主題配色。
- 資料備份匯入現在會顯示上傳進度百分比與處理狀態。

### 修復
- 修復行動裝置上迭代彈窗（聊天補全預設助手、角色編輯器、多智能體編排、記憶圖）發送按鈕被截斷的問題。
- 迭代彈窗中的 diff 卡片預設摺疊，長歷史條目不再縱向佔滿頁面，行動裝置也不會再觸及 WebView 繪製層上限。

### 效能
- 修復 STscript 解析長參數（超長 base64、包含大量管線的指令）時的長時間卡頓問題。

**Full Changelog**: https://github.com/funnycups/Luker/compare/v2.4.1...v2.5.0

## v2.4.1 (2026-05-26)
- 修復補全預設助手的載入問題
- 為多智能體編排加上 agent dispatcher 開關
- 修復多智能體編排子 agent 中的一個問題

**Full Changelog**: https://github.com/funnycups/Luker/compare/v2.4.0...v2.4.1

## v2.4.0 (2026-05-25)
### 文件
- 新增三語實戰指南區塊，首篇實戰指南帶新使用者端到端走完完整的多 agent 寫作工作流：建立純 agent 預設、把正文寫作與迭代拆到兩條獨立的 API 通道、將記憶圖的抽取/召回/壓縮交給子 agent、接入搜尋引擎，最後在 AI 迭代工作台裡整體調校——並附帶配套的最小起步預設與分步截圖。

### 多智能體編排
- 每個 agent（主 agent 加 12 個內建子 agent）現在都能有獨立的工具權限，可按 agent 繼承或覆寫，並為每個子 agent 的角色量身配置預設工具集（memory curator 獲得記憶寫入權限，voice critic 獲得唯讀聊天權限，等等）。
- 打磨執行軌跡彈窗：現在可按輪次/按派遣閱讀每個 agent 的推理；Director 面板改為雙欄版面配置；總覽卡片會報告主 agent 輪次數與子 agent 派遣次數。

### AI 迭代彈窗（CardApp Studio / 記憶圖 / 多智能體編排共用）
- 修復審閱完一批待處理 AI 變更後彈窗卡住的問題——應用/丟棄現在會自動恢復循環，AI 能看到你接受了哪些、拒絕了哪些變更，並據此調整下一步行動。
- 修復 AI 看不到上一輪變更是否真正生效的問題；回饋現在會報告成功多少、失敗多少及其原因，以及哪些條目的哪些欄位實際發生了變動，AI 不再重複提出同一條無效變更。
- 修復行內程式碼片段在有色訊息氣泡上難以辨認的問題。
- 修復一輪提出大量變更時 diff 卡片在窄螢幕/行動裝置視埠閃現大片白底的問題。

### 記憶圖
- 修復 v2.3.0 引入的嚴重資料遺失問題：自動抽取、自動壓縮、手動增量補全/重建最近/手動壓縮以及編輯器中的每一次新增/編輯/刪除，在 UI 上都顯示成功，卻會在下次重新整理或重新產生訊息時靜默回滾到早前幾層的狀態。
- 修復靜默儲存失敗的問題——持久化失敗現在會彈出帶完整上下文的三語 Toast，方便截圖回報。
- 修復向量召回索引每次切換聊天或重新整理時都從頭重新嵌入 50 個節點的問題；增量同步現在真正做到跨重新整理增量。

### 預設助手
- 新增以識別碼為鍵的工具，可精確編輯預設內的提示詞條目（對內容執行替換/插入/刪除，外加啟用/停用開關），AI 不會再因索引漂移而改錯條目，也不會因寫錯欄位而反覆重試同一條失效開關。
- 重寫「多智能體編排最佳化」模式的指導，把「會毒化 agent 工具呼叫通道的流程強制」與「安全的最終輸出修飾」區分開，產出的建議更一針見血；並移除了誤報的 Director 預設警告橫幅。
- 修復「將目前預設克隆為新預設」工具無效的問題——此前 AI 的呼叫會靜默失敗，現在克隆會生效並切換到新預設。

### 其他
- 修復 Luker 更新橫幅在任何介面語言下都顯示英文原文的問題。
- 修復儲存聊天時偶發的「聊天補丁衝突」問題，此前需要自動重試才能儲存成功。
- 修復 CardApp 第三方 `sendMessage` 的 silent 選項並未真正靜默的問題——訊息仍會進入聊天紀錄；現在它會真正靜默執行，並把 AI 的回覆以字串傳回給呼叫方。

**Full Changelog**: https://github.com/funnycups/Luker/compare/v2.3.0...v2.4.0

## v2.3.0 (2026-05-25)
### AI 迭代彈窗
- 為五個外掛——補全預設助手、記憶圖 schema、多智能體編排、角色編輯器與 CardApp Studio——新增統一的 AI 迭代彈窗，讓 AI 直接在彈窗內修改草稿；具備分欄即時預覽、多輪對話、按訊息切換工具呼叫可見性、重新產生與回滾、帶 diff 的行內應用、依據 AI 是否仍在呼叫工具的自動續輪、世界書讀取工具，以及擴充功能設定中查看和編輯各彈窗 AI 系統提示詞的入口。

### 文件
- 重寫一大批文件，涵蓋編排筆記、迭代工作台框架開發指南與新的記憶圖 API 章節，統一術語並規範中日韓標點。
- 為文件站的每個頁面新增社交卡片中繼資料。
- 補齊管理面板與 AI 迭代彈窗的在地化。

### 多智能體編排
- 將編排筆記重新設計為面向 AI 的作者側劇情線索追蹤器。
- 新增意圖偵察子 agent，交叉比對使用者意圖並產出世界書撰寫指令。
- 收緊 Director 與記憶相關子 agent 的提示詞，使其協作更順暢、遵守欄位紀律、把握正確的層級；現在遇到元敘事、底層模型名稱、「上一輪」式引用等平台框架洩漏會直接中止。
- 重構角色覆寫編輯流程，移除舊的 AI 快速建構入口。
- 將子 agent 每任務最大輪次從 8 提升到 16。
- 移除硬性自動續輪上限，使其跟隨實際生效的上下文範圍，並持久化收尾狀態。

### 記憶圖
- 新增記憶圖唯讀 API 與 session 式擴充功能 API，第三方擴充功能一次呼叫即可完成讀寫並自動提交版本。
- 新增記憶圖寫入與壓縮 API、memory curator 子 agent，並提升內建抽取品質。
- 透過統一的 7 步推理模板與自檢回退改進事件摘要抽取。
- 收緊記憶產生提示詞，禁止作者口吻收尾與杜撰的心理狀態標籤，並強化別名收集、關係正規化與位置狀態欄位紀律。
- 調整每批事件策略：每批必須產出事件，僅穩定事實類型預設跳過。
- 提升行動裝置大型記憶圖的匯入速度。
- 將主上下文注入視窗與召回候選池解耦。

### CardApp 與角色編輯器
- 為變數系統新增基於路徑的 set/delete 與 push/pop 操作，接入斜線指令、巨集、JS API 與 Studio AI。
- 改進 CardApp Studio 檔案操作：統一經由編輯通道批次執行，每輪均需審核。
- 為角色編輯器新增世界書檢視器、分頁、搜尋與行動裝置 tab 版面配置。
- 讓角色編輯器的 AI 工具可直接讀寫世界書遞迴欄位。

### 應用程式內公告
- 新增管理員可發布的應用程式內公告系統，單一使用者模式下鈴鐺自動隱藏，並附帶三語使用文件。

### 穩定性與可觀測性
- 大幅提升聊天儲存可靠性，修復多起偶發的訊息遺失、事件缺失與編輯/刪除後儲存衝突問題。
- 新增自動請求重試，重試次數按連線配置各自設定，文字與圖像產生均受益。
- 程序結束時傾印進行中的請求，原生中止時輸出診斷報告。
- 在請求檢查器中顯示每個請求的上游端點與金鑰指紋，並於來源訊息旁展示實際發出的請求載荷。
- 無論是否處於除錯模式，主控台各層級日誌都會寫入前端日誌緩衝區，匯出的除錯日誌因此完整。
- 改進接管流程，明確三種終態——已提交、已中止、已丟棄——並在氣泡上提供即時計時器與最終 token 計數。

### 安全與存取
- 新增可自行選擇開啟的自助註冊入口。

### 其他體驗
- 在 API 連線配置中開放 Claude 與 Gemini 提示詞快取開關。
- 搜尋外掛新增手動條目管理彈窗，用於維護已存條目。
- 世界書進階關鍵字搜尋支援按角色篩選。
- 新使用者預設開啟角色延遲載入，加快啟動速度。
- 最佳化「模型請求」標籤中的預設用詞，並移除舊的「單 Agent」表述。
- 修復彩色背景下 Toast 通知中的詳情小字難以辨認的問題。
- 修復中日韓按鈕文字直排顯示的問題。
- 修復預設管理器左側抽屜在切換預設時失去捲動位置的問題。
- 修復擴充功能管理器彈窗在重新整理時覆寫即時開關狀態的問題。
- 修復彈窗捲動時背景遮罩透出導致內容模糊的問題。
- 修復透過指令碼設定的反向代理被 Base URL 覆寫的問題。

**Full Changelog**: https://github.com/funnycups/Luker/compare/v2.2.2...v2.3.0

## v2.2.2 (2026-05-18)
- 修正了多智能體編排的 Director 模式無法讀取心智圖的問題。

**完整更新日誌**：https://github.com/funnycups/Luker/compare/v2.2.1...v2.2.2


## v2.2.1 (2026-05-18)
- 最佳化了 Director 模式的提示詞結構。
- 隱藏並整理了 Director 模式中與指令注入相關的設定。
- 修正了角色卡編輯助手等外掛的 CardApp Studio/角色卡編輯彈窗中文字無法自然換行的問題。
- 最佳化了角色卡編輯助手彈窗的輸入框大小。

**完整更新日誌**：https://github.com/funnycups/Luker/compare/v2.2.0...v2.2.1


## v2.2.0 (2026-05-17)

### 多智能體編排

- **新增 Director 模式。** 一個八 agent 陣容——chat / memory / lorebook / epistemic / canon 偵察員、一名劇情腦力激盪員、以及 voice / continuity 兩位評論員——透過接管掛鉤直接產出 assistant 訊息本文，完全繞過主 LLM 分派。Director 自帶一份 `pure-preset` 快照，在每次執行期間換入，使目前預設中的主提示詞 / NSFW / 越獄 / 反陳腔濫調文字不會洩漏進 sub-agent 上下文，快照 + 還原機制沿用 LittleWhiteBox 模式。編排 profile 可匯出為 JSON 並重新匯入。兩位評論員重寫完畢：`voice_critic` 現在專門獵殺「資料人」文風（冷觀察動詞、播報式對白、人設原型處理不當，並附上一份針對中文 RP 的雙語違禁詞表）；`continuity_critic` 預設信任草稿，只標記硬性矛盾與知識邊界違規。
- **新增工具級聯。** 循環工具集（chat / memory / lorebook / note / search）現在可以在每個編排節點上啟用——Loop 模式本身、Spec 節點、Agenda agent、以及 Director 的主 agent 和 sub-agent——全部共用 `profile.tools.<ns>.<verb>` 這一開關形狀。解析分三層：節點級覆寫 → profile 根節點 `defaultTools` → 內建預設。UI 在工作流程看板上方提供作用於整個 profile 的面板，並在每個節點體底部提供「工具（覆寫 profile 預設值）」摺疊區，附帶全部啟用 / 全部清除快捷操作。
- **執行時 Trace 面板擴充。** 現有 Trace 彈窗現在還會展示每個節點嘗試和循環 agent 的完整訊息執行緒——system / user / assistant / tool 各輪以角色樣式氣泡渲染，tool_call 與 tool_result 區塊可摺疊。Agenda 模式額外新增看板式待辦面板和每輪分派卡片；循環面板以即時別名掛載，執行期間新增的訊息會即時顯現。
- 修正：Anthropic 的工具名正規表達式 `^[a-zA-Z0-9_-]{1,128}$` 不接受點號，Loop 模式搭配 Claude 時立即 422。十一個循環工具名（`chat_read_range`、`chat_search`、`lorebook_search/get`、`memory_search/list_recent/get`、`note_add/delete`、`search_search/visit`）已改名為底線形式，並附帶遷移墊片，將舊歷史中的點號名稱正規化，已儲存的 profile 和持久化的工具呼叫酬載繼續可用。
- 修正：全域模式選擇下拉會被 dispatch 內部的 `character.savedMode` 覆寫，因此帶 Spec 覆寫的角色在使用者點擊 Loop 後仍被強制為 Spec。dispatch 現在遵循最近一次模式選擇點擊，與 UI 作用域標籤既有的顯示一致。
- 修正：多智能體編排設定面板此前只訂閱 `CHAT_CHANGED`，替換角色卡或 AI 驅動的欄位寫入會讓面板仍顯示上一個角色的覆寫來源標籤。現在它同時監聽 `CHARACTER_REPLACED`、`CHARACTER_FIELDS_UPDATED` 和 `CHARACTER_EDITED`。
- 文件：每種模式開頭都配 d2 預設流程圖（loop / spec / agenda / director），預設 agent 已製成表格並貫穿一套共享的 Lin Wan / Luoyang 情境給出具體 RP 範例，各模式頁面的 Trace 面板章節配有真實執行截圖。

### 記憶圖

- **按類型的抽取節奏與指令。** 節點類型現在攜帶兩個新欄位：`extractEveryN`（預設 1）透過 `currentSeq % N == 0` 把該類型限定為每 N 輪抽取一次；`extractionInstructions` 只在該類型於當前輪次啟用時才附加到抽取系統提示詞。某個類型輪空時，它的 create / edit / delete 工具根本不會公開給 LLM——模型那一輪在字面上無法輸出那張表，因此 `location_state` 這類慢變表可以省下 LLM 呼叫，又不會讓抽取 agent 無所適從。
- 修正：`isExtractableAssistantMessage` 把 `is_system` 視為永久排除，但 `/hide` 會在既有 assistant 訊息上翻轉該旗標——每次隱藏/取消隱藏都會移動可抽取 seq 的排名，使已儲存的節點 seq 相對對話漂移。隱藏的訊息現在與可見訊息貢獻相同的記憶權重，符合社群慣例：`/hide` 控制的是提示詞可見性，而非記憶。
- 修正：`recallEnabled` 關閉時混合召回（向量 + 擴散 + 可選重新排序）仍在執行，而 LLM 召回路徑靠內部防護短路。現在 recallEnabled 檢查上移到兩個分支之上，停用召回的行為一致；`alwaysInjectNodes` 的歸屬也從召回函式中移出，持久世界書注入仍向多智能體編排的去重發布正確的 id 集合。
- 修正：手動 `/delete` + 立即重新生成時，`MESSAGE_DELETED` 的快取重新整理與重新生成的世界書掃描召回可能在兩條交錯的點擊堆疊上執行，導致召回讀到過期的儲存快取。變動失效現在經模組級 promise 鏈序列化，召回監聽器會等待在途任務完成。
- 修正：邊編輯器曾拋出「Edge form not found」，因為 `openEdgeEditor` 在 `callGenericPopup` resolve 之後才透過 `jQuery` 讀取表單值——而 `Popup#hide()` 會在 promise resolve 前把對話方塊從 DOM 移除。現在改為在 `onClosing` 處理器內擷取值。內建邊類型預設清單也已重新對齊到規範 schema（新增 `involved_in / occurred_at / evidence / updates / advances`，去掉非規範的 `involves`，移除禁用的 `located_at`）。

### 請求檢查器

- 模型回傳的工具呼叫現在可以在 Response Body 中檢視。每個 `tool_call` 渲染為一張卡片，帶徽章、名稱、id 和美化排版的參數 JSON，並在章節標題中顯示計數。OpenAI `tool_calls`、Claude `tool_use` 內容區塊與 Gemini `functionCall` part 全部可解析（包括串流重組：按 index 合併的 OpenAI 增量、Claude `content_block_*` 走訪、Gemini 交錯的文字與函式 part）。詳情級搜尋現在也能比對工具名稱和參數 JSON。

### 連線管理器

- **反向代理設定已併入新的「API 端點」抽屜。** 該抽屜統一管理基礎 URL 與反向代理密碼——此前兩者分屬兩個面板，語意重疊、優先序含糊。這次重構帶出三個連帶問題，均已在本版本修正：跨源外掛複用讓主 API 的 `base_url` 滲入子 profile（Claude 主 API 的 `base_url` 以 `/v1` 結尾時被帶進 Gemini 子 profile，生成 `https://claude-proxy/v1/v1beta/models/...:generateContent`）；`ConnectionManagerRequestService.sendRequest` 從未把 `profile['base-url']` 轉發給後端，導致經以 `/v1` 結尾的 OAI 相容代理使用 Gemini 時拼出 `/v1/v1beta/...:generateContent` 並拋出「Invalid URL」；代理密碼遷移到祕密儲存庫後，`readProviderSecret(...) || body.proxy_password || ''` 會在存在過期的已存 provider 祕密時短路，默默覆寫 body 中顯式攜帶的 `proxy_password`——透過 `custom_api.key` 自帶金鑰的 JS-Slash-Runner 第三方腳本，其金鑰會被過期的已存 MAKERSUITE 祕密取代。
- **新增按 profile 的 RPM 限制與等待 toast。** 一個滑動視窗限流器同時閘住外掛路徑（`ConnectionManagerRequestService.sendRequest`）和主聊天補全路徑；桶鍵為 profile id，跨外掛與主聊天複用的同一 profile 共享同一視窗。等待期間常駐一個 toast，即時顯示「已排隊 · N 秒後下一個」倒數；`AbortSignal` 可乾淨取消；`0` 或未設定 = 不限制；文字補全路徑不受閘。
- **連線設定抽屜內新增 Embedding / 重排標籤頁。** Embedding 與重排 profile 的新增、刪除、修改、查詢已從向量儲存和記憶圖中拆出，統一為內聯編輯的 UI。這兩個標籤頁上聊天 API 面板自動隱藏，避免可見的來源 / url / 金鑰讓人誤以為與正在編輯的 embedding profile 相關。外掛頁面只保留 profile 選擇下拉，並帶同步邏輯：底層 profile 在別處被刪除時清除已持久化的 id。已棄用的 SillyTavern Extras embedding 來源移除。
- **在支援反向代理的各來源統一為輸入框驅動的模型選擇器**（OpenAI / Claude / Mistral / DeepSeek / xAI / Moonshot / Makersuite / VertexAI / ZAI，加上原有的 Custom）。現在文字輸入框是唯一事實來源，旁邊的 `<select>` 是鏡像它的單次選擇器，`<datalist>` 提供輸入提示。此前純 select 流程會在剛擷取的 `/v1/models` 回應中找不到已存 id 時，把 `oai_settings.<X>_model` 強制回設為 `model_list[0]`，默默覆寫經反向代理下發、清單未列出的自訂 id。
- 修正：`normalizeOpenAIBaseUrl` 此前只檢查路徑尾端是否為 `/vN`。在版本號後再巢狀類別的廠商（如百度千帆的 `/v2/coding`）被錯誤附加 `/v1`，導致所有請求 404。現在改為比對路徑中任意位置的 `/vN`。
- 修正：重新整理模型清單時，即使目前選中的模型不在新擷取的清單中，也可能被重新插入下拉選單，導致一個未列入清單的條目固定駐留在選擇器上。

### 角色 / CardApp / Studio

- **新增資料驅動的角色更新 API（`updateCharacterData`）。** 角色欄位寫入此前要經過 jQuery DOM（`$('#description_textarea').val(x)`）並依賴以合成點擊觸發彈窗的儲存按鈕；編輯彈窗關閉後 DOM 元素不存在，寫入靜默失效而 `saveCharacterDebounced` 仍會觸發（有時留下幽靈狀態，例如主世界重綁後從未真正重綁的 `data.character_book` 鏡像）。新 API 用點路徑映射修補 `characters[charId].data`，發出 `CHARACTER_FIELDS_UPDATED`，並按 `/api/characters/edit` 本就預期的同一種 multipart 形狀持久化。Studio AI 的 `character_update_fields`、CardApp 的 `ctx.updateCharacterFields`、世界書的 `charUpdatePrimaryWorld`、以及多智能體編排的持久化路徑現在都經由它，無論編輯彈窗開還是關，把世界綁定到卡片都能生效。
- **新增擴充功能欄位寫入語義（`writeExtensionField` / `writeExtensionFieldBulk`）。** 兩者現在透過 `/api/characters/merge-attributes` 的 `replacePaths` 旗標選擇啟用：完整值原樣成為 `data.extensions[key]`——此前深度合併默默保留的同層子鍵不再被帶入。`updateCharacterData` 現在遇到 `extensions.*` 路徑會同步拋錯並把呼叫者指向 `writeExtensionField`，靜默合併這個坑不可能再被誤踩。
- **新增自動套用開關。** 迭代工作台外殼（被多智能體編排的 AI 迭代彈窗、記憶圖 schema 編輯器、以及任何採用該外殼的第三方外掛複用）與 CardApp Studio 編輯器現在都帶自動套用開關：開啟後寫入 / 補丁工具立即寫入磁碟，而不是渲染內嵌的核准 / 拒絕卡片。偏好按配接器 / 擴充功能各自持久化。
- **CardApp 可讀取角色輔助世界書。** `ctx.getCharacterAuxWorldBooks()` 與擴充後的 `ctx.getWorldBooks()` 會在主書之外呈現透過 `world_info.charLore[].extraBooks` 綁定的書。給 `getWorldBooks` 傳入 `{ withSource: true }` 可取得帶 `source: 'character' | 'character_aux' | 'chat' | 'global'` 標記的條目。
- **創作期與執行期作用域在三層暴露層之間完成拆分。** CardApp `ctx` 不再洩漏 `.jsonl` / sidecar 檔案系統術語，對話生命週期方法（`closeCurrentChat`、`doNewChat`、`getPastCharacterChats`、`deleteCharacterChat`）現在也透過 `getContext()` 正式公開，第三方擴充功能無需深入私有內部即可管理對話。
- Studio AI 的世界書工具統一為顯式 `book_name` 參數。`list / query / get / upsert / delete_lorebook_entry` 不再退回隱式主書；新的 `luker_card_list_world_books` 是探索入口。Studio 的 `worldinfo_list_books` 新增 `character_aux` 來源，新的 `worldinfo_search_entries` 支援在單本書內做關鍵字搜尋而無需載入全部條目。
- 修正：當 Studio AI 在同一回應中回傳本文與 tool_calls 時，對話會先顯示核准對話方塊（自動套用模式下為工具結果）再顯示說明文字。`onAssistantText` 現在在解析後立即觸發，UI 順序與生成順序一致。
- 修正：CardApp Studio 的靜態讀取（`fetchFileList`、`fetchFileContent`）與執行環境的 `style.css` 擷取會靜默命中瀏覽器 HTTP 快取——即使伺服器端 `no-store` 中介層已就位，編輯器與 AI 的 `read_file` 仍可能看到過期內容。這些呼叫現在在用戶端顯式指定 `cache: 'no-cache'`。
- 修正：`charaFormatData` 在每次儲存角色時都會呼叫 `syncCharacterBookFromWorldInfo`，把已綁定世界的完整內容序列化進 `data.character_book`——該欄位本用於透過 PNG / JSON 分享角色卡，而非作為執行環境鏡像。過期鏡像隨後會讓 `checkEmbeddedWorld` 為使用者在別處管理的內容彈出「匯入內嵌世界書」對話方塊。儲存不再寫入該鏡像。
- 修正：角色替換後世界書同步彈窗中的三個 bug 疊加，把按鈕變成直排的「傳送」字樣，並讓 AI 後備路徑在失敗時破壞性地同時替換舊世界書與新世界書。CSS 作用域現在錨定到 `.luker-studio`，選單按鈕規則得以生效；破壞性替換路徑也已修復，失敗不再遺失內容。
- 修正：批次檔案系統操作（刪除並重建同名角色卡、重新命名、匯入）不會使記憶體中的最近對話索引失效，歡迎畫面的「最近對話」因此顯示過期條目——包括磁碟上已不存在的對話，使用者嘗試刪除時回傳 400。現在索引在既有的三個呼叫點（與角色 / 群組批次檔案系統變更處理相同）一併失效。
- 修正：透過 `updateCharacterData` 對 `characters[chid].data.extensions.world` 做程式化寫入後，隱藏的 `#character_world` 輸入框仍保留舊值（編輯彈窗是 `display:none` 的 div，不是動態掛載的視窗，其 13 個表單屬性關聯始終存活）。後續基於表單的儲存會把過期值原樣帶回。現在資料驅動寫入後表單保持同步。

### 對話儲存 / 樓層同步

- **409 對話寫入衝突現在使用者可見。** 此前它們透過重建-差異-重試（補丁路徑）或重新整理-重試（附加路徑）靜默自動復原——使用者與測試無從察覺漂移發生，且重建路徑本身基於最新伺服器狀態重新計算 JSON Patch diff，訊息位移時會產出錯誤的子替換。409 現在觸發「對話寫入衝突」警告 toast，帶端點名稱 + 前三個操作摘要 + 送出時的完整性識別碼，發出 `CHAT_WRITE_CONFLICT` 供監測，把每個分岔索引的用戶端 / 伺服器 / 即時三方比對傾印到主控台，並把分岔欄位解析到巢狀路徑而非粗糙的頂層名稱——然後轉入每個呼叫者本就作為後備的完整儲存退回。
- 修正：快照內完整性識別碼在入隊時同步擷取，若期間另一次儲存推進了伺服器狀態，排隊的儲存可能帶過期完整性送出——自動插畫外掛在每次生圖時都會踩中。現在每次送出都會在傳輸前一刻從即時 `chat_metadata` 重新整理完整性（單聊與三條群組儲存路徑皆是）。
- 修正：當用戶端快照攜帶 `Date` 物件而伺服器擷取在相同位置攜帶等價的 ISO 字串時，分岔診斷會誤報——底層值序列化為同一個 JSON 字面量，伺服器的 `test` 操作本會視其為相等。診斷現在採用與伺服器相同的 JSON 形狀比對，線上等價的欄位不再被標記。
- 修正：在寫入磁碟前一刻中止生成再點擊重新生成會產生良性 409（快照 ≡ 伺服器，兩者均與已修正的用戶端分岔）。後備完整儲存能乾淨地修正它，但使用者會看到誤導性的「對話寫入衝突」toast。這一特定形態（`kind === 'snapshot'` 且 `divergence === null`）現在在 toast 層被抑制；診斷事件與 console.warn 仍照常發出。
- `luker_generation_id` 重試去重 token 從 `chat[N].extra` 移入以對話路徑為鍵的記憶體映射，每個條目帶 60 秒 TTL。該欄位不再污染持久化的 jsonl，也不再在 409 診斷中製造 `mutated:[extra.luker_generation_id]` 誤報。
- 效能：外部腳本的變數更新此前每次寫入都觸發完整儲存鏈。`saveMetadata` 的僅中繼資料路徑現在跳過對話複製（依賴既有的即時切片退回），`saveTokenCache` / `saveItemizedPrompts` 透過 1 秒防抖加髒標記合併寫入，並在 `beforeunload`、對話重新載入、以及另一對話接管 itemizedPrompts 時沖刷。
- 修正：一次上游合併把 `saveChatConditional` 重新加回 `sendMessageAsUser` 的推至尾端分支，而既有的 `appendChatMessages` 呼叫仍在。每條使用者訊息被寫入兩次（先按 `MESSAGE_SENT` / `USER_MESSAGE_RENDERED` 之前擷取的快照打補丁，又在這些事件發出後透過附加再寫一次），任何在這兩個事件之間觸碰 `message.extra` 的監聽器都會破壞去重並在尾端產生重複的使用者訊息。重複呼叫已移除，後備設計得以恢復。

### 生成 / 任務流

- **新增面向 OpenAI 系串流的 `generateTaskStream` 分流 API。** 回傳 `{ stream, result }`：一個文字 / 推理增量區塊的 `AsyncIterable`，外加一個 Promise，其標準化終態結果形狀與 `generateTask` 相同。`jsonSchema` 在串流下可用（區塊攜帶部分 JSON，`result.jsonData` 保存解析後的物件）；`tools+jsonSchema` 互斥仍同步拋錯；非 OpenAI 供應商同步拋出 `stream_unavailable`，落實使用者的顯式選用。透過 `getContext().generateTaskStream` 公開。
- **五個內建外掛新增「使用串流傳輸」開關**（search-tools、completion-preset-assistant、orchestrator、memory-graph、character-editor-assistant；預設關閉）。開啟後外掛的 `generateTask` 呼叫會包裝為 `generateTaskStream(opts).result`，在長生成期間保持 HTTP 連線存活，避免慢速 API 上的閒置逾時。非 OpenAI 供應商拋出 `stream_unavailable` 而非靜默退回，靜默退回會違背顯式選用。
- **`generateTask` 現在預設對呼叫者傳入的 `taskMessages` 做巨集替換。** <span v-pre>`{{user}}`</span> / <span v-pre>`{{char}}`</span> / <span v-pre>`{{datetime}}`</span> / <span v-pre>`{{getvar::}}`</span> 及其他任何共享引擎巨集都在請求時解析，副作用巨集（`setvar` / `addvar` / ...）透過 `skipSideEffects:true` 剝除，逐次替換不會改動 `chat_metadata.variables`。創作流程（角色編輯器、世界書 diff 分析、預設編輯器、CardApp Studio AI）以 `substituteMacros:false` 退出，因為它們的職責是讀取或編輯含字面 <span v-pre>`{{...}}`</span> 標記的文字。
- 思考啟用現在由 `reasoning_effort` 驅動而非 `show_thoughts`。此前在 DeepSeek / Moonshot / Z.AI 上 `show_thoughts` 兼任思考的開/關開關，與其「僅可見性」的 UI 標籤相矛盾。現在 `auto` 省略全部思考參數（交給供應商預設值決定），任何顯式檔位送出 `thinking.type='enabled'`，而 `show_thoughts` 在所有供應商上保持僅可見性語意。Gemini 2.5 Flash / Flash-Lite / Pro 的 `auto` 回傳 `null` 而非 `-1`，因此 `thinkingBudget` 也一併省略。
- 提示詞後處理下拉從 7 個選項收縮為 4 個（`Merge` / `Semi` / `Strict` / `Single`）。`_TOOLS` 變體僅差 8 行剝離 tool 角色 / tool_calls 的程式碼——針對早已不再適用的後端的舊相容。舊預設值（`merge_tools` / `semi_tools` / `strict_tools`）在載入時自動遷移，函式呼叫開關上誤導性的「無工具」警告已改寫，精確指向 `Single`（唯一真正不相容的選項）。
- 修正：上游 1.17.0 把 `generateRaw` 拆成 `generateRaw` + `generateRawData`（PR #5249）時，openai 來源分支對 `llmPresetName` / `apiPresetName` / `apiSettingsOverride` 的參照落進了 `generateRawData`，而加入這三個參數的參數表卻留在 `generateRaw` 上。任何透過 `ctx.generateRaw` 走 openai 路徑的呼叫者都會拋出 `ReferenceError: llmPresetName is not defined`。現在兩個函式的參數表都與共享 typedef 一致。
- 修正：Claude、Gemini、Cohere 的非串流回應沒有被提升為 `generateTask` 等函式期望的聊天補全形狀。Claude 只包裝 `content[0].text`，靜默丟棄 `tool_use` 與思考區塊；Gemini 在候選上偵測到 `functionCall` 卻從未寫進回覆；Cohere 原樣轉發且完全沒有 `choices[]`，`normalizeResponse` 因此拋出「openai sender returned no choices」。`generateTask` 呼叫方（角色編輯器、多智能體編排任務節點、記憶圖）現在在非串流模式下對這三家供應商都能正常運作。
- 修正：`ToolManager.parseToolCalls` 會在全域 `function_calling` 開關處短路。開發中的 director 分支為顯式提供工具的擴充功能呼叫方（director-runtime、`generateTaskStream`）加了繞過該閘門的 `force` 參數，但呼叫點接線缺失——使用者保持開關關閉時，Claude `tool_use` 內容區塊會被靜默丟棄於串流管線。串流 sender 現在傳入 `force: normalizedTools.length > 0`，把繞過限定在真正選用工具呼叫的請求上。
- 修正：世界書 / 擴充功能提示詞中的 <span v-pre>`\{{...}}`</span> 轉義（`setvar` / `addvar` 等副作用巨集的教學範例）會把前導反斜線洩漏進 LLM 的提示詞，模型會把 <span v-pre>`\{{setvar::a::1}}`</span> 原樣抄回回覆，巨集引擎與 op-log 掃描器都尊重該轉義——對話變數靜默地從未更新。花括號轉義的剝離現在收束到生成請求邊界。

### 訊息接管（公開擴充功能 API）

- **新增 `createMessageEditorHandle` API 與 `GENERATE_TAKEOVER_DISPATCH` 事件。** 外掛現在可以直接產出 assistant 訊息本文，為該回合繞過主 LLM 分派。核心負責對話陣列的修改、DOM 重繪、`MESSAGE_UPDATED` 發出、佔位符壓入、生成後管線（regex AI_OUTPUT、對話儲存、工具呼叫偵測）與 `saveReply` 路由——外掛專注於內容生成。Director 模式是儲存庫內自帶的消費者；核心本身不綁定任何外掛。

### 變數

- **`setVariable(name, value, { floor? })`** 公開於 `script.js`、`getContext()` 與 CardApp `ctx`。不帶 `floor` 時直接寫入 `chat_metadata.variables`（對話作用域，在本次對話後續過程中持續存在）。帶 `floor` 時透過變數操作日誌向 `chat[floor].extra.var_ops` 推入一條合成的 setvar 操作，並鏡像到該樓層目前 swipe——刪除、滑出、滑回與分支都經重建器對帳，回滾方式與 AI 寫下的 <span v-pre>`{{setvar}}`</span> 字面量一致。樓層綁定路徑把值強制轉為字串（操作日誌只承載字串）；需要帶獨立提交日誌的結構化按樓層狀態時，改用 `ctx.lukerContext.createFloorState({ namespace })`。

### 迭代工作台（開發者 API）

- **AI 迭代彈窗框架從多智能體編排中抽出，成為可複用的 `iteration-studio` 外殼**，位於 `public/scripts/iteration-studio/`。配接器宣告產物的樣貌（`cloneWorkingProfile` + `getInitialProfile`）、哪些工具編輯它、提示詞如何建構、如何持久化。外殼負責彈窗生命週期、對話、歷史、中止、自動續輪、自動套用開關、LLM 往返與 diff 渲染（物件遞迴 + 內嵌行 / 詞級 diff，帶縮放與分割器浮層）。隨附兩個參考配接器：`orchestrator/iteration-adapter.js`（既有的 AI 迭代 UI，從 480 行減到 47 行）與 `memory-graph/schema-adapter.js`（新增——由 AI 編輯的節點類型 schema，透過 schema 編輯器旁新增的「AI 迭代 Schema」按鈕開啟）。第三方外掛透過 `getContext().iterationStudio.{ open, defineAdapter, createSettingsBackedHistoryStore, ... }` 消費。

### 世界書

- 修正：編輯器 `<select>` 的 change 處理器把每次觸發都當作切換書並清空使用中的搜尋 / 篩選，而兩條路徑會在純資料更新時觸發它——`reloadEditor`（透過 `WORLDINFO_UPDATED`、條目開關、斜線指令）與 `deleteWorldInfo` 的清單重新整理後回呼。`reloadEditor` 現在當選中仍為同一本書時直接透過 `showWorldEditor` 重新載入，`deleteWorldInfo` 僅在被編輯的書確實變更時才重新觸發 change，刪除無關的書不再清空使用者使用中的搜尋。

### 預設

- 修正：`persistPreset` 比對 `existingPreset` 與 `preset` 計算 JSON Patch，但像 JS-Slash-Runner 這樣的擴充功能會從 `preset_list.presets[i]` 取參照、原地修改、再呼叫 `savePreset(name, sameRef)`。兩個 diff 輸入是同一個物件的別名，補丁永遠為空，`persistPreset` 回傳 `mode='noop'` 而不請求伺服器——腳本刪除 / 開關在重新整理後靜默還原。補丁路徑已整體移除；儲存一律向 `/api/presets/save` POST 完整預設。

### 使用者備份

- **覆寫模式還原現在是快照加回滾。** 此前還原會先刪除所有選中類別的目錄（`rm -rf`），再把封存檔串流解進新建的空目錄——解壓期間任何失敗（zip 條目損壞、磁碟寫滿、程序被終止）都會讓使用者失去舊資料又留下半成品新狀態，未解壓的內容永久遺失。先刪後寫改為先重新命名為 `<path>.restore-snapshot-<ts>-<hex>`；成功則捨棄快照，解壓失敗則清除部分寫入並把快照重新命名回原位。解壓期間磁碟佔用短暫翻倍，但重新命名操作本身開銷極小。
- 修正：`restoreUserBackupArchive`（或 `/lan-migration/import`、`/import/data-zip`）成功後，記憶體中的 `recentChatIndexCache` 仍指向還原前的檔案系統快照，歡迎畫面的最近對話清單看似過期，儘管打開角色卡能看到剛匯入的對話。現在還原完成時索引即在同樣三個端點上失效。
- 修正：還原以警告結束時，藍色「請稍候…」進度 toast 會滯留在成功 + 警告 toast 與診斷報告視窗之後，因為 `toastr.clear` 只在 finally 區塊中呼叫，而 `await showRestoreDiagnosticReport` 會讓 try 區塊一直存活到使用者關閉視窗。現在還原 promise 一 resolve 就在行內清除 toast，備份還原與區域網路遷移匯入兩條路徑皆是。
- 備份與還原面板中的「匯入 Data ZIP」按鈕是「全選 + 還原備份」的功能性重複（兩者都 POST 到 `/api/users/restore-backup`；唯一差異是該按鈕忽略核取方塊並硬編碼 `BACKUP_FULL_SELECTION`）。已從面板移除；從 Termux 遷移的文件已用三種語言更新，改為描述六步備份與還原流程。新手精靈中的同名按鈕指向不同端點，予以保留。

### 生成復原

- 進行中的復原預覽現在渲染為**對話末尾的內嵌 assistant 訊息氣泡**，而非獨立橫幅，使用同樣的 `.mes` 佈局（頭像 + ch_name + mes_text），視覺上讀作正在生成的訊息。虛線邊框的狀態徽章讓復原中狀態一目瞭然；氣泡是純 DOM，從不觸碰 `chat[]`，當 `reloadCurrentChat()` 把持久化的訊息畫到原位時佔位符乾淨消失。首次渲染時會捲動到可見位置。
- 用戶端現在透過 SSE（`/jobs/events-stream`）串流接收復原事件，不再以 1Hz 輪詢 `/jobs/status`。伺服器端：每個任務的監聽器集合在每次 `appendGenerationEvent` 與每個終態轉換（`awaiting_ack` / `persisting` / `completed` / `failed` / `cancelled`）時通知訂閱者；該端點先按 after_seq 起點重播，再持續輸出即時 `event` / `status` 幀直至終態。用戶端側：`EventSource` 遇瞬時錯誤自動重連；僅 `CLOSED` 就緒態退回重新載入。缺少 `EventSource` 的舊用戶端或受限代理自動使用 1Hz 輪詢後備。

### 管理主控台

- 會阻止下次啟動的伺服器設定儲存與匯入現在在預檢階段即被拒絕，並附帶在地化訊息說明要修正什麼。檢查的兩條不變式為：(a) 開啟 `listen` 時必須啟用 `whitelistMode` / `basicAuthMode` / `enableUserAccounts` 之一（或設定 `securityOverride: true`）；(b) `protocol.ipv4` / `protocol.ipv6` 至少啟用一個或設為 `"auto"`。改設定不再讓你到下次啟動才發現伺服器拒絕啟動。

### 伺服器

- 修正：兩條路徑可能以空 stderr 終止後端。為 `backendLogBuffer` 安裝的主控台包裝器對每個非字串參數執行 `JSON.stringify` 卻沒有 try-catch，任何 `console.*` 參數中的循環參照或 BigInt 都會讓包裝器拋出 `TypeError`；在 `process.on('uncaughtException')` 內部重入的包裝器再次拋錯，Node 隨之中止，收尾的 `original(...args)` 永遠執行不到。另外 Express 4 不會把非同步路由處理器的 rejection 轉發給 `next(err)`，在沒有 `unhandledRejection` 監聽器時 Node 20+ 會把該 rejection 升級為 `uncaughtException`，直接進入劫持中止路徑。兩處現在均有防禦：包裝器後備到 `util.inspect` 再到 `String()` 並隔離緩衝區簿記；顯式 `unhandledRejection` 監聽器確保單一失敗請求不再殺死程序。

### Android 應用程式

- WebView 算繪程序死亡、原生當機、OOM 殺程序與 ANR 都會在 `MainActivity` 寫入任何內容之前拆除 activity，使用者過去只會看到載入轉圈與靜默退出。`LukerCrashCapture` 現在會在下次啟動時透過 `ApplicationExitInfo`（API 30+）讀取最近一次異常退出——`CRASH`、`CRASH_NATIVE`、`ANR`、`LOW_MEMORY`、`DEPENDENCY_DIED`、`SIGNALED`、`EXCESSIVE_RESOURCE_USAGE`、`INITIALIZATION_FAILURE`——對 ANR / 原生情境擷取完整 `traceInputStream`，持久化到 `filesDir/luker-last-crash-report.txt`，並在帶複製 / 分享按鈕的對話方塊中展示。按套件名稱的時間戳防止同一份報告反覆彈出。低於 API 30 時輪詢靜默空操作。

### 更新器

- 修正：Node 20.12+ 拒絕在不帶 `shell: true` 的情況下直接啟動 `.cmd` / `.bat`（CVE-2024-27980 強化），導致拉取後的 `npm install` 步驟在 Windows 上以 `spawn EINVAL` 失敗，儘管 `git pull` 本身成功。現在 win32 上設定 `shell: true`；參數仍為硬編碼字面量，不新增 shell 注入面。

### 擴充功能平台

- 擴充功能啟用現在真正並行：此前 `for` 迴圈內部的逐擴充功能 `await` 鏈讓結尾的 `Promise.allSettled(promises)` 實際形同虛設，而區域 `promise` 變數本就只保存啟用前的階段。`.then(activate)` 與 `.catch` 現在被併入存入 `promise` 的鏈，迴圈內的 `await` 被移除，迴圈結尾的 `Promise.allSettled` 真正並行等待啟用完成。`manifest.dependencies` 存在性檢查保留。

### 雜項

- 系統頭像與歡迎助理現在使用 Luker 標誌（`img/logo.png`）而非 SillyTavern 標誌；`/echo` 說明範例已更新，孤立的 `img/five.png` 已移除。
- 文件：新增五個擴充功能 API 參考頁（世界書、角色、斜線指令、巨集與變數、UI 與彈窗），既有頁面擴充涵蓋對話生命週期、swipe API、擴充功能提示詞、媒體輔助函式、提示詞信封檢查、推理輔助函式、設定視圖、底層生成原語、服務類別、i18n、設定儲存、除錯與擷取器註冊、分詞、工具函式、以及符號 / 常數。新的 basics/macros 指南以 en / zh-CN / zh-TW 三語發布。所有變更已同步到全部三種語言。
- 文件：在 zh-CN / zh-TW 文件頁點擊頂部導覽不再把讀者送回英文版——導覽、側邊欄、文件頁尾、大綱、搜尋標籤、頁尾與 UI 字串現在按語言存放於各自的 `themeConfig`。一輪完整的三語稽核還發現並修正了 `changelog.md` 在英文標題下通篇為中文的問題，以及 `memory-graph.md` 中的四個跨語言內部連結。

**完整更新日誌**：https://github.com/funnycups/Luker/compare/v2.1.2...v2.2.0


## v2.1.2 (2026-05-10)
- 修正了 CardApp Studio 無法讀取角色卡資訊的問題
- 最佳化了 CardApp Studio 提示詞
- 修正了 Web 端更新衝突處理

**完整更新日誌**：https://github.com/funnycups/Luker/compare/v2.1.1...v2.1.2


## v2.1.1 (2026-05-09)
- 修正了 CardApp Studio 中的文件錯誤並擴充了其文件

**完整更新日誌**：https://github.com/funnycups/Luker/compare/v2.1.0...v2.1.1


## v2.1.0 (2026-05-09)
- **變數巨集支援走訪物件**
- **CardApp Studio 支援在角色卡層級操作 regex、記憶圖與多智能體編排，簡化角色卡建立**
- CardApp Studio 在每次工具呼叫前輸出的文字現在被正確保留並渲染
- CardApp Studio 現在顯示 CardApp 錯誤日誌，便於除錯
- CardApp API 提供對話世界書操作介面
- 修正了行動裝置上預設群組無法開啟的問題
- 在 API 抽屜中新增 Embedding API 與檢索 API 設定
- 向量與記憶圖外掛現在統一複用 API 抽屜中的 Vector API 設定
- 修正了內建外掛中明文函式呼叫不生效的問題
- 最佳化了擴充功能更新檢查的設計以減少流量消耗
- 最佳化了 CardApp Studio 提示詞
- 修正了 CardApp Studio 不顯示工作階段歷史的問題
- 記憶圖現在支援手動重新計算或補算向量
- 修復修改預設時的卡頓問題
- 修正了部分行動裝置上的渲染問題
- 修正了 Loop 模式下多智能體編排的問題
- Loop 編排模式現在可以呼叫搜尋外掛的搜尋工具
- 新增了前端 token 估算功能

**完整更新日誌**：https://github.com/funnycups/Luker/compare/v2.0.0...v2.1.0


## v2.0.0 (2026-05-07)

### ★ 文件

https://luker.cups.moe

Luker 官方文件站，涵蓋 Luker 的大部分改進、內建外掛使用指南、外掛開發規範等內容——簡體中文、繁體中文與英文三語保持同步。

- 新增三語（zh-CN、zh-TW、EN）文件站，作為外掛、擴充功能 API、CardApp 規範、記憶圖等內容的統一入口
- 新增多智能體編排、記憶圖、CardApp、Studio、樓層狀態、按訊息變數、自動遷移說明等內容的使用指南，配有截圖與流程圖
- 新增伺服器外掛開發指南與預設 API 參考
- 新增設定 / 啟動文件

### ★ CardApp 與 CardApp Studio

https://luker.cups.moe/features/cardapp.html
https://luker.cups.moe/features/card-editor/studio.html
https://luker.cups.moe/features/card-editor/walkthrough.html
https://luker.cups.moe/development/card-developers.html

CardApp 是 Luker 為「前端角色卡」制定的標準形態；Studio 是面向 CardApp 作者的 AI 輔助程式碼編輯器——撰寫、編輯、執行一站完成。

- 新增 CardApp 前端角色卡：涵蓋伺服器 + 前端的完整套件，含 CSS 自動隔離、訊息渲染管線、對話 / 角色欄位 / 世界書 API、AI 工具定義與執行循環
- 新增 CardApp Studio：程式碼編輯器、變更核准 + diff 檢視、多工作階段、程式碼自動補全、一鍵 Git 回滾、熱重載、完整三語 UI
- 反覆打磨 Studio 的提示詞與工具集，讓 AI 寫出的程式碼經得起考驗
- 新增世界綁定：Studio 內的 AI 可將 AI 面向的文字直接寫入已綁定的世界書條目，無需繞路
- Studio 行動裝置版面：底部標籤列與響應式佈局，小螢幕也能用

### ★ 多智能體編排

https://luker.cups.moe/features/orchestrator/

- 新增 Loop 模式：單個 agent 執行自己的工具循環，帶預設循環提示詞與「刪除筆記」工具
- 編排成功時發出事件，其他外掛可從該處接續
- Loop 模式可直接讀寫記憶圖
- 持久化迭代工作階段
- 移除硬性迭代上限
- 新增 RPM 限流

### ★ 聊天補全預設助手

https://luker.cups.moe/features/preset-assistant.html

新增聊天補全預設助手：一個編輯預設、提示詞與世界書的 AI 助理，附帶逐步預覽——預設維護一站式完成。

- 豐富工具集：建立預設的預設、欄位讀取器、世界書開關、組合後提示詞預覽等
- 持久化工作階段歷史與工具呼叫軌跡，可逐步回溯
- 預設修改可透過變更歷史回滾

### 記憶圖

https://luker.cups.moe/features/memory-graph.html

- 新增混合召回管線（圖擴散 + 認知算子）
- 注入預覽新增 HTML 表格渲染，並新增響應式的節點詳情與注入檢視器版面配置，支援複製與可摺疊搜尋
- 自動 schema 遷移：舊對話在載入時升級，附帶循環防護與後備機制，不會卡死
- 新增兩種匯入模式（還原到原樓層 / 綁定到目前樓層）
- 重寫事件壓縮規則：摘要更精簡，彙整（rollup）擁有獨立規則集，支援跨深度扁平壓縮
- 遷移到新的樓層狀態核心服務，記憶依樓層對齊的 diff 提交，語意更清晰
- 新增 RPM 限流
- 最佳化召回提示詞結構以減少 token 消耗
- 移除一批舊 schema 與死程式碼路徑；提示詞更精簡

### 樓層狀態

https://luker.cups.moe/features/state-system.html

新增樓層狀態——隨訊息樓層自然回滾與前進的狀態。

- 提供外掛作者使用的實例 API，可定位特定樓層或分支
- 分支對話繼承提交日誌
- 多智能體編排、搜尋外掛與記憶圖皆已遷移到其上

### 按訊息變數

https://luker.cups.moe/features/variable-op-log.html

- 新增按訊息變數功能：每條訊息貢獻的變數變更可個別檢視與管理
- 對話中涉及的所有變數在訊息被刪除、swipe 或重新生成時自動回滾或更新

### 統一訊息 API

https://luker.cups.moe/improvements/generation-layer.html

- 新增統一訊息 API，取代零散的舊介面——為外掛提供乾淨的 LLM 入口

### 預設管理器

https://luker.cups.moe/features/preset-groups.html

- 新增分組系統：可摺疊面板、情境選單、按 API 分組
- 支援巢狀子群組；編輯模式下可展開 / 摺疊
- 聊天補全預設與連線設定完全解耦
- 強化預設內建 regex 腳本的匯入

### 提示詞管理器

https://luker.cups.moe/features/prompt-groups.html

- 新增分組系統：可摺疊區塊、批次開關、批次啟用 / 設為額外 / 移除
- 支援巢狀子群組
- 新增進階提示詞搜尋

### 世界書

https://luker.cups.moe/basics/world-info.html
https://luker.cups.moe/features/world-info-trace.html

- 新增多世界書綁定：每個對話可同時綁定多個世界書
- 新增涵蓋所有可編輯欄位的批次欄位編輯工具列，含單一欄位、複合（觸發策略）、三態（匹配欄位）與注入深度對話方塊；一鍵回滾
- 新增可設定的編輯器欄位可見性，少用欄位可以隱藏
- 擴充批次條目操作
- 改進搜尋體驗並新增進階搜尋
- 完整三語；行動裝置版面改進

### 擴充功能 API

https://luker.cups.moe/development/frontend-plugin.html
https://luker.cups.moe/development/server-plugin.html
https://luker.cups.moe/development/extension-api/

- 新增擴充功能 API 註冊表與查詢
- 新增角色狀態讀寫，狀態操作不再經過 metadata 呼叫
- 新增一站式請求 API：連線設定、預設、訊息組裝、串流——一次完成
- 為 Studio 及其他上層外掛新增本機 Git 能力
- 向外掛公開預設 API
- 移除舊的 extras API

### WebSocket 代理

https://luker.cups.moe/improvements/ws-proxy.html

- 新增 WebSocket 代理通道：LLM 與圖像生成請求經 WS 轉發，斷線自動重試，遠端使用更穩定

### 重排與向量

- 新增重新排序：相似度分數公開、重排端點、UI 整合、完整三語
- 新增 Jina AI 作為原生 embedding 來源
- 向量查詢端點可回傳原始向量

### 請求檢查器

https://luker.cups.moe/improvements/request-inspector.html

- 新增請求檢查器：按使用者追蹤 LLM 與圖像生成請求，用於診斷
- 涵蓋所有圖像生成後端的請求追蹤

### 圖像生成

- ComfyUI 改用 WebSocket 而非 HTTP 輪詢，WS 失敗時回退到輪詢

### 正規表達式

- 新增 ReDoS 與長時間執行的正規表示式偵測，壞模式無法凍結對話
- 拖放改進；行動裝置長按不再誤觸發
- 修正正規表達式編輯後事件未觸發的問題
- 處理預設內建 regex 腳本中的無效條目

### 復原

https://luker.cups.moe/improvements/other.html

- 為提示詞與世界書條目刪除新增復原 toast——誤刪可還原

### UI 現代化

- 以效能最佳化與更新樣式翻新抽屜面板
- 彈窗樣式與 Studio 設計系統統一
- 重新設計多智能體編排與記憶圖的檢視彈窗

### 效能與體驗

- 新增前端自我效能取樣開關，可擷取並精確定位卡頓
- 預設關閉自動補全，杜絕長對話中的版面抖動；啟用時節流更有效率
- 精簡內部不必要的物件複製——預設編輯手感明顯更順
- 情境選單重新定位於可視範圍內，不再裁切出螢幕
- Android WebView 中的自適應對話寬度
- 長對話中批次處理 OpenAI token 計數
- 渲染時批次處理世界書條目標題的自動調寬

### 行動裝置

- 修正行動裝置虛擬鍵盤自動彈出及若干相關輸入問題
- 預設與世界書控制項的觸控間距更好
- 彈窗因應小螢幕調整；小螢幕彈窗不再溢出
- Android 應用程式：WebView 自訂全螢幕、優先使用系統檔案選擇器 intent、更寬泛的 JSON 匯入、系統主題切換不再重新啟動

### i18n

- 多處完成翻譯：變數操作面板、SD 生成 toast、世界書批次編輯、提示詞分組、重排設定等

### 日誌與除錯

- 前端與後端所有 console 日誌皆帶時間戳
- 新增一鍵除錯日誌匯出，自動遮罩金鑰，可直接作為回饋送回
- 強化 Luker 持久化的日誌

### 安全與認證

https://luker.cups.moe/guide/authentication.html

- 啟動時為未設防的管理員帳戶自動配發隨機密碼
- 修正內建更新器在某些情境下無法執行的問題
- 區域網路遷移路徑略過基本認證；Android WebView 處理 Basic Auth 提示

### 模型通道

- DeepSeek 與 Claude 支援自訂附加參數
- 在工具呼叫路徑中處理 DeepSeek V4 推理內容
- 正規化 Claude 與 Gemini 的原生工具 schema
- 正規化 OpenAI 相容端點 URL，接受彈性的輸入格式
- 伺服器端訊息傳輸持久化擴及更多對話供應商
- 函式呼叫提示詞強化，包括改進的明文函式呼叫提示

### 修正

- 修正多智能體編排與記憶圖中 RPM 限流的語意
- 修正記憶圖節點排序、注入記錄更新、toast 相互覆寫、持久化內容被覆寫以及進階設定對話框捲動問題
- 修正多個提示詞管理器與世界書條目樣式問題
- 修正對話綁定世界書選擇器無法選擇世界書的問題
- 修正 ComfyUI WS 重新連線重試與連線管理器 API 新增流程
- 阻止角色卡編輯器在主對話上下文中註冊工具
- 防止下拉搜尋點擊意外關閉抽屜
- 修正 SD 生成 toast 無法關閉、toast 相互覆蓋、生成失效等問題
- 修正缺失的持久化完整性檢查，避免過期資料覆寫對話記錄
- 修正 WS-Proxy 被 IP 驗證錯誤拒絕的問題
- 修正 WS-Proxy 因關閉時機不當而中止請求的問題（應用程式內「無法傳送訊息」在 rc.2 的根因）
- 修正上游對話在載入失敗時的資料遺失 bug（現在在任何寫入之前先區分「新對話」與「損壞資料」）
- 修正串流端點靜默丟棄錯誤的問題——現在記錄完整細節並回傳 500
- 修正 bootstrap 回應攜帶 PNG 資料導致酬載過大的問題
- 修正推理斜線指令在初始化期間未註冊的問題
- 修正 OpenAI 錯誤處理與提示詞參照、提示詞 token 上限誤算以及 SD 例外處理
- 修正 blob/iframe 下載處理
- 儲存角色表單時保留自訂欄位
- 修正巨集轉義：轉義在多條路徑上保持有效；副作用巨集不再於提示詞組裝期間重複觸發
- 修正切換分支時分支對話儲存到錯誤目標檔案的問題
- 修正 persona 解綁狀態不持久化與遷移頭像檔名未保留的問題
- 修正綁定預設被清空時 OpenAI 凍結的問題
- 修正下拉刪除按鈕在 WebView 觸控下無回應的問題
- 修正角色卡驗證在合併卡正規化之前就生效的問題
- 修正多個連線設定切換問題

### 重構與上游同步

- 同步至上游 SillyTavern 1.18
- 角色卡執行環境與儲存改為 v2 優先（移除 v1 後備）；舊卡自動遷移
- 移除內建 summarize 擴充功能（由記憶圖取代）
- 移除舊的重新導向路由與死相容墊片
- 移除世界書字串後備，改用條目陣列
- 將單體式擴充功能拆分為內部模組

### 新貢獻者
* @Youzini-afk 在 https://github.com/funnycups/Luker/pull/1 中做出了首次貢獻
* @1432647 在 https://github.com/funnycups/Luker/pull/3 中做出了首次貢獻
* @atonal519 在 https://github.com/funnycups/Luker/pull/5 中做出了首次貢獻

**完整更新日誌**：https://github.com/funnycups/Luker/compare/v1.32.1...v2.0.0

## v1.32.1 (2026-03-21)
- 更新管理器中開關圖示的啟用狀態

**完整更新日誌**：https://github.com/funnycups/Luker/compare/v1.32.0...v1.32.1

## v1.32.0 (2026-03-21)
- 將全域世界書管理移入抽屜，附帶釘選世界書、啟用摘要、標籤搜尋與批次控制
- 新增批次世界書條目轉移，並透過專用拖曳指示器實現更安全的自訂排序
- 改進世界書管理器的效能與渲染穩定性
- 新增聊天人設變更提醒，並使聊天/角色人設綁定在切換聊天時保持穩定
- 為角色卡編輯助手加入持久化對話歷史
- 為編排器加入持久化迭代歷史與基於 diff/patch 的變更追蹤
- 允許在儲存進行中時安全切換聊天與執行聊天檔案操作，同時正確限定刪除新聊天操作的範圍，並減少行動裝置上意外觸發樓層切換
- 改進建立世界書條目的搜尋指引，包括來源作品處理、常駐注入條目，以及訊息編輯後重新整理快取
- 在角色綁定預設中保留正規表示式擴充功能，並提升提示詞/正規表示式編輯器的回應速度

**完整更新日誌**：https://github.com/funnycups/Luker/compare/v1.31.0...v1.32.0

## v1.31.0 (2026-03-20)
- 將純文字函式呼叫重試設定儲存到指定的 API 預設
- 搜尋外掛中的網頁造訪優先使用 jina reader
- 避免重新命名時聊天資料夾衝突
- 修正圖庫檢索
- 為無效腳本的編輯器渲染加入防護
- 停止依據隱藏訊息修剪圖
- 中止生成後恢復傳送控制項
- 防止歡迎畫面與還原的聊天混雜
- 提升預設切換效能
- 限制日誌檢視器的渲染預算
- 為日誌檢視器新增搜尋
- 將預設與正規表示式的重新排序限制為實際拖曳把手
- 在代理分塊間保持 utf-8
- 處理帶尾端空格的世界書檔名
- 在預設操作按鈕之間加入間距

**完整更新日誌**：https://github.com/funnycups/Luker/compare/v1.30.1...v1.31.0

## v1.30.1 (2026-03-18)
- 修正啟動載入問題
- 最佳化純文字函式呼叫參數相關文件

**完整更新日誌**：https://github.com/funnycups/Luker/compare/v1.30.0...v1.30.1

## v1.30.0 (2026-03-18)
- 最佳化外掛重用預設時清除世界書資料相關的開發文件。
- 記憶圖、編排器與搜尋外掛現在可手動停用在請求中包含世界書資料的功能。
- 最佳化搜尋外掛，要求搜尋後生成的世界書條目使用標準 YAML 格式，提升條目品質。
- 在使用者設定中新增前端日誌開關（預設關閉），防止外掛印出過多日誌；除錯時可開啟以查看錯誤訊息。
- 最佳化預設儲存效能。

**完整更新日誌**：https://github.com/funnycups/Luker/compare/v1.29.1...v1.30.0

## v1.29.1 (2026-03-18)
- 為記憶圖增量持久化壓縮進度
- 在重設或匯入記憶圖前停止執行時期工作
- 為記憶圖的排程更新加入 single-flight 合併
- 避免手機上的固定背景渲染
- 最佳化預設記憶圖 Schema 與提示詞
- 防止 App 在螢幕方向變更時重新啟動

**完整更新日誌**：https://github.com/funnycups/Luker/compare/v1.29.0...v1.29.1

## v1.29.0 (2026-03-17)
- 為外掛彈出視窗新增重新生成
- 跨輪持久化彈出視窗中的工具輪次
- 角色編輯器支援開場白欄位

**完整更新日誌**：https://github.com/funnycups/Luker/compare/v1.28.0...v1.29.0

## v1.28.0 (2026-03-17)
- 為編排器加入按 agent 的聊天預設路由
- 為純文字函式呼叫加入可選自動重試
- 為記憶圖加入事件時間欄位預設值
- App 啟動時重新整理正規表示式清單
- 最佳化 App 啟動
- 取消編輯時恢復 message_updated 事件
- 避免取消編輯時清空翻譯

**完整更新日誌**：https://github.com/funnycups/Luker/compare/v1.27.1...v1.28.0

## v1.27.1 (2026-03-16)
- 修正快速回覆中的錯誤
- 議程模式下，編排器中的規劃器現在可設定 API 預設
- 修正正規表示式狀態更新

**完整更新日誌**：https://github.com/funnycups/Luker/compare/v1.27.0...v1.27.1

## v1.27.0 (2026-03-16)
- 新增外掛專用正規表示式
- 啟動時恢復 UI 狀態
- 改進開發文件
- 修正金鑰彈出視窗
- 記憶圖採用檔案匯入匯出
- 為記憶圖新增節點搜尋
- 編排器支援按 agent 的 API 預設
- 修正啟動頁 GitHub 圖示連結
- 最佳化編排器生成提示詞
- 純文字函式呼叫改用 XML 模型
- 寫入後使過期的快取讀取失效

**完整更新日誌**：https://github.com/funnycups/Luker/compare/v1.26.1...v1.27.0

## v1.26.1 (2026-03-16)
- 修正預設切換
- 最佳化純文字函式呼叫模型

**完整更新日誌**：https://github.com/funnycups/Luker/compare/v1.26.0...v1.26.1

## v1.26.0 (2026-03-15)
- 一系列前端與後端的效能和快取最佳化，包括世界書渲染最佳化、啟動首畫面最佳化、最近聊天快取、diff 後端最佳化、前端設定快取，以及最大化平行請求
- 最佳化搜尋外掛的提示詞；請在外掛設定中點擊重設
- 最佳化搜尋外掛的執行邏輯
- 將多智能體編排的預設注入深度重設為 0
- 為角色卡編輯器彈出視窗加入中斷按鈕
- 為多智能體編排引入議程模式：在該模式下，規劃器動態決策並呼叫 agent 進行編排，規劃器可自由運作，不受固定編排順序的約束
- 編排器現在可在角色卡層級持久化編排類型（agenda/spec/single）
- 修正角色卡編輯器在更新角色卡後觸發錯誤的問題
- 最佳化 emoji 名稱的處理
- 為前端日誌顯示加入時間與數量篩選
- 停用記憶圖時立即停止進行中的更新
- 搜尋外掛結果現在支援隨使用者聊天歷史一同回滾
- 修正切換 API 預設時反向代理未能自動載入的問題
- 最佳化純文字函式呼叫的設計，以更好地對齊 Toolify 的通用函式呼叫模型

**完整更新日誌**：https://github.com/funnycups/Luker/compare/v1.25.3...v1.26.0

## v1.25.3 (2026-03-13)
- 修正重新生成時助手訊息重複的問題

**完整更新日誌**：https://github.com/funnycups/Luker/compare/v1.25.2...v1.25.3

## v1.25.2 (2026-03-12)
- 遵循召回世界書的注入設定
- 最佳化編排器生成提示詞
- 注入設定變更時同步持久世界書
- 在事件中加入樓層切換中繼資料
- 修正樓層切換期間記憶圖的問題
- 將沉浸模式開關移入使用者設定
- 確保編輯器在儲存後關閉
- 修正 App 內 jsonl 與正規表示式的選取問題
- 修正鉤子順序中第三方擴充功能的問題
- 為鉤子順序加入更多事件

**完整更新日誌**：https://github.com/funnycups/Luker/compare/v1.25.1...v1.25.2

## v1.25.1 (2026-03-11)
- 改進簡體與繁體中文的 i18n 覆蓋率
- 修正 App 無法匯入圖片的問題
- 切換預設時保留停止字串
- 修正訊息編輯時偶發的 UI 混亂
- TTS 現在會在後端記錄請求細節並捕捉錯誤
- 修正部分裝置上 App 無法匯出檔案的問題

**完整更新日誌**：https://github.com/funnycups/Luker/compare/v1.25.0...v1.25.1

## v1.25.0 (2026-03-11)
- 編排器注入評審節點的回饋
- 為 App 加入 i18n
- 修正受正規表示式影響的訊息儲存
- 復原時保留世界書啟用狀態
- 為角色卡加入復原功能

**完整更新日誌**：https://github.com/funnycups/Luker/compare/v1.24.0...v1.25.0

## v1.24.0 (2026-03-10)
- 允許在未選擇 API 預設的情況下修改函式呼叫模式
- 角色卡編輯器現在提供世界書搜尋與檢索工具，而非直接嵌入整本世界書
- 修正抽屜 UI 顯示
- 在角色卡範圍正確覆寫記憶圖的進階設定
- 為編排新增評審節點類型，該節點可審查先前節點，並對不理想的部分觸發重試
- 刪除聊天、預設或世界書時，現在會提供簡短的復原提示
- 角色卡匯出將包含最新綁定的世界書
- 修復輸入法開啟或關閉時的卡頓問題
- 為編排加入視覺化流程圖，以觀察整個過程
- 單 agent 編排模式下現在可查看編排結果
- App 允許在狀態列通知中自訂端點；非本機端點不會啟動本機服務
- 訊息編輯事件提供更詳細的中繼資料
- 編排結果現在會隨使用者訊息的變更與刪除一同回滾
- 最佳化增量更新端點，減少不必要的完整儲存
- 記憶圖的錯誤與警告提示現在會持久顯示

**完整更新日誌**：https://github.com/funnycups/Luker/compare/v1.23.0...v1.24.0

## v1.23.0 (2026-03-09)
- 在前端管理後端外掛
- 最佳化外掛作用域的正規表示式與 API
- 修正編排器結果注入
- 修正外掛的作者備註注入
- 為外掛開放搜尋 API
- 新增 SearXNG 與 Brave 作為搜尋提供者
- 即使網頁擷取失敗也繼續搜尋 agent 迴圈
- 搜尋擷取失敗時回傳詳細錯誤

**完整更新日誌**：https://github.com/funnycups/Luker/compare/v1.22.0...v1.23.0

## v1.22.0 (2026-03-08)
- 切換聊天時會同步更新記憶圖與搜尋外掛的狀態。
- 中斷記憶圖更新不會導致圖資料遺失，部分處理的變更會被儲存。
- 修正了純文字函式呼叫的若干回呼問題。
- 最佳化了 DuckDuckGo 搜尋結果的解析。
- 取消訊息編輯不再錯誤地觸發訊息更新事件。
- 記憶圖更新被中斷時會出現提示通知。
- 最佳化了搜尋外掛的提示詞。
- 最佳化了與記憶圖節點和更新相關的提示詞；可在 Schema 與進階設定中手動重設為最新預設值。
- 新增了聊天分支事件。
- 聊天分支會將記憶圖資料同步到新聊天。
- 提示詞管理器現在可搜尋執行時期提示詞，例如聊天歷史中的訊息。
- 編輯訊息不再中斷記憶圖更新。
- 修正並統一了記憶圖、編排與搜尋外掛的注入設定。
- Luker 現在可透過指定前端與後端外掛路徑啟動。
- App 的前端與後端外掛現在直接從 Android/data 讀取並使用。
- 修正了關閉記憶圖後訊息被錯誤隱藏的問題。
- 搜尋外掛現在與編排一樣，納入兩階段查詢及對應提示詞。
- 修正了外掛請求重新掃描世界書的工作流程。
- 修正了搜尋外掛無法注入搜尋結果的問題。

**完整更新日誌**：https://github.com/funnycups/Luker/compare/v1.21.0...v1.22.0

## v1.21.0 (2026-03-07)
- 開啟抽屜時重新整理正規表示式腳本清單
- 穩定影像生成追蹤，並在最後一個活躍工作停止後清除生成提示
- 切換聊天預設時保持 API 設定檔穩定
- 支援外掛在啟用後重寫世界書的鉤子
- 規範編排器與記憶圖的執行時期世界書酬載處理，包括 Quick Build 情境
- 以 Toolify 風格流程統一核心與擴充功能的函式呼叫執行環境
- 在 API 抽屜中加入主聊純文字函式呼叫開關
- 支援呼叫方自有的無工具處理、純文字 prompt_json 回應，以及更清晰的多工具純文字提示詞
- 保留對 array/parts 酬載的助手文字擷取，並規範流式純文字工具呼叫
- 將工具結果重播標準化為 assistant/tool 訊息
- 在編排器中加入節點搜尋與知識迭代，支援聊天狀態持久化
- 摺疊較長的編排迭代訊息，並隱藏自動模擬酬載
- 簡化預設編排器提示詞範本
- 新增編排研究紀錄檢視器彈出視窗
- 將「膠囊」用語更名為「編排結果」
- 允許編輯最新的編排結果
- 將網頁搜尋與編排器解耦
- 在角色卡編輯助手中加入整合的網頁搜尋工具流程
- 新增 DDG 提供者，並將搜尋外掛 API 從全域工具註冊中解耦
- 明確搜尋外掛的主模型可見性開關，支援基於預設的 agent 選擇器，新增可取消的搜尋提示，並在重新生成時重用請求前結果
- 為記憶圖角色 Schema 加入預設特質欄
- 在記憶圖中新增可設定的召回注入位置
- 在記憶圖擷取中排除最近的助手輪次
- 支援將記憶圖匯入為聊天基線
- 強化記憶圖在聊天變更回滾、召回中止、重新生成重用與過期後續清理方面的穩定性
- 在記憶圖中持久化增量操作日誌
- 使用共用的外掛世界書，並在執行環境建立後重新整理世界書清單
- 為使用者備份加入安全的區域網路遷移流程，並在下載前清除進度提示
- 外掛中止後繼續生成，並在用戶端取消時中止進行中的後端請求

**完整更新日誌**：https://github.com/funnycups/Luker/compare/v1.20.0...v1.21.0

## v1.20.0 (2026-03-02)
- 記憶圖將儲存持久節點

**完整更新日誌**：https://github.com/funnycups/Luker/compare/v1.19.0...v1.20.0

## v1.19.0 (2026-03-02)
- 清除最後一次影像生成的生成提示
- 最佳化編排提示詞
- 穩定記憶圖批次刪除訊息後的狀態
- 在 API 預設中儲存額外參數
- 修正編排器角色範圍下刪除預設的問題
- 支援與預設關聯的世界書
- 新增提示詞搜尋
- 預設匯入匯出始終剝離連線欄位

**完整更新日誌**：https://github.com/funnycups/Luker/compare/v1.18.0...v1.19.0

## v1.18.0 (2026-03-01)
- 避免將編排器的 agent 逾時套用於 agent 生成
- agent 生成的 JSON 解析錯誤將觸發重試
- 修正編排器的預設移除
- 中止時清除影像生成的生成提示
- 修正正規表示式清單渲染
- 防止重試競爭時重複插入訊息

**完整更新日誌**：https://github.com/funnycups/Luker/compare/v1.17.0...v1.18.0

## v1.17.0 (2026-02-28)
- 影像生成提示現在加入中斷生成的按鈕
- 編排器生成模型可將全域編排作為參考查看
- API 預設的反向代理現在隨預設本身一併儲存
- 正規表示式外掛現在提供外掛專用正規表示式。任何外掛/腳本均可透過 Luker 介面加入
- 編排器現在使用外掛正規表示式功能處理訊息隱藏

**完整更新日誌**：https://github.com/funnycups/Luker/compare/v1.16.1...v1.17.0

## v1.16.1 (2026-02-27)
- 將 config.yaml 儲存到外部儲存空間

**完整更新日誌**：https://github.com/funnycups/Luker/compare/v1.16.0...v1.16.1

## v1.16.0 (2026-02-27)
- 編排器現在注入最新節點的純回應
- 為編排器生成新增佔位符使用指南
- 穩定編排器重新生成的快取重用
- 為編排器新增 CoT
- 支援 Discord OAuth 作用域
- App 資料遷移至外部儲存空間

**完整更新日誌**：https://github.com/funnycups/Luker/compare/v1.15.0...v1.16.0

## v1.15.0 (2026-02-26)
- 修正傳送訊息時的問題
- 新增聊天訊息管理
- 關閉/重新載入本頁面前新增警告

**完整更新日誌**：https://github.com/funnycups/Luker/compare/v1.14.0...v1.15.0

## v1.14.0 (2026-02-25)
- 修正作者備註、對話範例等內容無法被外掛請求重用的問題。
- 從記憶圖預設 Schema 中移除「thread」。
- 切換預設時，若有未儲存的變更，將提示你儲存。
- 切換預設或將其從提示詞順序中移除等操作，現在會觸發復原提示，可在短時間內還原變更。
- temperature 等預設配置現在預設摺疊，以防意外修改。
- 最佳化全螢幕模式下的輸入法問題。
- 修正記憶圖中的聊天樓層裁切功能。

**完整更新日誌**：https://github.com/funnycups/Luker/compare/v1.13.1...v1.14.0

## v1.13.1 (2026-02-24)
- 最佳化記憶圖提示詞
- 改進 Luker API 文件

**完整更新日誌**：https://github.com/funnycups/Luker/compare/v1.13.0...v1.13.1

## v1.13.0 (2026-02-24)
- 允許在圖形檢查器中刪除節點
- 更新預設事件 Schema 與壓縮提示詞
- 壓縮彙總中保留 Schema 欄位
- 在最近注入檢視中顯示動態召回內容
- 為記憶圖加入 Schema 壓縮規則與 thread 預設篩選
- 修正重新生成
- 強化 App 沉浸式版面穩定性
- 修正 App 中龐大備份檔案的問題
- 針對繁重操作改用非同步 diff

**完整更新日誌**：https://github.com/funnycups/Luker/compare/v1.12.1...v1.13.0

## v1.12.1 (2026-02-23)
- 修正記憶圖自動壓縮

**完整更新日誌**：https://github.com/funnycups/Luker/compare/v1.12.0...v1.12.1

## v1.12.0 (2026-02-23)
- 最佳化編排器角色範圍的使用
- 相容依賴錯誤時序的腳本與外掛
- 修正外掛所用 API 預設中的驗證問題
- 跟隨上游 SillyTavern 更新至 7ffb28f，內容如下

### 亮點
- 提升大型聊天中的訊息渲染效能（`printMessages`、批次前置插入、編輯替換路徑）。
- 遷移 Macros 2.0 核心及後續執行時期/自動完成修正。
- 升級媒體管線，新增 `/api/image-metadata`、背景中繼資料與排序支援。
- 擴充 SD/媒體能力：Z.AI GLM-Image、Pollinations API 更新、stable-diffusion.cpp 後端、更佳的生成進度/中止體驗。
- 同步 OpenRouter、NanoGPT、Moonshot、Z.AI 與打標工具的模型/提供者更新。
- 新增向量斜線命令控制，並改進世界書命令診斷。

### Luker 原生變更
- `b9dc9c278` 新增 Z.AI GLM-Image 模型支援與尺寸規則。
- `917c25564` 新增 SD 生成進度指示器與中止體驗改進。
- `5ae4d365b` 遷移 Pollinations 影像 API（驗證與回應格式）。
- `f26567c97` 新增 stable-diffusion.cpp 後端支援。
- `7befcdf23` 避免樓層切換時重複附加媒體。
- `d804ee975` 新增最小提示詞處理選項。
- `a57a1d68b` 新增 NanoGPT 推理力度控制。
- `33a7eca6d` 為影像生成請求加入 OpenRouter 請求標頭。
- `e023ea2b1` 新增向量儲存斜線命令。
- `a2b0cefb2` 新增可設定的 Gemini 思考簽章注入。
- `c6451e254` 對應 Moonshot 與 NanoGPT 的推理控制。
- `b854572e2` 改進世界書斜線命令警告與重複命名。
- `dabd9bd23` / `c8fca6e4f` / `424c118e7` / `17d87e939` 完成 Macros 2.0 遷移工作。
- `564d1d84e` / `c175e43c3` / `e95f192a4` 改進訊息渲染/編輯/索引行為。

### 上游同步
- 修正包含冒號密碼的 HTTP Basic Auth 驗證。  
  上游：https://github.com/SillyTavern/SillyTavern/commit/df0e1256e67276f203bb2dc93ba747bb18df8f26
- 使 CORS 中介軟體可設定。  
  上游：https://github.com/SillyTavern/SillyTavern/commit/10e08f0e3df3bd22a00a017db772cd8b0258ecc3
- 防止切換角色/群組時意外覆蓋聊天。  
  上游：https://github.com/SillyTavern/SillyTavern/commit/4e5cb9c44f99f6ecd886a7c4a26defb6b8ed06f6
- 新增釘選最近聊天。  
  上游：https://github.com/SillyTavern/SillyTavern/commit/1ff98e76f8a80f0d9025b2cc288bab8045c25335
- 工具呼叫遞迴時保留使用者輸入。  
  上游：https://github.com/SillyTavern/SillyTavern/commit/9714374749b0bf1193f10af1b83695ab38147b7c
- 為擴充功能開放角色更新 API。  
  上游：https://github.com/SillyTavern/SillyTavern/commit/ef25a0365014fe7c298e34b207907f390647d0d8
- 為 `isValidImageUrl` 加入針對空值頭像的防護。  
  上游：https://github.com/SillyTavern/SillyTavern/commit/3efe809d274f71c8b34e58b97255ea1d6a319f57
- 修正帶前綴 ID 時 NanoGPT Claude 快取偵測。  
  上游：https://github.com/SillyTavern/SillyTavern/commit/4672647293b616ba99a87bfe3dbeeb76d5f3ad7d
- 依應用程式語系設定 HTML `lang` 屬性。  
  上游：https://github.com/SillyTavern/SillyTavern/commit/50e566ee0dde408065d2b05a1c0c0eedb019052e
- 同步 OpenRouter 提供者清單。  
  上游：https://github.com/SillyTavern/SillyTavern/commit/300912237d0e53ae3725685b79eccc7b22765bf2
- 為 `clearChat` 加入 `clearData` 選項。  
  上游：https://github.com/SillyTavern/SillyTavern/commit/b64c279473be4b17be16b52caf3ce9dbf65b8eeb
- 改進搜尋解析並恢復跨訊息文字搜尋。  
  上游：https://github.com/SillyTavern/SillyTavern/commit/3f8acaad4e2ac6251e9b714726eed180c2de7fb7  
  上游：https://github.com/SillyTavern/SillyTavern/commit/5c62cf4a6ef7d3b73d9ac746c2b08e1ab026e8a9
- 改進歡迎畫面捲動行為。  
  上游：https://github.com/SillyTavern/SillyTavern/commit/e5c14af76d4d4d99638414f7a09ad71587549610
- 改進巨集解析時的樓層切換同步防護。  
  上游：https://github.com/SillyTavern/SillyTavern/commit/bee4d9a8183f4aecf326b8d6e2b1d9cfdca96dd3
- 為向量儲存加入 NanoGPT 嵌入支援。  
  上游：https://github.com/SillyTavern/SillyTavern/commit/5832cb8b07f8e7c62880b77be49b765dccb6fe49
- 改進 ComfyUI 重新命名體驗與樣式儲存預設行為。  
  上游：https://github.com/SillyTavern/SillyTavern/commit/23ba3e5bb2e7aad59d0912b2b026a14052936f1b  
  上游：https://github.com/SillyTavern/SillyTavern/commit/8e911af031d2ac609b9f6f1acee72810aa5521e4
- 新增 Claude Opus 4.6 選項。  
  上游：https://github.com/SillyTavern/SillyTavern/commit/39c8eb343c279b8e1293caff7c357caa3ba93b07
- 為空查詢加入 null 比對器最佳化。  
  上游：https://github.com/SillyTavern/SillyTavern/commit/ad88acc9805a14bf67987f9018b9dd83ff906c27
- 新增背景中繼資料填充、排序與縮圖修正。  
  上游：https://github.com/SillyTavern/SillyTavern/commit/4550afd4cce9de4129af66495d6e56f35f5381f0  
  上游：https://github.com/SillyTavern/SillyTavern/commit/788ed3d32cf2f2698ea84f189f70f8df3ba359ed  
  上游：https://github.com/SillyTavern/SillyTavern/commit/1e49f3d4f84cf855cf7406ff3e146f27427b6ee0  
  上游：https://github.com/SillyTavern/SillyTavern/commit/266f3ade0effd08a45448f93fda0f54e1fca11aa
- 提升 `printMessages` 與 `getGroupPastChats` 效能；以 fetch 取代 jQuery AJAX。  
  上游：https://github.com/SillyTavern/SillyTavern/commit/2d1a96f91d675c618e7fc9832cda3bea5c2ac8d4  
  上游：https://github.com/SillyTavern/SillyTavern/commit/68d4da1c83d74a53f77a28ca0e0aae5c26aa9d7b  
  上游：https://github.com/SillyTavern/SillyTavern/commit/8a32b72dfea21a678864c561cd74ae3c4caab82e

### Macros 2.0 上游參考集
- https://github.com/SillyTavern/SillyTavern/commit/e9bedadc0
- https://github.com/SillyTavern/SillyTavern/commit/0dcd9906b
- https://github.com/SillyTavern/SillyTavern/commit/dbc4fe611
- https://github.com/SillyTavern/SillyTavern/commit/81414724b
- https://github.com/SillyTavern/SillyTavern/commit/cd0627bfe
- https://github.com/SillyTavern/SillyTavern/commit/b453fdc5d
- https://github.com/SillyTavern/SillyTavern/commit/e40b31b06
- https://github.com/SillyTavern/SillyTavern/commit/7331dba05
- https://github.com/SillyTavern/SillyTavern/commit/3047045d3
- https://github.com/SillyTavern/SillyTavern/commit/5c2a02a12
- https://github.com/SillyTavern/SillyTavern/commit/f8c373f55
- https://github.com/SillyTavern/SillyTavern/commit/0b529290a
- https://github.com/SillyTavern/SillyTavern/commit/42155eceb
- https://github.com/SillyTavern/SillyTavern/commit/ca60ba148
- https://github.com/SillyTavern/SillyTavern/commit/9ff9d5967
- https://github.com/SillyTavern/SillyTavern/commit/9f4449973
- https://github.com/SillyTavern/SillyTavern/commit/953d9f34c
- https://github.com/SillyTavern/SillyTavern/commit/06b77ec94
- https://github.com/SillyTavern/SillyTavern/commit/26d495f45
- https://github.com/SillyTavern/SillyTavern/commit/6f5032f20
- https://github.com/SillyTavern/SillyTavern/commit/bee4d9a81

**完整更新日誌**：https://github.com/funnycups/Luker/compare/v1.11.0...v1.12.0

## v1.11.0 (2026-02-23)
- 為有衝突的外掛加入強制更新
- 刪除角色時，僅在世界書存在時才提示刪除世界書
- 修正角色更新期間世界書分析的問題

**完整更新日誌**：https://github.com/funnycups/Luker/compare/v1.10.0...v1.11.0

## v1.10.0 (2026-02-22)
- 新增行動裝置模型中繼資料提示
- 明確記憶圖與編排器的描述
- 修正記憶圖與編排器最新一次執行的顯示邏輯
- 修正 App 內擴充功能升級的問題

**完整更新日誌**：https://github.com/funnycups/Luker/compare/v1.9.2...v1.10.0

## v1.9.2 (2026-02-22)
- 修正全域擴充功能的備份與還原。

**完整更新日誌**：https://github.com/funnycups/Luker/compare/v1.9.1...v1.9.2

## v1.9.1 (2026-02-22)
- 避免暫時注入提示詞遺失

**完整更新日誌**：https://github.com/funnycups/Luker/compare/v1.9.0...v1.9.1

## v1.9.0 (2026-02-22)
- 修正部分外掛中的世界書啟用
- 外掛現在可重用 `/inject` 命令中的提示詞
- 記憶圖現在可隱藏早期訊息
- 最佳化 SillyTavern 資料遷移引導
- 管理員現在可在還原與備份中備份全域擴充功能
- 修正管理面板缺失的問題
- 為 Claude 與 Vertex 端點新增自動模型擷取
- 為 Chat Completions 新增自訂模型

**完整更新日誌**：https://github.com/funnycups/Luker/compare/v1.8.2...v1.9.0

## v1.8.2 (2026-02-22)
- 強化記憶圖提示詞

**完整更新日誌**：https://github.com/funnycups/Luker/compare/v1.8.1...v1.8.2

## v1.8.1 (2026-02-22)
- 修正記憶圖中的函式定義

**完整更新日誌**：https://github.com/funnycups/Luker/compare/v1.8.0...v1.8.1

## v1.8.0 (2026-02-21)
- 允許 App 上的前端腳本呼叫全螢幕 API

**完整更新日誌**：https://github.com/funnycups/Luker/compare/v1.7.0...v1.8.0

## v1.7.0 (2026-02-21)
- 修正記憶圖中的錯誤
- 在記憶圖中加入角色範圍進階設定
- 新增與生成相關的通知
- 修正與完整性變更相關的補丁錯誤
- 在感知預設的請求中保留世界書注入
- 最佳化正規表示式重新載入策略
- 新增原生沉浸式全螢幕

**完整更新日誌**：https://github.com/funnycups/Luker/compare/v1.6.1...v1.7.0

## v1.6.1 (2026-02-20)
- 修正記憶圖中的錯誤

**完整更新日誌**：https://github.com/funnycups/Luker/compare/v1.6.0...v1.6.1

## v1.6.0 (2026-02-20)
- App 啟動時自動偵測可用連接埠

**完整更新日誌**：https://github.com/funnycups/Luker/compare/v1.5.1...v1.6.0

## v1.5.1 (2026-02-20)
- 避免重新生成時快照遺失。
- 強化擴充功能安裝的穩健性。

**完整更新日誌**：https://github.com/funnycups/Luker/compare/v1.5.0...v1.5.1

## v1.5.0 (2026-02-20)
- 修正聊天意外重新載入的問題
- 為 App 新增執行時期通知

**完整更新日誌**：https://github.com/funnycups/Luker/compare/v1.4.0...v1.5.0

## v1.4.0 (2026-02-20)
- 強化 SillyTavern 資料遷移指南。
- 避免 App 上訊息消失。
- 對相同訊息與重新生成重用編排器與記憶圖擴充功能的結果。

**完整更新日誌**：https://github.com/funnycups/Luker/compare/v1.3.1...v1.4.0

## v1.3.1 (2026-02-20)
- 強化正規表示式擴充功能的邊界條件處理。

**完整更新日誌**：https://github.com/funnycups/Luker/compare/v1.3.0...v1.3.1

## v1.3.0 (2026-02-20)
- 修正行動裝置上的錯誤。
- 管理員現在可在管理面板編輯 config.yaml。
- 防止行動應用程式升級時擴充功能遺失。

**完整更新日誌**：https://github.com/funnycups/Luker/compare/v1.2.0...v1.3.0

## v1.2.0 (2026-02-20)
- 在提醒彈出視窗中允許後，Luker 現在會使用 git 自動升級或下載 apk。
- 現在可在日誌設定中查看前端日誌。

**完整更新日誌**：https://github.com/funnycups/Luker/compare/v1.1.0...v1.2.0

## v1.1.0 (2026-02-20)
- 現在可在備份與還原設定中直接從 ST 資料 zip 遷移資料。
- 後端日誌現已可供管理員查看。

**完整更新日誌**：https://github.com/funnycups/Luker/compare/v1.0.0...v1.1.0

## v1.0.0 (2026-02-20)
### 核心最佳化
- 主要儲存鏈路改為 patch-first（RFC 6902）模型，大幅減少重複整檔重寫，明顯節省流量並提升可靠性。
- 增強了增量儲存的衝突處理與整體執行穩定性。
- 聊天補全預設與 API 預設解耦，模型路由更靈活。
- 新增角色範圍綁定能力，可綁定使用者人設與預設，且不污染全域配置。
- 角色範圍的人設與預設綁定會隨角色卡一起匯入匯出，便於創作者分發。
- 新增 GitHub / Discord OAuth 登入支援。
- 新增使用者儲存限額控制與預設配額分配。

### 世界書
- 新增世界書啟用鏈路追蹤，可查看某條目為何被啟用、由誰觸發。
- 世界書儲存流程升級為 patch-first 增量更新。

### 內建功能
- 多智能體編排器：支援序列/平行階段編排，支援 AI 自動生成編排方案，並提供可讀的差異審核流程。
- 多智能體編排配置支援角色卡範圍，並支援匯入匯出。
- 記憶圖外掛：最佳化圖結構記憶擷取與關聯，支援迭代召回、最近輪次局部重建，並改進圖展示效果。
- 記憶圖支援角色卡範圍的 Schema 設定，並支援目前聊天記憶圖匯入匯出。
- 角色卡編輯助手：支援 AI 編輯角色欄位與世界書內容，提供差異審閱、核准與歷史回滾。
- 在「角色卡替換/更新」後，會彈出引導面板，詢問你要保留目前世界書、直接替換為新世界書，還是使用 AI 比較新舊世界書後更新。
- diff 體驗增強，支援逐行差異放大查看。

### 安卓 App
- 新增 Luker 安卓 App 執行支援。
- 提升 WebView 檔案/媒體互動能力（SAF 選取、blob/data 下載處理、權限橋接）。
- 支援在安卓 App 內安裝擴充功能。

### 備份與還原
- 新增內建備份/還原功能，支援按資料類別選取。

**完整更新日誌**：https://github.com/funnycups/Luker/commits/v1.0.0
