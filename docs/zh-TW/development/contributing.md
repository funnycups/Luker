# 貢獻指南

感謝你對 Luker 專案的關注！本文件介紹如何為 Luker 貢獻程式碼、文件和其他改進。

## 開發環境準備

1. **Fork 倉庫**：在 GitHub 上 fork Luker 倉庫到你的帳戶下。

2. **複製到本機**：

```bash
git clone https://github.com/<your-username>/Luker.git
cd Luker
```

3. **安裝依賴**：

```bash
npm install
```

4. **啟動開發伺服器**：

```bash
node server.js
```

預設監聽 `http://localhost:8000`。可透過命令列參數或 `config.yaml` 修改連接埠。

## 分支策略

- **`release`** — 穩定分支，始終保持可發布狀態。所有 PR 應以 `release` 為目標分支
- 功能開發請從 `release` 建立特性分支

```bash
git checkout -b feat/my-new-feature release
```

> [!IMPORTANT]
Luker 的穩定分支是 `release`。

分支命名建議：

| 前綴 | 用途 | 範例 |
|------|------|------|
| `feat/` | 新功能 | `feat/memory-graph-export` |
| `fix/` | Bug 修復 | `fix/chat-sync-race-condition` |
| `docs/` | 文件改進 | `docs/extension-api-examples` |
| `refactor/` | 程式碼重構 | `refactor/preset-manager` |
| `chore/` | 建置/工具鏈 | `chore/update-dependencies` |

## Commit 規範

Luker 遵循 [Conventional Commits](https://www.conventionalcommits.org/) 規範：

```
<type>(<scope>): <description>

[optional body]

[optional footer(s)]
```

**類型（type）：**

| 類型 | 說明 |
|------|------|
| `feat` | 新功能 |
| `fix` | Bug 修復 |
| `docs` | 文件變更 |
| `style` | 程式碼格式（不影響邏輯） |
| `refactor` | 重構（不新增功能或修復 bug） |
| `perf` | 效能最佳化 |
| `test` | 測試相關 |
| `chore` | 建置/工具鏈/依賴更新 |

**範例：**

```
feat(memory-graph): add hierarchical compression for event nodes

fix(search-tools): handle empty query in web search

docs(extension-api): add examples for registerExtensionApi
```

## Pull Request 流程

1. **確保程式碼品質**：提交前檢查程式碼風格和基本功能。

2. **推送分支**：

```bash
git push origin feat/my-new-feature
```

3. **建立 PR**：在 GitHub 上建立 Pull Request，目標分支為 `release`。

4. **PR 描述**：清晰描述改動內容、動機和影響。如果關聯了 Issue，請引用。

5. **程式碼審查**：維護者會審查程式碼並提供回饋。請及時回應審查意見。

6. **合併**：審查通過後，維護者會合併 PR。

## 程式碼風格

### 基本規則

- **縮排**：4 空格
- **引號**：單引號（JavaScript）
- **分號**：必須使用
- **換行符**：LF（`\n`），不使用 CRLF
- **檔案末尾**：保留一個空行

> [!IMPORTANT]
> 所有檔案必須使用 LF 換行符。Windows 使用者請設定 Git：
> ```bash
> git config core.autocrlf input
> ```
> 或在 `.gitattributes` 中確保 `* text=auto eol=lf`。

### 命名規範

| 場景 | 風格 | 範例 |
|------|------|------|
| 變數和函式 | `camelCase` | `loadSettings()` |
| 常數 | `UPPER_SNAKE_CASE` | `DEFAULT_TIMEOUT` |
| CSS 類別名稱 | `kebab-case` | `chat-message-container` |
| 檔案名稱 | `kebab-case` | `preset-manager.js` |

### 模組系統

- **前端程式碼**：ES Module（`import`/`export`）
- **後端程式碼**：ES Module（`import`/`export`）

### 註解

- 關鍵邏輯和公共 API 需要 JSDoc 註解
- 複雜的演算法或業務邏輯應有行內註解說明意圖
- 避免無意義的註解（如 `// 增加計數器` 後面跟 `counter++`）

## 專案結構概覽

```
Luker/
├── server.js              # 伺服器入口
├── src/                   # 後端原始碼
│   ├── endpoints/         # API 路由
│   └── middleware/        # 中介軟體
├── public/                # 前端資源
│   ├── scripts/           # 前端腳本
│   │   ├── extensions/    # 內建擴充功能
│   │   │   └── third-party/  # 第三方外掛
│   │   └── ...            # 核心模組
│   └── ...                # 靜態資源
├── docs/                  # 文件
│   ├── zh-CN/             # 簡體中文文件
│   ├── zh-TW/             # 繁體中文文件
│   └── en/                # 英文文件
└── config.yaml            # 伺服器設定
```

## 測試

- 新功能應包含基本的功能驗證
- Bug 修復應說明重現步驟和修復方案
- 確保改動不會破壞現有功能
- 測試多種瀏覽器和裝置（如適用）

## 文件貢獻

文件位於 `docs/` 目錄下，使用 Markdown 格式：

- 簡體中文文件：`docs/zh-CN/`
- 繁體中文文件：`docs/zh-TW/`
- 英文文件：`docs/en/`（如有）

文件貢獻同樣遵循上述 PR 流程。撰寫文件時請注意：

- 使用準確的技術術語
- 程式碼和 API 名稱保留英文
- 適當使用程式碼區塊和表格
- 交叉引用使用 `/zh-CN/`、`/zh-TW/` 或 `/en/` 前綴的路徑
- 所有檔案使用 LF 換行符

## 回報問題

如果你發現了 bug 或有功能建議，請在 GitHub Issues 中提交。提交 Issue 時請包含：

- 問題描述
- 重現步驟（如適用）
- 預期行為與實際行為
- 環境資訊（作業系統、Node.js 版本、瀏覽器）

## 行為準則

請尊重所有貢獻者和使用者。保持友善、專業的交流態度。

## 相關頁面

- [前端外掛開發](/zh-TW/development/frontend-plugin) — 第三方外掛開發入門
- [擴充 API 參考](/zh-TW/development/extension-api) — 完整的 API 文件
- [角色卡開發](/zh-TW/development/card-developers) — 角色卡擴充功能
