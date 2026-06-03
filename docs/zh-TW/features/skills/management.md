# Skill 管理

編排器面板的**管理 Skills**按鈕打開一個子面板，裡頭可以安裝、編輯、遷移、刪除 Skill。本頁逐一過一遍每個入口。

::: tip 在哪裡找
打開擴充套件抽屜 → **多智慧體編排** 節 → 點面板底部附近的**管理 Skills**。子面板以彈窗形式覆蓋在編排器設定之上。
:::

## 子面板概覽

Skill 管理頂部有三個 tab：

- **已安裝** —— 你 `data/<user>/skills/<scope>/` 下有什麼。按作用域過濾（全域 / 預設 / 角色卡）或選**全部**。
- **瀏覽出廠** —— `default/skills/global/` 自帶的 24 個 Skill，每行顯示你本地副本是匹配、有差異，還是沒裝。
- **匯入** —— 從檔案、URL，或角色卡 / 預設裡抽出 Skill 的入口。

![Skill 管理子面板，已安裝 tab](/_screenshots/skills/manager-installed-tab.png)

## Tab 1 —— 已安裝

每行顯示：

- `name` —— Skill frontmatter 裡的 `name`。點擊打開內嵌編輯器。
- `description` —— frontmatter 裡的一行摘要。
- `scope` —— 作用域 chip（`global` / `preset/<api>/<name>` / `character/<file>`）。
- `size` —— 檔案數 + 總位元組數。
- **被參照** —— 當前編排器 profile 中可見清單參照了該 Skill 的 agent 數量 chip。

行內動作（右側）：

| 動作 | 作用 |
|---|---|
| **檢視** | `SKILL.md` 的唯讀 Markdown 渲染。 |
| **編輯** | 打開內嵌編輯器（見下文 [內嵌編輯器](#內嵌編輯器)）。 |
| **遷移到……** | 原子級跨作用域 move。參照（僅按名字）依然有效。 |
| **改名** | 在當前作用域內原子改名。目錄與 frontmatter `name` 同步更新。指向舊名的參照變灰（見 [失效參照](#失效參照)）。 |
| **刪除** | 刪除 Skill 目錄。參照繼續變灰，而不是阻斷派遣。 |

### 批次選擇

頂列切到**多選**模式後，每行多一個核取方塊。勾選至少一項後，工具列會多一個**把所選打包進預設……**動作 —— 見下文 [嵌入匯出](#嵌入匯出-到預設和角色卡)。

## Tab 2 —— 瀏覽出廠

「瀏覽出廠」tab 把你本地每個出廠 Skill 的副本和 `default/skills/global/` 裡的版本對比。每行顯示三種狀態之一：

| 標記 | 含義 |
|---|---|
| **已安裝（一致）** | 本地副本與出廠版本逐位元組一致。 |
| **已安裝（你的版本有差異）** | 本地副本存在，但雜湊與出廠版本不匹配 —— 你（或某次迭代工作台會話）改過它。 |
| **未安裝** | 本地沒有副本。點擊**安裝**把它落到 `global`。 |

![瀏覽出廠，混合狀態](/_screenshots/skills/manager-bundled-tab.png)

tab 頂部的**全量匯入出廠**按鈕，是對每個「未安裝」或「有差異」行點**安裝**的便捷等價 —— 它會用出廠版本**覆蓋**全部 24 個出廠 Skill。

::: warning 覆蓋是破壞性的
全量匯入出廠不會合併 —— 它直接覆蓋。如果你本地改過 `event-summary-rules-zh`，匯入出廠版本會沖掉你的修改。按鈕標籤會在點擊前明確告訴你即將覆蓋多少個同名 Skill。
:::

## Tab 3 —— 匯入

四個入口：

### 從檔案匯入

上傳一個包含單個 Skill 目錄的 `.zip`。伺服器校驗封存，預覽每個 Skill 的衝突狀態（每 Skill：`新` / `相同` / `不同`），然後等你對每個衝突做決定再提交。

### 從 URL 匯入

貼上一條 `https://...` URL，指向一份原始 `SKILL.md`。伺服器拉下來後作為單檔案 Skill 安裝（無子檔案）。多檔案 Skill 用**從檔案匯入**走 zip 路徑。

::: info 只接受 HTTPS、只接受原始 SKILL.md
URL 匯入器有意做窄 —— 它只抓一份 Markdown 檔案。再複雜（多檔案、二進位）的就走 zip 路徑。匯入面保持小而可預測。
:::

### 匯入出廠

跟「瀏覽出廠」tab 的**全量匯入出廠**是同一個動作，這裡列出便於發現。

### 從角色卡 / 預設抽取

匯入帶 `embedded_skills_source` 欄位的角色卡（PNG）或預設（JSON）時，Luker 會自動彈出預覽對話框：

![嵌入匯入預覽](/_screenshots/skills/embed-import-preview.png)

對話框逐項列出每個嵌入的 Skill 及其衝突狀態。對每個衝突，你可選**跳過**（保留本地版本）或**替換**（用嵌入裡的版本）。內容相同的項（`相同`）會靜默不操作；新條目（`新`）直接安裝。

抽取後角色卡 / 預設磁碟檔案裡的嵌入負載被移除 —— Skill 現在住在 `skills/character/<file>/` 或 `skills/preset/<api>/<preset>/` 裡。這樣避免「過期嵌入」陷阱：內聯負載與已落地的檔案版本不一致。

## 內嵌編輯器

點擊 Skill 行的**編輯**會打開彈窗內編輯器：

![內嵌 Skill 編輯器](/_screenshots/skills/skill-editor.png)

- 左欄：檔案樹（SKILL.md + 任何子檔案）。點擊切換。
- 右欄：Markdown 編輯器，frontmatter 區段有 YAML 感知高亮。
- 頂列：檔案路徑、未儲存標記、**儲存**（走 `.staging/` 並原子提交）、**新增檔案**（在你指定的路徑建立一份新子檔案）。

寫入跟安裝走同一套 `.staging/` 紀律：新內容先經過校驗（路徑安全、大小限額、frontmatter 解析），全部通過後 staging 檔案原子地替換原檔案。失敗的寫入對原檔案零影響。

`SKILL.md` 是特殊的 —— 你能編輯它但不能從編輯器裡刪它（它是必需入口）。Skill 本身可透過行內動作整體刪除。

::: tip 不想手動改？
[AI 迭代工作台](/zh-TW/features/orchestrator/iteration-studio#用工作台編寫-skill) 也能替你寫和修改 Skill —— 用一句話描述變更，工作台透過相同的安裝路徑起草。要新建一個 Skill、或者把已有 Skill 重寫一遍而不想自己敲 Markdown 時很省事。
:::

## 嵌入匯出 —— 到預設和角色卡

Skill 在跟它所依賴的產物（角色卡、預設）一起分發時最有用。某張角色卡需要某條口吻規則，某個預設是為特定子代理調出來的 —— 兩者都能把 Skill 內聯打包。

### 打包進預設

在編排器面板裡，[補全預設助手](/zh-TW/features/preset-assistant) 會派生出一份 `-orchestrator` 預設。派生緊接著，助手在工具列給出一條**為該預設打包 Skills**連結，點開後會進入 Skill 管理並自動開啟多選模式。挑你想要的 Skill，點**把所選打包進預設……**，再選目標預設。

打包器把這些 Skill 寫進預設的 `extensions.luker.embedded_skills_source` 欄位。下一次儲存預設時，嵌入隨 JSON 一起被持久化。其他 Luker 使用者匯入這份預設時會看到上文描述的嵌入抽取對話框。

### 打包進角色卡

在角色卡編輯器裡，**出廠 Skill** 區段也是同樣的邏輯：選 Skill、打包，它們寫進 `data.extensions.luker.embedded_skills_source`。PNG 匯出時嵌入序列化進卡的元資料，分發這張卡也就分發了 Skill。

::: tip 內聯 vs zip 的閾值
小且只含文字的 Skill 走 `inline-files-v1` 格式（Markdown 內容直接內嵌）。更大或帶二進位的 Skill 自動升級到 `archive-base64-v1`（zip + base64 + sha256）。打包器按每 Skill 自動決定，你不用選。
:::

## 作用域遷移

透過行內動作**遷移到……**，你隨時可以把 Skill 從 `global` → `preset` → `character`（或反向）挪。遷移是一次原子檔案系統重新命名 —— 沒有拷貝，沒有中間狀態。

這為什麼安全：編排器 profile 只按**名字**參照 Skill，永遠不帶作用域前綴。名為 `voice-rules` 的 Skill 不管當前在哪個作用域，都按後者優先（character > preset > global）解析。遷移不破壞任何參照；它只改變 Skill 何時可見。

典型遷移：

- **`global` → `character`** —— 你寫了一條寫作規則、用在多張卡上，後來發現某張卡需要一份專門變體。把它遷到那張卡的作用域，讓更通用的版本留在 `global`。兩者共存；卡片載入時按卡的版本勝出。
- **`preset` → `global`** —— 你打包在某個預設裡的 Skill 後來發現到處都有用。把它提升到全域。
- **`character` → `global`** —— 某個角色卡專屬 Skill 最終泛化了。提升它。

## 失效參照

當你改名或刪除某個被編排器 profile 參照的 Skill，profile 的 `skills.visible` 清單仍然保留舊名。執行時找不到它，於是 agent 靜默看不到（沒有錯誤、沒有阻斷派遣）。

在編排器設定編輯器裡，失效參照變灰，並帶 tooltip **「該 Skill 未安裝」**。兩次點擊就能修：要麼在 profile 裡改名，要麼重新加上這個 Skill。

這種「軟失敗」紀律是有意的。它意味著：缺失的 Skill 永遠不會阻斷 agent 派遣；增加 / 刪除 Skill 不需要同步編輯 profile。

## 相關

- [Skills 概覽](/zh-TW/features/skills/) —— 什麼是 Skill、三種作用域
- [創作 Skill](/zh-TW/features/skills/authoring) —— 寫自己的
- [編排器整合](/zh-TW/features/skills/orchestrator-integration) —— 把 Skill 掛到 profile 上
- [Skill 擴充套件 API](/zh-TW/development/extension-api/skills) —— 從擴充套件程式設計式管理
- [補全預設助手](/zh-TW/features/preset-assistant) —— 派生 `-orchestrator` 預設並給出打包 Skills 連結
