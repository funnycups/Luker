# 測試指南

Luker 透過位於 `tests/harness/` 的測試框架執行 Jest 與 Playwright 套件，於作用域內分配暫存目錄、服務端程序與資料庫命名空間，並於用例結束時自動回收。

## 執行測試 Profile

所有標準指令均經由 `tests/harness/run.js --profile <name>` 執行：

```bash
# 單元測試，不依賴外部資料庫服務
npm run test:unit --prefix tests

# 序列執行 Jest 單元測試
npm run test:unit:serial --prefix tests

# 本機儲存引擎測試，涵蓋檔案系統與 SQLite
npm run test:storage:local --prefix tests

# SQL 儲存引擎整合測試，執行前校驗 MySQL 與 PostgreSQL 連線
npm run test:storage:sql --prefix tests

# 瀏覽器端對端測試與前端套件
npm run test:e2e --prefix tests

# 常規測試聯集，依序執行 unit、storage:local、storage:sql 與 e2e
npm test --prefix tests

# 桌面端原始碼程式與打包程式測試
npm run test:e2e:desktop --prefix tests
npm run test:e2e:desktop:packaged --prefix tests

# 全量測試聯集，包含桌面端原始碼與打包程式
npm run test:all --prefix tests

# 真實資料相容性檢查，需透過 --input 提供唯讀絕對路徑
npm run test:compatibility --prefix tests -- --input /absolute/path/to/data
```

### 按檔案篩選

直接呼叫 `tests/harness/run.js` 可查詢 profile 資訊或僅執行指定檔案：

```bash
node tests/harness/run.js --profile unit --list
node tests/harness/run.js --profile unit --file tests/announcements.test.js
```

## Profile 與外部依賴

| Profile | 測試框架 | 外部依賴 |
|---------|----------|----------|
| `unit` | `jest` | 無 |
| `storage-local` | `jest` | 已編譯的 `better-sqlite3` 原生模組 |
| `storage-sql` | `jest` | 可連線的 MySQL（`LUKER_TEST_MYSQL_ROOT_URL`）與 PostgreSQL（`LUKER_TEST_POSTGRES_URL`） |
| `e2e` | `playwright` | Playwright Chromium |
| `frontend` | `playwright` | Playwright Chromium |
| `desktop` | `playwright` | Electron 執行環境（`desktop-app/node_modules` 或 `LUKER_DESKTOP_ELECTRON_PATH`） |
| `desktop-packaged` | `playwright` | 打包產物（`desktop-app/dist`、`LUKER_DESKTOP_ARTIFACT_DIR` 或 `LUKER_DESKTOP_ARTIFACT_MANIFEST`） |
| `compatibility` | `playwright` | Playwright Chromium 與 `--input <absolute-dir>` |

必需資料庫無法連線或打包產物缺失時，預檢直接以非零狀態碼退出。

## 編寫測試

- **暫存目錄**：在 Jest 中透過 `scope.directory(label)` 分配目錄，在 Playwright 中透過 `resources.directory(label)` 分配目錄；唯讀外部輸入透過 `scope.borrowDirectory(absPath)` 宣告。
- **應用服務端**：透過 `tests/harness/server.js` 中的 `startServer` 啟動服務端執行個體。
- **桌面端應用**：透過 `tests/e2e/_lib/desktop.js` 中的 `launchLukerDesktop` 與 `spawnLukerDesktop` 啟動桌面程序。
- **網路攔截**：透過 `tests/harness/observations.js` 中的 `observeOperations` 攔截與釋放 HTTP 請求或回應。
- **單元測試瀏覽器依賴**：透過 `tests/util/browser-module-context.js` 中的 `createBrowserModuleContext` 與 `installBrowserModuleContext` 宣告模組依賴。

## 靜態檢查

```bash
npm run lint
npm run lint:plugin-imports
npm run lint:i18n
```
