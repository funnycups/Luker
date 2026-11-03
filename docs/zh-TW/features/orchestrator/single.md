# 單 Agent 模式

單 Agent 是編排器最輕的模式：只執行一個節點，呼叫一次模型，產出一段引導文字注入主模型。它像一個只剩單一節點的 Spec，適合只需要一句提醒、一段摘要或一條風格限制的回合。

## 什麼時候用

- 主對話只需要一段 OOC 提醒、一段世界書摘要或一句寫作限制。
- 想使用編排結果的注入，但不想承擔多 Agent 的延遲和成本。
- 除錯新的引導提示詞：先用單 Agent 驗證注入位置與效果，再升級到更複雜的模式。
- 預算有限，只需要一次額外呼叫。

需要 Agent 主動查世界書、檢索記憶或做多步研究時，用 [Loop 模式](/zh-TW/features/orchestrator/loop)。需要固定多階段流程時，用 [Spec 模式](/zh-TW/features/orchestrator/spec)。需要動態決定下一步時，用 [Agenda 模式](/zh-TW/features/orchestrator/agenda)。

## 開始使用

在擴充功能抽屜把執行模式選為 **單 Agent**。其他模式的編輯器入口會收起，出現兩個欄位：

- **System Prompt**：Agent 的角色與任務。
- **User Prompt 範本**：本輪提供給 Agent 的輸入。

直接填寫這兩個欄位即可，不需要開啟編排編輯器。執行時 Agent 的產出會作為編排結果注入主模型。

## 與 Spec 的關係

單 Agent 在底層是只有一個節點的 Spec。切回 Spec 時，看到的就是這個節點，可以繼續新增階段和節點。兩個模式之間切換不會遺失提示詞。

## 與其他模式對比

| | 單 Agent | Spec | Agenda | Loop |
| --- | --- | --- | --- | --- |
| 模型呼叫 | 一次 | 多次，依階段 | 由規劃 Agent 決定 | 由 Agent 決定 |
| 設定方式 | 兩個提示詞欄位 | 階段與節點編輯器 | 規劃 Agent 與工作 Agent 池 | 系統提示詞與工具開關 |
| 工具呼叫 | 無 | 無 | 規劃 Agent 使用 | Agent 自由使用 |
| 流程 | 固定單步 | 固定階段 | 動態調度 | Agent 自主決定 |
| 適合 | 簡單引導 | 可預期的多階段準備 | 需要動態調度 | 需要邊查邊想 |

## 用 AI 編寫提示詞

[AI 迭代工作台](/zh-TW/features/orchestrator/iteration-studio) 在單 Agent 模式下同樣可用。描述希望 Agent 完成的任務，工作台會產生系統提示詞與使用者提示詞，並逐項確認。

## 相關頁面

- [多 Agent 編排概覽](/zh-TW/features/orchestrator/) —— 通用設定、觸發時機與角色卡繫結
- [Spec 模式](/zh-TW/features/orchestrator/spec) —— 多階段流程
- [AI 迭代工作台](/zh-TW/features/orchestrator/iteration-studio) —— 用自然語言編寫提示詞
- [Loop 模式](/zh-TW/features/orchestrator/loop) —— 讓 Agent 呼叫工具
