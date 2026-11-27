# Skill 管理

**工作台 → 編排 → 準備階段**中的**管理技能...**按鈕會開啟 Skill 管理彈窗，用於安裝、編輯、遷移與刪除 Skill。本頁逐個說明入口。

::: tip 在哪裡找
開啟**工作台 → 編排 → 準備階段**，點擊**管理技能...**；也可點擊**擴充功能 → 聊天補全預設助手 → 將 Skills 打包到此預設**直接定位到目前預設的作用域。
:::

## 子面板概覽

Skill 管理頂部包含分頁，並在**已安裝**工具列中提供匯入入口：

- **已安裝** —— 目前工作區內已安裝的 Skill，可依作用域篩選或檢視**全部作用域**。
- **瀏覽 Luker 內建 Skills** —— Luker 內建的 Skill，每列顯示本機副本為一致、存在差異或未安裝。
- **匯入工具列** —— 透過**匯入 Luker 內建 Skills**、**從檔案匯入……**或**從連結匯入……**安裝 Skill。

![Skill 管理子面板，已安裝分頁](/images/skills/manager-installed-tab.png)

## 已安裝

每行顯示：

- `name` —— Skill frontmatter 裡的 `name`。點擊打開內嵌編輯器。
- `description` —— frontmatter 裡的一行摘要。
- **作用域** —— 作用域標記，標示該 Skill 所屬的全域、聊天補全預設、編排預設或角色作用域。
- `size` —— 檔案數 + 總位元組數。
- **被參照** —— 目前編排設定中參照該 Skill 的 agent 數量。

右側行內操作：

| 操作 | 作用 |
|---|---|
| **檢視** | 以唯讀 Markdown 渲染 `SKILL.md`。 |
| **編輯** | 開啟內嵌編輯器，詳見下文[內嵌編輯器](#內嵌編輯器)。 |
| **移動到……** | 跨作用域原子移動，僅依名稱儲存的參照保持有效。 |
| **重新命名** | 在目前作用域內原子重新命名，同步更新目錄與 frontmatter `name`，指向舊名的參照變為灰色，詳見[失效參照](#失效參照)。 |
| **刪除** | 刪除 Skill 目錄，參照變為灰色，派遣照常執行。 |

## 瀏覽 Luker 內建 Skills

**瀏覽 Luker 內建 Skills** 將本機副本與內建版本對比，每列顯示以下狀態：

| 標記 | 含義 |
|---|---|
| **已安裝** | 本機副本與內建版本逐位元組一致。 |
| **內容不同** | 本機副本存在且內容與內建版本不同。 |
| **未安裝** | 本機尚無副本，點擊**安裝此 Skill** 安裝至 `global` 作用域。 |

![瀏覽 Luker 內建 Skills，混合狀態](/images/skills/manager-bundled-tab.png)

頂部的**安裝全部內建 Skills** 按鈕會安裝全部內建 Skill，並以內建版本覆蓋內容不同的本機副本。

::: warning 覆蓋操作不可合併
**安裝全部內建 Skills** 會直接覆蓋同名本機副本。本機修改過 `event-summary-rules-zh` 時，安裝內建版本會取代本機修改。
:::

## 匯入

入口說明：

### 從檔案匯入……

上傳包含單個 Skill 目錄的 `.zip` 封存或 `SKILL.md` 檔案。伺服器校驗檔案並預覽每個 Skill 的衝突狀態，待逐項確認後再提交寫入。

### 從連結匯入……

貼上指向原始 `SKILL.md` 或 zip 壓縮包的 `https://...` 連結即可匯入。本機多檔案 Skill 請使用**從檔案匯入……**。

### 匯入 Luker 內建 Skills

與**瀏覽 Luker 內建 Skills** 中的**安裝全部內建 Skills** 對應，位於**已安裝**工具列中以便直接操作。

## 內嵌編輯器

點擊 Skill 列的**編輯**可開啟彈窗內嵌編輯器：

![內嵌 Skill 編輯器](/images/skills/skill-editor.png)

- 左欄：檔案樹，列出 `SKILL.md` 及全部子檔案，點擊可切換。
- 右欄：Markdown 編輯器，支援 YAML frontmatter 高亮。
- 頂列：顯示檔案路徑、未儲存標記、**儲存**按鈕與 **+ 新建檔案**按鈕。

儲存時均先校驗路徑安全、大小限制與 frontmatter 語法，全部通過後再原子取代原檔案。

`SKILL.md` 可在編輯器中修改，不可從編輯器刪除；刪除整個 Skill 請使用行內**刪除**操作。

::: tip 用 AI 編輯 Skill
[編排 AI 迭代](/zh-TW/features/orchestrator/iteration-studio#用工作台編寫-skill) 也能編寫與修改 Skill，直接描述變更即可透過相同安裝路徑起草，適用於新建或改寫已有 Skill。
:::

## 嵌入匯出 —— 到預設和角色卡

Skill 與依賴它的預設或角色卡一同分發時最有價值。匯出預設或角色卡時，Luker 會詢問是否將對應的 Skill 一併附帶進匯出檔案。

僅當選擇**包含**時，匯出檔案才附帶 Skill。選擇**略過**、因沒有需要附帶的 Skill 而未出現詢問，或 Skill 附帶失敗時，匯出檔案均不附帶 Skill，匯入時附帶 Skill 的預設或角色卡同樣如此。

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

- 角色卡 → 角色作用域，包含角色卡繫結預設中附帶的 Skill
- 聊天補全預設 → 聊天補全預設作用域
- 編排預設 → 編排預設作用域

該對話框對同一角色卡或預設僅顯示一次。

## 作用域遷移

透過行內操作**移動到……**，可將 Skill 在 `global`、`preset` 與 `character` 之間自由移動。移動為原子檔案系統重新命名，不產生拷貝或中間狀態。

編排設定僅依**名稱**參照 Skill，不附帶作用域前綴。名為 `voice-rules` 的 Skill 無論位於哪個作用域，均依 character、preset、global 的優先順序解析。移動作用域不改變參照，只調整 Skill 的可見範圍。

典型遷移：

- **`global` → `character`** —— 為特定角色卡製作專屬變體時，將變體移入該角色作用域，通用版本保留在 `global`，載入該角色卡時自動以角色作用域版本優先。
- **`preset` → `global`** —— 將僅打包在單個預設中的 Skill 提升至全域作用域以供重複使用。
- **`character` → `global`** —— 將角色卡專屬 Skill 提升為全域通用 Skill。

## 失效參照

重新命名或刪除已被編排設定參照的 Skill 後，參照清單保留舊名稱。執行時未找到對應 Skill 時，agent 略過載入該 Skill，派遣照常執行。

在**工作台 → 編排 → 準備階段**中，失效參照顯示為灰色，並提示**「目前資料目錄未安裝此 Skill。」**。可在編排設定中更新名稱，或重新加入對應 Skill。

缺失 Skill 不阻斷 agent 派遣；增刪 Skill 無需同步修改編排設定。

## 相關

- [Skills 概覽](/zh-TW/features/skills/) —— 介紹 Skill 的定義與作用域
- [創作 Skill](/zh-TW/features/skills/authoring) —— 編寫自訂 Skill
- [多智能體編排整合](/zh-TW/features/skills/orchestrator-integration) —— 在編排設定中繫結 Skill
- [Skill 擴充套件 API](/zh-TW/development/extension-api/skills) —— 透過擴充套件程式設計管理 Skill
- [聊天補全預設助手](/zh-TW/features/preset-assistant) —— 派生 `-orchestrator` 預設並開啟對應預設作用域的 Skill 管理彈窗
