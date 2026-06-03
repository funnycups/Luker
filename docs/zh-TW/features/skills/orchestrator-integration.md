# 編排器整合

本頁講 Skill 如何掛到編排器 profile 上、以及每個 agent 派遣時如何看到對的那一組。

整體圖景：編排器 profile 在兩個層級帶著 `skills` 策略 —— **模式級**（預設值）與**每 agent 覆寫** —— 執行時在每次派遣前把兩層與物理庫存對帳。agent 只看到它解析後的可見集；其餘被過濾掉。

## 策略形狀

編排器 profile JSON 裡，兩個 `skills` 區塊跟 `systemPrompt` 等現有欄位並列：

```jsonc
{
  "mode": "director",

  // 模式級預設 —— 套用於該模式下每個 agent。
  "skills": {
    "visible": ["director-anti-cliche-zh", "director-character-voice-zh"],
    "deny": []
  },

  "mainAgent": {
    "systemPrompt": "你是 director 的主代理……",
    // 每 agent 覆寫。開頭的 "+" 表示繼承模式預設值。
    "skills": {
      "visible": ["+", "director-turn-workflow-zh", "director-dispatch-protocol-zh"]
    }
  },

  "subAgents": [
    {
      "id": "voice_critic",
      "systemPrompt": "你是口吻評審……",
      "skills": {
        "visible": ["+", "voice-critic-method-zh"]
      }
    }
    // …更多子代理
  ]
}
```

`visible` 與 `deny` 都是**只有名字**的清單 —— 沒有作用域前綴。解析器遍歷三個物理作用域，按名字匹配（後者優先：character > preset > global）。

## 三條解析規則

派遣 agent 時，執行時從模式 + agent 兩個區塊算出有效的 `visible` 與 `deny`：

### 規則 1 —— agent 沒有 `visible`（或為空）

有效 visible = 模式 visible。agent 原樣繼承模式預設值。

```jsonc
"mainAgent": {
  "skills": { "visible": [] }  // 或省略
}
// 有效: ["director-anti-cliche-zh", "director-character-voice-zh"]
```

### 規則 2 —— agent 的 `visible` 以 `"+"` 開頭

有效 visible = 模式 visible ∪ agent visible 的其餘項。`"+"` 是顯式的「繼承再追加」。

```jsonc
"mainAgent": {
  "skills": { "visible": ["+", "director-turn-workflow-zh"] }
}
// 有效: ["director-anti-cliche-zh", "director-character-voice-zh",
//        "director-turn-workflow-zh"]
```

### 規則 3 —— agent 的 `visible` 不以 `"+"` 開頭

有效 visible = agent visible。模式預設值被完全替換。

```jsonc
"specializedSubAgent": {
  "skills": { "visible": ["only-this-one"] }
}
// 有效: ["only-this-one"]
```

這對需要從模式級寫作規則裡隔離出去的 agent 有用 —— 例如，只產出結構化資料的 agent 不應該看到文字評審類 Skill。

### deny 永遠是聯集

`deny` 跨模式 + agent 兩層取聯集（永不被替換），並且**永遠勝過** `visible`。某個 Skill 名字只要出現在任一 deny 清單裡，即使也在某個 visible 清單裡，仍然被過濾掉。

```jsonc
"mode": "director",
"skills": { "deny": ["director-anti-cliche-zh"] },
"mainAgent": {
  "skills": { "visible": ["+", "director-anti-cliche-zh"] }
}
// 有效 visible: [] (deny 勝出)
```

### 萬用字元

`visible` 接受 `"*"`，意為「所有已安裝 Skill」。早期想讓 agent 看到所有可用項又不想列名時很有用：

```jsonc
"mainAgent": {
  "skills": { "visible": ["*"], "deny": ["scripts-experimental"] }
}
```

萬用字元按你預期的方式與 `"+"` 和 `deny` 組合。

## agent 實際看到什麼

策略解析完之後，執行時在派遣時交給 agent 兩件東西：

### 1. 自動注入的目錄

一份精簡的 `<available_skills>` 區塊追加到 agent 的系統訊息裡：

```
<available_skills>
- director-anti-cliche-zh: 敘事寫作的反八股模式。
- director-character-voice-zh: 共享的角色口吻規則，所有預設子代理可見。
- director-turn-workflow-zh: director 主代理的 7 步回合工作流。
- ...
</available_skills>

（用 skill_read 檢視具體內容；用 skill_search 在一個 Skill 內 grep。）
```

只是目錄 —— 名字 + 描述。agent 不用花一輪 `skill_list` 工具呼叫就知道有什麼可用。

預設 director profile 的 18 來項加起來約 150–300 token —— 很便宜。

### 2. 三個函式工具

被限制在可見集內，這是 agent 唯一能拿到 Skill 內容的方式：

| 工具 | 簽名 | 返回 |
|---|---|---|
| `skill_list({ query? })` | 可選子字串過濾 | `[{ name, description, tags }]` |
| `skill_read({ name, path?, offset?, limit? })` | `path` 預設 SKILL.md；`offset`/`limit` 是行號 | `{ content, totalLines, truncated }` |
| `skill_search({ name, query, path?, limit?, contextLines? })` | 在單個 Skill 的檔案內做子字串搜尋 | `{ hits: [{ path, lineStart, lineEnd, snippet }] }` |

agent 真的需要正文時就呼叫 `skill_read`。`skill_search` 用於 Skill 很大、只有某一段相關的場景。

執行時硬上限：`skill_read` 響應不超過 50 KB。截斷時 agent 用 `offset` 繼續讀。這保證即使 Skill 攜帶大塊參考檔案，上下文成本也是有界的。

## 一個 director 真實例子

出廠的預設 director profile 示範了這些範式：

```jsonc
{
  "mode": "director",

  "skills": {
    "visible": [
      "director-anti-cliche-zh",
      "director-character-voice-zh",
      "director-no-meta-zh",
      "director-output-discipline-zh",
      "director-zh-style-baseline"
    ]
  },

  "mainAgent": {
    "systemPrompt": "<極薄的主代理身份>",
    "skills": {
      "visible": ["+", "director-turn-workflow-zh", "director-dispatch-protocol-zh"]
    }
  },

  "subAgents": [
    {
      "id": "voice_critic",
      "skills": { "visible": ["+", "voice-critic-method-zh"] }
    },
    {
      "id": "memory_curator",
      "skills": { "visible": ["+", "event-summary-rules-zh"] }
    },
    {
      "id": "plot_brainstormer",
      "skills": { "visible": ["+", "plot-brainstormer-method-zh"] }
    }
    // …還有 14 個子代理，形狀一致
  ]
}
```

讀這份策略：

- **每個 agent 都拿到 5 條共享寫作規則** —— 透過模式級 visible。
- **主代理額外拿到** 回合工作流 + 派遣協議 —— 它特有的職責。
- **每個子代理額外拿到自己的方法 Skill** —— `voice_critic` 讀 `voice-critic-method-zh`，`memory_curator` 讀 `event-summary-rules-zh`，依此類推。

沒有任何一個 agent 的 `skills.visible` 重複模式級條目。`"+"` 前綴讓每條 per-agent 覆寫都很短 —— 只列出這個 agent 特有的部分，而不是整摞疊。

## 各模式行為

每種編排器模式在略微不同的位置注入目錄，但策略解析是一致的：

| 模式 | 目錄注入位置 | 每 agent 覆寫位置 |
|---|---|---|
| **director** | 主代理系統訊息 + 派遣時每個子代理的系統訊息 | `mainAgent.skills` + 每個 `subAgents[].skills` |
| **loop** | 唯一的 loop agent 的系統訊息 | `loopAgent.skills` |
| **spec** | 執行時每個節點的系統訊息 | 每個 `nodes[].skills`（按節點） |
| **agenda** | Planner + 每個被派遣 worker 的系統訊息 | `planner.skills` + `workers[].skills` |
| **single** | 該單一節點的系統訊息 | `node.skills` |

所有模式下，沒有顯式 `skills.skills` 欄位的 agent 都透過上文規則 1 繼承模式級預設值。

::: info 審查節點跳過目錄注入
spec 模式的審查節點（review nodes）的目錄注入是有意跳過的 —— 審查是結構化的判斷任務而不是內容生成任務，給它的 prompt 加 `<available_skills>` 只是雜訊。審查節點仍然可以顯式呼叫 `skill_list` 或 `skill_read` 看到 Skill，但自動注入的目錄被省略。
:::

## 失效參照

`skills.visible` 是名字清單 —— 每個 Skill 在派遣時才校驗物理存在。

- **缺失的 Skill**（改名 / 刪除 / 未安裝）：靜默過濾掉。agent 看不到；沒有錯誤。
- **在編輯器 UI 裡**：該條目變灰，帶 tooltip 「該 Skill 未安裝」。

這種「軟失敗」行為是有意的。意味著：

- 匯入一張你跳過其內嵌 Skill 的角色卡不會壞任何東西 —— 參照只是懸空。
- 刪除一個 Skill 不需要清理每一個參照它的 profile。
- 改名一個 Skill 是一步操作 —— 參照變失效，但派遣繼續工作，直到你選擇修。

## 編輯策略

在編排器面板裡，每個 agent 的設定卡顯示一行 **Skill**：

![每 agent 的 Skill chip，帶 + 繼承標記](/_screenshots/skills/agent-skill-chips.png)

- **`+`** chip —— 顯式的「繼承模式預設值」標記（`visible` 以 `"+"` 開頭時出現）。
- 每個具名 Skill 一個 chip。點擊移除；點 **新增……** 從你已安裝的庫存裡挑。
- **禁用** 行 —— 同樣的 chip，獨立清單。

面板頂部的模式級 **Skill** 行也一樣。編輯它更新 `mode.skills`；編輯某個 agent 的行更新該 agent 的覆寫。

要讓 AI 幫你編輯，[迭代工作台](/zh-TW/features/orchestrator/iteration-studio) 自帶 Skill 繫結工具（`skill_bind_to_agent`、`skill_unbind_from_agent`、`skill_set_mode_defaults`）—— 用自然語言描述需求，AI 透過工具呼叫 patch 你的策略。

## 模式切換會失效

編排器從一種模式切到另一種（例如 director → loop）時，執行時把快取的解析結果作廢。下一次派遣按新模式的策略重新建構目錄。UI 也按新模式的 profile 重新渲染 **Skill** 行，所以編輯永遠反映當前激活的模式。

意味著 `director.mainAgent.skills` 區塊切到 loop 模式後不會跟過去。每種模式自己一份策略。許多使用者在多種模式之間保持類似形狀（同樣的共享 Skill、同樣的 per-agent 專屬），但編輯是按模式獨立的。

## 相關

- [Skills 概覽](/zh-TW/features/skills/) —— 什麼是 Skill、三種作用域
- [創作 Skill](/zh-TW/features/skills/authoring) —— 寫自己的
- [Skill 管理](/zh-TW/features/skills/management) —— 安裝 / 遷移 / 刪除
- [Director 模式](/zh-TW/features/orchestrator/director) —— 出廠自帶完整 Skill 整合的典型多 agent profile
- [AI 迭代工作台](/zh-TW/features/orchestrator/iteration-studio) —— 用自然語言 AI 編輯 patch 策略
- [Skill 擴充套件 API](/zh-TW/development/extension-api/skills) —— 從擴充套件程式設計式編輯策略
