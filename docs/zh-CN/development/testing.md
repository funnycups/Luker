# 测试指南

Luker 通过位于 `tests/harness/` 的测试框架执行 Jest 与 Playwright 套件，在作用域内分配临时目录、服务端进程与数据库命名空间，并在用例结束时自动回收。

## 执行测试 Profile

所有标准命令均经由 `tests/harness/run.js --profile <name>` 执行：

```bash
# 单元测试，不依赖外部数据库服务
npm run test:unit --prefix tests

# 串行执行 Jest 单元测试
npm run test:unit:serial --prefix tests

# 本地存储引擎测试，覆盖文件系统与 SQLite
npm run test:storage:local --prefix tests

# SQL 存储引擎集成测试，执行前校验 MySQL 与 PostgreSQL 连接
npm run test:storage:sql --prefix tests

# 浏览器端到端测试与前端套件
npm run test:e2e --prefix tests

# 常规测试并集，依次执行 unit、storage:local、storage:sql 与 e2e
npm test --prefix tests

# 桌面端源码程序与打包程序测试
npm run test:e2e:desktop --prefix tests
npm run test:e2e:desktop:packaged --prefix tests

# 全量测试并集，包含桌面端源码与打包程序
npm run test:all --prefix tests

# 真实数据兼容性检查，需通过 --input 提供只读绝对路径
npm run test:compatibility --prefix tests -- --input /absolute/path/to/data
```

### 按文件筛选

直接调用 `tests/harness/run.js` 可查询 profile 信息或仅执行指定文件：

```bash
node tests/harness/run.js --profile unit --list
node tests/harness/run.js --profile unit --file tests/announcements.test.js
```

## Profile 与外部依赖

| Profile | 测试框架 | 外部依赖 |
|---------|----------|----------|
| `unit` | `jest` | 无 |
| `storage-local` | `jest` | 已编译的 `better-sqlite3` 原生模块 |
| `storage-sql` | `jest` | 可连接的 MySQL（`LUKER_TEST_MYSQL_ROOT_URL`）与 PostgreSQL（`LUKER_TEST_POSTGRES_URL`） |
| `e2e` | `playwright` | Playwright Chromium |
| `frontend` | `playwright` | Playwright Chromium |
| `desktop` | `playwright` | Electron 运行时（`desktop-app/node_modules` 或 `LUKER_DESKTOP_ELECTRON_PATH`） |
| `desktop-packaged` | `playwright` | 打包产物（`desktop-app/dist`、`LUKER_DESKTOP_ARTIFACT_DIR` 或 `LUKER_DESKTOP_ARTIFACT_MANIFEST`） |
| `compatibility` | `playwright` | Playwright Chromium 与 `--input <absolute-dir>` |

必需数据库不可达或打包产物缺失时，预检直接以非零状态码退出。

## 编写测试

- **临时目录**：在 Jest 中通过 `scope.directory(label)` 分配目录，在 Playwright 中通过 `resources.directory(label)` 分配目录；只读外部输入通过 `scope.borrowDirectory(absPath)` 声明。
- **应用服务端**：通过 `tests/harness/server.js` 中的 `startServer` 启动服务端实例。
- **桌面端应用**：通过 `tests/e2e/_lib/desktop.js` 中的 `launchLukerDesktop` 与 `spawnLukerDesktop` 启动桌面进程。
- **网络拦截**：通过 `tests/harness/observations.js` 中的 `observeOperations` 拦截与释放 HTTP 请求或响应。
- **单元测试浏览器依赖**：通过 `tests/util/browser-module-context.js` 中的 `createBrowserModuleContext` 与 `installBrowserModuleContext` 声明模块依赖。

## 静态检查

```bash
npm run lint
npm run lint:plugin-imports
npm run lint:i18n
```
