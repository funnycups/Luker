# Skills

編排器派發某個 agent 時，那個 agent 只能看到你專門給它"亮出來"的 skills，看不到整個 Skill 庫。這一頁講的是怎麼**讓一個 skill 對某個 agent 可見**。

skill 本身是什麼、SKILL.md 長什麼樣、怎麼寫——見 [Skills 概覽](/zh-TW/features/skills/)。

## 兩種掛載方式

**讓工作台替你掛（推薦）。** 在 AI 迭代工作台裡讓它寫 skill 或改 skill 的時候，順便告訴它你想讓誰能看到——"讓導演模式下所有 agent 都看到"、"只給 voice_critic 看"——它會在同一輪審批裡把這條掛到對應的位置。你不用想該放哪一層。詳見 [《用 skills 調教 RP 輸出》](/zh-TW/recipes/rp-skills-walkthrough) 和 [工作台的 skill 編寫](/zh-TW/features/orchestrator/iteration-studio#用工作台編寫-skill)。

**自己掛。** 開啟編排器面板裡的導演編輯器，往下滾到 Skill 列表那一節。每個 agent 自己有一份列表，頂上還有一份所有 agent 共享的列表。從下拉裡選一個 skill，點**新增**，儲存。

![導演編輯器 — Skill 列表，剛新增的一條 skill](/_screenshots/skills/rp-demo-11-director-chip-added.png)

不確定掛在哪一份裡？讓工作台來更省心——你描述一下需求，剩下的讓它決定。

## Agent 派發時看到什麼

派發時，執行時會在 agent 的系統提示詞頂部拼上一段簡短的清單，只有名字和描述，不含正文：

```
<available_skills>
- director-character-voice-zh: Character voice consistency rules — living-being principle, archetype handling, voice-register matching.
- director-no-meta-zh: 禁止破壞沉浸——敘述與對話都在故事世界內，作者側裝置不在場。
- director-anti-cliche-zh: Anti-cliché checklist — banned phrases, narrative-template avoidance, freshness rules.
- voice-critic-method-zh: How voice_critic audits a draft — pass criteria, common failure modes, hand-off back to the main agent.

(Use skill_read to consult specific content; skill_search to grep within a skill.)
</available_skills>
```

agent 自己判斷哪條相關。如果某條描述跟當前任務直接相關，agent 就調一次 `skill_read({name: "..."})`，SKILL.md 的正文以工具呼叫的返回結果回來。

清單裡**只有名字**。`skill_read` 真去拉正文的時候，執行時按 `character → preset → global` 走，後者覆蓋前者。所以同名的 `character` 作用域 skill 會在該角色卡載入期間靜悄悄蓋掉 `global` 的同名版本，切到別的卡又自動讓位。

## 相關

- [Skills 概覽](/zh-TW/features/skills/) — SKILL.md 長什麼樣、scope 怎麼用
- [Skill 管理](/zh-TW/features/skills/management) — 安裝 / 匯入 / 刪除 / 切換作用域
- [創作 Skill](/zh-TW/features/skills/authoring) — Skill 正文的寫作規則
- [編排器整合（深度）](/zh-TW/features/skills/orchestrator-integration) — 完整層級策略、繼承規則、萬用字元、deny 列表
- [AI 迭代工作台](/zh-TW/features/orchestrator/iteration-studio) — 讓 LLM 替你寫 Skill
- [Recipe：用 skills 調教 RP 輸出](/zh-TW/recipes/rp-skills-walkthrough) — 端到端示例
