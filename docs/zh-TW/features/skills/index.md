# Skills

**Skill** 是一個緊湊、自包含的知識包，agent 可以按需讀取。把每條寫作規則、每條口吻約定、每份反八股清單全塞進一份巨型系統提示詞裡是常見痛點；Skill 讓你把它們拆成命名的包，由 agent 在真正需要的時候去拉。

Luker 的 Skill 格式與 [Anthropic Claude Skills](https://www.anthropic.com/news/skills) 相容 —— 同樣的 `SKILL.md` + frontmatter + 可選子檔案結構 —— 所以 Claude Code 裡寫的 Skill 放進 Luker 能直接用，Luker 裡寫的 Skill 放進 Claude Code 也不用轉換。

編排器自帶的預設 director profile 就是建立在 Skill 之上的：一段極薄的主代理身份提示詞 + 24 份出廠 Skill，agent 按名字讀取。你也可以把自己的 profile 調成同樣的樣子。

## 為什麼有這玩意

多 agent 編排裡最常見的痛點之一是「這個 prompt 兩千多行，我不敢動它」。所有可重用的規則 —— 反八股清單、角色口吻約定、七步回合工作流、事件摘要格式 —— 過去都內聯在 `systemPrompt` 欄位裡，經常在多個子代理裡重複拷貝。

Skill 把這整塊拆開。agent 的身份留在 `systemPrompt`（「你是口吻評審，這是你的職責」）；可重用規則放進 Skill 檔案裡。agent 在真正需要時透過 `skill_read` 讀取，規則的編輯、版本管理、分發都跟消費它的 prompt 解耦。

## Skill 的結構

一個 Skill 是一個目錄：

```
director-anti-cliche-zh/
├── SKILL.md          # 必需 —— frontmatter + 正文
├── references/       # 可選 —— 輔助清單、更長的參考資料
├── examples/         # 可選 —— 真實範例
└── assets/           # 可選 —— 二進位附件
```

`SKILL.md` 是唯一必需的檔案。它帶著 Anthropic 標準的 YAML frontmatter：

```markdown
---
name: director-anti-cliche-zh
description: 敘事寫作的反八股模式。
license: MIT
metadata:
  author: Luker Team
  version: 1.0.0
  tags: [writing-rules, zh, director]
---

# director-anti-cliche-zh

本 Skill 記錄了預設 director profile 主動防範的八股模式……
```

- `name` 和 `description` 是必需的。
- `license` 和 `metadata.*` 是可選的，遵循 Anthropic 標準。Luker 不引入私有命名空間。
- 正文就是「契約」—— agent 讀取這個 Skill 時，正文就是它消費的內容。要寫得直接、命令式；把「什麼時候用」「怎麼用」「優先使用哪些工具」等指導都放進正文。

完整的寫作手冊見 [創作 Skill](/zh-TW/features/skills/authoring)。

## 三種作用域

Skill 物理上存放在 `data/<user>/skills/<scope>/`。Luker 有三種作用域：

| 作用域 | 存放位置 | 何時生效 | 用途 |
|---|---|---|---|
| `global` | `data/<user>/skills/global/<name>/` | 始終可見 | 通用寫作規則、反八股清單、共享方法文件 |
| `preset` | `data/<user>/skills/preset/<api>/<preset>/<name>/` | 僅在選中該預設時 | 跟某個 Chat Completion 預設強綁的規則（如為 Claude 4 derive 的編排器預設） |
| `character` | `data/<user>/skills/character/<file>/<name>/` | 僅在載入該角色卡時 | 角色卡專屬設定、口吻約定、世界內俚語 |

當 agent 按名字查找 Skill 時，執行時遍歷三種作用域，套用**後者優先**的優先順序：`character` 覆蓋 `preset`，`preset` 覆蓋 `global`。所以一個名為 `voice-rules` 的 `character` 作用域 Skill 會在該卡載入期間悄悄接管同名的 `global` 版本，切換卡片後再退回。

重要：編排器 profile 裡寫 `skills.visible: ["voice-rules"]` 時，它**只按名字**參照 —— 沒有作用域前綴。把 Skill 在作用域之間挪動永遠不會破壞參照。

### 預設 / 角色卡作用域的 Skill 會隨它們一起匯出

`preset` 和 `character` 作用域不只是你自己存放 Skill 的目錄——它們打包匯出時，Skill 也跟著走：

- **預設**作用域的 Skill 會寫進預設的 JSON。匯出預設、發給別人、對方匯入——他們也得到你的 Skill。
- **角色**作用域的 Skill 會寫進角色卡 PNG 的 metadata。匯出 PNG、分享卡片，你的 Skill 跟著卡走。

所以如果你寫的寫作紀律 Skill 依賴某個預設的提示詞結構，或者某條嗓音規則只對一張卡有意義，按這個作用域寫就夠——分享是順帶的事，不用單獨處理。詳見 [把 Skill 打包進預設 / 卡片](/zh-TW/features/skills/management#embed-export-into-presets-and-cards)。

## agent 如何看到 Skill

編排器 profile 在兩個層級帶著 `skills` 策略：

- **模式級** —— 適用於該模式下每個 agent（主代理 + 子代理）的預設值。
- **每 agent 覆寫** —— 每個 agent 可以釘自己的 `visible` / `deny` 清單。開頭的 `"+"` 表示繼承模式預設值再追加。

執行時在派遣時把策略與物理庫存對帳，給 agent 交付一份過濾後的清單。由此帶來兩件事：

1. **一份精簡目錄被自動注入到 agent 的系統提示詞**—— `<available_skills>` 區塊逐行列出每個可見 Skill 的名稱和描述。agent 不需要花一輪 `skill_list` 工具呼叫就知道有什麼可用。
2. **三個函式工具 —— `skill_list`、`skill_read`、`skill_search` —— 提供給 agent**。它們被限制在可見集內；agent 拿不到策略之外的 Skill。`skill_read` 是主力 —— agent 需要正文時就呼叫它。它還接一個 `path` 引數，所以帶子檔案（`references/`、`examples/` 等）的 Skill 可以選擇性按路徑讀：`skill_read({ name: "my-skill", path: "references/checklist.md" })`。skill 作者在 SKILL.md 裡寫明哪些子檔案值得拉、什麼時候拉 —— 見 [創作 Skill](/zh-TW/features/skills/authoring#何時使用子檔案)。

策略解析的完整規則見 [編排器整合](/zh-TW/features/skills/orchestrator-integration)。

## 分層概覽

```d2
direction: down

user: "使用者安裝 / 自創" {
  style.fill: "#e1f5ff"
  fs: "data/<user>/skills/\n  global / preset / character" { style.fill: "#fffde7" }
}

bundled: "Luker 出廠自帶" {
  style.fill: "#fff3e0"
  pop: "default/skills/global/*\n（首次安裝時落到 global 作用域）" { style.fill: "#fffde7" }
}

orch: "編排器 profile" {
  style.fill: "#e8f5e9"
  mode: "mode.skills.visible / deny" { style.fill: "#fffde7" }
  agent: "agent.skills.visible（+ 繼承）" { style.fill: "#fffde7" }
}

runtime: "派遣時解析器" {
  style.fill: "#fce4ec"
  walk: "遍歷三個作用域\n（後者優先）" { style.fill: "#fffde7" }
  policy: "套用 visible / deny" { style.fill: "#fffde7" }
  catalog: "<available_skills> 目錄\n注入到系統提示詞" { style.fill: "#fffde7" }
}

agent: "執行中的 agent" {
  style.fill: "#f3e5f5"
  tools: "skill_list / skill_read / skill_search" { style.fill: "#fffde7" }
}

bundled.pop -> user.fs: "首次安裝出廠匯入\n（之後只能透過按鈕）"
user.fs -> runtime.walk
orch.mode -> runtime.policy
orch.agent -> runtime.policy
runtime.walk -> runtime.policy
runtime.policy -> runtime.catalog
runtime.catalog -> agent.tools
```

## 讀 vs 寫

agent 只能透過三個函式工具**讀取**Skill，無法修改。這是有意為之 —— Skill 是使用者管理的底層素材，只有使用者（或者代表使用者工作的 AI 助手，比如 [迭代工作台](/zh-TW/features/orchestrator/iteration-studio) 的 Skill 工具）才能改 Skill 內容。

面向使用者的寫入入口：

- **編排器設定裡的 Skill 管理子面板** —— 安裝、編輯、改名、遷移作用域、刪除。
- **內嵌 Skill 編輯器** —— 檔案樹 + Markdown 編輯器，編輯 SKILL.md 和子檔案。
- **匯入 / 匯出** —— 把一個或多個 Skill 打包進角色卡或預設；匯入時從內嵌負載裡抽出 Skill。詳見 [Skill 管理](/zh-TW/features/skills/management)。
- **迭代工作台工具** —— 讓迭代工作台的 AI「把這條寫作規則抽成一個 Skill」時，它透過一組專門的工具完成抽取，並把 agent 的 `systemPrompt` 同步改寫。

## 24 個出廠 Skill

全新的 Luker 安裝會把 `data/<user>/skills/global/` 填入 24 個出廠預設 Skill，全部由 director profile 原先的內聯 prompt 拆解而來。它們分三類：

- **共享類（5 個）**—— `director-anti-cliche-zh`、`director-character-voice-zh`、`director-no-meta-zh`、`director-output-discipline-zh`、`director-zh-style-baseline`。所有預設 director 子代理都可見。
- **主代理類（2 個）**—— `director-turn-workflow-zh`、`director-dispatch-protocol-zh`。僅主代理可見。
- **每子代理一份（17 個）**—— 每個預設子代理一份方法/契約 Skill（如 `voice-critic-method-zh`、`event-summary-rules-zh`、`chat-scout-method-zh`）。

這些出廠 Skill 從原 director 預設值**逐字搬出** —— 沒有改寫、沒有壓縮 —— 所以基於 Skill 的新版 director profile 跟未拆分前同強度。詳見 [Director 模式 → 預設 Skill](/zh-TW/features/orchestrator/director#預設 Skill)。

## 下一步去哪

- **想寫自己的 Skill？** → [創作 Skill](/zh-TW/features/skills/authoring)
- **想安裝、分享或遷移 Skill？** → [Skill 管理](/zh-TW/features/skills/management)
- **想把某個 Skill 掛到具體 agent？** → [編排器整合](/zh-TW/features/skills/orchestrator-integration)
- **在寫擴充套件？** → [Skill 擴充套件 API](/zh-TW/development/extension-api/skills)
- **想看它實際跑起來？** → [Director 模式](/zh-TW/features/orchestrator/director)
