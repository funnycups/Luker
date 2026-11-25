# Skill 管理

**工作台 → 編排 → 準備階段**中的**管理技能...**按鈕會開啟 Skill 管理彈窗，用於安裝、編輯、遷移與刪除 Skill。本頁逐個說明入口。

::: tip 在哪裡找
開啟**工作台 → 編排 → 準備階段**，點擊**管理技能...**（或點擊**擴充功能 → 聊天補全預設助手 → 將 Skills 打包到此預設**直接定位到目前預設的作用域）。
:::

## 子面板概覽

Skill 管理頂部有多個分頁：

- **已安裝** —— 你 `data/<user>/skills/<scope>/` 下有什麼。按作用域過濾（全域 / 預設 / 角色卡）或選**全部**。
- **瀏覽出廠** —— `default/skills/global/` 自帶的 Skill，每行顯示你本地副本是匹配、有差異，還是沒裝。
- **匯入** —— 從檔案、URL 或 Luker 出廠 Skill 安裝的入口。

![Skill 管理子面板，已安裝分頁](/images/skills/manager-installed-tab.png)

## 已安裝

每行顯示：

- `name` —— Skill frontmatter 裡的 `name`。點擊打開內嵌編輯器。
- `description` —— frontmatter 裡的一行摘要。
- `scope` —— 作用域 chip，取值為 `global`、`preset/<name>`、`orch-preset/<mode>/<name>` 或 `character/<file>`。
- `size` —— 檔案數 + 總位元組數。
- **被參照** —— 當前編排器設定中引用該 Skill 的 agent 數量。

行內動作（右側）：

| 動作 | 作用 |
|---|---|
| **檢視** | `SKILL.md` 的唯讀 Markdown 渲染。 |
| **編輯** | 打開內嵌編輯器（見下文 [內嵌編輯器](#內嵌編輯器)）。 |
| **遷移到……** | 原子級跨作用域 move。參照（僅按名字）依然有效。 |
| **改名** | 在當前作用域內原子改名。目錄與 frontmatter `name` 同步更新。指向舊名的參照變灰（見 [失效參照](#失效參照)）。 |
| **刪除** | 刪除 Skill 目錄。參照顯示為灰色，派遣照常進行。 |

## 瀏覽出廠

「瀏覽出廠」分頁把你本機每個出廠 Skill 的副本和內建版本對比。每列顯示以下狀態之一：

| 標記 | 含義 |
|---|---|
| **已安裝（一致）** | 本地副本與出廠版本逐位元組一致。 |
| **已安裝（你的版本有差異）** | 本地副本存在，但雜湊與出廠版本不匹配 —— 你（或某次 AI 迭代會話）改過它。 |
| **未安裝** | 本地沒有副本。點擊**安裝**將其裝入 `global` 作用域。 |

![瀏覽出廠，混合狀態](/images/skills/manager-bundled-tab.png)

頂部的**全量匯入出廠**按鈕相當於對每個「未安裝」或「有差異」的列選擇**安裝**，會用出廠版本覆蓋所有出廠 Skill。

::: warning 覆蓋是破壞性的
全量匯入出廠不會合併 —— 它直接覆蓋。如果你本地改過 `event-summary-rules-zh`，匯入出廠版本會沖掉你的修改。按鈕標籤會在點擊前明確告訴你即將覆蓋多少個同名 Skill。
:::

## 匯入

入口：

### 從檔案匯入

上傳一個包含單個 Skill 目錄的 `.zip`。伺服器校驗封存，預覽每個 Skill 的衝突狀態（每 Skill：`新` / `相同` / `不同`），然後等你對每個衝突做決定再提交。

### 從 URL 匯入

貼上一條 `https://...` URL，指向一份原始 `SKILL.md`。伺服器下載後作為單檔案 Skill 安裝（無子檔案）。多檔案 Skill 請使用**從檔案匯入**的 zip 路徑。

::: info 只接受 HTTPS、只接受原始 SKILL.md
URL 匯入器的範圍有意保持狹窄：它只取得一份 Markdown 檔案。更複雜的情況（多檔案、二進位）使用 zip 匯入。匯入範圍保持小且可預測。
:::

### 匯入出廠

與「瀏覽出廠」中的**全量匯入出廠**是同一操作，此處列出以便查找。

## 內嵌編輯器

點擊 Skill 行的**編輯**會打開彈窗內編輯器：

![內嵌 Skill 編輯器](/images/skills/skill-editor.png)

- 左欄：檔案樹（SKILL.md + 任何子檔案）。點擊切換。
- 右欄：Markdown 編輯器，frontmatter 區段有 YAML 感知高亮。
- 頂列：檔案路徑、未儲存標記、**儲存**（透過 `.staging/` 原子提交）、**新增檔案**（在指定路徑建立一份新子檔案）。

寫入與安裝使用同一套 `.staging/` 規則：新內容先經過校驗（路徑安全、大小限制、frontmatter 解析），全部通過後由 staging 檔案原子替換原檔案。失敗的寫入對原檔案沒有影響。

`SKILL.md` 是特殊的 —— 它可以編輯，但不能從編輯器中刪除（它是必需入口）。Skill 本身可透過行內動作整體刪除。

::: tip 用 AI 編輯 Skill
[編排 AI 迭代](/zh-TW/features/orchestrator/iteration-studio#用工作台編寫-skill) 也能替你寫和修改 Skill —— 用一句話描述變更，工作台透過相同的安裝路徑起草。適用於需要新建 Skill、或重寫已有 Skill 而不想手動編寫 Markdown 的情境。
:::

## 嵌入匯出 —— 到預設和角色卡

Skill 與依賴它的預設或角色卡一同分發時最有價值。匯出預設或角色卡時，Luker 詢問是否將對應的 Skill 附帶進匯出檔案，附帶的 Skill 寫入檔案的 `extensions.luker.embedded_skills_source` 欄位。

僅當選擇**包含**時，匯出檔案才附帶 Skill。選擇**略過**、因沒有需要附帶的 Skill 而未出現詢問，或 Skill 附帶失敗時，匯出檔案均不附帶 Skill，匯入時附帶 Skill 的預設或角色卡同樣如此。Luker 中儲存的預設或角色卡保持不變。

### 匯出聊天補全預設

匯出的聊天補全預設在其預設作用域中存在 Skill 時，Luker 詢問「匯出時一併附帶此預設作用域的 Skills 嗎？」。選擇**包含**會將這些 Skill 附帶進匯出的 JSON；選擇**略過**則匯出不含 Skill 的預設。

聊天補全預設助手的**將 Skills 打包到此預設**按鈕會開啟已篩選到目前預設作用域的 Skill 管理器，便於檢視或補充此次匯出附帶的 Skill。

### 匯出編排預設

匯出編排預設時，若預設中任一 agent 可見 Skill，Luker 詢問「匯出時一併附帶此編排預設目前啟用的所有 Skills 嗎？」。選擇**包含**會附帶來自全域、聊天補全預設與編排預設作用域的全部可見 Skill；角色作用域的 Skill 不會附帶。

### 匯出角色卡

角色在其角色作用域中存在 Skill 時，透過**匯出和下載**匯出角色卡，Luker 會在 PNG 或 JSON 檔案下載前詢問「匯出時一併附帶此角色的 Skills 嗎？」。選擇**包含**會將這些 Skill 附帶進匯出檔案。角色卡繫結預設中附帶的 Skill 不會匯出。Skill 附帶失敗時，角色卡照常匯出但不含 Skill，並顯示警告提示。

### 安裝附帶的 Skill

首次開啟匯入的、附帶 Skill 的角色卡時，以及匯入附帶 Skill 的聊天補全預設或編排預設時，Luker 顯示安裝對話框：

![嵌入匯入預覽：衝突處理](/images/skills/skill-conflict-replace-dialog.png)

對話框逐項列出附帶的 Skill 及其衝突狀態。存在衝突的條目可選擇**略過**以保留本地版本，或選擇**取代**以採用檔案中的版本。與已安裝 Skill 內容相同的條目會略過，新條目直接安裝。點擊**安裝**後，Skill 寫入角色卡或預設對應的作用域：

- 角色卡 → `skills/character/<file>/`，包括角色卡繫結預設中附帶的 Skill
- 聊天補全預設 → `skills/preset/<preset>/`
- 編排預設 → `skills/orch-preset/<mode>/<preset>/`

該對話框對同一角色卡或預設僅顯示一次。

::: tip 內聯與 zip 的閾值
小且只含文字的 Skill 採用 `inline-files-v1` 格式，Markdown 內容直接內嵌。較大或包含二進位檔案的 Skill 自動改用 `archive-base64-v1` 格式，即 zip、base64 與 sha256 校驗。打包器按 Skill 逐一決定，無需手動選擇。
:::

## 作用域遷移

透過行內動作**遷移到……**，你隨時可以把 Skill 從 `global` → `preset` → `character`（或反向）移動。遷移是一次原子檔案系統重新命名 —— 沒有拷貝，沒有中間狀態。

編排器設定只按**名稱**引用 Skill，不帶作用域前綴。名為 `voice-rules` 的 Skill 無論在哪個作用域，均依 character、preset、global 的順序解析。遷移不改變引用，只改變 Skill 何時可見。

典型遷移：

- **`global` → `character`** —— 你寫了一條寫作規則、用在多張卡上，後來發現某張卡需要一份專門變體。把它遷到那張卡的作用域，讓更通用的版本留在 `global`。兩者共存；卡片載入時按卡的版本勝出。
- **`preset` → `global`** —— 你打包在某個預設裡的 Skill 後來發現到處均有用。把它提升到全域。
- **`character` → `global`** —— 某個角色卡專屬 Skill 最終泛化了。提升它。

## 失效參照

當你改名或刪除某個被編排器設定參照的 Skill，參照清單保留舊名。執行時找不到它，Agent 不載入這個 Skill，派遣照常進行。

在**工作台 → 編排 → 準備階段**中，失效參照顯示為灰色，並提示**「該 Skill 未安裝」**。修正方式有兩種：在編排設定中改名，或重新加入該 Skill。

缺失的 Skill 不阻斷 Agent 派遣；增刪 Skill 無需修改編排設定。

## 相關

- [Skills 概覽](/zh-TW/features/skills/) —— 什麼是 Skill、作用域
- [創作 Skill](/zh-TW/features/skills/authoring) —— 寫自己的
- [編排器整合](/zh-TW/features/skills/orchestrator-integration) —— 把 Skill 掛到編排設定上
- [Skill 擴充套件 API](/zh-TW/development/extension-api/skills) —— 從擴充套件程式設計式管理
- [聊天補全預設助手](/zh-TW/features/preset-assistant) —— 派生 `-orchestrator` 預設，並開啟該預設作用域的 Skill 管理器
