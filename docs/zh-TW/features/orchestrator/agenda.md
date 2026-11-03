# Agenda 模式

Agenda 以規劃 Agent 組織流程。規劃 Agent 維護待辦清單，依中間結果決定呼叫哪些 Agent、呼叫幾次以及何時結束，最後由收尾 Agent 合成編排結果。

## 什麼時候用

Agenda 適用於以下情況：

- 某些步驟只在條件成立時執行，例如先判斷使用者輸入是否越界，越界才啟動限制檢查。
- 下一步呼叫哪個 Agent 取決於上一步的輸出，無法提前畫出完整流程。
- 需要由一個規劃 Agent 統一協調多個工作 Agent。

兩種模式的差別在於由誰選擇 Agent：Spec 由階段表決定，Agenda 由規劃 Agent 決定。

## 工作方式

```d2
direction: down

start: "新回合開始" {
  shape: oval
  style.fill: "#e8f5e9"
}

loop: "規劃 Agent 調度" {
  style.fill: "#e1f5ff"

  driver: "規劃 Agent\n讀取已完成的工作 · 更新待辦清單 ·\n派遣工作 Agent · 決定何時收尾" {
    style.fill: "#fffde7"
  }

  pool: "工作 Agent 池" {
    style.fill: "#fff3e0"
    a: "場景整理" {
      style.fill: "#fffde7"
    }
    b: "世界書限制" {
      style.fill: "#fffde7"
    }
    c: "情節規劃" {
      style.fill: "#fffde7"
    }
    d: "審查" {
      style.fill: "#fffde7"
    }
  }

  driver -> pool: "派遣一個或多個（可並行）"
  pool -> driver: "傳回結果 · 必要時重新規劃"
}

finalizer: "收尾 Agent 寫出編排結果" {
  style.fill: "#c8e6c9"
}

out: "注入主模型的提示詞" {
  shape: oval
  style.fill: "#f3e5f5"
}

start -> loop.driver
loop.driver -> finalizer: "結束"
finalizer -> out
```

1. 規劃 Agent 讀取最近聊天和使用者訊息。
2. 它維護一份待辦清單，記錄已完成和待處理的事項。
3. 它從工作 Agent 池中選擇一個或多個 Agent，分配任務。
4. 它讀取傳回的結果，更新清單，決定繼續派遣還是結束。
5. 結束時，由指定的收尾 Agent 把結果合成編排結果，注入主模型。

工作 Agent 不繫結在固定階段上：是否呼叫、呼叫幾次、以什麼順序呼叫，都由規劃 Agent 決定。

## 預設流程

出廠設定自帶一個規劃 Agent 和一組工作 Agent：

- **場景整理**：提取使用者意圖、目前張力和可能的發展方向。
- **世界書限制**：從已啟用的條目中選出本回合真正有影響的設定與文風要求。
- **情節規劃**：規劃下一拍的節拍和決策點，保持因果與角色獨立性。
- **審查**：檢查連續性、角色偏離、缺失限制和不符合世界規則的因果。
- **收尾**：把審查通過的產出合成一段簡短的編排指引。

規劃 Agent 可以並行派遣多個工作 Agent，也可以依結果重新規劃。它決定何時停止，收尾 Agent 只執行一次。

## 開始使用

1. 在擴充功能抽屜把執行模式設為 **Agenda**。
2. 開啟編排編輯器，檢查規劃 Agent 的系統提示詞與任務範本。
3. 查看工作 Agent 池，依需要調整每個 Agent 的職責、提示詞和模型。
4. 設定規劃輪數、並行數和總呼叫次數上限。
5. 正常聊天，在執行面板查看規劃過程和每個工作 Agent 的輸出。

需要改流程時，優先使用 [AI 迭代工作台](/zh-TW/features/orchestrator/iteration-studio) 描述目標，讓 AI 修改規劃邏輯或 Agent 池。

## 編輯器

左側是規劃 Agent 的設定：API 連線、聊天補全預設、系統提示詞和任務範本。右側是工作 Agent 池，每個 Agent 有自己的系統提示詞、使用者提示詞範本和可選的模型覆寫。

規劃 Agent 透過工具呼叫派遣工作 Agent，因此所用連線需要支援函式呼叫。OpenAI、Claude 與 Gemini 均支援。

## 執行上限

Agenda 提供三項執行上限：

- 規劃 Agent 的最大輪數。
- 同時執行的工作 Agent 數量。
- 單次執行中所有工作 Agent 的呼叫總數。

達到任一上限時強制結束。

## 與 Spec 互轉

編輯器提供把 Agent 池複製到另一模式的按鈕。轉換只遷移 Agent，不遷移調度邏輯：

- 從 Spec 轉到 Agenda，階段順序會遺失，需要在規劃 Agent 的提示詞裡重新描述調度規則。
- 從 Agenda 轉到 Spec，動態派遣無法完整對應為固定階段，需要手動決定階段劃分。

## 執行面板

執行面板依規劃輪次展示。每一輪是一張卡片，本輪派遣的工作 Agent 顯示為子卡片，展開可以查看推理、輸入和輸出。

重點關注：

- 規劃 Agent 是否派錯了 Agent，或漏掉必要步驟。
- 是否在同一件事上反覆派遣，遲遲不結束。
- 收尾 Agent 的產出是否包含本回合真正需要的資訊。

面板頂部的匯出按鈕可以把整次執行儲存為 JSON，便於回報問題。

## 設定

- **規劃最大輪數**：規劃 Agent 的調度輪數上限。
- **最大並行 Agent 數**：同時執行的工作 Agent 數量。
- **總執行次數上限**：單次執行中所有工作 Agent 的呼叫總數。
- **規劃 API 與提示詞預設**：規劃 Agent 使用的連線與聊天補全預設。下拉框旁的問號按鈕可以一鍵匯入內建預設。
- **規劃系統提示詞與任務範本**：定義它的工作方式。
- **收尾 Agent**：結束時由哪個 Agent 產出編排結果。
- **工作 Agent 池**：每個 Agent 的提示詞、模型和職責。

## 相關頁面

- [多 Agent 編排概覽](/zh-TW/features/orchestrator/) —— 通用設定、觸發時機與角色卡繫結
- [AI 迭代工作台](/zh-TW/features/orchestrator/iteration-studio) —— 用自然語言修改規劃邏輯與 Agent 池
- [Spec 模式](/zh-TW/features/orchestrator/spec) —— 固定階段的預設模式
- [Loop 模式](/zh-TW/features/orchestrator/loop) —— 單 Agent 工具循環
- [自訂工具](/zh-TW/features/orchestrator/custom-tools) —— 給工作 Agent 增加內建之外的能力
