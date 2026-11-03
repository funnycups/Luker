# 實戰：異世界生存日誌

本頁用一張完整的生存題材角色卡，演示如何用一段需求讓 [CardApp Studio](/zh-TW/features/card-editor/studio) 生成介面、世界書與開場白，再透過幾輪追問調整細節。全程只需描述效果。

## 最終結果

最終成品是一張名為「異世界生存日誌」的單人沉浸式角色扮演角色卡。發送第一條訊息後，介面如下：

![成品截圖](/images/walkthrough/isekai/step-08-end-to-end.png)

- 頂部狀態列顯示天數 / 體力 / 飽食度 / 心情
- 主角穿越到陌生森林的西式低魔異世界，AI 擔任環境與敘事者
- 一本隨卡繫結的世界書，包含狀態記錄、世界觀約定和幾個 NPC 設定
- 沉浸式按鈕命名（停筆 / 改寫 / 舊冊 / 新章 / 合卷），覆蓋常用的對話操作

整個過程只需要用中文描述需求，**AI 會處理介面、世界書條目、狀態變數和開場白，並把各項內容關聯到角色卡**。

## 前置條件

- 一個可用的 Luker 執行個體
- 已設定完成的 LLM API，推薦使用 Claude、GPT-5 等支援工具呼叫的模型
- （進階步驟需要）已設定完成的 Stable Diffusion / ComfyUI 後端

## 1. 建立空白角色卡並進入 Studio

開啟右側角色管理面板，點擊「新建角色」並填寫名稱（本文使用「異世界生存日誌」）。描述、第一條訊息與世界書繫結由 Studio AI 生成。

接下來開啟「擴充功能」面板 → 展開「角色卡編輯助手」→ 點擊 **「&lt;/&gt; CardApp Studio」**：

![Studio 入口位置](/images/walkthrough/isekai/step-01-studio-entry.png)

Studio 是覆蓋在主介面上的三欄佈局：左側 AI 對話、中間即時預覽、右側程式碼編輯器。新角色卡的 CardApp 尚未啟用，Studio 偵測到該狀態後會主動詢問是否啟用。

![Studio 初始空白狀態](/images/walkthrough/isekai/step-02-studio-empty.png)

::: tip 閱讀重點
右側程式碼編輯器會隨 AI 的工作重新整理。閱讀本頁時關注**左欄對話**與**中間預覽**即可。
:::

## 2. 一段需求完成骨架、世界書與開場白

點擊左側輸入框，**完整複製**以下內容：

```
我想做一個輕小說風味的西式異世界冒險角色卡,主角穿越到陌生森林獨自求生,
AI 擔任環境和敘事者(第三人稱視角描寫主角看到 / 感受到什麼)。
不要東方仙俠 / 修真 / 都市 / 校園風,也不要末日 dark fantasy。

先幫我搭一個最小可用的 CardApp:
- 頂部狀態列 4 格:天數、體力、飽食度、心情
- 中間是訊息渲染區
- 下面是輸入框和傳送按鈕
- 必須的快捷按鈕(停止生成、切換聊天、新存檔、關閉聊天)放底部

狀態變數都用 isj_ 前綴(isj_day / isj_hp / isj_food / isj_mood)。
風格請配合"輕小說西式異世界"的氛圍,具體配色 / 字體 / 排版你來定。
```

![輸入第一輪需求](/images/walkthrough/isekai/step-03-first-prompt.png)

發送後，Studio 不會直接開始編寫，而是先查看這張卡的現狀，再說明打算怎麼做。新卡還沒有啟用 CardApp，它會先詢問是否啟用（回覆「好」即可）。

確認後，它一次完成以下工作：

- 啟用這張卡的 CardApp
- 編寫介面程式碼，包括狀態列、訊息區、輸入區和常用操作按鈕
- 建立配套世界書，寫入狀態記錄和世界觀約定
- 編寫開場白，並初始化狀態變數
- 把世界書關聯到這張卡

每項修改都會彈出對話框顯示改動內容，確認後才會寫入。

![AI 工作過程：修改與確認](/images/walkthrough/isekai/step-04-first-round-work.png)

::: tip AI 內容放入世界書，不修改主提示詞
AI 不會修改角色卡的主提示詞，這是 [Luker 的 CardApp 創作約定](/zh-TW/development/card-developers)：角色卡的主提示詞會覆蓋聊天補全預設原本設計的系統部分，把卡片內容放入世界書條目才能與預設共存。Studio AI 預設遵守該約定。
:::

AI 全部完成後，Studio 中間預覽區自動重新載入，顯示生成的 CardApp：

![首次執行效果](/images/walkthrough/isekai/step-05-first-round-running.png)

## 3. 不滿意時繼續追問 AI

完成一輪後，你可能想更換配色、調整按鈕順序、修改 AI 描述的氛圍，或補充某個 NPC 的設定；這些均可在左欄繼續追問，Studio AI 會結合上下文繼續修改：

措辭不準確時補充說明即可，AI 會繼續修改。

## 4. 端到端測試

發送一條角色扮演輸入（內容不限），觀察頂部狀態列的數值隨劇情變化。

到這裡，你已經透過多輪自然語言對話，得到了一張：

- ✓ 自帶前端介面（狀態列和常用操作按鈕）
- ✓ 自帶世界觀和 NPC 設定（繫結的世界書）
- ✓ 開場白會初始化狀態
- ✓ 具備沉浸感的角色扮演角色卡

上述內容由 Studio 生成並寫入，CardApp 在確認後啟用。

## 5.（進階）接入影像生成

::: warning 前置：SD/ComfyUI 後端
本節需要先設定 SillyTavern 自帶的 [影像生成擴充功能](https://docs.sillytavern.app/extensions/stable-diffusion/) 後端（本地 Stable Diffusion、ComfyUI 或遠端 API 均可）。後端不可用時跳過本節。
:::

```
我想要每次 AI 描述新場景時 CardApp 自動配圖。玩家純對話 / 內心戲不畫。
另外底部加一個「畫下所見」按鈕,可以手動讓最近一條 AI 訊息的場景重畫。

對沒配置畫圖後端的用戶:靜默跳過或隱藏按鈕,不要彈出錯誤,
不要影響 CardApp 其他功能。
```

![訊息上方插畫](/images/walkthrough/isekai/step-09-scene-image.png)

![「畫下所見」按鈕觸發](/images/walkthrough/isekai/step-10-redraw-button.png)

## 提示詞實踐要點

有效的 Studio 需求描述不需要很長，說明目標即可。以下為幾條要點：

1. **描述外觀與行為**
   - 示例：「頂部狀態列 4 格，顯示天數、體力、飽食度與心情」
   - 實作方式交給 Studio 決定，例如何時重新渲染狀態列

2. **區分約束與自由度**
   - 必須固定的內容寫成約束，例如變數使用 `isj_` 前綴。
   - 其餘內容交由 Studio 決定，例如配色、字型與版面。

3. **說明與預期的偏差**
   - 指出期望結果與目前結果，例如「狀態列應有四項，目前只有兩項，請補齊」。
   - 在原需求上追加說明即可。

4. **批准前查看改動**
   - 每項修改都會彈出確認，可以逐項檢查。
   - Studio 會處理常用操作、變數記錄、世界書關聯與跳脫。

5. **讓 Studio 解釋機制**
   - 例如「狀態變數在哪一步寫入？」「這個世界書條目什麼時候觸發？」
   - Studio 可以讀取專案檔案與文件，回答與目前角色卡相關的問題。

## 下一步

- [CardApp 概覽](/zh-TW/features/cardapp) —— CardApp 的核心概念
- [角色卡開發者指南](/zh-TW/development/card-developers) —— CardApp 的完整介面和創作約定
- [變數記錄](/zh-TW/features/variable-op-log) —— 變數如何隨對話更新
- [狀態系統](/zh-TW/features/state-system) —— 樓層狀態、觸發器和全域變數
- [Studio 能力清單](/zh-TW/features/card-editor/studio) —— 編輯器、版本記錄和 AI 操作一覽
