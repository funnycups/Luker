<a name="readme-top"></a>

<picture>
  <source media="(prefers-color-scheme: dark)" srcset="https://raw.githubusercontent.com/funnycups/Luker/release/docs/public/images/branding/hero-dark.png">
  <img alt="Luker —— 下一代角色扮演聊天平台" src="https://raw.githubusercontent.com/funnycups/Luker/release/docs/public/images/branding/hero-light.png">
</picture>

<div align="center">

[English](readme.md) | [Deutsch](readme-de_de.md) | [简体中文](readme-zh_cn.md) | **繁體中文** | [日本語](readme-ja_jp.md) | [Русский](readme-ru_ru.md) | [한국어](readme-ko_kr.md)

[![GitHub Stars](https://img.shields.io/github/stars/funnycups/Luker.svg?style=flat)](https://github.com/funnycups/Luker/stargazers)
[![GitHub Forks](https://img.shields.io/github/forks/funnycups/Luker.svg?style=flat)](https://github.com/funnycups/Luker/forks)
[![GitHub Issues](https://img.shields.io/github/issues/funnycups/Luker.svg?style=flat)](https://github.com/funnycups/Luker/issues)
[![License](https://img.shields.io/github/license/funnycups/Luker.svg?style=flat)](../LICENSE)
[![Docs](https://img.shields.io/badge/docs-luker.cups.moe-orange?style=flat)](https://luker.cups.moe/zh-TW/)
[![Android APK](https://img.shields.io/badge/download-Android%20APK-3ddc84?style=flat&logo=android&logoColor=white)](https://github.com/funnycups/Luker/releases)

</div>

---

Luker 是一款下一代角色扮演聊天平台。和真正記得住劇情的角色對話，讓一整支導演帶隊的 agent 團在每次回覆前先把這場戲排好，透過和 AI 聊天來修改角色卡，讓角色能在對話中途即時聯網檢索。

## Luker 是什麼

Luker 是一個為大型語言模型角色扮演場景專門打造的平台。開箱即用，不需要裝第三方擴充，內建了：基於知識圖譜的長期記憶、自帶可重用技能庫的多 Agent 場景編排、AI 輔助的角色卡編輯工作台、聊天補全預設助手、區域網路同步，以及一個可在手機上執行完整後端的原生 Android 應用。

Luker 基於 [SillyTavern](https://github.com/SillyTavern/SillyTavern) 深度重構而來，與其保持**雙向 100% 資料相容**。角色卡、世界書、預設、聊天記錄都可以在兩者之間無損搬遷，零遷移成本。

## 核心亮點

### 記憶圖 —— 讓角色真的記得住

一套基於知識圖譜的長期記憶。每一場戲都會被提取成帶類型的節點（角色、地點、事件、劇情線），節點之間互相連邊。每次回覆前，召回環節會在圖上游走，把最相關的記憶注入上下文——所以三十輪之後使用者隨口問一句「通往廢棄神殿的第三條路徑呢」，角色能準確翻出之前的那次對話。

![記憶圖演示](https://raw.githubusercontent.com/funnycups/Luker/release/docs/public/images/branding/memory-graph-demo.gif)

→ [記憶圖文件](https://luker.cups.moe/zh-TW/features/memory-graph)

### 多 Agent 編排 —— 一整支導演隊伍替你把每場戲排好

在創作 LLM 開口之前，一支可自由配置的 agent 隊伍先行執行：蒸餾器壓縮最近上下文，規劃師草擬下一場戲，評審員做最後審校。最終回覆出來的同時，附帶一份可展開檢查的執行時 trace。五種執行模式任選：Spec（固定流水線）、單 Agent、Agenda（流程動態派發 agent）、Loop（單一 agent 進行迴圈迭代）、Director（主 agent 帶一支子 agent 團隊直接寫正文）。

![多 Agent 編排演示](https://raw.githubusercontent.com/funnycups/Luker/release/docs/public/images/branding/orchestrator-demo.gif)

→ [多 Agent 編排文件](https://luker.cups.moe/zh-TW/features/orchestrator/)

### 技能 —— 按需讀取的可重用知識包

agent 按需讀取的可重用知識包：寫作規則、口吻約定、反八股清單。格式相容 Anthropic Claude Skills，為 Claude Code 撰寫的技能可原樣遷移至 Luker，也可遷移回去。編排器預設的 Director profile 自帶 24 個內建技能，技能也可以隨角色卡或預設一起分發。

<img alt="技能管理器：已安裝與內建技能" src="https://raw.githubusercontent.com/funnycups/Luker/release/docs/public/_screenshots/skills/manager-installed-tab.png" width="720">

→ [技能文件](https://luker.cups.moe/zh-TW/features/skills/)

### CardApp Studio 與角色卡編輯助手 —— 透過和 AI 對話來編輯角色卡

一整套針對角色卡的編輯環境：CodeMirror 6 程式碼編輯器、AI 聊天面板、每批改動都以 diff 形式讓你逐條批准。普通角色卡使用輕量彈窗版編輯助手；帶 **CardApp**（內嵌在角色卡裡的迷你應用）的卡片則進入功能完整的 Studio，內含檔案樹、即時預覽、歷史記錄。

![CardApp Studio 演示](https://raw.githubusercontent.com/funnycups/Luker/release/docs/public/images/branding/cardapp-studio-demo.gif)

→ [角色卡編輯助手](https://luker.cups.moe/zh-TW/features/card-editor/) · [CardApp Studio](https://luker.cups.moe/zh-TW/features/card-editor/studio)

### 聊天補全預設助手 —— 透過描述構建預設

告訴助手你想讓某個聊天補全預設做什麼，它會與你逐輪迭代，每次改動都以 diff 形式供你審閱，直至符合預期——讀取參數、編輯提示詞條目、並與參考預設對比。同一套工作流也覆蓋多 Agent 編排的預設。

<img alt="聊天補全預設助手" src="https://raw.githubusercontent.com/funnycups/Luker/release/docs/public/images/preset-assistant/cpa-overview.png" width="720">

→ [聊天補全預設助手文件](https://luker.cups.moe/zh-TW/features/preset-assistant)

### 原生 Android 應用 —— 把整個平台裝進手機

Luker 的後端**內嵌於** Android 應用執行。安裝 APK 並打開，即可在一部裝置上獲得完整的伺服端與介面——無需 Termux、無需手動安裝 Node、無需連接埠轉送。首次啟動畫面支援備份 ZIP 匯入，遷移便捷。

![Android APK 演示](https://raw.githubusercontent.com/funnycups/Luker/release/docs/public/images/branding/android-apk-demo.gif)

→ [Android 應用指南](https://luker.cups.moe/zh-TW/guide/android)

### 搜尋外掛 —— 角色也能聯網搜尋

為寫作 LLM 提供一個即時聯網搜尋工具（DuckDuckGo、SearXNG、Brave），或者讓搜尋作為預請求 agent 在生成前自動執行，把結果寫入世界書。這些結果來自真正的搜尋引擎，而非訓練語料中的記憶。

→ [搜尋外掛文件](https://luker.cups.moe/zh-TW/features/search-tools)

### 區域網路同步

同一區域網路內兩台 Luker 實例互相配對，聊天記錄、角色卡、世界書、設定在兩者之間自動同步。桌面端和手機端保持一致，不用推任何東西到雲上。

→ [區域網路同步指南](https://luker.cups.moe/zh-TW/improvements/lan-sync)

### 聊天合併與拆分

任意位置拆分長聊天，或將兩段聊天合併成一條；分支歷史保持一致。適用於劇情失控、希望保留精彩片段並拆分另開分支的場景。

<img alt="聊天合併與拆分" src="https://raw.githubusercontent.com/funnycups/Luker/release/docs/public/screenshots/chat-merge-split/07-split-dialog-three-segments.png" width="720">

→ [聊天管理](https://luker.cups.moe/zh-TW/basics/chat-management)

### TTS NPC 對白歸屬

開啟 TTS 之後，一則回覆裡每一句引號台詞都可以用說話者自己的聲音唸出來。後台會有一個 AI 環節判斷每句台詞是誰說的——它發現的 NPC 會自動出現在語音映射裡；你事先手動加進去的名字，從第一次播放起就能被辨識。

<img alt="訊息中每句台詞旁的播放按鈕" src="https://raw.githubusercontent.com/funnycups/Luker/release/docs/public/screenshots/tts-npc-attribution/03-inline-buttons-zoom.png" width="678">

→ [TTS NPC 對白歸屬](https://luker.cups.moe/zh-TW/features/tts-npc-attribution)

### 換模型不必重配提示詞

SillyTavern 中 API 連線與聊天補全預設是聯動的，切換模型會連帶變更你的提示詞設定。Luker 把兩者解耦：換模型不用重新配提示詞，換預設不用重新填 API key。

### 關掉分頁，回覆照樣在寫

生成在後端執行，透過 WebSocket 串流推送給介面。重新整理分頁、蓋上筆電、丟失 Wi-Fi——後端上的這次回覆會繼續寫下去，你回來的那一刻自動重連到介面。沒有丟失，沒有重啟。

→ [後端儲存與生命週期](https://luker.cups.moe/zh-TW/improvements/backend-storage)

---

此外還有一長串小便利功能：預設與提示詞的分組、聊天人設鎖定、復原 Toast、能看到世界書條目因何啟動的追蹤、從各提供商即時拉取的模型列表。詳見[文件](https://luker.cups.moe/zh-TW/)。

## 介面截圖

<table>
  <tr>
    <td width="50%"><img alt="記憶圖檢查器" src="https://raw.githubusercontent.com/funnycups/Luker/release/docs/public/images/memory-graph/memory-graph-view.png"></td>
    <td width="50%"><img alt="多 Agent 編排執行時 trace" src="https://raw.githubusercontent.com/funnycups/Luker/release/docs/public/images/orchestrator/orch-runtime-trace.png"></td>
  </tr>
  <tr>
    <td width="50%"><img alt="CardApp Studio 工作台" src="https://raw.githubusercontent.com/funnycups/Luker/release/docs/public/images/cardapp-studio/studio-overview.png"></td>
    <td width="50%"><img alt="聊天補全預設助手" src="https://raw.githubusercontent.com/funnycups/Luker/release/docs/public/images/preset-assistant/cpa-overview.png"></td>
  </tr>
</table>

## 開始使用

- **桌面（Node.js）** —— `git clone https://github.com/funnycups/Luker.git && cd Luker && npm install && node server.js`。需要 Node.js 24 或更新版本。→ [快速開始](https://luker.cups.moe/zh-TW/guide/getting-started)
- **Android APK** —— 從 [Releases](https://github.com/funnycups/Luker/releases) 頁面下載最新簽名 APK，安裝即用。→ [Android 應用指南](https://luker.cups.moe/zh-TW/guide/android)
- **Docker** —— 用倉庫根目錄的 compose 檔案執行 `docker compose up`。→ [快速開始](https://luker.cups.moe/zh-TW/guide/getting-started)

## 從 SillyTavern 遷移過來？

Luker 與 SillyTavern 保持雙向 100% 資料相容。把 `data/` 目錄整個拷過來即可——角色卡、世界書、預設、聊天記錄、人設、設定全部無損。全域第三方擴充存放在 `data/` 之外，位於 `public/scripts/extensions/third-party/`，需要另外複製。想回去也是一樣，反向拷回來；Luker 獨家資料（記憶圖、多 Agent 編排設定）存在獨立狀態檔案裡，SillyTavern 會自動忽略。**遷移前無論如何都請先做備份。**

→ [遷移指南](https://luker.cups.moe/zh-TW/guide/migration)

## 社群與回饋

- Bug 回報和功能請求：[GitHub Issues](https://github.com/funnycups/Luker/issues)
- 提交 Issue 之前請先閱讀文件：[luker.cups.moe](https://luker.cups.moe/zh-TW/)

## 參與貢獻

歡迎 PR。請先閱讀 [CONTRIBUTING.md](../CONTRIBUTING.md)；提交 Issue 之前請先檢索是否已有相同問題。

## 授權與鳴謝

以 **AGPL-3.0** 開源。本程式按現狀分發，不附帶任何擔保；詳見 [GNU Affero 通用公共許可證](../LICENSE)。

- 建構於 **SillyTavern** —— 由 Cohee、RossAscends、Wolfsblvt 以及 300 多位貢獻者共同打造：<https://github.com/SillyTavern/SillyTavern>
- [TavernAI](https://github.com/TavernAI/TavernAI-v1) 1.2.8 by Humi（MIT 許可）
- 部分程式碼源自 CncAnon 的 TavernAITurbo mod，已獲授權
- Visual Novel 模式靈感來自 [PepperTaco](https://github.com/peppertaco/Tavern/)
- Noto Sans 字體 by Google（OFL 許可）
- Lexer / Parser 使用 [Chevrotain](https://github.com/chevrotain/chevrotain)（Apache-2.0）
- 圖示主題 [Font Awesome](https://fontawesome.com)（圖示 CC BY 4.0、字體 SIL OFL 1.1、程式碼 MIT）
- 預設角色內容 by @OtisAlejandro（Seraphina）和 @kallmeflocc
- Docker 指南 by [@mrguymiah](https://github.com/mrguymiah) 與 [@Bronya-Rand](https://github.com/Bronya-Rand)
- kokoro-js 函式庫 by [@hexgrad](https://github.com/hexgrad)（Apache-2.0）

## 主要貢獻者

[![Contributors](https://contrib.rocks/image?repo=funnycups/Luker)](https://github.com/funnycups/Luker/graphs/contributors)
