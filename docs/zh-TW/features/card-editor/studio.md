# CardApp Studio

CardApp Studio 是角色卡編輯助手的完整開發環境,專為內嵌了 [CardApp](/zh-TW/features/cardapp) 的角色卡設計。它提供基於 CodeMirror 6 的程式碼編輯器、即時預覽、AI 輔助開發,以及 Git 版本控制——是開發和除錯 CardApp 的推薦工作台。

::: tip 第一次用 Studio?
看[從零寫一個 CardApp](/zh-TW/features/card-editor/walkthrough),用一個範例角色卡完整跑通工作流,含提示詞實踐小抄。本頁是 Studio 的能力清單,walkthrough 是從零跑通的實戰路徑。
:::

## 開啟方式

兩條路徑都會進入 Studio:

1. **擴充功能面板 → 角色卡編輯助手 → 「&lt;/&gt; CardApp Studio」按鈕**
2. 當前角色含 CardApp 時,**「開啟編輯器」也會自動進入 Studio**(而非[普通彈窗](/zh-TW/features/card-editor/popup))

## 介面佈局

Studio 採用三欄佈局,覆蓋在 Luker 主介面之上:

![Studio 三欄總覽:左側 AI 對話 / 中間即時預覽 / 右側程式碼編輯器](/images/cardapp-studio/studio-overview.png)

- **左側面板** — AI 對話區域,用自然語言描述需求,AI 透過工具呼叫編輯檔案
- **中間區域** — 即時聊天介面 / CardApp 預覽,方便邊改邊驗證
- **右側面板** — 基於 CodeMirror 6 的程式碼編輯器 + 檔案樹管理

### 左側:AI 對話與會話

左側是 Studio 的 AI 助手對話區。所有對 CardApp 的修改都從這裡發起:

![Studio AI 助手對話區](/images/cardapp-studio/studio-ai-chat.png)

頂部的「會話」按鈕展開後是當前角色下的所有 Studio 會話,可以建立 / 切換 / 刪除:

![Studio 會話面板](/images/cardapp-studio/studio-sessions.png)

### 中間:CardApp 即時預覽

中間區域就是 SillyTavern 自身的聊天介面,CardApp 在其中即時渲染。AI 改完檔案並批准後,預覽自動重新載入,立刻能看到效果:

![中間面板:abyss-walker CardApp 即時執行](/images/cardapp-studio/studio-preview.png)

上圖是 demo 角色「深淵行者」的 CardApp 在執行——狀態列(HP/MP/金幣)、動作按鈕區(探索 / 搜尋 / 戰鬥 / 休息 / 下層 / 背包 / 撤回 / 重新生成 / 存檔)、自訂行動輸入框,全部由 CardApp 的 HTML/JS 渲染。

### 右側:程式碼編輯器、檔案樹、Git 歷史

右側合併了三塊:

![右側面板:CodeMirror 編輯器、檔案列表、Git 歷史](/images/cardapp-studio/studio-code-editor.png)

- 頂部 **程式碼編輯器**(CodeMirror 6)—— 自動按檔案類型語法高亮(HTML / JS / CSS / JSON 等);儲存 / 重新載入按鈕在右上
- 中部 **檔案列表** —— 列出 CardApp 所有檔案並顯示尺寸;點選切換編輯目標
- 底部 **修改歷史** —— Git commit 列表,每條顯示短 commit hash、commit message、時間和回滾按鈕

## 支援的操作

Studio 中的 AI 擁有比普通彈窗更豐富的工具集,分七大類:

**CardApp 檔案操作:**
- 列出所有檔案
- 讀取檔案內容
- 建立或覆寫檔案
- 補丁式修改檔案(查找替換)
- 刪除檔案
- 重新命名 / 移動檔案
- 切換 CardApp 啟用開關(`extensions.card_app.enabled`)

**角色卡欄位操作:**
- 讀取所有可編輯欄位
- 更新一個或多個欄位

**世界書操作:**
- 列出可見世界書並標註作用域(`character` / `chat` / `global`)
- 取得/建立/更新/刪除/全量替換某本書內的條目
- 列出、替換、建立+繫結 chat-bound 世界書(`chat_metadata.world_info`)

**正則表示式腳本操作** — 列出/建立/更新/刪除卡級(`character.data.extensions.regex_scripts`)或全域(`extension_settings.regex`)正則腳本。Studio AI 是這套流程裡唯一會建立卡級正則腳本的入口。

**角色級編排器(orchestrator)覆蓋** — 讀取、替換、清空當前角色卡上的編排器覆蓋。永遠只作用於當前角色,不會動全域編排器設定。

**角色級記憶圖覆蓋** — 讀取生效的記憶圖設定(schema + 進階設定 + 作用域標籤)、替換節點類型 schema、或對進階設定打補丁。永遠只作用於當前角色。

**發現 / 文件查詢** — `slashcmd_list` + `slashcmd_help` 查斜線指令,`luker_context_list_keys` + `luker_context_describe` 查執行時 API,`list_luker_docs` + `read_luker_doc` 直接讀 Markdown 文件(和本站同源)。Studio AI 用這些工具在生成程式碼前核對名稱和簽名,而不是憑記憶猜。

::: tip CardApp 創作約定
按 Luker 的 CardApp 創作約定,所有 AI 可見內容都應放在透過 `extensions.world` 繫結的世界書裡,而非角色卡的 `system_prompt` / `post_history_instructions` 欄位。Studio 預設遵守這一約定。詳見[角色卡開發者指南](/zh-TW/development/card-developers)。
:::

## 程式碼編輯器細節

右側 CodeMirror 6 編輯器的能力:

- **語法高亮** — 自動按檔案副檔名識別(HTML / JS / CSS / JSON 等)
- **多檔案切換** — 頂部 Tab 形式管理已開啟的檔案
- **新建檔案** / **儲存** / **重新載入**
- **AI 與你的編輯共存** — 你直接修改的內容也會被納入 Git 版本管理

## 檔案變更審批

AI 對檔案的每次修改都需要審批,與普通彈窗相同的 diff 體驗:完整檔案 diff、逐行 side-by-side 對比、單項 / 批次批准。批准後變更才落到磁碟。

## 會話管理

- 多個開發會話,可建立 / 切換 / 刪除
- 每個角色最多保留 **20** 個會話(普通彈窗是 24 個)
- 會話內容持久化保存在角色狀態中,關閉 Studio 後重新開啟不遺失

## 版本歷史(Git)

Studio 透過 Git 自動記錄檔案的版本歷史:

- 每次審批通過的變更會作為一個 commit
- 支援檢視歷史版本的 diff
- 支援回滾到任意歷史版本
- 與角色卡資料一起匯出,分享後接收方仍可看到完整開發歷程

::: info 與 SillyTavern 資料相容
Studio 的 Git 倉庫儲存在 Luker 的擴充功能資料區,不會汙染角色卡 V2 標準欄位。匯回 SillyTavern 時僅遺失版本歷史,CardApp 本體仍可正常執行。
:::

## 與搜尋外掛整合

Studio 已整合 [搜尋外掛](/zh-TW/features/search-tools) 的能力,AI 可在開發過程中網路搜尋資料(如 API 文件、設計參考),將結果直接用在編碼上下文中。無需額外配置——只要搜尋外掛可用即可。

## 相關頁面

- [角色卡編輯助手概覽](/zh-TW/features/card-editor/) — 公共能力與入口
- [普通彈窗模式](/zh-TW/features/card-editor/popup) — 不含 CardApp 的角色卡的 AI 編輯流程
- [CardApp](/zh-TW/features/cardapp) — 角色卡應用化概念
- [角色卡開發者指南](/zh-TW/development/card-developers) — CardApp API 參考與創作約定
