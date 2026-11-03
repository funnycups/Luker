# 多 Agent 編排

精心鋪墊的場景仍可能被一則回覆破壞：跳過剛建立的節奏、忘記先前確立的世界規則、出戲總結，或倉促收尾本應留到後面的伏筆。一次生成要同時滿足人物一致性、上下文、世界規則、情節推進與文筆，很難每項都到位。

編排器在主模型動筆之前，先執行一組 Agent 完成準備工作：提取近期聊天中的關鍵狀態、確定目前生效的世界規則、規劃這一回合的推進方向並審校。產物取決於執行模式：多數模式輸出一份精簡的編排結果，注入主模型的提示詞；Director 模式由編排器內的主代理直接寫出回覆正文。

**編排器自帶可用的預設 Spec 工作流，啟用即可執行。** 需要其他形態時，各執行模式均有獨立編輯器。

::: info 它什麼時候觸發？
編排器在一般回覆、繼續、重新生成、滑動切換和扮演時執行，在世界書解析之後、主模型回覆之前。執行面板只儲存在記憶體中，切換聊天時清空。
:::

## 快速開始（使用預設編排）

預設 Spec 已設定完成，啟用後即可執行。

### Step 0 —— 你需要先有什麼 {#step-0}

- 你的主對話已經能正常用 Chat Completion API 出回覆
- 當前對話至少有數輪聊天記錄

### Step 1 —— 啟用編排器 {#step-1}

打開頂欄的擴展抽屜，找到 **多 Agent 編排** 那一節。把 **啟用** 開關打開。

![編排器啟用開關](/images/orchestrator/orch-toggle.png)

### Step 2 —— 給各 Agent 選模型 {#step-2}

在同一面板中找到 **LLM 節點 API 預設** 與 **AI 生成 API 預設**，分別指定各 Agent 使用的 API 連線與聊天補全預設。預設下拉框旁的問號按鈕說明該槽位需要什麼類型的預設，並可以一鍵匯入內建預設：非 Director 模式使用 `agent-non-director`，Director 使用 `agent-director`。

::: tip 成本
編排器的每個節點都會產生模型呼叫。主對話使用高價模型時，可以為編排器選擇更小的模型；需要更高品質時，也可以為每個節點單獨指定連線與預設。
:::

### Step 3 —— 直接發一條訊息 {#step-3}

在主對話中發送一則訊息，其他設定保持預設。主模型回覆之前，預設 Spec 工作流會在後台執行。

### Step 4 —— 查看執行過程 {#step-4}

執行開始時，**執行面板**會從聊天區右側滑入，窄屏上則從底部升起。面板即時更新：輪次以可折疊卡片展示，展開後可查看模型的思考過程、呼叫的工具和工具回傳內容。

![編排器開始運行時的面板](/images/run-panel/01-panel-initial.png)

模型流式輸出時，面板在原地即時更新：

![流式過程：思考、文字與工具分節即時填充](/images/run-panel/02-panel-streaming.png)

展開任意工具呼叫，能看到它的傳入參數和回傳：

![工具呼叫展開——參數與結果](/images/run-panel/03-panel-tool-expanded.png)

窄屏下面板變成底部抽屜，可以上拉展開或下滑關閉：

![窄屏下的運行面板（抽屜佈局）](/images/run-panel/05-panel-drawer.png)

面板僅儲存在記憶體中。切換聊天或重新整理頁面會清空；聊天記錄裡只保留最終回覆。還可以執行以下操作：

- 運行中**停止**
- **複製**任意分節的原始內容
- 把整次執行**匯出**為 JSON，便於分享或反饋問題
- 一鍵**全部收起**所有卡片

回覆不理想時，可在面板中查看每一步的輸出。

至此編排器已啟用，接下來選擇執行模式：

- 需要固定、可重複的流程 → [Spec 模式](/zh-TW/features/orchestrator/spec)
- 只需要一次呼叫注入一段引導 → [單 Agent 模式](/zh-TW/features/orchestrator/single)
- 執行哪些 Agent 需要依中間結果決定 → [Agenda 模式](/zh-TW/features/orchestrator/agenda)
- 希望單一 Agent 反覆呼叫工具，自行判斷何時結束 → [Loop 模式](/zh-TW/features/orchestrator/loop)
- 希望由編排器內的團隊直接寫出正文 → [Director 模式](/zh-TW/features/orchestrator/director)

::: tip 定製入口
各模式的定製均從 **[AI 迭代工作台](/zh-TW/features/orchestrator/iteration-studio)** 開始：用一句話描述目標，AI 傳回方案，逐條審批。五種模式共用同一個工作台。
:::

## 選你的執行模式

| 模式 | 是什麼 | 何時用 | 技能範圍 | 詳細文件 |
|---|---|---|---|---|
| **Spec**（預設） | 固定的階段與節點流程 | 預設模式。需要可預期的流程 | 每個節點可個別選擇可見技能 | [Spec 模式](/zh-TW/features/orchestrator/spec) |
| **單 Agent** | 只有一個節點的 Spec | 成本低、速度快。不需要多 Agent 協作 | 在該節點上選擇技能 | [單 Agent 模式](/zh-TW/features/orchestrator/single) |
| **Agenda** | 規劃 Agent 依情況動態派遣其他 Agent | 流程無法預先固定 | 規劃 Agent 與每個被派遣的 Agent 分別選擇 | [Agenda 模式](/zh-TW/features/orchestrator/agenda) |
| **Loop** | 單 Agent 在會話中反覆呼叫工具，自行判斷何時結束 | 探索性研究、動態決策 | 在 Loop Agent 上選擇 | [Loop 模式](/zh-TW/features/orchestrator/loop) |
| **Director** | 主代理帶子代理團隊探索上下文並創作正文 | 高品質長篇角色扮演 | 主代理與子代理分別選擇；出廠自帶預設技能 | [Director 模式](/zh-TW/features/orchestrator/director) |

切換模式：擴充功能抽屜裡的 **執行模式** 下拉。Spec 與 Agenda 可以在編輯器中互相轉換；Loop 結構差異較大，沒有對應的互轉入口。

::: info 技能範圍
所有模式都可以限制每個 Agent 能看到哪些技能。Director 在出廠設定中已繫結預設技能，其他模式的 Agent 預設可以看到全部已安裝技能。技能的作用方式見 [編排器整合](/zh-TW/features/skills/orchestrator-integration)。
:::

## 通用設定

無論選哪種模式，以下設定均共享。

### 結果注入

編排器的最終輸出會注入主模型的提示詞。設定：

| 設定 | 預設 | 說明 |
|---|---|---|
| 注入位置 | `atDepth` | 編排結果在提示詞中的位置 |
| 注入深度 | `0` | 在該位置的深度 |
| 注入角色 | `SYSTEM` | `SYSTEM` / `USER` / `ASSISTANT` 之一 |
| 自定義指令前綴 | 預設值為一句話 | 新增在編排結果之前 |

編排結果綁定到觸發編排的使用者訊息樓層。同一樓層切換 swipe 時複用現有結果；設定變更後重新套用最新結果。

### 角色卡綁定

編排設定可以綁到角色卡。綁定後：

- 設定隨卡匯出，匯入者自動獲得推薦工作流
- 卡作者可以為自己的角色定製工作流
- 切換到這張卡自動套用其工作流
- 卡可以指定自己的執行模式（Spec / Agenda / Loop / Director 均支援）
- 在卡的下拉中選擇預設後，目前聊天立即切換；卡上的預設庫保持不變
- 「清除這張卡上的預設」恢復到全域設定
- 可以在卡綁定設定之上疊加個人調整

### 匯入匯出

Spec 與 Agenda 設定可以匯出為 JSON，再匯入全域或某張角色卡。匯入檔案的模式必須與目前執行模式一致。Loop 設定透過 [AI 迭代工作台](/zh-TW/features/orchestrator/iteration-studio) 重複使用，不提供獨立的檔案匯入匯出。

### 通用設定參考

共用的設定包括執行模式、編排結果的注入位置與深度、注入角色、自訂指令前綴、請求速率限制、工具呼叫重試、預設 API 連線與聊天補全預設、節點是否能看到世界書，以及執行面板的訊息摺疊閾值。

模式專屬的參數在各自的子頁面說明。

## 相關頁面

- [AI 迭代工作台](/zh-TW/features/orchestrator/iteration-studio) —— 編排器核心定製工具，所有模式共用
- [Spec 模式](/zh-TW/features/orchestrator/spec) —— 固定流程工作流
- [單 Agent 模式](/zh-TW/features/orchestrator/single) —— 只執行一個節點的精簡流程
- [Agenda 模式](/zh-TW/features/orchestrator/agenda) —— 規劃 Agent 動態派遣
- [Loop 模式](/zh-TW/features/orchestrator/loop) —— 單 Agent 工具循環
- [Director 模式](/zh-TW/features/orchestrator/director) —— 多 Agent 接管，出廠自帶技能
- [技能概覽](/zh-TW/features/skills/) —— 所有模式共用的知識包
- [便箋](/zh-TW/features/orchestrator/notes) —— 目前聊天的劇情線索追蹤
- [角色卡編輯助手](/zh-TW/features/card-editor/) —— 與迭代工作台共用差異審批
- [卡內綁定預設與人設](/zh-TW/improvements/card-bound-presets) —— 編排設定如何隨角色卡分發
