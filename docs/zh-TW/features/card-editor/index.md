# 角色卡編輯助手

角色卡編輯助手是 Luker 內建的 AI 輔助編輯工具，支援透過自然語言指令修改角色卡設定、世界書條目與 CardApp 程式碼。AI 提出的每次修改均先以差異對比顯示，確認後才會生效。

角色卡欄位與內嵌 CardApp 分別對應各自的工作區：

| 模式 | 適用場景 | 詳細說明文件 |
| --- | --- | --- |
| **工作台卡片編輯** | 修改角色卡欄位與綁定的世界書 | [工作台卡片編輯](/zh-TW/features/card-editor/popup) |
| **CardApp Studio** | 開發角色卡內嵌的 CardApp 應用 | [CardApp Studio](/zh-TW/features/card-editor/studio) |

## 公共能力

- **AI 工具呼叫驅動** —— 用自然語言描述需求，AI 透過結構化的工具呼叫產生欄位與檔案改動提案
- **差異審閱** —— 每處修改先進入**改動清單**顯示前後差異，勾選後套用或放棄
- **逐行差異展開** —— 欄位級差異可展開檢視完整的逐行對比
- **會話持久化** —— 同一角色下的多個編輯會話獨立儲存，重新開啟後可繼續先前的討論與待審改動
- **改動記錄與復原** —— 已套用的卡片與世界書修改記入**工作台 → 改動記錄**支援逐條復原；Studio 模式下檔案變更透過 Git 提交記錄版本

## 入口說明

- **工作台 → AI 迭代** —— 選擇**角色卡**或**世界書**目標，在統一的[工作台](/zh-TW/features/workbench)中對話修改目前角色卡及綁定的世界書，右側即時預覽卡片內容。
- **擴充功能 → 角色卡編輯助手** —— **開啟編輯器**直接跳轉到目前角色的**工作台 → AI 迭代 → 角色卡**，**&lt;/&gt; CardApp Studio** 開啟面向 CardApp 的多欄開發環境。

![編輯助手在擴充功能面板的入口與設定](/images/card-editor-popup/cea-extensions-panel.png)

## 設定選項

可在**工作台 → 設定**統一設定預設連線與生成預設，也可在**擴充功能 → 角色卡編輯助手**單獨指定：

- **迭代 AI 的提示詞預設** —— 編輯助手與 CardApp Studio 使用的提示詞預設；留空時跟隨工作台共用設定或目前預設。下拉選單下方的操作可匯入內建的 `plugin-only` 示例，或開啟預設工作台從現有預設派生
- **迭代 AI 的 API 預設** —— 編輯助手與 CardApp Studio 使用的 API 連線設定
- **工具呼叫重試次數** —— AI 傳回無效工具呼叫時的重試次數
- **自訂系統提示詞（進階）** —— 分別改寫「編輯器迭代提示詞」與「CardApp Studio 提示詞」

## 修改歷史

在工作台套用的卡片與世界書改動可在**工作台 → 改動記錄**中依目標篩選並逐條復原。CardApp Studio 下的程式碼版本歷史見 [CardApp Studio](/zh-TW/features/card-editor/studio#version-history-git)。

## 相關頁面

- [工作台卡片編輯](/zh-TW/features/card-editor/popup) —— 角色卡欄位編輯與替換角色卡時的世界書合併
- [CardApp Studio](/zh-TW/features/card-editor/studio) —— 含 CardApp 角色卡的完整開發環境
- [CardApp](/zh-TW/features/cardapp) —— 角色卡內嵌應用系統
- [搜尋工具](/zh-TW/features/search-tools) —— Studio 與工作台 AI 迭代中的聯網搜尋
