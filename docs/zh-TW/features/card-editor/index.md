# 角色卡編輯助手

角色卡編輯助手（Character Editor Assistant，簡稱 CEA）是 Luker 內建的 AI 輔助編輯工具。它讓你可以用自然語言指令修改角色卡設定、世界書條目和 CardApp 程式碼，AI 的每次修改都以差異對比的形式展示，逐項審批後才會生效。

編輯助手會根據當前角色卡是否含 CardApp 自動選擇兩種模式：

| 模式 | 適用場景 | 詳細文件 |
| --- | --- | --- |
| **普通彈窗** | 不含 CardApp 的常規角色卡 | [普通彈窗模式](/zh-TW/features/card-editor/popup) |
| **CardApp Studio** | 內嵌了 CardApp 的角色卡 | [CardApp Studio](/zh-TW/features/card-editor/studio) |

## 公共能力

無論哪種模式，編輯助手均提供以下核心能力：

- **AI 工具呼叫驅動** —— 用自然語言描述需求，AI 透過結構化的工具呼叫直接修改欄位與檔案
- **差異審批** —— 每一處修改均先以差異對比呈現，逐項 / 整批批准或拒絕，未批准的不生效
- **逐行 side-by-side 檢視** —— 欄位級差異可放大查看完整的逐行對比
- **會話持久化** —— 多個編輯會話獨立保存，關閉後再開啟能繼續之前的工作和待審批的改動
- **修改歷史與回滾** —— 已批准的修改記入歷史，可隨時回滾到任意版本

## 入口與兩種模式的切換

入口在**擴充功能面板 → 角色卡編輯助手**。當前角色不含 CardApp 時，「開啟編輯器」開啟普通彈窗；含 CardApp 時自動進入 Studio。Studio 也可以透過同面板裡的「&lt;/&gt; CardApp Studio」按鈕主動啟動。

![編輯助手在擴充功能面板的入口與配置](/images/card-editor-popup/cea-extensions-panel.png)

## 配置選項

兩種模式共享擴充功能面板裡的同一組設定：

- **世界書同步彈窗** —— 是否在替換 / 更新角色卡後啟用世界書同步彈窗（僅普通彈窗會觸發，詳見[普通彈窗模式](/zh-TW/features/card-editor/popup#世界書同步)）
- **模型請求 LLM 預設** —— 編輯助手使用的提示詞預設（留空則使用當前預設）
- **模型請求 API 預設** —— 編輯助手使用的 API 連線配置（留空則使用當前配置）

兩個預設下拉框旁均有問號按鈕，說明該槽位需要什麼類型的預設，並可以一鍵匯入內建預設。
- **工具呼叫重試次數** —— AI 回傳無效工具呼叫時的重試次數

## 修改歷史

修改歷史在擴充功能面板裡獨立呈現。所有透過 AI 執行並批准的修改均會記錄在這裡——支援檢視改動、回滾、刪除單條或清空全部歷史。Studio 模式下檔案變更由版本管理記錄，每條記錄對應一個版本，詳見 [CardApp Studio](/zh-TW/features/card-editor/studio#version-history-git)。

## 相關頁面

- [普通彈窗模式](/zh-TW/features/card-editor/popup) —— 不含 CardApp 的角色卡的 AI 編輯流程
- [CardApp Studio](/zh-TW/features/card-editor/studio) —— 含 CardApp 的角色卡的完整開發環境
- [CardApp](/zh-TW/features/cardapp) —— 角色卡內嵌應用系統
- [搜尋外掛](/zh-TW/features/search-tools) —— Studio / 編輯助手中的網路搜尋
