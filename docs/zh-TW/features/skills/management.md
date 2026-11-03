# Skill 管理

編排器面板的**管理 Skills**按鈕打開一個子面板，用於安裝、編輯、遷移與刪除 Skill。本頁逐個說明入口。

::: tip 在哪裡找
打開擴充套件抽屜 → **多 Agent 編排** 節 → 點面板底部附近的**管理 Skills**。子面板以彈窗形式覆蓋在編排器設定之上。
:::

## 子面板概覽

Skill 管理頂部有多個分頁：

- **已安裝** —— 本機安裝的 Skill。依作用域篩選，可選全域、預設、角色卡或全部。
- **瀏覽出廠** —— Luker 自帶的 Skill，每列顯示本機副本與內建版本一致、有差異或尚未安裝。
- **匯入** —— 從檔案、URL、角色卡或預設中提取 Skill。

![Skill 管理子面板，已安裝分頁](/images/skills/manager-installed-tab.png)

## 已安裝

每行顯示：

- `name` —— Skill frontmatter 裡的 `name`。點擊打開內嵌編輯器。
- `description` —— frontmatter 裡的一行摘要。
- `scope` —— 作用域標記，取值為 `global`、`preset/<api>/<name>` 或 `character/<file>`。
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

### 批次選擇

頂列切到**多選**模式後，每行多一個核取方塊。勾選至少一項後，工具列會出現一個**把所選打包進預設……**動作 —— 見下文 [嵌入匯出](#嵌入匯出-到預設和角色卡)。

## 瀏覽出廠

「瀏覽出廠」分頁把你本機每個出廠 Skill 的副本和內建版本對比。每列顯示以下狀態之一：

| 標記 | 含義 |
|---|---|
| **已安裝（一致）** | 本地副本與出廠版本逐位元組一致。 |
| **已安裝（你的版本有差異）** | 本地副本存在，但雜湊與出廠版本不匹配 —— 你（或某次迭代工作台會話）改過它。 |
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

### 從角色卡 / 預設抽取

匯入帶 `embedded_skills_source` 欄位的角色卡（PNG）或預設（JSON）時，Luker 會自動彈出預覽對話框：

![嵌入匯入預覽：衝突處理](/images/skills/skill-conflict-replace-dialog.png)

對話框逐項列出每個嵌入的 Skill 及其衝突狀態。對每個衝突，你可選**跳過**（保留本地版本）或**替換**（用嵌入裡的版本）。內容相同的項（`相同`）會靜默跳過；新條目（`新`）直接安裝。

抽取後，角色卡與預設檔案中的嵌入負載被移除，Skill 內容以 `skills/character/<file>/` 或 `skills/preset/<api>/<preset>/` 下的檔案為準。

## 內嵌編輯器

點擊 Skill 行的**編輯**會打開彈窗內編輯器：

![內嵌 Skill 編輯器](/images/skills/skill-editor.png)

- 左欄：檔案樹（SKILL.md + 任何子檔案）。點擊切換。
- 右欄：Markdown 編輯器，frontmatter 區段有 YAML 感知高亮。
- 頂列：檔案路徑、未儲存標記、**儲存**（透過 `.staging/` 原子提交）、**新增檔案**（在指定路徑建立一份新子檔案）。

寫入與安裝使用同一套 `.staging/` 規則：新內容先經過校驗（路徑安全、大小限制、frontmatter 解析），全部通過後由 staging 檔案原子替換原檔案。失敗的寫入對原檔案沒有影響。

`SKILL.md` 是特殊的 —— 它可以編輯，但不能從編輯器中刪除（它是必需入口）。Skill 本身可透過行內動作整體刪除。

::: tip 用 AI 編輯 Skill
[AI 迭代工作台](/zh-TW/features/orchestrator/iteration-studio#用工作台編寫-skill) 也能替你寫和修改 Skill —— 用一句話描述變更，工作台透過相同的安裝路徑起草。適用於需要新建 Skill、或重寫已有 Skill 而不想手動編寫 Markdown 的情境。
:::

## 嵌入匯出 —— 到預設和角色卡

Skill 在跟它所依賴的產物（角色卡、預設）一起分發時最有用。某張角色卡需要某條口吻規則，某個預設是為特定子代理調出來的 —— 兩者均能把 Skill 內聯打包。

### 打包進預設

在編排器面板中，[補全預設助手](/zh-TW/features/preset-assistant) 會派生出一份 `-orchestrator` 預設。派生完成後，助手會提供一條**為該預設打包 Skills** 連結，點擊後開啟 Skill 管理並自動啟用多選模式。選擇需要的 Skill，點擊**把所選打包進預設……**，再選擇目標預設。

打包器把這些 Skill 寫進預設的 `extensions.luker.embedded_skills_source` 欄位。下一次儲存預設時，嵌入隨 JSON 一起被持久化。其他 Luker 使用者匯入這份預設時會看到上文描述的嵌入抽取對話框。

### 打包進角色卡

在角色卡編輯器裡，**出廠 Skill** 區段也是同樣的邏輯：選 Skill、打包，它們寫進 `data.extensions.luker.embedded_skills_source`。PNG 匯出時嵌入序列化進卡的元資料，分發這張卡也就分發了 Skill。

::: tip 內聯 vs zip 的閾值
僅含文字的小型 Skill 使用 `inline-files-v1` 格式（Markdown 內容直接內嵌）。較大或包含二進位的 Skill 自動升級到 `archive-base64-v1`（zip + base64 + sha256）。打包器會按每個 Skill 自動決定，無需手動選擇。
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

在編排器設定編輯器中，失效參照顯示為灰色，並提示**「該 Skill 未安裝」**。修正方式有兩種：在編排設定中改名，或重新加入該 Skill。

缺失的 Skill 不阻斷 Agent 派遣；增刪 Skill 無需修改編排設定。

## 相關

- [Skills 概覽](/zh-TW/features/skills/) —— 什麼是 Skill、作用域
- [創作 Skill](/zh-TW/features/skills/authoring) —— 寫自己的
- [編排器整合](/zh-TW/features/skills/orchestrator-integration) —— 把 Skill 掛到編排設定上
- [Skill 擴充套件 API](/zh-TW/development/extension-api/skills) —— 從擴充套件程式設計式管理
- [補全預設助手](/zh-TW/features/preset-assistant) —— 派生 `-orchestrator` 預設並給出打包 Skills 連結
