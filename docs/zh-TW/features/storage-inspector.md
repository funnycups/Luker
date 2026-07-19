# 儲存審查

Luker 提供兩個互補的儲存審查工具，一個針對伺服器端的使用者資料目錄，一個針對目前裝置瀏覽器本地的儲存。兩者入口都在**「使用者設定」→「帳號」**下，共用同一套視覺佈局：配額列、堆疊使用條、圖例，以及可下鑽的清單。

## 伺服器端儲存審查

**入口：**「使用者設定」→「帳號」→**「儲存審查」**

**展示什麼：** 你帳號在磁碟上的十大類內容：聊天、角色卡、世界書、圖片、附件、預設、擴充功能、向量、備份、其他。堆疊條按位元組數彙總每一類，清單可以下鑽進任意類別查看具體檔案（聊天存檔、角色卡檔案、世界書 JSON、背景圖等）。

**Admin 可以做什麼：** 管理員在「管理面板」→「儲存管理」標籤裡，可以單獨查看任一使用者帳號的儲存，或者查看跨全部使用者的彙總視圖。

**做不了什麼：** 這個審查工具**唯讀**，不提供刪除功能。需要清理請走對應的介面（在聊天面板刪聊天，在角色清單刪角色卡等）。像 `secrets.json` 這類敏感檔案只顯示大小，不允許下鑽查看內容。

![伺服器儲存總覽](/images/storage-inspector/01-self-l1.png)

![聊天下鑽](/images/storage-inspector/02-self-chats-drilldown.png)

![Admin 彙總視圖](/images/storage-inspector/05-admin-aggregate.png)

## 瀏覽器儲存審查

**入口：**「使用者設定」→「帳號」→**「瀏覽器儲存」**

**展示什麼：** 瀏覽器為每個 origin 提供的五大類儲存：`localStorage`、`sessionStorage`、`IndexedDB`（資料庫與物件儲存）、`Cache Storage`（Service Worker 快取），以及儲存配額（瀏覽器對此 origin 的用量與總量估算）。下鑽進任意類別查看具體項：單個 localStorage 鍵、單個資料庫及其物件儲存、單個快取。

**可以刪除什麼：** 可以刪除單個 `localStorage` 或 `sessionStorage` 鍵、清空單個 `IndexedDB` 物件儲存、刪除整個 `IndexedDB` 資料庫，或刪除單個 Cache Storage 快取。每次刪除前都會二次確認，且無法復原。儲存配額視圖是純資訊展示，不可刪除。

**做不了什麼：** 它不會碰伺服器上的帳號資料，只影響你目前使用的這個瀏覽器 —— 用同一帳號在其他裝置上登入時，那邊瀏覽器的儲存是獨立的。

![瀏覽器儲存總覽](/images/browser-storage-inspector/01-browser-l1.png)

![IndexedDB 下鑽](/images/browser-storage-inspector/02-indexeddb-l2.png)

![刪除確認](/images/browser-storage-inspector/03-delete-confirm.png)

## 常見問題

**儲存配額顯示「無限」是什麼意思？**
有些瀏覽器不上報此 origin 的配額，Luker 顯示為「無限」。實際上瀏覽器仍會靜默地施加它自己的限制。

**刪除某個 `localStorage` 鍵會不會破壞 Luker？**
有可能。Luker 會把目前介面語言覆蓋、未儲存的草稿、某些連線位址存進 `localStorage`。刪掉某一項之後，對應設定在下次頁面載入時會回落到預設值。確認彈窗會給出具體的 key 名，讓你自己判斷。

**為什麼 IndexedDB 與 Cache Storage 的大小列顯示 `?`？**
瀏覽器沒有提供快速查詢單庫或單快取位元組總量的 API。要精確得知就得逐條記錄、逐個回應地讀，對大規模儲存非常慢。審查器頂部展示的是瀏覽器給出的彙總估算（`navigator.storage.estimate()`）作為參考。

**兩個審查器看到的是同一份資料嗎？**
不是。伺服器端儲存審查看的是 Luker 伺服器磁碟上的檔案（同帳號下所有裝置共用）。瀏覽器儲存審查只看目前這個瀏覽器 origin 本地的儲存（每裝置獨立）。

**我刪了整個 IndexedDB 資料庫，然後某個功能壞了怎麼辦？**
某些 Luker 功能與第三方函式庫（語音合成、模型快取、離線資源）用 IndexedDB 與 Cache Storage 存狀態。刪掉之後，下次載入時會強制重新抓取或重新初始化。刪除後重新整理頁面，功能通常會自動重新填充所需儲存。
