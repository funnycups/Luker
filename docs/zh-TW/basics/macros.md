# 巨集

巨集（Macro）是寫成 <code v-pre>{{name}}</code> 形式的占位符，在 prompt 組裝時被替換為動態內容。它們出現在預設、世界書、角色卡、聊天訊息、斜線指令、正則替換裡——任何會被拼裝進 prompt 的文字欄位都能用巨集。請求到達 AI 時，所有的巨集都已經被替換成最終字串。

## Macros 2.0 / 實驗性巨集引擎

本頁的特性跑在 chevrotain 實作的新巨集引擎上——也就是 SillyTavern 引入的 **Macros 2.0**。Luker 預設啟用它，可以在「**使用者設定 → 聊天／訊息處理 → 實驗性宏引擎**」切換。

實驗性引擎**關掉**時，巨集仍然能用，但下面這些特性會退化到老的正則管線、不再可用：

| 特性 | 需要實驗性引擎 |
|---|---|
| <code v-pre>{{if}}</code> / <code v-pre>{{else}}</code> / <code v-pre>{{each}}</code> 控制流 | ✓ |
| 範圍巨集，如 <code v-pre>{{setvar::k}}body{{/setvar}}</code> | ✓ |
| 變數簡寫（<code v-pre>{{.var}}</code>、<code v-pre>{{$var}}</code>、運算式） | ✓ |
| 旗標（`#`、`/`、……） | ✓ |
| 巨集參數內巢狀巨集 | ✓ |
| 範圍巨集內容保留前導空白 | ✓ |
| 多遍展開時的穩定替換順序（從左到右、內層先於外層） | ✓ |
| 一般 <code v-pre>{{user}}</code>、<code v-pre>{{setvar::name::value}}</code>、<code v-pre>{{time}}</code>…… | 兩種都能用 |

本頁裡某個特性看起來不生效，先檢查這個開關。

## 語法

巨集的形態是 <code v-pre>{{name}}</code>、<code v-pre>{{name::arg}}</code>，或 <code v-pre>{{name::arg1::arg2}}</code>。巨集名**大小寫不敏感**——<code v-pre>{{user}}</code>、<code v-pre>{{User}}</code>、<code v-pre>{{USER}}</code> 解析到同一個巨集。花括號和巨集名之間允許空白：<code v-pre>{{ user }}</code> 等價於 <code v-pre>{{user}}</code>。

巨集識別子必須符合 `^[a-zA-Z][\w-_]*$`——字母開頭，後接字母、數字、底線或連字號。唯一的例外是註解巨集 <code v-pre>{{//}}</code>。

### 參數

參數之間用 `::` 分隔：

```text
{{setvar::hp::50}}
{{datetimeformat::YYYY-MM-DD HH:mm:ss}}
{{roll::3d6+4}}
```

單個 `:` 作為兜底也認（<code v-pre>{{roll: 1d20}}</code>），但因為正文裡經常出現單冒號，**推薦用 `::`**。

逗號列表巨集（<code v-pre>{{random}}</code>、<code v-pre>{{pick}}</code>）兩種寫法都行：

```text
{{random::red::green::blue}}
{{random::red,green,blue}}
```

列表項裡要寫字面意義的逗號，跳脫為 `\,`。

### 巢狀巨集

巨集可以巢狀。內層先解析，結果作為外層的參數：

```text
{{setvar::greeting::Hello, {{user}}!}}
{{if {{getvar::showHeader}}}}# Header{{/if}}
{{each::{{getvar::roster}}}}- {{loop_value::name}}{{/each}}
```

巢狀深度沒有硬上限，但巢狀太深通常是巨集在做太多事——拆成中間變數。

### 範圍巨集

部分巨集（<code v-pre>{{if}}</code>、<code v-pre>{{each}}</code>、<code v-pre>{{trim}}</code>、<code v-pre>{{//}}</code>，以及大多數接受參數的自訂巨集）支援「開 / 閉標籤 + 中間內容」的寫法。中間的內容會作為**最後一個位置參數**傳給巨集：

```text
{{if .ready}}
角色已就緒。
{{/if}}

{{each::npcs}}
- {{loop_key}}: {{loop_value::hp}} HP
{{/each}}
```

預設情況下，範圍巨集的內容會被**自動整理**——首尾空白被剝掉，首個非空行的共同前導縮排會從所有行裡減掉。要原樣保留空白，在巨集名前加 `#` 旗標：

```text
{{#if .verbose}}
   這一段的縮排和首尾空白都會原樣保留。
{{/if}}
```

### 跳脫

要輸出字面的雙花括號，前面加反斜線：

```text
\{{not a macro}}
```

反斜線在後處理階段被去掉，原始的 <code v-pre>{{...}}</code> 字串原樣到達 AI。這是在 prompt 裡**教模型巨集語法**而不讓範例真的被執行的官方寫法。

### 老式標籤

5 個非花括號的老式標籤，會在巨集解析前被自動重寫：

| 老式 | 現代等價 |
|---|---|
| `<USER>` | <code v-pre>{{user}}</code> |
| `<BOT>` / `<CHAR>` | <code v-pre>{{char}}</code> |
| `<GROUP>` / `<CHARIFNOTGROUP>` | <code v-pre>{{group}}</code> / <code v-pre>{{charIfNotGroup}}</code> |

新內容用花括號寫法。老式標籤為向後相容保留。

<code v-pre>{{time_UTC+N}}</code> 同樣會被重寫為 <code v-pre>{{time::UTC+N}}</code>。

## 變數簡寫

除了完整的 <code v-pre>{{getvar::name}}</code> / <code v-pre>{{setvar::name::value}}</code>，Luker 還提供一套**變數運算式**簡寫，讀起來跟賦值語句一樣：

| 寫法 | 含義 | 回傳 |
|---|---|---|
| <code v-pre>{{.name}}</code> | 讀**區域**變數 | 目前值 |
| <code v-pre>{{$name}}</code> | 讀**全域**變數 | 目前值 |
| <code v-pre>{{.name = 5}}</code> | 賦值 | `''`（空字串） |
| <code v-pre>{{.name += 1}}</code> | 加（數值加 / 字串拼接） | `''` |
| <code v-pre>{{.name -= 1}}</code> | 減（僅數值；非數值會告警） | `''` |
| <code v-pre>{{.name++}}</code> | 自增 | `''` |
| <code v-pre>{{.name--}}</code> | 自減 | `''` |
| <code v-pre>{{.name ?? "default"}}</code> | 取值，**未定義**時取預設 | 值或預設 |
| <code v-pre>{{.name &#124;&#124; "default"}}</code> | 取值，**falsy** 時取預設 | 值或預設 |
| <code v-pre>{{.name ??= "x"}}</code> | 未定義時才賦值 | 新值 |
| <code v-pre>{{.name &#124;&#124;= "x"}}</code> | falsy 時才賦值 | 新值 |
| <code v-pre>{{.name == 5}}</code> | 字串相等 | `"true"` / `"false"` |
| <code v-pre>{{.name != 5}}</code> | 字串不等 | `"true"` / `"false"` |
| <code v-pre>{{.name > 5}}</code> | 數值 `>` | `"true"` / `"false"` |
| <code v-pre>{{.name >= 5}}</code> | 數值 `>=` | `"true"` / `"false"` |
| <code v-pre>{{.name < 5}}</code> | 數值 `<` | `"true"` / `"false"` |
| <code v-pre>{{.name <= 5}}</code> | 數值 `<=` | `"true"` / `"false"` |

`.` 永遠指 chat 區域變數，`$` 永遠指全域變數。兩個作用域不共用命名。

變數運算式可以和控制流組合：

```text
{{if .hp <= 0}}
你死了。
{{else}}
你還剩 {{.hp}} 點 HP。
{{/if}}
```

變數名允許底線和連字號，但最後一個字元必須是 word 字元：`my-var` 合法，`my-` 不合法（會和 `--` 自減運算子衝突）。

::: tip 預設值惰性求值
`??` 和 `||` 只在變數缺失 / falsy 時才會求 fallback 運算式。這能讓你跳過昂貴的預設值：<code v-pre>{{.cachedSummary ?? {{summary}}}}</code> 只在快取未命中時才會呼叫 <code v-pre>{{summary}}</code>。
:::

## 控制流

### 條件 — <code v-pre>{{if}}</code> / <code v-pre>{{else}}</code>

```text
{{if condition}}then-content{{/if}}
{{if condition}}then{{else}}otherwise{{/if}}
{{if !condition}}negated{{/if}}
```

condition 可以是：

- 字面值——空字串、`false`、`off`、`0` 視為 falsy；其他都 truthy。
- 已註冊的巨集名（不帶花括號）——<code v-pre>{{if description}}# Description{{/if}}</code> 會先把 `description` 解析出來。
- 巢狀巨集——<code v-pre>{{if {{getvar::showHeader}}}}...{{/if}}</code>。
- 變數簡寫——<code v-pre>{{if .ready}}</code>、<code v-pre>{{if $debugFlag}}</code>。
- 變數運算式——<code v-pre>{{if .hp > 0}}</code>。
- 以上任何一種前面加 `!` 取反——<code v-pre>{{if !.dead}}</code>。

::: tip 分支惰性求值
只有命中的那個分支裡的巢狀巨集才會被解析。<code v-pre>{{if .casting}}{{.mana -= 10}}{{/if}}</code> 在 `.casting` 為 false 時不會扣魔。把 <code v-pre>{{if}}</code> 套在昂貴或有副作用的巨集外面是安全的。
:::

### 迭代 — <code v-pre>{{each}}</code>

```text
{{each::collection}}
{{loop_key}}: {{loop_value}}
{{/each}}
```

`collection` 接受三種形式：

1. 內嵌 JSON 字面量——<code v-pre>{{each::["sword"，"shield"]}}</code> 或 <code v-pre>{{each::{"a":1，"b":2}}}</code>。
2. 變數名——<code v-pre>{{each::npcs}}</code> 讀區域變數 `npcs`（找不到 fallback 到全域），並把字串當 JSON 解析。
3. 解析結果為集合的巢狀巨集——<code v-pre>{{each::{{getglobalvar::roster}}}}</code>。

body 裡：

| 巨集 | 含義 |
|---|---|
| <code v-pre>{{loop_key}}</code> | 目前 key（陣列時是字串形式的索引） |
| <code v-pre>{{loop_value}}</code> | 目前值整體（物件會自動 JSON 字串化） |
| <code v-pre>{{loop_value::field}}</code> | 用點號路徑深入值，語義同 <code v-pre>{{getvar}}</code> |

巢狀 <code v-pre>{{each}}</code> 會自然遮蔽外層的 `loop_key` / `loop_value`。物件的迭代順序遵循 JavaScript 原生規則——字串 key 走插入順序，整數樣 key 走升序。

空集合或不可迭代值繪製為空字串。引擎**沒有**對迭代次數加保護——body 裡再次 <code v-pre>{{each}}</code> 自己負責防爆。

### 註解 — <code v-pre>{{//}}</code>

行內：

```text
{{// 這一行被忽略}}
```

範圍形式：

```text
{{//}}
多行註解。
裡面可以寫 {{巨集}} 和 \{跳脫\}——什麼都不會執行。
{{///}}
```

註解解析為空字串，內容原樣吃掉。給 prompt 裡要標註但不想讓 AI 看見的部分用。

## 變數

變數分兩種作用域：

- **區域**——按聊天獨立儲存，持久化在 `chat_metadata.variables` 裡。用來存聊天專屬狀態（HP、目前任務、回合數）。
- **全域**——跨所有聊天共享，存在擴充設定裡。用來存跨 chat 計數器、外掛設定。

### 讀

| 巨集 | 變數簡寫 | 用途 |
|---|---|---|
| <code v-pre>{{getvar::name}}</code> | <code v-pre>{{.name}}</code> | 讀區域 |
| <code v-pre>{{getglobalvar::name}}</code> | <code v-pre>{{$name}}</code> | 讀全域 |
| <code v-pre>{{hasvar::name}}</code>（別名 `varexists`） | — | `"true"` / `"false"` |
| <code v-pre>{{hasglobalvar::name}}</code>（別名 `globalvarexists`） | — | `"true"` / `"false"` |

不存在的變數回傳空字串。

### 寫

| 巨集 | 變數簡寫 | 用途 |
|---|---|---|
| <code v-pre>{{setvar::name::value}}</code> | <code v-pre>{{.name = value}}</code> | 設定區域 |
| <code v-pre>{{addvar::name::value}}</code> | <code v-pre>{{.name += value}}</code> | 加（數值）/ 拼接（字串）/ push（JSON 陣列） |
| <code v-pre>{{incvar::name}}</code> | <code v-pre>{{.name++}}</code> | +1 |
| <code v-pre>{{decvar::name}}</code> | <code v-pre>{{.name--}}</code> | -1 |
| <code v-pre>{{deletevar::name}}</code>（別名 `flushvar`） | — | 刪除 |

全域對應的有 `setglobalvar` / `addglobalvar` / `incglobalvar` / `decglobalvar` / `deleteglobalvar`。

`addvar` 是重載的：兩側都是數值字串時做數值加；現有值是 JSON 陣列時 push；否則按字串拼接。

::: tip 用 <code v-pre>{{noop}}</code> 錨住空白
拼接、範圍巨集 body、`+= "  text"` 等場景下，前導/尾端空白經常被引擎的自動整理或參數 trim 吃掉。在要保留的空白前後插一個 <code v-pre>{{noop}}</code>（解析為空字串）就能錨住它。例如 <code v-pre>{{addvar::story::{{noop}}  這是新的一段。}}</code>。
:::

### 結構化值的點號路徑

變數可以存任何 JSON-可序列化的值。當變數存的是 JSON 字串化的物件 / 陣列時，點號路徑直接生效：

```text
{{setvar::npcs::{"alice":{"hp":40},"bob":{"hp":30}}}}
{{getvar::npcs.alice.hp}}    → 40
{{getvar::npcs.alice}}        → {"hp":40}
{{getvar::list.0}}            → list 的第一個元素
```

對非 JSON 值用點號路徑時，會 fallback 到字面鍵查找——名字真的就是 `a.b` 的變數也能讀到。

這套和 <code v-pre>{{each}}</code> 配合很自然：一個 NPC 名冊、一份背包字典、一本任務日誌都可以塞進單一變數，每輪 prompt 組裝時再繪製到 prompt 或世界書條目裡：

```text
{{each::npcs}}
- {{loop_key}}: {{loop_value::hp}} HP
{{/each}}
```

### 逐樓層變數 {#per-message-variables}

原生 SillyTavern 裡，副作用巨集 <code v-pre>{{setvar::hp::50}}</code> 只在 *prompt 範本* 裡（預設、世界書、首樓）才會執行。AI 在回覆裡寫同樣的字面量什麼都不會發生，還會原樣顯示出來污染敘事。

Luker 用**逐樓層變數提取**解決這個問題。一條訊息（AI 回覆、使用者訊息、swipe、續寫）儲存時，Luker 會：

1. 掃描文字裡的 <code v-pre>{{setvar}}</code>、<code v-pre>{{addvar}}</code>、<code v-pre>{{incvar}}</code>、<code v-pre>{{decvar}}</code>、<code v-pre>{{deletevar}}</code>。
2. 把裡面巢狀的展示巨集（<code v-pre>{{user}}</code>、<code v-pre>{{getvar::other}}</code>、<code v-pre>{{time}}</code>……）對目前狀態求值。
3. 把 op 立刻 apply 到 `chat_metadata.variables`。
4. 在 `message.extra.var_ops` 上追加一條結構化記錄。
5. 從可見文字裡把字面量刪掉。

當你刪訊息、切 swipe、重新生成、編輯時，Luker 會**重播剩餘的 op log**，讓變數狀態跟可見的時間線保持一致。

這就是「**逐樓層變數**」面板背後的機制——每條帶 op 的訊息按鈕欄會出現一個燒瓶圖示，點開可以查看 / 編輯 / 刪除 / 新增 op。結果就是 AI 能直接在自己回覆裡擁有和修改狀態，而這個狀態能扛住使用者慣常的所有結構性操作。

完整的特性頁面（重播語義、swipe 生命週期、op 編輯器、推薦的創作範式）見 [逐樓層變數](/zh-TW/features/variable-op-log)。

::: warning 全域變數不會被提取
<code v-pre>{{setglobalvar}}</code> 這一家不在逐樓層提取的範圍內——全域狀態是跨 chat 的，跟某條訊息綁不到一起。它們保留原生 SillyTavern 的語義。
:::

## 內建巨集目錄

`/? macros` 會打開應用內瀏覽器，裡面是同一份描述、能搜尋、能看即時簽名。

### 名稱與參與方

| 巨集 | 回傳 |
|---|---|
| <code v-pre>{{user}}</code> | 目前 persona 名 |
| <code v-pre>{{char}}</code> | 目前角色名 |
| <code v-pre>{{group}}</code>（別名 `charIfNotGroup`） | 群聊成員名字（逗號分隔），單聊時是角色名 |
| <code v-pre>{{groupNotMuted}}</code> | 同 `group` 但排除被靜音的成員 |
| <code v-pre>{{notChar}}</code> | 除目前發言者之外的所有參與方 |

### 角色卡欄位

| 巨集 | 回傳 |
|---|---|
| <code v-pre>{{charDescription}}</code>（別名 `description`） | 描述欄位 |
| <code v-pre>{{charPersonality}}</code>（別名 `personality`） | 人格欄位 |
| <code v-pre>{{charScenario}}</code>（別名 `scenario`） | 場景欄位 |
| <code v-pre>{{persona}}</code> | 目前 persona 描述 |
| <code v-pre>{{charPrompt}}</code> | 主提示詞 override |
| <code v-pre>{{charInstruction}}</code> | Post-History Instructions override |
| <code v-pre>{{charDepthPrompt}}</code> | @ Depth Note |
| <code v-pre>{{charCreatorNotes}}</code>（別名 `creatorNotes`） | 作者筆記 |
| <code v-pre>{{charVersion}}</code> | 卡片版本號 |
| <code v-pre>{{charFirstMessage}}</code>（別名 `greeting`） | 主問候語（索引 0） |
| <code v-pre>{{greeting::N}}</code> | 第 N 條問候語——0 是主，1+ 是 alt greetings |
| <code v-pre>{{mesExamples}}</code> | 對話範例，啟用 instruct 時自動按 instruct 格式化 |
| <code v-pre>{{mesExamplesRaw}}</code> | 對話範例原文 |
| <code v-pre>{{original}}</code> | 角色級 override 裡的原始 prompt 內容。**單次有效**——同一次替換裡第二次呼叫回傳 `""`。只在 `charPrompt` / `charInstruction` 內有意義。 |

### 聊天狀態

| 巨集 | 回傳 |
|---|---|
| <code v-pre>{{lastMessage}}</code> | 最後一條訊息的文字 |
| <code v-pre>{{lastMessageId}}</code> | 最後一條訊息的索引 |
| <code v-pre>{{lastUserMessage}}</code> | 最後一條使用者訊息文字 |
| <code v-pre>{{lastCharMessage}}</code> | 最後一條角色訊息文字 |
| <code v-pre>{{firstIncludedMessageId}}</code> | 目前 context 視窗裡第一條訊息的索引 |
| <code v-pre>{{firstDisplayedMessageId}}</code> | 聊天捲動區裡第一條可見訊息的索引 |
| <code v-pre>{{lastSwipeId}}</code> | 最後一條訊息的 swipe 數（1-based） |
| <code v-pre>{{currentSwipeId}}</code> | 目前活躍 swipe 的索引（1-based） |
| <code v-pre>{{allChatRange}}</code> | 形如 `0-12` 的全訊息範圍字串，空 chat 時是空字串 |
| <code v-pre>{{idleDuration}}</code>（別名 `idle_duration`） | 距上一次使用者訊息的可讀時長 |
| <code v-pre>{{lastGenerationType}}</code> | `normal` / `impersonate` / `regenerate` / `quiet` / `swipe` / `continue` |

### 時間與日期

| 巨集 | 回傳 |
|---|---|
| <code v-pre>{{time}}</code> | 本地時間（locale 短格式，如 `3:45 PM`） |
| <code v-pre>{{time::UTC+2}}</code> | 指定 UTC 偏移的本地時間 |
| <code v-pre>{{date}}</code> | 本地日期（locale 長格式） |
| <code v-pre>{{weekday}}</code> | 星期名（`Monday`、……） |
| <code v-pre>{{isotime}}</code> | `HH:mm` |
| <code v-pre>{{isodate}}</code> | `YYYY-MM-DD` |
| <code v-pre>{{datetimeformat::FORMAT}}</code> | 用 moment.js 格式字串繪製目前時間 |
| <code v-pre>{{timeDiff::A::B}}</code> | 兩個時間之間可讀的絕對差 |

### 變數

完整列表見上面的 [變數](#變數) 一節。

### 控制流與工具

| 巨集 | 回傳 |
|---|---|
| <code v-pre>{{if cond}}…{{/if}}</code> | 條件內容 |
| <code v-pre>{{else}}</code> | 在 <code v-pre>{{if}}</code> 裡標記 else 分支 |
| <code v-pre>{{each::col}}…{{/each}}</code> | 迭代 |
| <code v-pre>{{loop_key}}</code> / <code v-pre>{{loop_value}}</code> / <code v-pre>{{loop_value::path}}</code> | 在 <code v-pre>{{each}}</code> body 裡 |
| <code v-pre>{{trim}}</code> | 行內：後處理時把巨集周圍的換行刪掉。範圍形式：回傳剝掉首尾空白後的內容 |
| <code v-pre>{{newline}}</code> / <code v-pre>{{newline::N}}</code> | 1 個或 N 個換行 |
| <code v-pre>{{space}}</code> / <code v-pre>{{space::N}}</code> | 1 個或 N 個空格 |
| <code v-pre>{{noop}}</code> | 空字串。在拼接 / 範圍巨集裡作為空白錨點很好用 |
| <code v-pre>{{reverse::text}}</code> | 反轉字串 |
| <code v-pre>{{//comment}}</code>（別名 `comment`） | 註解（輸出為空） |

### 隨機

| 巨集 | 回傳 |
|---|---|
| <code v-pre>{{roll::1d20}}</code> | 用 droll 語法擲骰（`1d6`、`3d6+4`……）。只有數字 `N` 時等價 `1dN`。每次繪製都重擲。 |
| <code v-pre>{{random::red::green::blue}}</code> | 隨機一項。每次繪製都重擲。 |
| <code v-pre>{{pick::red::green::blue}}</code> | 隨機一項，但**對同一 chat 同一位置穩定**。Seed = chat hash + content hash + 位置 + reroll seed。用 `/reroll-pick` 重置。 |

### 環境與 API

| 巨集 | 回傳 |
|---|---|
| <code v-pre>{{model}}</code> | 目前 model 識別字 |
| <code v-pre>{{maxPrompt}}</code>（別名 `maxPromptTokens`） | prompt 上下文 token 上限 |
| <code v-pre>{{maxContext}}</code>（別名 `maxContextTokens`） | 上下文 token 上限 |
| <code v-pre>{{maxResponse}}</code>（別名 `maxResponseTokens`） | 回應 token 上限 |
| <code v-pre>{{isMobile}}</code> | 行動裝置時 `"true"` |
| <code v-pre>{{hasExtension::name}}</code> | 指定擴充已載入**且**啟用時 `"true"` |
| <code v-pre>{{input}}</code> | 目前輸入框內容 |
| <code v-pre>{{outlet::key}}</code> | 指定 key 的世界書 outlet 內容 |
| <code v-pre>{{banned::word}}</code> | 給 Text Completion 後端註冊一個 banned word；回傳空 |

### 作者筆記與摘要

| 巨集 | 回傳 |
|---|---|
| <code v-pre>{{authorsNote}}</code> | 目前 chat 生效的作者筆記 |
| <code v-pre>{{charAuthorsNote}}</code> | 角色級作者筆記 |
| <code v-pre>{{defaultAuthorsNote}}</code> | 預設作者筆記 |
| <code v-pre>{{summary}}</code> | 聊天摘要——只在 Summarize 擴充載入後才註冊 |

### 推理範本

| 巨集 | 回傳 |
|---|---|
| <code v-pre>{{reasoningPrefix}}</code> | 推理段前綴 |
| <code v-pre>{{reasoningSuffix}}</code> | 推理段後綴 |
| <code v-pre>{{reasoningSeparator}}</code> | 推理與答案之間的分隔 |

### Instruct 與系統提示詞

下面這些只在對應的 instruct / sysprompt 開關打開時回傳內容。

| 巨集 | 回傳 |
|---|---|
| <code v-pre>{{systemPrompt}}</code> | 目前生效的系統提示詞。啟用 **Prefer Character Prompt** 時會切到 <code v-pre>{{charPrompt}}</code>。 |
| <code v-pre>{{defaultSystemPrompt}}</code>（別名 `instructSystem`、`instructSystemPrompt`） | 設定的預設系統提示詞 |
| <code v-pre>{{instructStoryStringPrefix}}</code> / <code v-pre>{{instructStoryStringSuffix}}</code> | story string 包裹 |
| <code v-pre>{{instructUserPrefix}}</code>（別名 `instructInput`） / <code v-pre>{{instructUserSuffix}}</code> | 使用者回合 sequence |
| <code v-pre>{{instructAssistantPrefix}}</code>（別名 `instructOutput`） / <code v-pre>{{instructAssistantSuffix}}</code>（別名 `instructSeparator`） | 助理回合 sequence |
| <code v-pre>{{instructFirstAssistantPrefix}}</code>（別名 `instructFirstOutputPrefix`） / <code v-pre>{{instructLastAssistantPrefix}}</code>（別名 `instructLastOutputPrefix`） | 首 / 末助理變體 |
| <code v-pre>{{instructFirstUserPrefix}}</code>（別名 `instructFirstInput`） / <code v-pre>{{instructLastUserPrefix}}</code>（別名 `instructLastInput`） | 首 / 末使用者變體 |
| <code v-pre>{{instructSystemPrefix}}</code> / <code v-pre>{{instructSystemSuffix}}</code> | 系統回合 sequence |
| <code v-pre>{{instructSystemInstructionPrefix}}</code> | last-system sequence |
| <code v-pre>{{instructStop}}</code> | stop sequence |
| <code v-pre>{{instructUserFiller}}</code> | 對齊填充 |
| <code v-pre>{{exampleSeparator}}</code>（別名 `chatSeparator`） / <code v-pre>{{chatStart}}</code> | context 範本標記 |

### 擴充註冊

只在對應擴充安裝且啟用時才存在：

| 巨集 | 來源 | 回傳 |
|---|---|---|
| <code v-pre>{{charPrefix}}</code> | Stable Diffusion | 正面圖像生成 prompt 前綴 |
| <code v-pre>{{charNegativePrefix}}</code> | Stable Diffusion | 負面圖像生成 prompt 前綴 |
| <code v-pre>{{summary}}</code> | Summarize | 儲存的聊天摘要 |

第三方擴充可以註冊更多巨集，巨集瀏覽器會標出每個巨集的來源。

## 旗標

旗標是放在開頭 <code v-pre>{{</code> 和巨集名之間的單字元，用來改變巨集的解析或求值行為。

### `/` — 閉合標記

標記一個標籤是範圍巨集的閉合半邊。和同名的開標籤配對，把兩者之間的內容作為巨集的**最後一個位置參數**傳入：

```text
{{if .ready}} ...body... {{/if}}
{{each::npcs}} ...body... {{/each}}
{{setvar::longText}} ...body... {{/setvar}}
```

閉合標籤自身不接受參數。

### `#` — 保留空白

**只對範圍巨集有效。** 預設情況下，引擎會先對 body 做自動整理（剝掉首尾空白，再把第一個非空行的共同前導縮排從所有行裡減掉）才交給 handler。加上 `#` 旗標會跳過這一步，body 原樣傳入：

```text
{{#if .verbose}}
    這 4 空格縮排
    以及首尾的換行都會原樣保留。
{{/if}}
```

這個旗標也相容老的 Handlebars 風格寫法 <code v-pre>{{#if …}}</code> —— 跟 <code v-pre>{{if …}}</code> + 不自動 trim 等價。

加在非範圍巨集前面時，`#` 被接受但沒有任何效果。

### `!` `?` `~` `>` — 預留未實作

| 旗標 | 預期含義 | 現狀 |
|---|---|---|
| `!` | 比同段文字裡的其他巨集先解析 | 僅解析 |
| `?` | 比其他巨集後解析 | 僅解析 |
| `~` | 標記為可重新求值 | 僅解析 |
| `>` | 把 `\|` 當輸出過濾器的管道 | 僅解析（見下文 *管道符*）|

這些 token 解析器能識別，但執行時沒有任何 hook 消費它們。<code v-pre>{{if !.dead}}</code> 裡的 `!` 是另一回事——那是 <code v-pre>{{if}}</code> 內部的條件取反，不是這裡的旗標。

旗標之間、旗標和巨集名之間都允許空白，多個可以組合：<code v-pre>{{ #each ::list}} … {{/each}}</code>。

### `|` — 管道符（參數終止符）

管道符 `\|` 在巨集參數裡有特殊語義，**即使沒加 `>` 旗標也一樣**。lexer 看到 `\|` 就會從「參數」模式切走，所以：

```text
{{getvar::name|filter}}
```

…會被解析為 `getvar` 巨集 + 單個參數 `name` + 一個名為 `filter` 的「過濾器」識別字。過濾器執行鏈沒接上，所以 `filter` 這個名字會被丟掉，整個巨集的行為等價於 <code v-pre>{{getvar::name}}</code>。直接後果是：**參數裡出現字面 `\|` 會把那個參數截斷**——想要在參數裡保留字面管道符，跳脫成 `\|`：

```text
{{setvar::menu::sword \| shield \| bow}}
```

::: warning 管道符是預留語法
今天寫 <code v-pre>{{macro\|uppercase}}</code> 並**不會**把內容轉大寫——只是不報錯地解析掉、丟掉過濾器名、把管道符前面的參數交給巨集。要做字串變換，寫一個註冊巨集，或者用 regex 擴充。完整的管道過濾鏈留給將來的引擎版本。
:::

## 斜線指令裡的管道巨集 —— <code v-pre>{{pipe}}</code>、<code v-pre>{{var::name}}</code>

在**斜線指令閉包**裡（STscript —— `/command1 | /command2 | …` 鏈式呼叫、Quick Reply 等），斜線指令作用域會再綁兩個巨集：

| 巨集 | 作用域 | 含義 |
|---|---|---|
| <code v-pre>{{pipe}}</code> | 斜線指令閉包 | 上一條指令的輸出 |
| <code v-pre>{{var::name}}</code> | 斜線指令閉包 | 用 `/let` / `/var` 建立的閉包內變數。**和聊天變數（用 <code v-pre>{{getvar::name}}</code> 存取）不是一回事** |

這兩個只在斜線指令解析器裡存在。不在 STscript 脈絡裡出現時，它們會原樣輸出。

STscript 裡的 `\|` 是指令管道符，那是指令解析器的特性，不是巨集引擎的。在單個巨集的參數內部，`\|` 按上面*管道符*那一節的規則處理。

## 解析語義

引擎一次性掃每段文字，從左到右展開巨集。

- **巢狀巨集**先解析，外層拿到的是已經求值完的字串參數。除非該巨集定義打開 `delayArgResolution`（目前只有 <code v-pre>{{if}}</code> 和 <code v-pre>{{each}}</code>）。
- **副作用巨集**（<code v-pre>{{setvar}}</code>、<code v-pre>{{addvar}}</code>、<code v-pre>{{incvar}}</code>、<code v-pre>{{decvar}}</code>、<code v-pre>{{deletevar}}</code>）立即生效，同一 pass 裡後面的巨集能讀到新值。
- **逐樓層提取**（見 [逐樓層變數](#per-message-variables)）發生在**訊息儲存時**，不是 prompt 組裝時。
- **未知巨集**保留原始 <code v-pre>{{...}}</code>（巢狀參數仍然會展開）。不拋錯也不告警。
- **參數數量 / 類型不符**：預設 `strictArgs: true` 時記一條 runtime warning 並保留原始巨集文字；`strictArgs: false` 時記 warning 但 handler 仍然跑。
- **結果規範化**——每個 handler 的回傳都會被規範化：`null` / `undefined` → `''`，`Date` → ISO 字串，陣列 / 物件 → `JSON.stringify(...)`，其他 → `String(...)`。這就是 <code v-pre>{{loop_value}}</code> 對一個物件會輸出 JSON 的原因。
- **後處理清掃**——殘留的 <code v-pre>{{trim}}</code> 標記和零散的 `else` 哨兵字元會在後處理裡被清掉。

## 自訂與外掛巨集

擴充可以註冊自己的巨集：

```js
const ctx = Luker.getContext();

ctx.macros.register('myStatus', {
    description: '回傳外掛狀態字串。',
    category: 'utility',
    handler: () => 'My plugin is active.',
});

ctx.macros.register('greet', {
    description: '問候。',
    unnamedArgs: [
        { name: 'name', type: 'string', description: '問候對象' },
    ],
    handler: (mctx) => `Hello, ${mctx.unnamedArgs[0]}!`,
});
```

註冊之後 <code v-pre>{{myStatus}}</code> 和 <code v-pre>{{greet::Bob}}</code> 就能在所有支援巨集的位置使用，包括世界書、預設、聊天訊息。

完整的註冊 API——參數類型、別名、範圍巨集、惰性解析、`dynamicMacros` 單次注入——在 [Extension API · 巨集與變數](/zh-TW/development/extension-api/macros-and-variables)。

## 探索與除錯

- 在任何解析巨集的欄位裡輸入 <code v-pre>{{</code> 會觸發自動補全。任何位置按 **Ctrl+Space** 也能召出來。
- 在 **設定 → 自動補全設定 → 在所有巨集欄位中顯示** 裡把全域補全打開。
- 執行 `/? macros`（或 `/? macro` / `/? 4`）打開 **巨集瀏覽器**——一個可搜尋的彈窗，列出所有註冊的巨集、分類、別名、參數、回傳類型、範例、來源（核心 / 擴充 / 第三方）。
- 執行 `/reroll-pick` 重置目前 chat 裡所有 <code v-pre>{{pick}}</code> 的結果。可傳一個種子（`/reroll-pick mySeed`）以重現。

## 巨集在哪些欄位裡生效

凡是會被 prompt 管線吃進去的文字欄位：

- 角色卡欄位（description、personality、scenario、first message、alt greetings、對話範例、@ Depth Note、character prompts）
- 世界書條目正文、key、header
- 預設裡的提示詞條目
- 作者筆記
- 聊天訊息（使用者和 AI），帶逐樓層變數提取
- 斜線指令參數、Quick Reply 腳本
- 正則擴充的替換內容
- 巨集自己的參數（巢狀）

那些只存字面文字、不會到 model 的欄位——比如連線設定裡的 API URL——**不會**解析巨集。拿不準時用 <code v-pre>{{date}}</code> 試一下：如果顯示成字面的 <code v-pre>{{date}}</code>，那個欄位就不跑巨集。

## 常見範式

### 預設裡的條件段

```text
{{if .difficulty == "hard"}}
世界冷酷無情，失敗不可逆。
{{else}}
世界寬容，死亡只是挫折，不是終點。
{{/if}}
```

### 一個能扛住 swipe 和刪除的計數器

在角色卡的 `first_mes` 或 alt greeting 裡初始化變數：

```text
{{setvar::turn::0}}
```

在 AI 回覆裡（透過一條指示 AI 寫這個的世界書條目），讓 AI 自己 incr：

```text
{{incvar::turn}}
```

逐樓層提取會把字面量刪掉、把 op 記下來，使用者看到的是乾淨敘事、變數正常遞增。刪那條訊息時，重播會把 op 撤掉。

### 對目前 chat 穩定的隨機選擇

```text
{{pick::酒館鬥毆::一個安靜的夜晚::不速之客}}
```

擲一次後，對該 chat 的該位置就鎖住了——這種「今天的氛圍」式的隨機就該在重繪製裡不抖。

### 繪製一個結構化集合

```text
# 進行中的任務
{{each::quests}}{{if {{loop_value::status}} == "active"}}
- {{loop_value::name}}
{{/if}}{{/each}}
```

AI 用 <code v-pre>{{setvar::quests::…}}</code> 在回覆裡維護 `quests` 結構；上面那段寫在世界書裡，每輪 prompt 時按目前狀態鋪開。

### 根據 flag 切換的作者筆記

```text
{{if $debug_verbose}}
[敘事聲音：把推理過程講得格外清楚]
{{/if}}
```

從 Quick Reply 或斜線指令切的全域 flag，成為一個可選的指令，只在需要時隨 prompt 一起發出去。

## 參考

- [逐樓層變數](/zh-TW/features/variable-op-log) —— 樓層變數特性的完整說明。
- [Extension API · 巨集與變數](/zh-TW/development/extension-api/macros-and-variables) —— 在外掛裡註冊自訂巨集。
- [世界書基礎](/zh-TW/basics/world-info) —— 大部分 prompt 側巨集的歸宿。
- [預設系統](/zh-TW/basics/presets) —— prompt 側巨集的另一處歸宿。
