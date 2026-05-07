# 預設解耦

預設解耦將 Chat Completion 預設中的「生成參數」與「連線配置」分離，使切換預設不再意外改變 API 連線設定。

## 問題背景

在 SillyTavern 中，Chat Completion 預設（即 OpenAI / Claude 等 API 的預設）包含了兩類本質不同的配置：

- **生成參數** — 提示詞範本（System Prompt、Jailbreak 等）、取樣參數（Temperature、Top-P 等）、上下文長度等
- **連線欄位** — API 位址、API Key、模型名稱、Chat Completion Source 等

這兩類配置被打包在同一個預設物件中。當使用者切換預設時，連線欄位也會隨之改變——這意味著切換一個提示詞範本可能會把你的 API 位址從 Claude 切到 OpenAI，或者覆蓋你精心配置的自訂 API 端點。

這種連動在實際使用中造成了大量困擾：

- 使用者不敢隨意嘗試不同的預設，因為擔心連線配置被覆蓋
- 分享預設時必須手動清理連線資訊，否則會洩露 API Key
- 角色卡作者無法為角色推薦預設，因為載入預設會破壞使用者的連線設定

## 欄位分類機制

Luker 將預設中的每個欄位標記為「連線欄位」或「生成參數欄位」兩類：

- **連線欄位** — API 來源、自訂 URL、模型名稱、反向代理位址、代理密碼等
- **生成參數欄位** — Temperature、Top-P、最大 Token 數等

```d2
direction: right

ST: "SillyTavern：耦合" {
  ST_PRESET: "聊天補全預設"
  ST_GEN: "生成參數\nTemperature / Top-P / ..."
  ST_CONN: "連線欄位\nAPI URL / Key / Model" {
    style.fill: "#ffebee"
    style.stroke: "#c62828"
  }
  SWITCH1: "切換預設"

  ST_PRESET -> ST_GEN
  ST_PRESET -> ST_CONN
  SWITCH1 -> ST_GEN: {style.stroke-dash: 3}
  SWITCH1 -> ST_CONN: "意外覆蓋" {style.stroke-dash: 3}
}

LK: "Luker：解耦" {
  LK_PRESET: "聊天補全預設"
  LK_CONN: "連線配置"
  LK_GEN: "只含生成參數"
  LK_CONN_F: "只含連線欄位" {
    style.fill: "#e8f5e9"
    style.stroke: "#2e7d32"
  }
  SWITCH2: "切換預設"
  SWITCH3: "切換連線"

  LK_PRESET -> LK_GEN
  LK_CONN -> LK_CONN_F
  SWITCH2 -> LK_GEN: {style.stroke-dash: 3}
  SWITCH3 -> LK_CONN_F: {style.stroke-dash: 3}
  SWITCH2 -- LK_CONN_F: "跳過連線欄位" {style.stroke-dash: 3}
}
```

這個分類是預設解耦的基礎——所有涉及預設載入的邏輯都會檢查欄位類型來決定是否套用。

## 切換預設時自動跳過連線欄位

當使用者切換預設時，載入邏輯會遍歷預設中的每個欄位，自動跳過所有連線欄位。這確保了切換預設只會改變生成參數，而不會觸碰當前的 API 連線配置。

::: tip 何時包含連線欄位
只有在 Connection Manager 中顯式切換連線配置時，連線欄位才會被套用。普通的預設切換、角色卡綁定預設載入等場景都不會包含連線欄位。
:::

## 受影響的模組

預設解耦涉及三個核心模組的協調：

### 預設載入

- 維護連線欄位與生成參數欄位的分類邏輯
- 預設載入時根據場景決定是否包含連線欄位
- 預設匯出時可選擇是否包含連線欄位

### 預設管理器

- 預設選擇器的介面感知解耦狀態
- 預設儲存時保留連線欄位（確保預設檔案完整），但載入時按分類過濾
- 支援[角色卡綁定預設](/zh-TW/improvements/card-bound-presets)的特殊選項渲染

### Connection Manager

- 連線配置獨立於預設管理，擁有自己的儲存和切換邏輯
- 切換連線時只套用連線欄位，不影響當前的生成參數
- 連線配置的變更透過增量 patch 儲存，參見[增量同步](/zh-TW/improvements/incremental-sync)

## 與角色卡綁定預設的關係

預設解耦是[角色卡綁定預設](/zh-TW/improvements/card-bound-presets)功能的前提。正因為連線欄位被隔離，角色卡才能安全地攜帶推薦預設——載入角色卡預設時，連線欄位會被自動跳過，確保使用者的 API 連線不會被覆蓋。

如果沒有預設解耦，角色卡綁定預設將無法實現：每次打開一個角色卡都可能把使用者的 API 位址和密鑰替換掉，這顯然是不可接受的。

::: info 預設檔案相容性
預設解耦不改變預設檔案的儲存格式。連線欄位仍然儲存在預設 JSON 中，只是在載入時被選擇性跳過。這意味著現有的預設檔案無需遷移，也可以在需要時（如透過 Connection Manager）完整載入。
:::

## 相關頁面

- [角色卡綁定預設與人設](/zh-TW/improvements/card-bound-presets) — 依賴預設解耦的上層功能
- [改進總覽](/zh-TW/improvements/overview) — 所有技術改進的概述
