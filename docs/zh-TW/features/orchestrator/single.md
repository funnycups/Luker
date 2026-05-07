# 單 Agent 模式

單 Agent 是編排器最輕的執行模式——只有一個節點跑一次 LLM,產出一段 capsule 注入主模型。本質是個只剩一個節點的退化 Spec,但因為沒有多節點協作,擴展抽屜裡直接給你兩個簡化欄位,完全不用走編排編輯器。

::: tip 這個模式給誰用
不需要多 agent 協作、不需要工具循環、只想要「一段簡單的引導文字」注入主模型的場景。比如:一段 OOC 提醒、一段世界書摘要、一句風格約束。如果你在想「我要是能讓主模型回覆前先讀一下 XXX 就好了」,這個模式可能正合適。
:::

## 切到單 Agent

擴展抽屜裡把執行模式選成 **單 Agent**。Spec / Agenda / Loop 的編輯器入口收起,擴展抽屜裡多兩個簡化欄位——**System Prompt** 和 **User Prompt 模板**。

直接在這兩個欄位裡寫 prompt 即可,不需要打開編排編輯器。

## 模板變數

User Prompt 模板支援以下佔位符,和 Spec 模式一致:

| 變數 | 含義 |
|---|---|
| <span v-pre>`{{recent_chat}}`</span> | 最近的聊天訊息 |
| <span v-pre>`{{last_user}}`</span> | 最後一條使用者訊息 |
| <span v-pre>`{{previous_orchestration}}`</span> | 上一回合的編排結果。**運行時自動注入,模板裡一般不用寫。** |

## 適用場景

- **簡單 capsule** — 主對話只需要一段 OOC 提醒、一段 lorebook 摘要、一句約束指令
- **想用 capsule 注入,但不想付多 agent 延遲** — 只跑一次 LLM,延遲最低
- **新提示詞除錯** — 先單 agent 跑通基礎 prompt,驗證 capsule 注入位置 / 角色 / 深度都符合預期,再升級到多 agent
- **預算敏感** — 一次 LLM 呼叫比 Spec 預設工作流的 5–10 次便宜得多

## 不適用場景

- 需要 agent 讀世界書、查記憶、做調研 → 用 [Loop 模式](/zh-TW/features/orchestrator/loop)
- 需要多步規劃、審查、合成 → 用 [Spec 模式](/zh-TW/features/orchestrator/spec)
- 需要根據中間結果決定下一步 → 用 [Agenda 模式](/zh-TW/features/orchestrator/agenda)

## AI 幫你寫 prompt

不會寫 prompt?[AI 迭代工作台](/zh-TW/features/orchestrator/iteration-studio)在單 Agent 模式下也能用——切到單 Agent 後打開工作台,描述你想要 agent 幹什麼,它會幫你產生 system / user prompt。

## 與 Spec 的關係

單 Agent 模式底層是只有一個節點的 Spec profile。這意味著:

- 切到單 Agent → 只有一個節點 + 簡化 UI,不打開編排編輯器
- 切回 Spec → 看到的就是這一個節點,可以繼續手撸加節點

兩者之間切換不會丟設定(System Prompt + User Prompt 在 Spec 模式下是節點 0 的設定)。

## 與其他模式對比

| 維度 | 單 Agent | Spec | Agenda | Loop |
|---|---|---|---|---|
| LLM 呼叫次數 | 1 | 5–10 | 視 Planner 調度 | 視 agent 決定(預設 ≤ 20 輪) |
| 設定成本 | 兩個欄位 | 畫 DAG + 多 prompt | Planner prompt + worker pool | 一段 system prompt + 工具開關 |
| 工具呼叫 | ❌ | ❌ | ✅ Planner | ✅ agent 自由呼叫 |
| 流程可變 | ❌ | 拓撲固定 | Planner 決定 | agent 自己決定 |
| 角色卡覆寫 | ✅ | ✅ | ✅ | ✅ |
| 適合場景 | 簡單 capsule | 流程明確 / stage 固定 | 複雜任務需要調度 | 速度與效果平衡 / 探索性研究 |

## 相關頁面

- [編排器概覽](/zh-TW/features/orchestrator/) — 通用設定 / 觸發時機 / 角色卡綁定
- [Spec 模式](/zh-TW/features/orchestrator/spec) — 多節點 DAG 版本
- [AI 迭代工作台](/zh-TW/features/orchestrator/iteration-studio) — AI 幫你寫 prompt
- [Loop 模式](/zh-TW/features/orchestrator/loop) — 想讓 agent 呼叫工具就用這個
