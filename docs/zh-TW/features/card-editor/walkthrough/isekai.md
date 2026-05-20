# 從零寫一個 CardApp

::: tip 這篇文件解決什麼問題
[CardApp Studio](/zh-TW/features/card-editor/studio) 的頁面講它有什麼能力，這篇用一個完整角色卡演示**怎麼用人話指揮它幹活**。

讀完你能從零做出一張能跑、有 RP 沉浸感的 CardApp，過程中不用自己寫一行 JavaScript。
:::

## 你會得到什麼

最終成品是一張名叫「異世界生存日誌」的單人沉浸式 RP 角色卡。第一條訊息發出去，你會看到這樣：

![成品截圖](/images/walkthrough/isekai/step-08-end-to-end.png)

- 頂部 4 格狀態列：天數 / 體力 / 飽食度 / 心情
- 主角穿越到陌生森林的西式低魔異世界，AI 擔任環境與敘事者
- 一個繫結的世界書，內含狀態注入條目 + 世界觀錨點 + 幾個 NPC 設定
- 沉浸式按鈕命名（停筆 / 改寫 / 舊冊 / 新章 / 合卷），覆蓋必備 UX

整個過程你只需要用中文描述需求 — **AI 會處理程式碼、Git 提交、世界書條目、變數初始化、欄位繫結**。

## 前置條件

- 一個能跑的 Luker / SillyTavern 執行個體
- 已配通的 LLM API，推薦有工具呼叫能力的模型（Claude / GPT-5 等）
- （進階段需要）已配通 Stable Diffusion / ComfyUI 後端

## 1. 建立空白角色卡 → 進入 Studio

開啟右側角色管理面板，點「新建角色」，起個名字（本文用「異世界生存日誌」）。**不需要填任何欄位** — 描述 / 第一條訊息 / 世界書繫結全部交給 Studio AI。

接下來開啟「擴充功能」面板 → 展開「角色卡編輯助手」→ 點 **「&lt;/&gt; CardApp Studio」**:

![Studio 入口位置](/images/walkthrough/isekai/step-01-studio-entry.png)

Studio 是覆蓋在主介面上的三欄佈局：左 AI 對話 / 中即時預覽 / 右程式碼編輯器。新角色卡 CardApp 還沒啟用，Studio 看到這個狀態會主動問你要不要開 — 別擔心。

![Studio 初始空狀態](/images/walkthrough/isekai/step-02-studio-empty.png)

::: tip 不用讀程式碼也能跟下去
右側程式碼編輯器會隨著 AI 的工作重新整理，但本文不要求你看裡面的程式碼。只需要看 **左欄的對話** 和 **中間的預覽** — 這就是 vibe 編碼該有的樣子。
:::

## 2. 一發 prompt 把骨架 + 世界書 + 開場白全做了

點左側輸入框，**完整複製**下面這段：

```
我想做一個輕小說風味的西式異世界冒險角色卡,主角穿越到陌生森林獨自求生,
AI 擔任環境和敘事者(第三人稱視角描寫主角看到 / 感受到什麼)。
不要東方仙俠 / 修真 / 都市 / 校園風,也不要末日 dark fantasy。

先幫我搭一個最小可用的 CardApp:
- 頂部狀態列 4 格:天數、體力、飽食度、心情
- 中間是訊息渲染區
- 下面是輸入框和傳送按鈕
- 必須的快捷按鈕(停止生成、切換聊天、新存檔、關閉聊天)放底部

狀態變數都用 isj_ 字首(isj_day / isj_hp / isj_food / isj_mood)。
風格請配合"輕小說西式異世界"的氛圍,具體配色 / 字型 / 排版你來定。
```

![輸入第一輪 prompt](/images/walkthrough/isekai/step-03-first-prompt.png)

傳送後，Studio AI 不會埋頭猛寫，而是會先：

1. 調 `list_files` / `character_get_fields` 看現狀
2. 發現 CardApp 沒啟用，**先問你要不要開**（回個「好」即可）
3. 把方案講一遍讓你過一眼

確認後，它會一併完成下面這些事 — 一次性，不用你分輪發 prompt:

- 啟用 CardApp toggle(`cardapp_set_enabled`)
- 寫 `index.js` / `style.css`（狀態列 / 訊息區 / 輸入區 / 必備 UX 按鈕）
- 配套綁一本世界書，建狀態注入條目 + 世界觀錨點
- 改寫 `first_mes`（主角穿越的開場白，帶 setvar 初始化變數）
- 把 `world` 欄位繫結到新建的世界書

每個工具呼叫都會**彈出審批**讓你看 diff — 一般可以放心點「批准」一併通過。

![AI 工作過程：工具呼叫 + diff 審批](/images/walkthrough/isekai/step-04-first-round-work.png)

::: tip "AI 內容放世界書，不動 system_prompt"
你會注意到 AI 沒碰 `system_prompt` — 這是 [Luker 的 CardApp 創作約定](/zh-TW/development/card-developers#cardapp-內容存放約定)：角色卡的 `system_prompt` 會蓋掉聊天補全預設原本設計好的 system 部分，把卡片內容塞進世界書 entry 才能跟預設和平共存。Studio AI 預設遵守。
:::

::: tip 看到 AI 在世界書條目裡寫 <code v-pre>\{{...}}</code> 別奇怪
AI 在 entry 裡教模型怎麼用 `setvar` / `addvar` 等 macros — 這些教學示範必須**反斜線跳脫**(<code v-pre>\{{...}}</code>)，否則它們會在每次 prompt build 時被引擎執行，汙染你的變數。Studio AI 自動會處理這層 escape。
:::

AI 全部完成後，Studio 中間預覽區會自動重新載入，你能看到一張能跑的 CardApp:

![第一輪跑起來的樣子](/images/walkthrough/isekai/step-05-first-round-running.png)

## 3. 不滿意就追問 AI

跑過一輪你可能發現配色想換一種、按鈕順序想調一下、AI 描述的氛圍跟你想的不一樣、某個 NPC 的設定想再豐滿一點 — 這些都直接在左欄追問就行，Studio AI 會順著上下文繼續改：

::: tip 都可以大大方方追問
- "底部按鈕順序換成 寄出 / 改寫 / 舊冊 / 新章 / 合卷"
- "狀態列的字號能不能調大一點"
- "NPC 那條 keyed entry 加點暗示玩家可以送什麼禮物"
- "開場白結尾那段太冷，換個更明亮一點的畫面"

不用糾結 prompt 的措辭，把訴求說清楚 AI 就能改。如果改完不對，繼續追問。
:::

## 4. 端到端跑一次

試著發一條 RP 輸入（隨便說點什麼）:

![完整對話 + 狀態變化](/images/walkthrough/isekai/step-08-end-to-end.png)

到這裡，你已經透過 1-2 輪自然語言對話，得到了一張：

- ✓ 自帶前端 UI（狀態列 + 必備 UX 按鈕）
- ✓ 自帶世界觀和 NPC 設定（繫結的世界書）
- ✓ 自帶初始化邏輯的開場白
- ✓ 跑起來有沉浸感的 RP 角色卡

整個過程你**沒看過一行程式碼**，也沒有手動開過 CardApp toggle、沒有手動建過世界書條目。

## 5.（進階）接入影像生成

::: warning 前置：SD/ComfyUI 後端
本節需要先配通 SillyTavern 自帶的 [影像生成擴充功能](https://docs.sillytavern.app/extensions/stable-diffusion/) 的後端（本地 Stable Diffusion / ComfyUI / 遠端 API 任選）。後端不通時，這一節直接跳過。
:::

```
我想要每次 AI 描述新場景時 CardApp 自動配圖。玩家純對話 / 內心戲不畫。
另外底部加一個「畫下所見」按鈕,可以手動讓最近一條 AI 訊息的場景重畫。

對沒配置畫圖後端的使用者:靜默跳過 / 隱藏按鈕就行,別彈錯誤,
不要影響 CardApp 其他功能。
```

![訊息上方插畫](/images/walkthrough/isekai/step-09-scene-image.png)

![「畫下所見」按鈕觸發](/images/walkthrough/isekai/step-10-redraw-button.png)

## 提示詞實踐小抄

跑過一輪你會發現，有效的 Studio prompt 不需要長 — 關鍵是把"方向"說清楚。下面幾條經驗：

1. **描述外觀和行為，不描述實作**
   - ✓ "頂部狀態列 4 格，天數 / 體力 / 飽食度 / 心情"
   - ✗ "用 ctx.registerRenderer 註冊一個監聽 GENERATION_ENDED 的 renderer"

2. **把"約束"和"自由度"分開寫清楚**
   - "用 isj_ 字首"是約束（方向）
   - "具體配色 / 字型 / 排版你來定"是自由度（交給 AI）
   - AI 把自由度發揮到具體內容（NPC 名字、配色、按鈕命名），把約束當不可逾越的紅線 — 這是它最擅長的工作模式

3. **AI 跑出來跟你想的不一樣，不是 bug**
   - 這是工作循環的一部分。看到偏差，精準描述給 AI 聽："我想要 X（具體說出來），你給的偏向 Y（指出哪裡偏了），改一下"
   - 不要回頭自己改檔案，也不要重寫整個 prompt

4. **看 diff 再批准**
   - 每個工具呼叫都會彈出審批，真出問題時就能攔住
   - 但一般信任預設 — Studio 系統提示詞已經把 [Required UX](/zh-TW/features/cardapp#必備-ux)、[op-log 用法](/zh-TW/features/variable-op-log)、[世界書繫結](/zh-TW/development/card-developers#cardapp-內容存放約定)、巨集 escape 這些都內建了

5. **不會的就讓它解釋**
   - "為什麼這裡要用 <code v-pre>\{{...}}</code> 而不是 <code v-pre>{{...}}</code>?"
   - 它會用人話講給你聽，順帶幫你把這塊的來龍去脈理清楚

## 下一步

- [CardApp 概覽](/zh-TW/features/cardapp) — CardApp 的核心概念
- [角色卡開發者指南](/zh-TW/development/card-developers) — `ctx` API 全集 + 創作約定
- [變數 op-log](/zh-TW/features/variable-op-log) — <code v-pre>{{setvar}}</code> 等巨集的執行機制
- [State System](/zh-TW/features/state-system) — Floor State / 觸發器 / 全域變數
- [Studio 能力清單](/zh-TW/features/card-editor/studio) — 編輯器、Git、AI 工具一覽
