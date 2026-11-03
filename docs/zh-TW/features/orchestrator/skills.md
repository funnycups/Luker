# Skills

編排器派遣某個 Agent 時，它只能看到你為它選定的 Skill，看不到整個庫。本頁說明如何把 Skill 掛到指定 Agent 上。

Skill 本身是什麼、`SKILL.md` 怎麼寫，見 [Skills 概覽](/zh-TW/features/skills/)。

## 掛載方式

**讓工作台代勞（推薦）。** 在 AI 迭代工作台編寫或修改 Skill 時，順便說明要讓誰能看到，例如「讓 Director 下所有 Agent 都能看到」或「只給文風評審看」。它會在同一輪審批裡掛到對應位置，你不需要決定放在哪一層。詳見 [用 Skills 調整角色扮演輸出](/zh-TW/recipes/rp-skills-walkthrough) 和 [用工作台編寫 Skill](/zh-TW/features/orchestrator/iteration-studio#用工作台編寫-skill)。

**自行掛載。** 開啟編排器面板中的 Director 編輯器，捲動到 Skill 列表區域。每個 Agent 各有一份列表，頂部還有一份所有 Agent 共享的列表。從下拉中選擇一個 Skill，點擊**新增**，然後儲存。

![Director 編輯器中的 Skill 列表，剛新增的一條 Skill](/images/skills/rp-demo-11-director-chip-added.png)

不確定掛在哪一份裡，讓工作台決定即可。

## Agent 看到什麼

派遣時，執行環境在 Agent 的系統提示詞前面附上一份簡短清單，只有名稱和描述，不含正文。Agent 依描述判斷哪條相關，需要時再依名稱讀取正文。

清單裡只有名稱。讀取正文時依角色卡、預設、全域的順序解析，後者覆蓋前者。因此同名的角色卡 Skill 會在該卡載入期間覆蓋全域版本，切換到其他卡後自動恢復。

## 相關頁面

- [Skills 概覽](/zh-TW/features/skills/) —— Skill 的結構與作用域
- [Skill 管理](/zh-TW/features/skills/management) —— 安裝、匯入、刪除與切換作用域
- [創作 Skill](/zh-TW/features/skills/authoring) —— Skill 正文的寫作規則
- [編排器整合](/zh-TW/features/skills/orchestrator-integration) —— 繼承規則、萬用字元與停用清單
- [AI 迭代工作台](/zh-TW/features/orchestrator/iteration-studio) —— 讓 AI 替你寫 Skill
- [用 Skills 調整角色扮演輸出](/zh-TW/recipes/rp-skills-walkthrough) —— 端對端示例
