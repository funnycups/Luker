# CardApp Studio

CardApp Studio 是角色卡編輯助手的完整開發環境，專為內嵌了 [CardApp](/zh-TW/features/cardapp) 的角色卡設計。它提供程式碼編輯器、即時預覽、AI 輔助開發和版本歷史，是開發和除錯 CardApp 的推薦工作台。

::: tip 第一次用 Studio?
請先閱讀[從零寫一個 CardApp](/zh-TW/features/card-editor/walkthrough/)。該教程用一個示例角色卡完整執行工作流，並包含提示詞實踐要點。本頁說明 Studio 的能力，教程提供從零執行的實戰路徑。
:::

## 開啟方式

兩條路徑均會進入 Studio:

1. **擴充功能面板 → 角色卡編輯助手 → 「&lt;/&gt; CardApp Studio」按鈕**
2. 當前角色含 CardApp 時，**「開啟編輯器」會直接進入 Studio**；不含 CardApp 的角色卡進入[普通彈窗](/zh-TW/features/card-editor/popup)

## 介面佈局

Studio 採用三欄佈局，覆蓋在 Luker 主介面之上：

![Studio 三欄總覽：左側 AI 對話 / 中間即時預覽 / 右側程式碼編輯器](/images/cardapp-studio/studio-overview.png)

- **左側面板** —— AI 對話區域，用自然語言描述需求，由 AI 修改檔案
- **中間區域** —— 即時聊天介面與 CardApp 預覽，修改後可直接驗證效果
- **右側面板** —— 程式碼編輯器與檔案列表

### 左側：AI 對話與會話

左側是 Studio 的 AI 助手對話區。所有對 CardApp 的修改均從這裡發起：

![Studio AI 助手對話區](/images/cardapp-studio/studio-ai-chat.png)

頂部的「會話」按鈕展開後是當前角色下的所有 Studio 會話，可以建立 / 切換 / 刪除：

![Studio 會話面板](/images/cardapp-studio/studio-sessions.png)

### 中間：CardApp 即時預覽

中間區域就是 SillyTavern 自身的聊天介面，CardApp 在其中即時渲染。AI 改完檔案並批准後，預覽自動重新載入，立刻能看到效果：

![中間面板：abyss-walker CardApp 即時執行](/images/cardapp-studio/studio-preview.png)

上圖是 demo 角色「深淵行者」的 CardApp 在執行——狀態列（HP/MP/金幣）、動作按鈕區（探索 / 搜尋 / 戰鬥 / 休息 / 下層 / 背包 / 撤回 / 重新生成 / 存檔）、自訂行動輸入框，全部由 CardApp 的 HTML/JS 渲染。

### 右側：程式碼編輯器、檔案樹、版本歷史

右側合併了三塊：

![右側面板：程式碼編輯器、檔案列表、版本歷史](/images/cardapp-studio/studio-code-editor.png)

- 頂部 **程式碼編輯器** —— 自動按檔案類型語法高亮（HTML / JS / CSS / JSON 等）；儲存和重新載入按鈕在右上
- 中部 **檔案列表** —— 列出 CardApp 所有檔案並顯示尺寸；點選切換編輯目標
- 底部 **修改歷史** —— 版本記錄列表，每條顯示版本標識、說明、時間和回滾按鈕

## 支援的操作

Studio 中的 AI 具備比普通彈窗更完整的能力，包括以下幾類：

**CardApp 檔案操作：**
- 列出所有檔案
- 讀取檔案內容
- 建立或覆寫檔案
- 補丁式修改檔案（查找替換）
- 刪除檔案
- 重新命名 / 移動檔案
- 啟用或停用 CardApp

**角色卡欄位操作：**
- 讀取所有可編輯欄位
- 更新一個或多個欄位

**世界書操作：**
- 列出可見世界書，並標註其作用域：角色卡、聊天或全域
- 取得/建立/更新/刪除/全量替換某本書內的條目
- 列出、替換、建立並繫結聊天專用世界書

**正則表示式腳本操作** —— 列出、建立、更新、刪除角色卡級或全域正則腳本。

**角色級編排器覆蓋** —— 讀取、替換、清空當前角色卡上的編排器覆蓋，範圍限於當前角色卡。

**角色級記憶圖覆蓋** —— 讀取當前生效的記憶圖設定，替換節點類型，或調整進階設定，範圍限於當前角色卡。

**查詢輔助** —— Studio 可以查詢斜線指令、執行時介面和本站文件，在生成程式碼前核對名稱與用法。

::: tip CardApp 創作約定
按 Luker 的 CardApp 創作約定，所有 AI 可見內容放在繫結的世界書裡。Studio 預設遵守這一約定。詳見[角色卡開發者指南](/zh-TW/development/card-developers)。
:::

## 程式碼編輯器細節

右側程式碼編輯器的能力：

- **語法高亮** —— 自動按檔案副檔名識別（HTML / JS / CSS / JSON 等）
- **多檔案切換** —— 頂部 Tab 形式管理已開啟的檔案
- **新建檔案** / **儲存** / **重新載入**
- **手動修改同樣記錄** —— 你直接編輯的內容也進入版本歷史

## 檔案變更審批

AI 對檔案的每次修改均需要審批。與普通彈窗一樣，介面會顯示完整的改動內容和逐行對照，可以單項批准或批次批准。批准後寫入檔案。

## 會話管理

- 多個開發會話，可建立 / 切換 / 刪除
- 每個角色最多保留 **20** 個會話（普通彈窗是 24 個）
- 會話內容持久化保存在角色狀態中，關閉 Studio 後重新開啟不遺失

## 版本歷史 {#version-history-git}

Studio 自動記錄檔案的版本歷史：

- 每次審批通過的變更會生成一條版本記錄
- 支援檢視歷史版本的改動內容
- 支援回滾到任意歷史版本
- 與角色卡資料一起匯出，分享後接收方可查看完整開發歷程

::: info 資料位置
版本記錄保存在 Luker 的擴充功能資料中，不寫入角色卡的標準欄位。CardApp 依賴 Luker 的執行環境，匯出到 SillyTavern 後無法執行。
:::

## 與搜尋外掛整合

Studio 已整合[搜尋外掛](/zh-TW/features/search-tools)的能力，AI 可在開發過程中查詢網路資料，並把結果用於生成程式碼。搜尋外掛可用時即可使用。

## 相關頁面

- [角色卡編輯助手概覽](/zh-TW/features/card-editor/) —— 公共能力與入口
- [普通彈窗模式](/zh-TW/features/card-editor/popup) —— 不含 CardApp 的角色卡的 AI 編輯流程
- [CardApp](/zh-TW/features/cardapp) —— 角色卡應用化概念
- [角色卡開發者指南](/zh-TW/development/card-developers) —— CardApp API 參考與創作約定
