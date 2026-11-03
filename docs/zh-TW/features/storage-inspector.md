# 儲存審查

Luker 有兩個儲存審查工具：一個看伺服器端帳號的資料目錄，一個看目前瀏覽器的本機儲存。入口都在**「使用者設定」→「帳號」**，佈局一致：配額列、堆疊使用條、圖例，以及可下鑽的清單。

## 伺服器端儲存審查

**入口：**「使用者設定」→「帳號」→**「儲存審查」**

按磁碟佔用把帳號資料分成十類：聊天、角色卡、世界書、圖片、附件、預設、擴充功能、向量、備份、其他。點進任意類別可以查看具體檔案。

審查工具唯讀。清理請使用對應介面：在聊天面板刪聊天，在角色清單刪角色卡。`secrets.json` 這類敏感檔案只顯示大小。

管理員在「管理面板」→「儲存管理」裡可以查看任一帳號，或全部帳號的彙總。

![伺服器儲存總覽](/images/storage-inspector/01-self-l1.png)

![聊天下鑽](/images/storage-inspector/02-self-chats-drilldown.png)

![Admin 彙總視圖](/images/storage-inspector/05-admin-aggregate.png)

## 瀏覽器儲存審查

**入口：**「使用者設定」→「帳號」→**「瀏覽器儲存」**

按站點來源展示 `localStorage`、`sessionStorage`、`IndexedDB`、`Cache Storage` 與儲存配額。點進任意類別查看單個鍵、資料庫、物件儲存或快取。

可以刪除 `localStorage` / `sessionStorage` 鍵、清空物件儲存、刪除資料庫或刪除快取。刪除前二次確認，無法復原。配額視圖唯讀。

審查範圍是目前瀏覽器。同一帳號在另一台裝置上登入，看到的是那台裝置的儲存。

![瀏覽器儲存總覽](/images/browser-storage-inspector/01-browser-l1.png)

![IndexedDB 下鑽](/images/browser-storage-inspector/02-indexeddb-l2.png)

![刪除確認](/images/browser-storage-inspector/03-delete-confirm.png)

## 常見問題

**配額顯示「無限」是什麼意思？**
有些瀏覽器不上報此 origin 的配額，Luker 顯示「無限」。瀏覽器仍會施加自己的限制。

**刪掉某個 `localStorage` 鍵會破壞 Luker 嗎？**
看是哪個鍵。介面語言覆寫、未儲存的草稿、部分連線位址存在 `localStorage`；刪掉這類鍵後，對應設定在下次載入時回到預設值。確認彈窗會給出 key 名。

**為什麼 IndexedDB 與 Cache Storage 的大小顯示 `?`？**
瀏覽器沒有查詢單庫或單快取位元組總量的快速 API。精確計算要逐條讀取記錄或快取回應。頂部的數字來自 `navigator.storage.estimate()`。

**刪了整個 IndexedDB 資料庫，某個功能壞了。**
語音合成、模型快取、離線資源把狀態存在 IndexedDB 與 Cache Storage。重新整理頁面，它們會重新抓取或初始化。
