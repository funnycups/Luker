# CardApp

CardApp 是隨角色卡載入的小應用，把狀態面板、互動按鈕、小遊戲與劇情選項直接顯示在聊天介面中。CardApp 屬於角色卡：切換到該角色時載入，離開時卸載，不影響其他角色。

## 能做什麼

- **狀態面板**：顯示好感度、體力、任務進度、物品清單等隨劇情變化的資料。
- **互動按鈕**：用符合角色設定的按鈕取代通用工具列。
- **小遊戲**：文字冒險選項、骰子、卡牌等輕量玩法。
- **自訂介面**：以與世界觀一致的版面、配色和文案呈現資訊。

CardApp 的狀態儲存在目前聊天中，切換聊天或重新開啟後保留。

## 怎麼做

用 [CardApp Studio](/zh-TW/features/card-editor/studio) 開發：描述想要的效果，Studio 生成介面並寫入角色卡，即時預覽修改結果。完整的從零範例見[異世界生存日誌](/zh-TW/features/card-editor/walkthrough/isekai)。

::: tip 開發環境
Studio 提供程式碼編輯器、即時預覽與 AI 輔助。需要編寫自訂邏輯時，介面與約定見[角色卡開發者指南](/zh-TW/development/card-developers)。
:::

## 相關頁面

- [角色卡編輯助手](/zh-TW/features/card-editor/) —— 含 CardApp 角色卡的編輯入口
- [CardApp Studio](/zh-TW/features/card-editor/studio) —— 開發和除錯 CardApp 的工作台
- [狀態系統](/zh-TW/features/state-system) —— CardApp 的資料如何隨聊天儲存
