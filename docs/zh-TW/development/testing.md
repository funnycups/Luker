# 測試指南

Luker 透過位於 `tests/harness/` 的統一託管測試框架執行 Jest、Playwright 與 `node --test` 套件。框架在明確的作用域內分配目錄、程序、資料庫租約、桌面殼層與失敗診斷，測試只需宣告所需資源，無需自行編寫清理邏輯。

## 執行測試 Profile

所有標準指令均經由 `tests/harness/run.js --profile <name>` 執行：

```bash
# 單元測試與核心框架用例，不依賴外部資料庫服務
npm run test:unit --prefix tests

# 序列執行 Jest 單元測試，不使用 --forceExit
npm run test:unit:serial --prefix tests

# 本機儲存引擎測試，涵蓋檔案系統與 SQLite
npm run test:storage:local --prefix tests

# SQL 儲存引擎整合測試，執行前校驗 MySQL 與 PostgreSQL 真實連線與驗證
npm run test:storage:sql --prefix tests

# 瀏覽器端對端測試與前端套件
npm run test:e2e --prefix tests

# 常規涵蓋聯集，依序執行 unit、storage:local、storage:sql 與 e2e
npm test --prefix tests

# 桌面端原始碼程式與打包程式測試
npm run test:e2e:desktop --prefix tests
npm run test:e2e:desktop:packaged --prefix tests

# 全量確定性測試聯集，包含桌面端原始碼與打包程式
npm run test:all --prefix tests

# 真實資料相容性檢查，需透過 --input 提供顯式唯讀絕對路徑
npm run test:compatibility --prefix tests -- --input /absolute/path/to/data
```

### 列出範圍、按檔案篩選與匯出環境

直接呼叫 `tests/harness/run.js` 可在維持原有診斷槽不變的前提下篩選檔案、查詢清單或匯出完整執行環境：

```bash
# 僅列出 profile 宣告的檔案與依賴，不分配任何執行資源
node tests/harness/run.js --profile unit --list
node tests/harness/run.js --profile storage-sql --list --json

# 僅執行指定檔案
node tests/harness/run.js --profile unit --file tests/browser-module-context.test.js

# 將託管環境匯出至尚未存在的絕對路徑
node tests/harness/run.js --profile unit --file tests/browser-module-context.test.js --export-environment /tmp/luker-env-export
```

直接呼叫原生 `jest`、`playwright test` 或 `node --test` 入口時，同樣接入相同的託管配接器與資源生命週期。

## Profile 與外部依賴

| Profile | 測試框架 | 外部依賴 |
|---------|----------|----------|
| `unit` | `node`、`jest` | Jest 與核心框架無外部依賴；瀏覽器與觀察框架用例需 Playwright Chromium |
| `storage-local` | `jest` | 已編譯的 `better-sqlite3` 原生模組 |
| `storage-sql` | `node`、`jest` | 可連線的 MySQL（`LUKER_TEST_MYSQL_ROOT_URL`）與 PostgreSQL（`LUKER_TEST_POSTGRES_URL`） |
| `e2e` | `playwright` | Playwright Chromium |
| `frontend` | `playwright` | Playwright Chromium |
| `desktop` | `node`、`playwright` | Electron 執行環境（`desktop-app/node_modules` 或 `LUKER_DESKTOP_ELECTRON_PATH`） |
| `desktop-packaged` | `playwright` | 打包產物（`desktop-app/dist`、`LUKER_DESKTOP_ARTIFACT_DIR` 或 `LUKER_DESKTOP_ARTIFACT_MANIFEST`） |
| `compatibility` | `playwright` | Playwright Chromium 與顯式 `--input <absolute-dir>` |

當必需資料庫無法連線或打包產物缺失時，預檢立即以非零狀態碼退出，不會縮減測試集或回退至原始碼程式。

## 編寫託管測試

- **目錄歸屬**：在 Node 與 Jest（`testWithResources`）中透過 `scope.directory(label)` 分配目錄，在 Playwright 中透過 `resources.directory(label)` 分配目錄。已登記目錄內的普通 fixture 讀寫自動繼承歸屬；唯讀外部輸入需經 `scope.borrowDirectory(absPath)` 登記。
- **應用服務端**：透過 `tests/harness/server.js` 中的 `startServer({ scope, batchKey, scenarioId, extraConfig, extraEnv })` 啟動執行個體。
- **桌面端應用**：透過 `tests/e2e/_lib/desktop.js` 中的 `launchLukerDesktop` 與 `spawnLukerDesktop` 啟動桌面程序。預設自建使用者目錄於 `relaunch()` 期間保留，於 `close()` 或作用域結束時回收；顯式借用目錄不會被刪除。
- **瀏覽器操作觀察**：透過 `tests/harness/observations.js` 中的 `observeOperations({ page, scope, ... })` 建立呼叫、CDP 請求、回應攔截與磁碟最終狀態的因果關聯。
- **單元測試瀏覽器依賴**：透過 `tests/util/browser-module-context.js` 的 `createBrowserModuleContext` 與 `installBrowserModuleContext` 顯式宣告模組依賴，禁止安裝全域遞迴 `Proxy`。

## 歸屬與邊界檢查

提交變更前執行以下邊界門禁：

```bash
npm run lint:plugin-imports
npm run lint:test-ownership
```

`lint:test-ownership` 基於語法樹分析掃描 `tests/`，阻止在 `tests/harness/` 之外新增未登記的暫存根目錄、裸 `child_process` 子程序、未託管資料庫連線、`Proxy` 樁以及 `--forceExit` 指令碼。
