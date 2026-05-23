# 逐樓層變數

Luker 在 SillyTavern 原生變數系統之上引入了**逐樓層變數**：AI 回覆裡寫的變數賦值會被自動提取、結構化、隨訊息一起儲存，並在聊天歷史發生變化時被確定性地重播——刪除訊息、切換 swipe、重新生成回覆後，你的變數自動落到正確狀態。

## 為什麼需要這個

原生 SillyTavern 裡，副作用宏 <code v-pre>{{setvar::hp::50}}</code> 只在它出現在 *prompt 範本* 裡（預設、世界書、首樓）時才會被執行。如果 AI 在回覆裡寫了同樣的字面量，什麼都不會發生——它就是一段普通文字。更糟的是字面量會原樣顯示給使用者，污染敘事。

Luker 的解法：在儲存 AI / 使用者訊息時把副作用宏從文字裡提取出來，作為結構化操作掛在那條訊息上，需要時重播。字面量從可見文字裡消失，操作作為資料被保留。

## 工作原理

```d2
direction: down

AI: "AI 回覆 / 使用者訊息儲存"
EXTRACT: "掃描 mes 提取副作用宏\nsetvar / addvar / incvar / decvar / deletevar / pushvar / popvar" {
  style.fill: "#e1f5ff"
}
EVAL: "巢狀展示型宏求值\n{{user}} / {{getvar}} / {{time}} ..."
APPLY: "前向 apply 到\nchat_metadata.variables"
LOG: "結構化記錄追加到\nmessage.extra.var_ops"
CLEAN: "字面量從 mes 裡刪除"
DISPLAY: "聊天介面看到的是\n乾淨敘事"

AI -> EXTRACT -> EVAL -> APPLY -> LOG -> CLEAN -> DISPLAY

REPLAY: "聊天結構變化" {
  shape: diamond
}
DEL: "MESSAGE_DELETED"
SWIPE: "MESSAGE_SWIPED"
SWIPED: "MESSAGE_SWIPE_DELETED"
CHANGED: "CHAT_CHANGED"
EDIT: "MESSAGE_EDITED"
REBUILD: "從存活 op 重播\n僅動 op 日誌裡出現的 key" {
  style.fill: "#fff3e0"
}

DEL -> REPLAY
SWIPE -> REPLAY
SWIPED -> REPLAY
CHANGED -> REPLAY
EDIT -> REPLAY
REPLAY -> REBUILD
```

### 提取

訊息儲存時（AI 回覆、續寫、重新生成、swipe、使用者訊息），Luker 掃描 `mes` 尋找下面這些副作用宏：

- <code v-pre>{{setvar::name::value}}</code>
- <code v-pre>{{addvar::name::value}}</code>
- <code v-pre>{{incvar::name}}</code>
- <code v-pre>{{decvar::name}}</code>
- <code v-pre>{{deletevar::name}}</code>
- <code v-pre>{{pushvar::name::value}}</code>
- <code v-pre>{{popvar::name}}</code>

每一種被識別的 op 都接受點號路徑名（<code v-pre>{{setvar::roster.alice.hp::50}}</code>）——見下文的 [結構化物件工作流程](#structured-objects)。

按出現順序逐個處理：

1. value 裡巢狀的**展示型**宏（<code v-pre>{{user}}</code>、<code v-pre>{{getvar::other_key}}</code>、<code v-pre>{{time}}</code> 等）針對當前狀態求值。
2. op 立即前向 apply 到 `chat_metadata.variables`，這樣同一條訊息裡後續的 op 能讀到結果。
3. 結構化記錄追加到 `message.extra.var_ops`。
4. 字面量從 `mes` 裡刪掉。

聊天介面看到的就是乾淨敘事；變數是最新的；操作歷史可查詢。

::: info 順序求值
同一條訊息裡兩個相互依賴的 op 會按預期工作：

```
{{setvar::a::1}} {{setvar::b::{{getvar::a}}}}
```

提取完成後：`a = 1`，`b = 1`。每個宏都是先完整求值再 apply，再處理下一個。
:::

::: info JSON 形態的 value
value 末尾是字面 `}` 的情形（典型 `{"x":1}` / `[1,2]` 類負載）會讓宏末尾出現連續三個 `}`——一個是 JSON 閉合，兩個是宏 close。掃描器把任意末尾連續 `}` 裡**最後一對** `}}` 當作宏 close，所以 `{{setvar::config::{"x":1}}}` 不需要轉義就能正確解析。

副作用：宏緊跟字面 `}` 寫在敘事裡（例如 `... {{macro}}}`）會把那個 `}` 吞進 value。這種場景請在中間加空格（`{{macro}} }`）保持分離。
:::

### 結構性變化時重播

聊天結構變化時，Luker 重建變數快取的相關部分：

| 事件 | 動作 |
|------|------|
| `MESSAGE_DELETED` | 從存活 op 重播；只有出現在存活日誌裡的 key 會被改動 |
| `MESSAGE_SWIPED` | 重播（活躍 swipe 的 `extra.var_ops` 此時已就位） |
| `MESSAGE_SWIPE_DELETED` | 重播 |
| `CHAT_CHANGED` | 針對剛載入的 chat 重播 |
| `MESSAGE_EDITED` | 重播（**不**重新提取——編輯敘事不會觸發 setvar） |

重播是刻意保守的：只動那些出現在存活 op 日誌裡的 key。其他來源寫的變數——世界書副作用、slash 命令、Quick Reply、第三方擴充、舊 chat 遺留——一律不動。

### Swipe 生命週期

`var_ops` 掛在 `message.extra` 上，SillyTavern 已經透過 `swipe_info[i].extra` 自動鏡像到每個 swipe。切換 swipe 時正確的 op 自動跟過來。

新 swipe 開始生成時，`clearMessageData` 會丟掉前一個 swipe 的 `var_ops`（Luker 把它加進了白名單），這樣提取從乾淨狀態開始。

### 續寫

續寫會把新 token 追加到現有 `mes` 後面。因為之前的提取已經把字面量從 `mes` 裡刪乾淨了，下一次提取只會看到新增部分，把新 op 追加到同一個 `var_ops` 陣列末尾。不需要時間戳、偏移量、旗標位。

## 操作面板

任何帶有 op 日誌的訊息按鈕排上會出現一個小燒瓶圖示：

![樓層訊息上的小燒瓶圖示](/images/variable-op-log/var-ops-flask-button.png)

點開能：

- 檢視這條訊息記錄的所有操作
- 編輯某個操作的 `op` / `key` / `value`
- 刪除某個操作
- 新增操作

![Variable operations 面板](/images/variable-op-log/var-ops-panel.png)

儲存時該訊息的 op 陣列被你的編輯替換、快取重建、聊天落盤。**手動調整變數推薦這條路**——它把改動落在時間線上一個具體的訊息上，未來的結構性變化（刪除、swipe）能正確保留意圖。

## 與其他變數來源的共存

| 來源 | 行為 |
|------|------|
| 世界書 <code v-pre>{{setvar}}</code> | 走 SillyTavern 原生流程，prompt 組裝時執行；快取裡這個 key 每輪都會被 WI 的值覆蓋。如果想讓 WI 充當「初始化」而不是「每輪覆蓋」，把這類條目放在高 depth / prompt 最前。 |
| 預設 <code v-pre>{{setvar}}</code> | 同世界書。 |
| Slash 命令 `/setvar` | 直接寫 `chat_metadata.variables`。下次重播掃到同名 key（即存活的 AI op 提到了這個 key）時會被覆蓋。 |
| Quick Reply 腳本 | 同 slash 命令。給 QR 管理的變數起一個 AI op 不會碰的名字。 |
| <code v-pre>{{setglobalvar}}</code> 系列 | 不被提取。全域變數在 chat-local op 日誌的範圍之外，按原生語義工作。 |

## 角色卡作者建議

如果一個變數打算讓 **AI 在 RP 過程中擁有並修改**，就只讓它透過 AI 寫的 <code v-pre>{{setvar}}</code> 來變化，不要從世界書或 QR 裡再寫。

如果一個變數打算 **chat 開始時初始化一次**，把它寫在角色卡的首樓或 alt greeting 裡——它們也會被提取到 `chat[0].extra.var_ops`。

如果一個變數打算 **每輪 prompt 組裝時按當前情境重算**（比如根據當前位置算天氣），就放世界書；快取被覆蓋是預期行為。

## 何時使用變數驅動 UI

當某些欄位需要隨對話推進而變化、並被某種 UI 消費（CardApp 面板、世界書條目、自定義渲染器等）時，把它們建模成 chat 變數。生產端三種途徑：

1. `first_mes` / alt greetings 裡 setvar 兜底初始值
2. 世界書條目裡指引 AI 在 reply 中用 setvar 改寫
3. AI 在 reply 中 emit setvar 直接更新

消費端透過 `getvar` 讀取，UI 在每次 `chat_metadata` 變化時重新渲染。

這種模式適合"敘事 header"類資料——例如當前章節階段、任務進度、地點狀態、案件名等需要隨情節推進而變化的欄位。

## 儲存結構

```jsonc
chat[i] = {
    "mes": "...剝離了副作用宏的敘事...",
    "extra": {
        "var_ops": [
            { "op": "setvar", "key": "hp", "value": "50" },
            { "op": "setvar", "key": "roster", "path": "alice.hp", "value": "50" },
            { "op": "incvar", "key": "turn" }
        ]
    },
    "swipe_info": [
        { "extra": { "var_ops": [...] } },
        { "extra": { "var_ops": [...] } }
    ]
}
```

`chat_metadata.variables` 仍是 SillyTavern 原生快取，是 <code v-pre>{{getvar}}</code> 的真源。op 日誌是我們擁有的那部分值的 *來源*；快取是所有來源合併後的執行時視圖。

當 op 帶有 `path` 時，`op.key` 仍然是頂層變數名——`path` 是那個變數 JSON 值內部的子選擇器。op 日誌把回滾單位保持在頂層 key。詳見下文 [結構化物件工作流程](#structured-objects)。

## 結構化物件工作流程 {#structured-objects}

帶路徑的 op 讓一個變數裝得下完整的結構化載荷——NPC 名冊、物品字典、任務日誌——AI 在對話過程中逐葉修改。不必每輪重寫整盤（重寫會丟掉 op 日誌的粒度，讓 swipe 看起來像整狀態重寫），AI 每次只發出一條 op：

```text
{{setvar::roster.alice.hp::50}}              <!-- Alice 登場 -->
{{setvar::roster.alice.mood::cautious}}      <!-- 描述她的狀態 -->
{{pushvar::roster.alice.inventory::dagger}}  <!-- 給她一把匕首 -->
{{setvar::roster.alice.hp::40}}              <!-- 她受了傷 -->
{{deletevar::roster.bob}}                    <!-- Bob 離隊 -->
```

`op.key` 永遠是頂層變數名（上例裡是 `roster`），所以 tracked-keys／重播／swipe 還原邏輯把整個結構當成一個單位。刪掉某個寫過某片葉子的訊息時，結構會從存活的 op 重建，那片葉子自然回退——`roster` 整體跟存活時間線保持一致。

任何由 AI 跨輪維護的結構化集合都推薦這條路：NPC 名冊、隊伍物品、任務日誌、關係圖、地點狀態等。逐葉粒度給刪除／swipe／分支提供了最小的回滾單元，也能配合 <code v-pre>{{each::roster}}…{{/each}}</code> 直接從頂層 key 下掛的 JSON 物件渲染出來。

## 渲染結構化變數 — `{{each}}` 與 `loop_value`

聊天變數本身能裝任意 JSON 可序列化的值，所以一個結構化的集合（NPC 名冊、任務日誌、物品表）可以裝在單個變數裡，按需要渲染進 prompt 或世界書條目。

- **路徑存取** — <code v-pre>{{getvar::npcs.alice.hp}}</code> 解析存在 `npcs` 裡的 JSON 並按路徑下鑽。中間鍵缺失 / 解析失敗 / 頭段不可迭代 → 空字串。如果頭段不是 JSON，會回退到字面 flat-key 查找，所以名為 `a.b` 的變數也能用。
- **遍歷** — <code v-pre>{{each::npcs}}{{loop_key}}: {{loop_value::hp}}{{/each}}</code> 遍歷集合（物件 → 鍵/值，陣列 → 字串索引/元素）。each 體內可用：
  - <code v-pre>{{loop_key}}</code> — 當前鍵（陣列下標轉字串）
  - <code v-pre>{{loop_value}}</code> — 當前完整值（物件會自動 JSON.stringify）
  - <code v-pre>{{loop_value::path}}</code> — 按路徑下鑽，語義與 <code v-pre>{{getvar}}</code> 一致

  巢狀 <code v-pre>{{each}}</code> 時內層會自然 shadow 外層。集合參數也接受內聯 JSON 陣列字面量（<code v-pre>{{each::["sword"，"shield"]}}</code>）和巢狀宏（<code v-pre>{{each::{{getvar::roster}}}}</code>），不必非得先把資料寫進具名變數。

這就讓"一個變數裝 JSON 物件 → 一個世界書條目渲染它"成為完整的模式：AI 用 <code v-pre>{{setvar::npcs::...}}</code> 維護結構，條目內容用 <code v-pre>{{each::npcs}}…{{/each}}</code> 把結構鋪到 prompt 裡。
