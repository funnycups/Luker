# 創作 Skill

一個 Skill 是一個目錄：一份必需檔案（`SKILL.md`）+ 可選子資料夾。創作一個 Skill 就是給它取名字、寫 frontmatter、寫一段 agent 能讀的正文。僅此而已。

本頁講 Luker（與 Anthropic）期望的約定，沿途要做的選擇，以及拿兩個出廠 Skill 逐一拆解的真實例子。

## 寫一個 skill 的兩種方式

你不一定要手敲 SKILL.md。大多數使用者從下面兩條路之一開始：

| 路徑 | 在哪 | 適合 |
|---|---|---|
| **讓 LLM 替你寫** | [AI 迭代工作台](/zh-TW/features/orchestrator/iteration-studio#用工作台編寫-skill) | 在工作台裡用一句話告訴它你想要什麼；它起草 SKILL.md、安裝好，順便（如果你交代了）掛到對應位置。推薦先用這條。 |
| **自己手寫** | [Skill 管理面板 → 新建](/zh-TW/features/skills/management#tab-1-installed-已安裝) | 你已經清楚知道想要哪些段落、想自己定措辭、想完全控制文字。 |

![內嵌 Skill 編輯器 — 檔案樹 + 正文區](/_screenshots/skills/rp-demo-8.5-editor-body-pasted.png)

詳見 [《用 skills 調教 RP 輸出》](/zh-TW/recipes/rp-skills-walkthrough)。

## 目錄佈局

```
my-skill-name/
├── SKILL.md          # 必需 —— frontmatter + Markdown 正文
├── references/       # 可選 —— 輔助清單、更長的規範
├── examples/         # 可選 —— agent 可拉取的真實範例
├── assets/           # 可選 —— 二進位附件（圖片、PDF）
└── scripts/          # 可選 —— 前向相容預留，v1 不會執行
```

只有 `SKILL.md` 是必需的。其它資料夾是約定 —— Luker 不強制，但和 Anthropic 佈局一致，Skill 保持可移植。

::: info 子資料夾共用同一個 `skill_read` 工具
agent 不會按子資料夾得到不同的工具。它們用 `skill_read({ name, path })` 加相對路徑：`skill_read({ name: "my-skill", path: "references/checklist.md" })`。子資料夾純粹是組織手段。
:::

## Frontmatter —— Anthropic 標準

`SKILL.md` 以 YAML frontmatter 開頭：

```markdown
---
name: my-skill-name
description: 一句話摘要，agent 會在目錄裡看到。
license: MIT
metadata:
  author: 你的名字
  version: 1.0.0
  tags: [writing-rules, en]
---

# my-skill-name

正文從這裡開始。
```

| 欄位 | 必需 | 約束 | 備註 |
|---|---|---|---|
| `name` | 是 | 小寫 ASCII 字母、數字、`-`、`_`；不超過 128 字元 | 必須與目錄名一致。編排器 `skills.visible` 參照這個欄位。 |
| `description` | 是 | 一句話 | 顯示在自動注入的 `<available_skills>` 目錄裡。寫給 **agent** 看，不是給使用者看 —— 解釋這個 Skill 什麼時候相關。 |
| `license` | 否 | 任意字串（自由格式） | Anthropic 標準。準備分享出去時再用。 |
| `metadata.author` | 否 | 字串 | Anthropic 標準。 |
| `metadata.version` | 否 | semver 風格的字串 | Anthropic 標準。語意變更時記得 bump。 |
| `metadata.tags` | 否 | 字串陣列 | 可搜尋提示。 |

## 寫正文

正文就是契約。agent 呼叫 `skill_read({ name })` 時，正文是它看到的內容（再加 frontmatter 的一小段 JSON 風格頭部）。把正文當作命令式文件來寫，不要當百科參考。

借鑒出廠 Skill 的寫法，一個有效的範式有四個段落：

1. **這個 Skill 幹什麼** —— 一段話，讓 agent 讀完就能確認選對了。
2. **核心規則 / 方法** —— 真正的契約。用編號清單、表格、清單。具體、可執行；agent 會照著字面意思跟隨。
3. **範例或失敗案例** —— 讓成功與失敗長什麼樣具體可見。出廠的 `director-anti-cliche-zh` 用 `✗ 錯` / `✓ 對` 的成對行展示。
4. **何時該讀哪份子檔案** —— 如果你打包了 `references/`，告訴 agent 哪個子檔案值得讀。

### 語氣 —— 寫給 agent 看

Skill 是給 LLM 看的，不是給人類維運手冊的讀者看的。兩條推論：

- **要命令式，不要描述式。** 「避免 X」比「X 通常被認為不太合適」更有效。出廠 Skill 就是這種語氣。
- **不要元解釋。** 一段以「這是一個很棒的 Skill，將幫助你……」開頭的正文是浪費 token。agent 都已經決定讀它了，直接告訴它該幹什麼。

### 長度與限額

伺服器強制的硬上限：

| 限額 | 數值 |
|---|---|
| `SKILL.md` 大小 | 512 KB |
| 單檔案大小 | 4 MB |
| 單個 Skill 總大小 | 16 MB |
| 每個 Skill 檔案數 | 100 |

大多數出廠 Skill 在 2–8 KB Markdown 之間。如果你的 Skill 逼近 100 KB，考慮拆分：在 `SKILL.md` 放 5–15 KB 的命令式正文，把長清單挪到 `references/<topic>.md`。agent 僅在相關時才選擇性地 `skill_read({ name, path: "references/..." })` —— 更便宜的上下文、更快的讀取。

### 讀取預算

`skill_read` 強制每次響應不超過 50 KB。超過的檔案返回時 `truncated: true`；agent 再用 `offset` 繼續呼叫。把正文寫成「最重要的內容放最前面」 —— 即使 agent 只讀了前 50 KB，也能拿到契約。

## 何時使用子檔案

子檔案（`references/`、`examples/`、`assets/`）能配得上自己的名號的場景：

- **它們只是偶爾被查閱。** 每次派遣都需要的通用清單屬於 `SKILL.md`；5% 場景下才查的專門後備資料屬於 `references/`。
- **它們很長。** 一份 30 KB 的真實範例會汙染 SKILL.md 的讀取；放進 `examples/`。
- **它們是二進位。** 圖片、字型、PDF 放 `assets/`。（Skill 裡的二進位檔案能存得下，但 agent 沒法透過 `skill_read` 讀出來。如果部署面暴露了 URL，可以作為附件 URL 使用。）

在 `SKILL.md` 裡，把 agent 顯式指向子檔案：

```markdown
## 何時讀取額外檔案

- `references/cliche-deep-list.md` —— 比本檔案 top-20 更長的禁用措辭延伸清單。
  草稿反覆踩到這裡沒列出的模式時再讀。
- `examples/before-after.md` —— 六對「資料人式文字」與「重寫為活人文字」的
  對照例。會話開始時讀一遍校準。
```

## 真實例子 1：`director-anti-cliche-zh`

這個出廠 Skill 是單檔案、約 3 KB 的 SKILL.md，沒有子檔案。它在整個預設 director profile 內強制反八股寫作規則。

frontmatter：

```yaml
---
name: director-anti-cliche-zh
description: 敘事寫作的反八股模式 —— 禁用措辭、AI 自造標籤、契約詞彙、昇華八股。
metadata:
  author: Luker Team
  version: 1.0.0
---
```

正文遵循「規則家族」結構：每一族主要的八股（資料人式文字、契約詞彙、昇華八股、AI 自造標籤）各得一個標題，並給出具體的雙語範例。沒有子檔案 —— 整套契約小到能塞進 `SKILL.md`。

這個 Skill 是模式級可見：每個預設 director 子代理（主代理、口吻評審、連貫性評審、劇情頭腦風暴員……）都看得到。它錨定了整支團隊的寫作標準。

## 真實例子 2：`event-summary-rules-zh`

這個出廠 Skill 是更密的 ~12 KB 的 SKILL.md，同樣沒有子檔案。它是 `memory_curator` 子代理的寫作契約 —— V10 事件摘要紀律。

frontmatter：

```yaml
---
name: event-summary-rules-zh
description: 給 memory_curator 用的事件摘要寫作規則（V10）—— 7 步流程、閘門循環、反複述紀律。
metadata:
  author: Luker Team
  version: 1.0.0
---
```

正文先確立心智模型（「索引，不是回放」），然後定義帶閘門循環的 7 步寫作流程，再詳細列出反複述規則。關鍵是每條規則都附了真實範例 —— `✗ 錯` 與 `✓ 對` 並列 —— 因為這種紀律細微，只給抽象規則的 LLM 會一致地違反。

這個 Skill 是按子代理一對一：只有 `memory_curator` 在它的 `skills.visible` 裡有這一條（透過 `"+"` 繼承模式級預設值）。口吻評審不需要、連貫性評審不需要；只有 curator 需要，並且只在它真的在寫摘要時才需要。

## 選合適的作用域

新建 Skill 時要選一個作用域。經驗法則：

- **`global`** —— 個人使用的預設值。每次聊天都想用的通用規則。
- **`preset`** —— 該 Skill 僅在搭配特定 Chat Completion 預設時才有意義（一種模型特調的提示約定、依賴取樣器的文風規則）。匯出時跟著預設走。
- **`character`** —— 該 Skill 編碼了角色卡專屬設定或口吻規則。匯出時跟著角色卡走（PNG 元資料）。

作用域可以隨時改 —— Skill 管理子面板的**遷移到……**會做原子級 move。編排器 profile 裡的參照（僅按名字）在遷移後仍然有效。

## 校驗與安全

伺服器在安裝 / 寫入時校驗 Skill：

- frontmatter 必須能解析為 YAML。
- `name` 必須與目錄名一致。
- Skill 內部的檔案路徑不得逃出 Skill 目錄（不能 `..`，不能絕對路徑）。
- 大小限額（見上）快速失敗強制。
- `scripts/` 會被解析但**永不執行** —— 前向相容預留。UI 在 Skill 攜帶 scripts 時顯示風險標記。

如果校驗失敗，安裝或寫入原子回滾（寫入走 `.staging/` 目錄，校驗通過後才提交）。

## 相關

- [Skills 概覽](/zh-TW/features/skills/) —— 什麼是 Skill、三種作用域
- [Skill 管理](/zh-TW/features/skills/management) —— 安裝、匯入、匯出、遷移作用域
- [編排器整合](/zh-TW/features/skills/orchestrator-integration) —— 把 Skill 掛到 profile 上
- [Skill 擴充套件 API](/zh-TW/development/extension-api/skills) —— 程式設計式 `context.skills.*`
