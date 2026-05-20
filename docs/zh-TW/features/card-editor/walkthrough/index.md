# 從零寫一個 CardApp

這一節用具體題材演示**怎麼讓 CardApp Studio 從零聯動起來** —— 全程不用自己寫程式碼，用自然語言指揮 Studio 設計 schema、loop、世界書、CardApp 面板。

兩個示例按題材和複雜度挑一個看：

| 示例 | 題材 | 涵蓋能力 | 適合 |
| --- | --- | --- | --- |
| [異世界生存日誌](/zh-TW/features/card-editor/walkthrough/isekai) | 西式低魔異世界生存 RP | 頂部狀態列（Day / Stamina / Hunger / Mood）+ 世界書 + 場景插畫（可選） | 想最快看到 CardApp 跑起來 |
| [維多利亞案宗](/zh-TW/features/card-editor/walkthrough/victorian) | 1888 倫敦福爾摩斯式偵探卡 | 記憶圖派生 schema + orchestrator loop（draft → critique → revise）+ 卡專用世界書 + 變數驅動 CardApp 面板 | 想看 schema / loop / 變數驅動 UI 全棧協同 |

兩個示例的總章程一致 —— Studio 提案 / 你點頭 / Studio 落地，每個工具呼叫都有 diff 讓你審。差別在於涵蓋的能力層次不同。

剛接觸 Studio 沒建過卡，從[異世界生存日誌](/zh-TW/features/card-editor/walkthrough/isekai)開始；想看完整能力疊在一張卡上，看[維多利亞案宗](/zh-TW/features/card-editor/walkthrough/victorian)。
