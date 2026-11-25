# 测试指南

Luker 通过位于 `tests/harness/` 的统一托管测试框架执行 Jest、Playwright 与 `node --test` 套件。框架在明确的作用域内分配目录、进程、数据库租约、桌面壳层与失败诊断，测试只需声明所需资源，无需自行编写清理逻辑。

## 执行测试 Profile

所有标准命令均经由 `tests/harness/run.js --profile <name>` 执行：

```bash
# 单元测试与核心框架用例，不依赖外部数据库服务
npm run test:unit --prefix tests

# 串行执行 Jest 单元测试，不使用 --forceExit
npm run test:unit:serial --prefix tests

# 本地存储引擎测试，覆盖文件系统与 SQLite
npm run test:storage:local --prefix tests

# SQL 存储引擎集成测试，执行前校验 MySQL 与 PostgreSQL 真实连接与鉴权
npm run test:storage:sql --prefix tests

# 浏览器端到端测试与前端套件
npm run test:e2e --prefix tests

# 常规覆盖并集，依次执行 unit、storage:local、storage:sql 与 e2e
npm test --prefix tests

# 桌面端源码程序与打包程序测试
npm run test:e2e:desktop --prefix tests
npm run test:e2e:desktop:packaged --prefix tests

# 全量确定性测试并集，包含桌面端源码与打包程序
npm run test:all --prefix tests

# 真实数据兼容性检查，需通过 --input 提供显式只读绝对路径
npm run test:compatibility --prefix tests -- --input /absolute/path/to/data
```

### 列出范围、按文件筛选与导出环境

直接调用 `tests/harness/run.js` 可在保持原有诊断槽不变的前提下筛选文件、查询清单或导出完整运行环境：

```bash
# 仅列出 profile 声明的文件与依赖，不分配任何运行资源
node tests/harness/run.js --profile unit --list
node tests/harness/run.js --profile storage-sql --list --json

# 仅执行指定文件
node tests/harness/run.js --profile unit --file tests/browser-module-context.test.js

# 将托管环境导出至尚未存在的绝对路径
node tests/harness/run.js --profile unit --file tests/browser-module-context.test.js --export-environment /tmp/luker-env-export
```

直接调用原生 `jest`、`playwright test` 或 `node --test` 入口时，同样接入相同的托管适配器与资源生命周期。

## Profile 与外部依赖

| Profile | 测试框架 | 外部依赖 |
|---------|----------|----------|
| `unit` | `node`、`jest` | Jest 与核心框架无外部依赖；浏览器与观察框架用例需 Playwright Chromium |
| `storage-local` | `jest` | 已编译的 `better-sqlite3` 原生模块 |
| `storage-sql` | `node`、`jest` | 可连接的 MySQL（`LUKER_TEST_MYSQL_ROOT_URL`）与 PostgreSQL（`LUKER_TEST_POSTGRES_URL`） |
| `e2e` | `playwright` | Playwright Chromium |
| `frontend` | `playwright` | Playwright Chromium |
| `desktop` | `node`、`playwright` | Electron 运行时（`desktop-app/node_modules` 或 `LUKER_DESKTOP_ELECTRON_PATH`） |
| `desktop-packaged` | `playwright` | 打包产物（`desktop-app/dist`、`LUKER_DESKTOP_ARTIFACT_DIR` 或 `LUKER_DESKTOP_ARTIFACT_MANIFEST`） |
| `compatibility` | `playwright` | Playwright Chromium 与显式 `--input <absolute-dir>` |

当必需数据库不可达或打包产物缺失时，预检立即以非零状态码退出，不会缩减测试集或回退至源码程序。

## 编写托管测试

- **目录归属**：在 Node 与 Jest（`testWithResources`）中通过 `scope.directory(label)` 分配目录，在 Playwright 中通过 `resources.directory(label)` 分配目录。已登记目录内的普通 fixture 读写自动继承归属；只读外部输入需经 `scope.borrowDirectory(absPath)` 登记。
- **应用服务端**：通过 `tests/harness/server.js` 中的 `startServer({ scope, batchKey, scenarioId, extraConfig, extraEnv })` 启动实例。
- **桌面端应用**：通过 `tests/e2e/_lib/desktop.js` 中的 `launchLukerDesktop` 与 `spawnLukerDesktop` 启动桌面进程。默认自建用户目录在 `relaunch()` 期间保留，在 `close()` 或作用域结束时回收；显式借用目录不会被删除。
- **浏览器操作观察**：通过 `tests/harness/observations.js` 中的 `observeOperations({ page, scope, ... })` 建立调用、CDP 请求、响应拦截与磁盘最终状态的因果关联。
- **单元测试浏览器依赖**：通过 `tests/util/browser-module-context.js` 的 `createBrowserModuleContext` 与 `installBrowserModuleContext` 显式声明模块依赖，禁止安装全局递归 `Proxy`。

## 归属与边界检查

提交变更前执行以下边界门禁：

```bash
npm run lint:plugin-imports
npm run lint:test-ownership
```

`lint:test-ownership` 基于语法树分析扫描 `tests/`，阻止在 `tests/harness/` 之外新增未登记的临时根目录、裸 `child_process` 子进程、未托管数据库连接、`Proxy` 桩以及 `--forceExit` 脚本。
