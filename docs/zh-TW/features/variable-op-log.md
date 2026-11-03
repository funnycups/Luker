# 逐樓層變數

角色扮演裡的狀態常常寫在 AI 回覆中：體力降到 40、拿到一把匕首、某位 NPC 離隊。逐樓層變數讓這些變數賦值真正生效，並與聊天歷史保持一致：刪除訊息、切換 swipe、重新生成後，變數會回到目前時間線應有的狀態。

## 解決什麼問題

在原生 SillyTavern 中，<code v-pre>{{setvar::hp::50}}</code> 只有在預設、世界書或首樓等提示詞範本裡才會執行。AI 在回覆裡寫同樣的內容，不會改變任何變數，還會把這一段字面量顯示給使用者，打斷敘事。

Luker 在儲存訊息時把這類賦值提取出來，作為該則訊息的一部分保存，並從可見文字中移除。變數立即更新；訊息刪除或切換 swipe 時，Luker 依目前存在的賦值重新計算。

```d2
direction: down

AI: "回覆寫入聊天"
EXTRACT: "從訊息中提取賦值巨集\nsetvar / addvar / incvar / decvar / deletevar / pushvar / popvar" {
  style.fill: "#e1f5ff"
}
EVAL: "解析巢狀的展示巨集"
APPLY: "寫入目前變數"
LOG: "在訊息上記錄本次變數操作"
CLEAN: "從可見文字中移出賦值"
DISPLAY: "聊天介面顯示純敘事"

AI -> EXTRACT -> EVAL -> APPLY -> LOG -> CLEAN -> DISPLAY

REPLAY: "聊天結構變化" {
  shape: diamond
}
DEL: "刪除訊息"
SWIPE: "切換 swipe"
SWIPED: "刪除 swipe"
EDIT: "編輯訊息"
CHANGED: "切換聊天"
REBUILD: "依仍然有效的賦值重新計算" {
  style.fill: "#fff3e0"
}

DEL -> REPLAY
SWIPE -> REPLAY
SWIPED -> REPLAY
EDIT -> REPLAY
CHANGED -> REPLAY
REPLAY -> REBUILD
```

## 支援的寫法

以下賦值會從訊息中提取：

- <code v-pre>{{setvar::name::value}}</code>
- <code v-pre>{{addvar::name::value}}</code>
- <code v-pre>{{incvar::name}}</code>
- <code v-pre>{{decvar::name}}</code>
- <code v-pre>{{deletevar::name}}</code>
- <code v-pre>{{pushvar::name::value}}</code>
- <code v-pre>{{popvar::name}}</code>

變數名稱支援點號路徑，例如 <code v-pre>{{setvar::roster.alice.hp::50}}</code>。同一則訊息中的賦值依出現順序執行，後面的賦值可以讀取前面的結果。

值裡巢狀的展示巨集會先依目前狀態求值，例如 <code v-pre>{{setvar::greeting::{{user}}}}</code> 會寫入目前使用者名稱。

## 編輯和查看

帶有變數操作的訊息會出現一個燒瓶圖示。點開後可以：

- 查看這則訊息記錄的所有操作
- 修改操作類型、變數名稱或值
- 刪除某個操作
- 新增操作

儲存後，變數會依修改後的記錄重新計算。手動調整變數時優先使用這個面板：改動落在具體訊息上，之後的刪除與 swipe 會正確處理。

## 刪除、編輯與 swipe

Luker 只回放目前聊天中存在的變數操作。刪除一則訊息時，這則訊息寫過的變數會回到之前的狀態；切換 swipe 時，變數跟隨目前 swipe 的記錄；編輯訊息正文不會重新提取賦值，需要修改時請用燒瓶面板。

回放只影響變數操作記錄中出現的頂層變數名稱。世界書、斜線指令、Quick Reply 和第三方擴充功能寫入的變數不會被覆蓋。

## 與其他變數來源共存

| 來源 | 行為 |
| --- | --- |
| 世界書 <code v-pre>{{setvar}}</code> | 在提示詞組裝時執行，每輪都會覆蓋同名變數。適合初始化或依目前情境重算的值。 |
| 預設 <code v-pre>{{setvar}}</code> | 與世界書相同。 |
| 斜線指令 `/setvar` | 直接寫入聊天變數。如果之後的訊息操作也寫了同一個變數，回放時以訊息記錄為準。 |
| Quick Reply | 同斜線指令。給 Quick Reply 管理的變數取一個 AI 不會使用的名稱。 |
| <code v-pre>{{setglobalvar}}</code> 系列 | 不參與逐樓層提取。全域變數跨聊天共享，依原生語意運作。 |

## 給角色卡作者的建議

- 希望 AI 在劇情中修改的變數，只讓 AI 透過回覆裡的賦值來改，不要再從世界書或 Quick Reply 重複寫入。
- 只在聊天開始時初始化一次的變數，寫在首樓或備用開場白裡。
- 每輪都要依目前情境重算的變數，放在世界書裡，讓提示詞組裝時覆蓋。
- 需要隨劇情推進的面板資料，建模成聊天變數：開場白初始化，世界書條目指導 AI 更新，CardApp 讀取並渲染。

## 結構化變數

一個變數可以儲存完整的結構化資料：NPC 名冊、隊伍物品、任務日誌、關係表。AI 每次只改其中一項，不必重寫整個結構。

```text
{{setvar::roster.alice.hp::50}}
{{setvar::roster.alice.mood::cautious}}
{{pushvar::roster.alice.inventory::dagger}}
{{setvar::roster.alice.hp::40}}
{{deletevar::roster.bob}}
```

刪除訊息或切換 swipe 時，整個結構依聊天中存在的操作重建，改動會落在對應的葉子上。

渲染時用 <code v-pre>{{each}}</code> 遍歷：

```text
{{each::roster}}
- {{loop_key}}: {{loop_value::hp}} HP
{{/each}}
```

<code v-pre>{{loop_key}}</code> 是目前鍵，<code v-pre>{{loop_value}}</code> 是完整值，<code v-pre>{{loop_value::field}}</code> 讀取其中的欄位。集合也可以直接寫成內嵌陣列或巢狀巨集。

## 相關頁面

- [巨集](/zh-TW/basics/macros) —— 變數巨集的完整語法
- [世界書基礎](/zh-TW/basics/world-info) —— 用條目指導 AI 更新變數
- [CardApp](/zh-TW/features/cardapp) —— 讀取變數並渲染介面
