# CardApp

CardApp 是 Luker 的角色卡內嵌應用系統，允許角色卡創作者在角色卡中嵌入互動式 JavaScript 應用。這些應用可以追蹤遊戲狀態、顯示自訂 UI 元素、與聊天系統互動，為角色扮演增添遊戲化和視覺化的體驗。

## 適用場景

- **狀態追蹤**：好感度、體力值、庫存等遊戲化元素
- **互動元素**：骰子、卡牌、小遊戲
- **視覺化**：關係圖、時間線、地圖
- **自訂 UI**：角色專屬的介面元件

## 應用定義

CardApp 定義在角色卡的 `data.extensions.card_app` 欄位中，包含三個部分：

| 欄位 | 說明 |
|------|------|
| `html` | 應用的 HTML 範本 |
| `script` | 應用的 JavaScript 程式碼 |
| `style` | 應用的 CSS 樣式 |

## 入口函式

CardApp 的 `script` 欄位應匯出一個預設函式，該函式接收上下文物件 `ctx`：

```javascript
export default function (ctx) {
  const container = ctx.container;

  async function init() {
    const state = ctx.getChatState('my_app');
    render(state);
  }

  function render(state) {
    const fav = state?.favorability ?? 0;
    container.innerHTML = `
      <div class="fav-panel">
        <h3>好感度</h3>
        <span>${fav} / 100</span>
      </div>
    `;
  }

  init();
}
```

## 上下文 API

CardApp 的上下文物件提供以下 API：

| API | 說明 |
|-----|------|
| `ctx.container` | 應用的 DOM 容器元素 |
| `ctx.charId` | 當前角色 ID |
| `ctx.sendMessage(text, options?)` | 傳送訊息 |
| `ctx.stopGeneration()` | 停止當前生成 |
| `ctx.continueGeneration()` | 繼續生成 |
| `ctx.getChatState(namespace)` | 讀取聊天綁定的持久化狀態 |
| `ctx.getChatList()` | 取得當前角色的聊天列表 |

## 安全限制

CardApp 運行在受限環境中：

- ✅ 可以操作 `ctx.container` 內的 DOM
- ✅ 可以透過 `ctx` API 讀寫聊天狀態
- ✅ 可以傳送訊息和控制生成
- ❌ 不應直接操作沙箱外的 DOM
- ❌ 不應直接發起網路請求
- ❌ 不應直接存取其他擴充功能的資料

## CardApp Studio

[角色卡編輯助手](/zh-TW/features/card-editor)內建了 CardApp Studio，提供基於 CodeMirror 6 的程式碼編輯器，支援即時預覽和除錯。建議使用 Studio 進行 CardApp 開發，而非手動編輯 JSON。

## 狀態持久化

CardApp 透過[狀態系統](/zh-TW/features/state-system)實現資料持久化。應用可以將遊戲進度、使用者偏好等資料儲存到聊天狀態或角色狀態中，確保資料在重新載入後不會遺失。

## 相關頁面

- [角色卡編輯助手](/zh-TW/features/card-editor) — CardApp Studio 開發環境
- [狀態系統](/zh-TW/features/state-system) — 資料持久化機制
- [角色卡開發者指南](/zh-TW/development/card-developers) — 完整的 CardApp 開發文件
