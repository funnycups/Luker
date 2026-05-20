# 普通彈窗模式

對於不包含 CardApp 的常規角色卡，「開啟編輯器」會以彈窗形式開啟 AI 對話面板。你可以在彈窗裡用自然語言描述想要的修改，AI 透過工具呼叫自動完成，每一步都給你 diff 審批權。

::: tip 含 CardApp 的角色卡走 Studio
對於在 `data.extensions.card_app` 中內嵌了 CardApp 的角色卡，「開啟編輯器」會自動進入功能更完整的 [CardApp Studio](/zh-TW/features/card-editor/studio)，而非本頁描述的彈窗。
:::

## 彈窗佈局

彈窗頂部展示當前角色名和繫結的主世界書；中間是與 AI 的對話區；底部是輸入框、傳送 / 終止按鈕，以及可摺疊的「對話歷史」面板。

![編輯彈窗的初始空白狀態](/images/card-editor-popup/cea-popup-overview.png)

## 支援的操作

彈窗中的 AI 可以透過工具呼叫執行以下操作：

- **修改角色卡欄位** — 名稱、描述、性格、場景、首條訊息、示例對話、系統提示詞、越權提示詞、創作者備註等
- **管理世界書條目** — 建立、更新、刪除世界書條目
- **查詢世界書** — 按關鍵字搜尋條目、按啟用條件查詢、取得條目詳情
- **設定主世界書** — 更換角色卡繫結的主世界書
- **模擬 Prompt** — 預覽當前設定下實際傳送給模型的 prompt 結構

## 差異審批

AI 每次執行修改後，系統會在 pending 區按欄位展示修改前後的差異，等待你審批：

![待審批 diff（按欄位分行）](/images/card-editor-popup/cea-popup-diff-approval.png)

每個欄位的差異右上角有放大圖示，點開後是逐行的 side-by-side 檢視，方便檢查長文字（如世界書 content）的具體改動：

![放大檢視：逐行 side-by-side diff](/images/card-editor-popup/cea-popup-line-diff-zoom.png)

整輪變更下方提供「批准本批次」「拒絕本批次」按鈕，你也可以對單個 diff 單獨操作：

![批准 / 拒絕按鈕](/images/card-editor-popup/cea-popup-diff-actions.png)

只有你明確批准的修改才會生效，拒絕的修改會被丟棄。已批准的欄位被記入修改歷史，可以隨時回滾。

## 會話管理

彈窗底部「對話歷史」展開後是當前角色下的所有編輯會話：

![對話歷史：多個會話並列](/images/card-editor-popup/cea-popup-sessions.png)

- 建立、切換、刪除會話；上一個會話被 AI 自動取了首句作為標題
- 每個角色最多保留 **24** 個會話，超出後最早的會話被自動清理
- 會話內容持久化保存，關閉彈窗後重新開啟不會遺失，待審批的 diff 也會跟回來

## 世界書同步

當你透過替換或更新操作匯入新的角色卡時，如果新舊角色卡繫結了不同的世界書，編輯助手會彈出世界書同步彈窗，提供三種處理方式：

![世界書同步彈窗：三種處理方式](/images/card-editor-popup/cea-lorebook-sync.png)

- **模型分析後更新** — AI 分析新舊世界書的差異，智慧合併
- **直接替換** — 用新世界書完全替換舊世界書
- **不替換** — 保留原有世界書不變

是否啟用同步彈窗由擴充功能面板上的「替換 / 更新角色卡後啟用世界書同步彈窗」開關控制。

## 相關頁面

- [角色卡編輯助手概覽](/zh-TW/features/card-editor/) — 公共能力與入口
- [CardApp Studio](/zh-TW/features/card-editor/studio) — 含 CardApp 角色卡的完整開發環境
- [搜尋外掛](/zh-TW/features/search-tools) — 彈窗中的網路搜尋能力
- [狀態系統](/zh-TW/features/state-system) — 角色狀態和聊天狀態
