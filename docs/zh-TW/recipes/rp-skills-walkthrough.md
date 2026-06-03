# 用 skills 調教 RP 輸出

Skills 是給 agent 用的知識包。導演派發某個 sub-agent（`intent_scout`、`voice_critic`、`plot_brainstormer` 等）時，會順便把"它能讀哪些 skills"的清單和幾個查詢工具塞給它，它判斷哪條相關再去拉正文。整個機制就這點東西。

難的是寫出一條真能改變輸出的 skill。Luker 自帶二十多條作為起點——比如 `director-character-voice-zh`，規定每個角色（包括三無、android 這種冷感人設）首先都是有感官與本能的活的人，禁止情緒戲裡出現 "她注意到對方瞳孔散大" 這種觀察分析體；它預設就掛在導演 profile 裡，每次導演跑，所有 sub-agent 都看得到。

自帶集合覆蓋不到的紀律，就要自己補一條。兩條路：讓 AI 迭代工作台替你寫（推薦），或者自己手寫。

---

## 讓工作台替你寫

開啟編排器面板裡的 AI 迭代工作台。

![AI 迭代工作台剛開啟](/_screenshots/skills/iter-studio-02-iter-studio-opened.png)

在輸入框裡說一句你想要的，自然語言：

> 幫我寫一條 skill 讓導演避開翻譯腔。別讓角色對話出現"當 X 的時候"這種句式，不要用"——"破折號分隔短句，"是嗎？"改成"是吧？"。讓導演模式下所有 agent 都看到。

點**傳送**。工作台起草 SKILL.md、安裝好，順便（因為你交代了）掛到所有 agent 都能看到的位置。每個動作都顯示成一個綠色 ✅ 標記，引數和結果都能展開看：

![工作台跑完安裝](/_screenshots/skills/iter-studio-05-after-llm-round.png)

下次你在聊天裡發任何一條 RP 訊息觸發導演時，相關的 sub-agent（這裡是 `voice_critic`）就能在它的可見清單裡看到這條新規則，審稿時按需拉來用。

想再改這條 skill（加規則、放寬約束、改名）就在同一個會話裡接著聊；每次改動都要你審批才落地。

---

## 自己手寫（進階）

適合你已經清楚知道想要哪幾段、想自己定措辭、不願被 LLM 套話的時候。

在編排器面板點**管理 Skills**，再點**新建**。填好名字、描述、作用域，流程會自動落一份模板 SKILL.md 並開啟內嵌編輯器：

![內嵌 Skill 編輯器 — 檔案樹 + 正文區](/_screenshots/skills/rp-demo-8.5-editor-body-pasted.png)

把模板正文換成你想要的。要找格式參考，隨便開啟一條自帶 skill 看就行——它們用雙語段落、`✗` / `✓` 例子對照，結尾用一個 Self-check 段。儲存之後回到導演編輯器，把新 skill 加進它的 Skill 列表。

詳見 [Skill 管理](/zh-TW/features/skills/management)。

---

## 相關

- [Skills 概覽](/zh-TW/features/skills/) — skill 是什麼、scope 怎麼用、agent 怎麼讀
- [Skills 整合](/zh-TW/features/orchestrator/skills) — 讓 skill 對某個 agent 可見
- [AI 迭代工作台](/zh-TW/features/orchestrator/iteration-studio) — 工作台完整能力
- [創作 Skill](/zh-TW/features/skills/authoring) — SKILL.md 格式、frontmatter、多檔案
