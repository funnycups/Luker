# 創作 Skill

一個 Skill 是一個目錄：一份必需的 `SKILL.md`，加上可選的子資料夾。創作 Skill 就是給它命名、寫 frontmatter、寫一段 Agent 能讀的正文。

本頁說明目錄約定、frontmatter 欄位、正文寫法，以及什麼時候該拆子檔案。

## 從哪裡開始

不必手敲全部內容。常見做法：

- **讓 AI 起草**：在 [AI 迭代工作台](/zh-TW/features/orchestrator/iteration-studio#用工作台編寫-skill) 裡描述想要的效果，它會起草 `SKILL.md`、安裝好，並在你要求時掛到對應 Agent。
- **自己寫**：在 [Skill 管理面板](/zh-TW/features/skills/management) 新增，完全控制措辭與結構。

## 目錄配置

```text
my-skill-name/
├── SKILL.md          # 必需：frontmatter 與正文
├── references/       # 選用：輔助清單、較長規格
├── examples/         # 選用：Agent 可以讀取的真實範例
├── assets/           # 選用：圖片、PDF 等附件
└── scripts/          # 選用：預留，目前不會執行
```

只有 `SKILL.md` 是必需的。其他資料夾是組織約定，與 Anthropic 的配置一致，方便分享與遷移。

## Frontmatter

`SKILL.md` 以 YAML frontmatter 開頭：

```markdown
---
name: my-skill-name
description: 一句話摘要，Agent 會在目錄裡看到。
license: MIT
metadata:
  author: 你的名字
  version: 1.0.0
  tags: [writing-rules, zh]
---

# my-skill-name

正文從這裡開始。
```

| 欄位 | 必需 | 限制 | 說明 |
| --- | --- | --- | --- |
| `name` | 是 | 小寫字母、數字、`-`、`_` | 必須與目錄名稱一致。 |
| `description` | 是 | 一句話 | 顯示在 Agent 看到的目錄裡。寫給 Agent 看，說明這個 Skill 什麼時候相關。 |
| `license` | 否 | 任意字串 | 準備分享時填寫。 |
| `metadata.author` | 否 | 字串 | 作者資訊。 |
| `metadata.version` | 否 | 版本字串 | 語意變更時更新。 |
| `metadata.tags` | 否 | 字串陣列 | 便於搜尋。 |

## 正文

正文是 Agent 實際讀到的內容。寫成直接、可執行的規則，不要寫成百科條目。一個有效的結構：

1. **這個 Skill 做什麼**：一段話，讓 Agent 確認自己選對了。
2. **核心規則**：編號清單、表格或檢查清單。具體、可執行，Agent 會照字面執行。
3. **範例**：用「錯誤 / 正確」的對照讓標準可見。
4. **何時讀取子檔案**：如果打包了參考資料，明確說明什麼情況下讀哪一份。

### 語氣

Skill 寫給 LLM 看，不寫給人類維運手冊的讀者看。

- 用命令式，不用描述式。「避免 X」比「X 通常被認為不太合適」更有效。
- 不寫元解釋。「這是一個很棒的 Skill，將幫助你……」是浪費上下文；Agent 已經決定讀了，直接告訴它該做什麼。

### 長度

把最重要的內容放在最前面。Agent 讀取時可能只拿到正文的開頭部分，後面的內容未必進入上下文。

正文保持在能說清規則的規模。規則變長時，把擴充清單、長範例和參考資料移到子檔案，而不是讓 `SKILL.md` 無限成長。

## 何時使用子檔案

- **只是偶爾查閱**：每次都需要的基本規則放在 `SKILL.md`，特定場景才查的資料放在 `references/`。
- **內容很長**：完整範例、長清單放在 `examples/` 或 `references/`。
- **二進位附件**：圖片、字型、PDF 放在 `assets/`。

在 `SKILL.md` 裡明確指向子檔案，並說明讀取時機：

```markdown
## 何時讀取額外檔案

- `references/cliche-deep-list.md`：比本檔案更長的禁用措辭清單。
  草稿反覆踩到未列出的模式時再讀。
- `examples/before-after.md`：資料化文字與活人文字的對照例。
  工作階段開始時讀一遍校準。
```

## 範例：反制式規則

一個單檔案的寫作規則 Skill 可以依「規則家族」組織：資料化描寫、契約詞彙、昇華式總結、AI 自造標籤各佔一節，每節給出具體例子。規則總量不大時，全部放進 `SKILL.md` 即可。

這類 Skill 通常設為全域或模式層級可見，讓團隊裡的每個 Agent 都遵循同一套寫作標準。

## 範例：事件摘要規則

事件摘要 Skill 面向負責整理記憶的 Agent。正文先說明摘要的定位，例如「它是索引，不是回放」，再給出寫作步驟和反覆述規則，並用「錯誤 / 正確」的對照說明細微差別。

這類 Skill 只掛給真正需要它的 Agent，不必讓所有 Agent 都讀取。

## 選擇作用域

- **全域**：每次聊天都想用的通用規則。
- **預設**：只在搭配某份聊天補全預設時有意義，隨預設匯出。
- **角色卡**：角色專屬設定或口吻規則，隨角色卡匯出。

作用域可以隨時遷移，引用依名稱解析，遷移後無需改動。

## 驗證與安全

安裝或儲存時，Luker 會檢查 frontmatter 能否解析、名稱是否與目錄一致、檔案路徑是否留在 Skill 目錄內，以及大小是否超過限制。驗證失敗會回滾，不會留下半個 Skill。

`scripts/` 會被辨識但不會執行。介面會在 Skill 攜帶指令碼時顯示風險標記。

## 相關頁面

- [Skills 概覽](/zh-TW/features/skills/) —— 什麼是 Skill、作用域與可見性
- [Skill 管理](/zh-TW/features/skills/management) —— 安裝、匯入、匯出、遷移
- [編排器整合](/zh-TW/features/skills/orchestrator-integration) —— 把 Skill 掛到指定 Agent
- [Skill 擴充 API](/zh-TW/development/extension-api/skills) —— 開發者介面
