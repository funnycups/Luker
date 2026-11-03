# Skills

Skill 是 Agent 依需要讀取的知識包。把每條寫作規則、口吻約定和反制式清單都塞進一份超長系統提示詞，會讓提示詞難以維護，也會在多個 Agent 之間重複複製。Skill 把這些規則拆成命名的小包，Agent 只在真正需要時讀取。

Luker 的 Skill 格式與 Anthropic Claude Skills 相容：一份 `SKILL.md` 加可選的子檔案。編排器預設的 Director 設定就建立在 Skill 之上：主代理只保留很薄的身分提示詞，具體寫作規則放在 Skill 裡，依名稱讀取。

## 結構

一個 Skill 是一個目錄：

```text
my-skill/
├── SKILL.md          # 必需：frontmatter 與正文
├── references/       # 選用：較長的參考資料
├── examples/         # 選用：真實範例
└── assets/           # 選用：附件
```

`SKILL.md` 以 YAML frontmatter 開頭，`name` 和 `description` 必需。正文是 Agent 實際讀到的內容，應當寫成直接、可執行的規則，而不是百科條目。

## 作用域

Skill 可以放在三個作用域：

| 作用域 | 何時生效 | 用途 |
| --- | --- | --- |
| 全域 | 始終可見 | 通用寫作規則、反制式清單、共享方法 |
| 預設 | 選取該聊天補全預設時 | 與某份預設強繫結的規則 |
| 角色卡 | 載入該角色卡時 | 角色專屬設定、口吻約定、世界內用語 |

同名 Skill 依角色卡、預設、全域的順序覆蓋。引用只寫名稱，不寫作用域，所以把 Skill 在作用域之間移動不會破壞引用。

預設與角色卡作用域的 Skill 會隨預設或角色卡一起匯出，接收方無需另外安裝。

```d2
direction: down

bundled: "Luker 自帶的 Skill" {
  style.fill: "#fff3e0"
  pop: "首次安裝時進入全域作用域" {
    style.fill: "#fffde7"
  }
}

user: "本機安裝的 Skill" {
  style.fill: "#e1f5ff"
  fs: "全域 / 預設 / 角色卡" {
    style.fill: "#fffde7"
  }
}

profile: "編排設定" {
  style.fill: "#e8f5e9"
  mode: "模式層級可見範圍" {
    style.fill: "#fffde7"
  }
  agent: "Agent 層級可見範圍" {
    style.fill: "#fffde7"
  }
}

runtime: "派發時解析" {
  style.fill: "#fce4ec"
  walk: "依作用域優先順序合併" {
    style.fill: "#fffde7"
  }
  policy: "套用可見與停用規則" {
    style.fill: "#fffde7"
  }
  catalog: "生成 Skill 目錄\n注入 Agent 上下文" {
    style.fill: "#fffde7"
  }
}

agent: "執行中的 Agent" {
  style.fill: "#f3e5f5"
  tools: "依名稱讀取 Skill 正文" {
    style.fill: "#fffde7"
  }
}

bundled.pop -> user.fs: "匯入"
user.fs -> runtime.walk
profile.mode -> runtime.policy
profile.agent -> runtime.policy
runtime.walk -> runtime.policy
runtime.policy -> runtime.catalog
runtime.catalog -> agent.tools
```

## Agent 如何看到 Skill

編排器可以限制每個 Agent 能看到哪些 Skill。執行時把可見 Skill 的名稱和描述作為一份簡短目錄注入 Agent 的上下文，Agent 需要正文時再依名稱讀取。它只能讀取可見範圍內的 Skill，無法越過限制。

Director 的預設設定已經為不同 Agent 繫結好各自的 Skill。其他模式預設讓 Agent 看到全部已安裝 Skill，可以在編排編輯器裡收緊。

## 出廠 Skill

Luker 自帶一組用於角色扮演的 Skill，涵蓋反制式寫作、角色口吻、輸出紀律、事件摘要等規則。首次啟動時它們會安裝到全域作用域；之後可以在 Skill 管理面板瀏覽、匯入或覆蓋。

## 下一步

- [創作 Skill](/zh-TW/features/skills/authoring) —— 目錄結構、frontmatter 與正文寫法
- [管理 Skill](/zh-TW/features/skills/management) —— 安裝、匯入、編輯與打包
- [編排器整合](/zh-TW/features/skills/orchestrator-integration) —— 讓指定 Agent 看到指定 Skill
