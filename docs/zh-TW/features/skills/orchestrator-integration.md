# 編排器整合

編排器裡的每個 Agent 都有一份 Skill 清單，決定它執行時能讀到哪些知識包。

## 編輯 Agent 的 Skill

在編排編輯器裡，每個 Agent 的設定卡都有 **Skill** 一列：

- **繼承標記**：沿用該模式的預設清單。
- **具名項目**：這個 Agent 額外可見的 Skill。點項目可以移除，點 **新增** 從已安裝的 Skill 裡選擇。
- **停用清單**：明確不讓這個 Agent 看到的 Skill，優先順序高於可見清單。

面板頂部的 **Skill** 列是模式層級預設值，作用於該模式下的所有 Agent。編輯單一 Agent 只改它自己的覆寫。

切換執行模式時，Skill 列依該模式的設定重新顯示。每種模式各自保存一份策略。

## 清單如何合併

- Agent 沒有設定清單：繼承模式預設值。
- Agent 的清單以繼承標記開頭：保留模式預設值，再追加自己的項目。
- Agent 的清單不以繼承標記開頭：完全取代模式預設值。
- 停用清單在兩層之間取聯集，停用的名稱優先。

## Agent 看到什麼

執行時把可見 Skill 的名稱與描述作為一份簡短目錄注入 Agent 的上下文。Agent 需要正文時依名稱讀取，也可以在一份 Skill 內搜尋。它只能存取可見範圍內的 Skill。

## Skill 缺失

Skill 依名稱引用。改名、刪除或尚未安裝時，執行時在派遣階段跳過它，Agent 看不到這個 Skill，但派遣不會失敗。編輯器裡對應項目會變灰並提示未安裝。

角色卡或預設帶來的 Skill 沒有裝齊時，編排仍可執行；補裝後引用自動恢復。

## 用 AI 編輯

[AI 迭代工作台](/zh-TW/features/orchestrator/iteration-studio) 可以依自然語言修改繫結關係。描述要讓哪個 Agent 看到哪些 Skill，工作台會提交待審改動。

## 相關頁面

- [Skills 概覽](/zh-TW/features/skills/) —— 什麼是 Skill、作用域與可見性
- [創作 Skill](/zh-TW/features/skills/authoring) —— 寫自己的 Skill
- [Skill 管理](/zh-TW/features/skills/management) —— 安裝、遷移、刪除
- [Director 模式](/zh-TW/features/orchestrator/director) —— 出廠自帶完整 Skill 整合的多 Agent 設定
- [AI 迭代工作台](/zh-TW/features/orchestrator/iteration-studio) —— 用自然語言修改策略
