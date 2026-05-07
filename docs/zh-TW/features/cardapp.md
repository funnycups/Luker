# CardApp

CardApp 是 Luker 獨有的角色卡內嵌應用系統。它允許角色卡在 `data.extensions.card_app` 中定義小型應用（包含 HTML、JavaScript 和樣式），這些應用會在聊天介面中載入和渲染，為角色卡賦予互動式的動態能力。

::: tip 開發 CardApp
推薦使用 [CardApp Studio](/zh-TW/features/card-editor/studio) 來開發和除錯 CardApp。Studio 提供了 CodeMirror 6 程式碼編輯器、即時預覽和 AI 輔助開發。完整的 API 參考和開發指南請參閱[角色卡開發者指南](/zh-TW/development/card-developers)。
:::

::: tip 想看完整 walkthrough?
[從零寫一個 CardApp](/zh-TW/features/card-editor/walkthrough) 用一個輕小說西式異世界冒險題材的角色卡，演示從空角色卡到能跑的 CardApp 的全過程，含提示詞實踐小抄和影像生成進階。
:::

## 生命週期

1. **掛載** — 角色切換時，系統從角色卡提取應用定義，將應用掛載到聊天介面的 UI 容器，並呼叫應用的 `init(ctx)` 函數
2. **執行** — 應用透過 `ctx` 上下文物件與 Luker 互動，回應聊天事件並更新自身狀態
3. **卸載** — 切換到其他角色或關閉聊天時，系統清理應用實例，自動釋放所有透過 `ctx` 註冊的計時器、事件監聽器和 dispose 回呼

## 使用場景

- **角色卡內嵌互動元素** — 狀態面板、情緒指示器、自訂按鈕等
- **小遊戲** — 文字冒險選擇介面、骰子投擲器、卡牌遊戲元件等
- **狀態追蹤** — 透過 `getChatState` / `setChatState` 持久化好感度、任務進度、物品清單等資料

## 相關頁面

- [角色卡編輯助手](/zh-TW/features/card-editor/) — 含 CardApp 角色卡的編輯入口（自動進入 Studio）
- [CardApp Studio](/zh-TW/features/card-editor/studio) — 開發和除錯 CardApp 的完整環境
- [角色卡開發者指南](/zh-TW/development/card-developers) — 完整的 CardApp API 參考和開發文件
- [狀態系統](/zh-TW/features/state-system) — 角色狀態和聊天狀態
