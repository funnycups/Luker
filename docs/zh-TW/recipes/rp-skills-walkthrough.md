# 用 Skills 調整角色扮演輸出

Skills 是提供給 Agent 的知識包。Director 派遣子代理時，會把「它可以讀取哪些 Skills」的清單和查詢工具一併提供給它，由它判斷哪條相關，再讀取正文。

核心是一條能實際改變輸出的 Skill。Luker 自帶一批出廠 Skill 作為起點。其中一條口吻規則規定每個角色（包括三無、android 這類冷感人設）首先是有感官與本能的角色，禁止在情緒戲中出現「她注意到對方瞳孔散大」這種觀察分析體。該 Skill 預設包含在 Director 設定中，執行時所有子代理均可見。

出廠集合覆蓋不到的規則，需要自行補充：可以讓**工作台 → AI 迭代 → 編排**代為編寫（推薦），也可以手動編寫。

---

## 由 AI 迭代編寫

開啟**工作台**（快速鍵 `Alt+W` 或魔杖選單 → **工作台**）→ **AI 迭代** → **編排**（或在**編排**工作區頂列點 **AI**）。

![AI 迭代介面](/images/skills/iter-studio-02-iter-studio-opened.png)

在輸入框中用自然語言描述需求：

> 請編寫一條 Skill，讓 Director 避開翻譯腔。角色對話中不要出現「當 X 的時候」這種句式，不要用「——」破折號分隔短句，把「是嗎？」改為「是吧？」。讓 Director 模式下所有 agent 都能看到。

點擊**傳送**。AI 起草 `SKILL.md` 並產生安裝提案，同時依要求掛載到所有 agent 均能看到的位置。在**改動清單**中勾選並套用：

![安裝提案執行完成](/images/skills/iter-studio-05-after-llm-round.png)

下次在聊天中傳送角色扮演訊息觸發 Director 時，相關的子代理（這裡是文風評審）就能在可見清單中看到這條新規則，評審時按需讀取。

如需修改這條 Skill（新增規則、放寬約束、改名），可以在同一會話中繼續對話；改動均需經由**改動清單**確認後才會寫入。

---

## 手動編寫（進階）

適合你已經明確知道需要哪些段落、希望自行確定措辭、不希望受 LLM 套話影響的情況。

在**工作台 → 編排 → 準備階段**點擊**管理技能...**，再點擊**新建**。填寫名稱、描述和作用域後，系統會自動生成一份模板 `SKILL.md` 並開啟內嵌編輯器：

![內嵌 Skill 編輯器 —— 檔案樹與正文區](/images/skills/rp-demo-8.5-editor-body-pasted.png)

將模板正文替換為所需內容。需要格式參考時，可以開啟任意一條自帶 Skill 檢視：它們使用雙語段落、`✗` / `✓` 例子對照，結尾包含一個 Self-check 段。儲存後回到**編排 → 流程**或**準備階段**，將新 Skill 加入對應清單。

詳見 [Skill 管理](/zh-TW/features/skills/management)。

---

## 相關

- [Skills 概覽](/zh-TW/features/skills/) —— Skill 是什麼、作用域如何使用、agent 如何讀取
- [Skills 整合](/zh-TW/features/orchestrator/skills) —— 讓 Skill 對某個 agent 可見
- [編排 AI 迭代](/zh-TW/features/orchestrator/iteration-studio) —— 工作台 AI 迭代完整能力
- [創作 Skill](/zh-TW/features/skills/authoring) —— SKILL.md 格式、frontmatter、多檔案
