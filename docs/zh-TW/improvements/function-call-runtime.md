# 函數呼叫執行時

Luker 內建了統一的函數呼叫（Function Calling）執行時，讓 AI 角色能夠執行結構化的操作——搜尋資訊、管理記憶、操作狀態——而不僅僅是生成文字。無論底層模型是否原生支援 tool call，Luker 都提供一致的呼叫體驗。

## 統一的函數呼叫框架

函數呼叫執行時提供了一個統一的框架來管理工具的註冊、呼叫和結果處理。核心設計目標是：

- **模型無關** — 同一套工具定義可以在不同的 LLM 提供商之間無縫切換
- **協議透明** — 上層工具不需要關心底層使用的是原生 tool call 還是文字協議
- **串流相容** — 支援串流回應中的工具呼叫解析和規範化

```d2
direction: down

REG: "註冊工具 · 統一 schema 格式"
DECIDE: "模型原生支援 tool call?" {
  shape: diamond
}

NATIVE: "原生模式" {
  style.fill: "#e8f5e9"
  N_SCHEMA: "轉換為模型要求的 schema"
  N_REQ: "請求中附加 tools 欄位"
  N_RESP: "模型回傳結構化 tool_calls"
  N_PARSE: "解析並執行工具"
  N_SCHEMA -> N_REQ -> N_RESP -> N_PARSE
}

TEXT: "純文字模式" {
  style.fill: "#fff3e0"
  T_PROTO: "向 System Prompt 注入工具協議描述"
  T_RESP: "模型回傳普通文字"
  T_EXTRACT: "正則擷取工具呼叫標記"
  T_EXEC: "解析並執行工具"
  T_PROTO -> T_RESP -> T_EXTRACT -> T_EXEC
}

INJECT: "結果注入上下文 · 繼續生成"

REG -> DECIDE
DECIDE -> NATIVE.N_SCHEMA: "是"
DECIDE -> TEXT.T_PROTO: "否"
NATIVE.N_PARSE -> INJECT
TEXT.T_EXEC -> INJECT
```

## 原生模式

當連線的模型原生支援 Function Calling 時（如 OpenAI、Claude、Gemini），Luker 使用模型的原生 tool call 格式。執行時會：

1. 將註冊的工具轉換為模型要求的 schema 格式
2. 在請求中附加工具定義
3. 解析模型回傳的工具呼叫結構
4. 執行對應的工具函數
5. 將執行結果注入上下文，繼續對話

原生模式的優勢在於利用了模型經過專門訓練的工具呼叫能力，呼叫格式更規範，參數解析更準確。

## 純文字模式

對於不支援原生 Function Calling 的模型，Luker 提供了純文字協議作為降級方案。執行時會在 System Prompt 中自動注入工具使用說明，引導模型以特定的文字格式輸出工具呼叫請求。

純文字模式的工作流程：

1. 在 System Prompt 中描述可用工具及其參數格式
2. 模型在回覆中以約定的文字標記輸出工具呼叫
3. 執行時解析文字中的工具呼叫標記
4. 執行工具並將結果注入上下文
5. 繼續生成後續回覆

::: tip 適用場景
純文字模式適用於本地部署的開源模型、不支援 tool call 的 API 提供商，或者需要更靈活的工具呼叫格式的場景。雖然準確性不如原生模式，但大幅擴展了函數呼叫的適用範圍。
:::

## 多工具呼叫支援

執行時支援在單次生成中呼叫多個工具（multi-tool / parallel tool calls）。當模型在一次回應中請求呼叫多個工具時，執行時會：

- 按順序或並行執行所有請求的工具
- 收集所有工具的執行結果
- 將結果批次注入上下文
- 觸發後續生成

這對於需要同時查詢多個資訊來源的場景尤為重要，例如同時搜尋網頁和查詢記憶。

## 串流工具呼叫規範化

在串流回應（streaming）場景下，工具呼叫的資料可能分散在多個資料區塊中。執行時會自動將分散的工具呼叫片段重新組裝為完整的呼叫結構，確保無論是串流還是非串流回應，上層邏輯都能獲得一致的工具呼叫資料。

## 可配置的錯誤處理

當工具執行失敗時，執行時會將錯誤資訊格式化後注入上下文，讓模型知道工具呼叫失敗並可以選擇：

- 使用不同的參數重試
- 嘗試其他工具
- 直接基於已有資訊回覆使用者

錯誤資訊包含工具名稱、失敗原因等結構化資料，幫助模型做出合理的後續決策。

## Connection Manager 中的獨立開關

函數呼叫功能可以在連線級別獨立啟用或停用。不同的連線配置可以有不同的函數呼叫設定，例如：

- 主力連線啟用完整的函數呼叫
- 備用連線停用函數呼叫以節省 token
- 特定連線只啟用部分工具

這與[預設解耦](/zh-TW/improvements/preset-decoupling)機制協同工作——函數呼叫開關屬於連線配置的一部分，切換預設不會影響它。

## 內建工具

搜尋外掛註冊了全域工具：網頁搜尋（支援 DuckDuckGo、SearXNG、Brave Search 等搜尋引擎）和網頁存取。其他模組（編輯助手、編排器、預設助手）在各自的獨立上下文中使用工具呼叫機制，不透過全域工具註冊表。

::: info 擴充工具
第三方擴充可以透過 `context.registerFunctionTool()` 註冊自訂工具（由核心的 `ToolManager` 提供）。工具定義遵循統一的 schema 格式，註冊後自動適配原生模式和純文字模式。詳見[擴充 API — 工具註冊](/zh-TW/development/extension-api/generation#工具註冊)文件。
:::

## 底層實作

對於想了解內部實作的開發者，函數呼叫系統由三個核心模組組成：

| 模組 | 檔案 | 職責 |
|------|------|------|
| **ToolManager** | `tool-calling.js` | 全域工具註冊表、工具 schema 轉換、串流工具呼叫片段重組、工具執行編排和結果注入 |
| **函數呼叫執行時** | `function-call-runtime.js` | 純文字模式支援——建構工具協議訊息注入 System Prompt（`buildPlainTextToolProtocolMessage`）、從文字回應中提取函式呼叫（`extractAllFunctionCallsFromText` / `extractToolCallsFromTextResponse`）、將附加文字合併到 prompt messages（`mergeUserAddendumIntoPromptMessages` / `mergeSystemAddendumIntoPromptMessages`） |
| **請求引擎** | `openai.js`（`sendOpenAIRequest`） | 核心 LLM 請求函數，處理預設解析、連線覆寫，並將請求分發到對應的 API 後端 |

**原生模式**的流程：`ToolManager` 將註冊的工具轉換為模型的 schema → `sendOpenAIRequest` 將其附加到 API 請求 → 模型回傳結構化的工具呼叫 → `ToolManager` 解析、執行並注入結果。

**純文字模式**的流程多了一層：`function-call-runtime.js` 將工具描述注入 System Prompt → 模型輸出文字格式的工具呼叫 → `function-call-runtime.js` 解析文字 → `ToolManager` 執行並注入結果。

需要自行發送帶工具呼叫的 LLM 請求的外掛，直接使用 `sendOpenAIRequest` 並傳入 `tools` 和 `toolChoice` 參數——這與全域工具註冊表是分開的。詳見[擴充 API — 發送 LLM 請求](/zh-TW/development/extension-api/generation#發送-llm-請求)文件。

## 相關頁面

- [改進總覽](/zh-TW/improvements/overview) — 所有技術改進的概述
- [預設解耦](/zh-TW/improvements/preset-decoupling) — 函數呼叫開關與連線配置的關係
- [擴充 API](/zh-TW/development/extension-api/) — 外掛開發指南，包含工具註冊和 LLM 請求 API
