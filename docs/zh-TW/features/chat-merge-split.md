# 聊天合併與拆分

按你選擇的順序，把幾個聊天合併成一個，並可對每個來源裁剪範圍；或者在你選擇的切點，把一個聊天拆成多個新聊天。來源聊天始終保留不變。

## 合併聊天

1. 開啟 **過往聊天**（當前角色或群組的聊天清單彈窗），點擊彈窗頂部的合併圖示。

   ![兩個待合併的聊天](/screenshots/chat-merge-split/01-two-chats-ready.png)

2. 點擊 **+ 新增聊天** 選擇來源聊天。可以新增任意多個，同一個聊天也可以重複新增。

   ![合併對話框含兩個來源](/screenshots/chat-merge-split/02-merge-dialog-two-sources.png)

3. **拖動每行左側的 ⋮⋮ 把手** 重新排序。有三個或更多來源時，可將任一行拖到任意位置。

   ![合併對話框含三個來源](/screenshots/chat-merge-split/04-merge-dialog-three-sources.png)

   ![拖拽重排後的效果](/screenshots/chat-merge-split/05-merge-dialog-after-drag.png)

4. **設定 `起始` / `結束` 數字** 來只包含來源的一部分。彩色條顯示當前包含的訊息範圍。點擊 **全選** 把某一行恢復為完整聊天。

   ![已裁剪的段](/screenshots/chat-merge-split/06-merge-dialog-trimmed.png)

5. 在頂部輸入 **目標名稱**，點擊 **合併**。新聊天會自動開啟。

   ![新合併的聊天](/screenshots/chat-merge-split/03-merged-chat-opened.png)

## 拆分聊天

1. 找到你想要拆分的位置那條訊息，點擊該訊息按鈕列裡的 ✂ **拆分聊天** 圖示。
2. 彈窗會以這條訊息的索引為初始切點。點擊 **+ 新增切點** 增加更多切點；在數字輸入框裡微調位置。

   ![三段拆分對話框](/screenshots/chat-merge-split/07-split-dialog-three-segments.png)

3. 按需要重新命名每段，然後點擊 **拆分**。新聊天會出現在聊天清單裡，來源聊天保持不變。

## 群組聊天

群組聊天的合併方式完全一致。從群組開啟過往聊天，按上面的合併流程操作即可。

![待合併的群組聊天](/screenshots/chat-merge-split/20-group-two-chats-ready.png)

![群組合併對話框](/screenshots/chat-merge-split/21-group-merge-dialog-two-sources.png)

合併後的群組聊天會自動註冊到群組裡，因此會出現在該群組的過往聊天清單中，可以像任何其他群組聊天一樣開啟。

## 注意事項

- 新聊天只包含訊息。**外掛狀態——記憶圖、編排器、搜尋工具等每聊天側檔——不會遷移。** 你需要在新聊天裡重新生成。
- 來源聊天永遠不會被修改或刪除。
- 如果目標名稱已被佔用，系統會自動追加 ` (2)`、` (3)` 等後綴。
- 在單角色聊天和群組聊天裡行為一致。同源限制：不能把角色聊天和群組聊天合併到一起。

## 實作原理

伺服器端點 `POST /api/chats/merge` 與 `POST /api/chats/split`（以及對應的 `/group/*` 版本）透過 `ChatRepo` 讀取每個來源，在記憶體中構建新的訊息陣列和聊天標頭，再透過 `ChatRepo.save(...)` 寫入新聊天。由於讀寫都走同一個倉儲抽象層，無論底層是檔案系統、SQLite、MySQL 還是 PostgreSQL，功能行為完全一致。
