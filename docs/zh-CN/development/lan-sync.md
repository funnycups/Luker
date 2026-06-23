# 局域网同步——开发者指南

Luker 局域网同步功能的技术参考文档。面向用户的说明见 [局域网同步](/zh-CN/improvements/lan-sync)；设计依据和协议协商规则见 `docs/superpowers/specs/lan-sync.md` 中的规范文档。

## 一段话讲完架构

每个 Luker 用户都会为每个已配对的对端维护一份**影子 git 仓库**，存放在 `data/<handle>/.sync/<peer-id>/` 下。同步在发起方按四步流水线进行：把活动数据快照写入影子工作目录、通过 HTTP 抓取对端缺失的 git 对象、尝试三向合并、把合并结果反向同步回活动存储。响应方在 offer 阶段执行对称的快照，并在发起方推送落到 `refs/heads/main` 后执行尾部反向同步。v1 中所有冲突都是文件级——没有字段级合并。

## 文件布局

```
data/<handle>/.sync/
├── state.json                  对端注册表、最近同步时间戳、按对端记录的分类选择
└── <peer-id>/
    ├── repo.git/               裸 git 数据库，保存该对端的同步历史
    └── workdir/                工作目录，镜像该用户已启用的分类
```

影子仓库与活动数据相互独立。编排器在每次同步前把活动数据复制到影子，并在每次成功合并后把影子写回活动。裸 `repo.git` 与物化的 `workdir` 组成一个**分离布局**仓库：同步代码里的每次 isomorphic-git 调用都会同时传 `dir: shadow.workdir` 与 `gitdir: shadow.gitDir`，因为 `.git` 并不嵌套在工作目录内。

`state.json` 通过 `write-file-atomic` 原子重写。辅助函数位于 `src/sync/state.js`——`readSyncState`、`recordPeer`、`recordSyncCompletion`、`removePeer`、`removePeerCompletely`。该文件保存每个对端的 `categories` 选择，`runPull` 与 `undoLastSync` 直接复用，让后续同步沿用用户当初的选择，无需反复确认。`recordPeer` 还会持久化 `peerBaseUrl`，以便 `/peers/:peerId/sync`（UI 的"立即同步"）下次能直接重跑同步，不必再次询问对端地址。`removePeerCompletely` 会同时删除注册表条目和 `<userRoot>/.sync/<peerId>/` 下的影子目录——遗留的 `removePeer` 只更新 `state.json`，会留下孤儿影子目录。

## 线协议

所有端点位于 `/api/sync/v1/` 下。token 认证使用 `Authorization: Bearer <token>` 请求头。Token 是 64 位十六进制字符串，有效期 10 分钟，在 `/session/close` 之前可多次使用。

| 方法 | 路径 | 鉴权 | 用途 |
|---|---|---|---|
| `GET`  | `/health`                | Basic         | 存活探针，返回 `{ ok: true }` |
| `POST` | `/session/offer`         | Basic         | 响应方铸造会话 token，并把自身活动数据快照写入影子工作目录；返回 `{ url, token, expiresAt, peerId, label }` |
| `GET`  | `/session/manifest`      | 会话 token    | 发起方获取 `{ handle, peerId, expiresAt, headOid }` |
| `GET`  | `/session/object/:oid`   | 会话 token    | 发起方获取单个 git 对象；body 是原始内容，`X-Object-Type` 与 `X-Object-Oid` 请求头携带元数据 |
| `POST` | `/session/object`        | 会话 token    | 发起方上传单个 git 对象；`X-Object-Oid` 与 `X-Object-Type` 请求头加原始 body |
| `POST` | `/session/ref`           | 会话 token    | 发起方以 compare-and-swap 方式原子更新 ref（不匹配时返回 409，带 `currentOid`）；当 ref 为 `refs/heads/main` 时，响应方会执行一次尾部反向同步，把变更写回自己的活动树 |
| `POST` | `/session/close`         | 会话 token    | 立即作废 token |
| `POST` | `/pull`                  | Basic         | 发起方入口：驱动针对某个对端 offer 的完整同步流程 |
| `POST` | `/undo`                  | Basic         | 把指定对端回滚到最近一个 `sync-backup-*` 标签 |
| `GET`  | `/peers`                 | Basic         | 返回当前用户的对端注册表（label、categories、pairedAt、lastSyncAt、lastSyncedOid、peerBaseUrl） |
| `GET`  | `/categories`            | Basic         | 返回 `SYNC_CATEGORIES` 的形状，供 UI 渲染分类选择器，无需在前端打包列表 |
| `DELETE` | `/peers/:peerId`       | Basic         | 同时删除注册表条目和 `<userRoot>/.sync/<peerId>/` 下的影子目录；幂等 |
| `POST` | `/peers/:peerId/label`   | Basic         | 更新对端的 label/categories 而不重置 `pairedAt` |
| `POST` | `/peers/:peerId/sync`    | Basic         | "立即同步"：用注册表中存储的 `peerBaseUrl` 重跑同步，用户无需重新输入 URL |
| `POST` | `/pair/start`            | Basic         | 分配新的 peerId、本地注册，返回 `{peerId, label, peerBaseUrl, categories}`，供 UI 渲染为配对链接 |
| `POST` | `/pair/accept`           | Basic         | 消费配对链接：调用对端的 `/session/offer` 申请 token，本地注册对端，运行首次 `runPull` |

会话 token 路径（即 `/api/sync/v1/session/*`，但不含 `/session/offer`）通过 `src/middleware/basicAuth.js` 的 `SYNC_SESSION_PATH_PATTERN` 绕过标准 basic-auth 中间件。`/session/*` 同时在 `src/server-main.js` 的 `skipCsrfProtection` 中豁免 CSRF 保护，以便 `/pair/accept` 与 `/peers/:peerId/sync` 的服务器到服务器 `fetch` 调用能命中对端的 `/session/offer`，而无需携带按会话绑定的 CSRF token。`/session/offer` 自身仍在 basic-auth 流程内，以便 `req.user` 已填充——这正是把发出去的 token 绑定到已认证 handle 的关键。`/pull`、`/undo`、`/pair/*`、`/peers*` 同样走 basic-auth。

### 线格式约束

- **对象大小上限**：`MAX_OBJECT_BYTES = 1024 * 1024 * 1024`（1 GiB）。两端都强制——`src/sync/objects.js` 在读写时拒绝；`/session/object` 配置 `express.raw({ limit: MAX_OBJECT_BYTES })`，让 Express 在请求体到达 handler 之前就丢弃超大负载。超限会以 `OBJECT_TOO_LARGE` 抛出，映射为 HTTP 413。最初是 25 MB（按单个用户文件设计，settings.json 大约 4 MB 是最大情形），但 SQLite 模式下整个数据库 blob 可达数百 MB——1 GiB 足以容纳任何合理的 SQLite 快照，同时仍约束接收端内存。
- **对象完整性**：`writeObjectFromWire` 会对 body 重新做哈希并和传入的 `oid` 比对，不一致时在对象进入任何 ref 之前抛出；`fetchMissingObjects` 把**请求的** oid（而不是响应方在 `X-Object-Oid` 中声称的 oid）传给写入函数，这样即便响应方关于某对象身份撒谎，也无法污染本地数据库。
- **对端抓取超时**：编排器发往对端的 `fetch` 都带 `AbortSignal.timeout(30_000)`。超时会变成一个类型化的 `PEER_TIMEOUT` 错误，`/pull` 将其映射为 HTTP 504。没有这层防护，对端在同步过程中走出 Wi-Fi 覆盖时，会因 OS 默认 TCP 超时（数分钟）卡住整个 per-key 同步队列。
- **`/session/offer` body 上限**：`express.json({ limit: '16kb' })`——offer 负载只包含 peerId、label 和 categories 数组，16 KB 足够宽裕。
- **`/pull` body 上限**：`express.json({ limit: '1mb' })`——大量文件冲突时 resolutions 对象会变大，1 MB 留足空间。

## 分类注册表

`src/sync/categories.js` 导出唯一的 `SYNC_CATEGORIES` 数组。每个条目把一个 id 映射到一组路径（通过 `UserDirectoryList` 访问器解析），并声明默认值（`on` / `opt-in` / `never`）与冲突模式（`file` / `whole-db` / `none`）。所有 UI 标签和警告都是 i18n key，运行时绝不内联英文字符串。

当前注册表覆盖：`characters`、`chats`、`worlds`、`card-apps`、`skills`、四个预设家族（`openai-presets`、`novelai-presets`、`koboldai-presets`、`textgen-presets`）、四个模板家族（`instruct`、`context`、`sysprompt`、`reasoning`）、`themes`、`movingUI`、`quickreplies`、`assets`、`backgrounds`、`avatars`、`user-files`、`user-images`、`image-metadata`、`vectors`、`stats`、`settings`、`secrets`、`extensions`，以及 `database`（SQLite 模式下的整库 blob）。

新增一个分类：

1. 在 `SYNC_CATEGORIES` 增加一个条目。
2. 在 `public/locales/{zh-CN,zh-TW,en}.json` 加上对应 i18n key。
3. `tests/sync/categories.test.js` 中的形状测试会捕获缺失的 locale 字符串。

## 存储模式处理

- **`fs`**：把所有启用分类作为文件做完整同步。影子工作目录的布局与活动树一一对应（相对于 `<userRoot>`），反向同步的写入都走 `write-file-atomic`，崩溃时旧文件保持完好。
- **`sqlite`**：活动数据库（`<userRoot>/luker-storage.sqlite`）在使用中无法被原始复制。在快照步骤之前，编排器调用 `snapshotSqliteIntoShadowIfNeeded` 执行 `VACUUM INTO <shadow.workdir>/luker-storage.sqlite`，把一致快照暂存到影子工作目录；标准的文件遍历器随后通过 `database` 分类提交这个暂存 blob。每次反向同步之后，`closeSqliteEngineHandleIfNeeded` 通过 `engine.closeHandle(handle)` 关掉该 handle 缓存的引擎连接——`write-file-atomic` 的 rename 会让已打开的 inode 指向（现已被 unlink 的）旧文件，没有这次关闭，下一次存储调用会在 POSIX 上悄悄读到陈旧数据，在 Windows 上则会直接报错；重新打开通过 `SqliteEngine._dbFor` 在下次调用时惰性完成。
- **`mysql`** / **`postgres`**：`/session/offer` 和 `/pull` 都返回 HTTP 412（`Sync is unavailable in storage mode <kind>`）。引擎报告这两种模式时，UI 必须隐藏同步控件。

`snapshotSqliteIntoShadowIfNeeded` 与 `closeSqliteEngineHandleIfNeeded` 都从 `src/sync/orchestrator.js` 导出，供 `src/endpoints/sync.js` 在 `/session/offer` 和 `/session/ref` 响应方反向同步处复用同一套门控。门控条件是「引擎为 sqlite 且 `database` 分类已启用且相关 DB 文件存在」，落在这之外两个函数都是 no-op。

## 冲突解决流程

`git.merge` 抛出 `MergeConflictError` 时，`src/sync/conflicts.js` 中的 `attemptMerge` 会遍历 `error.data` 并返回：

```js
{
    success: false,
    conflicts: [
        { filepath, kind, oursOid, theirsOid },
        ...
    ],
}
```

`kind` 是 `bothModified`、`deleteByUs`、`deleteByTheirs` 中的一种。`deleteByUs` 时 `oursOid` 为 `null`；`deleteByTheirs` 时 `theirsOid` 为 `null`。编排器把冲突集合以 `{ ok: false, conflicts }` 形式向上传播，`/pull` 直接作为 JSON 返回；UI 逐条呈现冲突，用户为每个文件挑选一侧。后续调用 `/pull` 时附带 `resolutions: { filepath: 'ours' | 'theirs' }`，会触发 `applyResolutions`，把选定的 blob 写入工作目录并生成一个双父合并提交。

`attemptMerge` 还兜底处理 `git.merge` 不擅长的两种情形。**快进（向前/向后）**：`src/sync/orchestrator.js` 中的 `isAncestor` 通过 `git.log` 检测本地与对端 head 之间是否存在严格线性关系，命中则直接 `writeRef` + `checkout` + 反向同步，不生成合并提交。**无公共祖先**：两侧各自的首次快照都是根提交时，`git.merge` 会抛出 `MergeNotSupportedError`。`attemptMerge` 捕获后将对称差合成为按文件维度的冲突集合（仅出现在一侧的文件变成 `deleteByX`，两侧 blob oid 不同的文件变成 `bothModified`），形状仍是 `{ ok: false, conflicts }`，UI 端统一处理。

合并失败之后，编排器**不会**调用 `git.checkout`。此时工作目录处于合并进行中状态，自动合并的文件已经就位；做一次 checkout 会把它们抹掉。`applyResolutions` 只覆盖冲突文件，并通过 `writeAndStage` 暂存，让仅出现在某一侧的文件得以保留。

干净（无冲突）的合并之后，`git.merge` 会更新 `refs/heads/main` 和索引，但**不会**触碰工作目录，因此编排器会显式执行 `git.checkout({ ref: 'main', force: true })`，再让 `reconcileShadowToLive` 从工作目录读回活动数据。

## 恢复

每次 pull 之前，编排器都会把当前影子 `main` 打成 `sync-backup-<ISO timestamp>` 标签（其中 `:` / `.` 替换为 `-`，保证标签名在文件系统上安全且按字典序可排序）。首次配对时跳过（此时还没有 `main` 可以锚定）。

`POST /undo` 会遍历匹配 `sync-backup-*` 的标签，排序后取最新的一个，把 `main` 指向该标签的提交，通过 `git.checkout` 把树物化到工作目录，再以该对端最近记录的分类选择为范围执行 `reconcileShadowToLive`。标签到提交的对应关系是真相来源；活动数据通过反向同步刚回滚的影子重建。

如果没有任何 `sync-backup-*` 标签（例如某对端只做过一次同步，而首次配对的 pull 不会打标签），`undoLastSync` 会抛出 `NO_BACKUP_TAG`，`/undo` 将其映射为 HTTP 404。

撤销严格限于本地——只触碰本侧数据。对端在下次同步之前完全不受影响。

## 锁

编排器对每一个会修改某配对活动数据的操作都使用一条 **per-`(userRoot, peerId)` FIFO 队列**：本侧的 `runPull` 调用，以及来自对端 `/session/ref` 推送触发的响应方反向同步。队列键使用 `userRoot` 而非 `handle`，这样两个共用 handle 的用户（测试工具、未来的多租户场景）会绑定到各自的物理数据根、得到相互独立的队列。

队列只**等待**而不抛错。同一个 `(userRoot, peerId)` 的第二次 `/pull` 会阻塞在前一次之后，而不是返回 409——这符合用户「按两次同步按钮自然就行」的心理模型，也能与对端触发的响应方反向同步正确串行。队列尾部以 `.catch` 吞掉异常，单次失败不会污染后续每一次入队。

正规的队列辅助函数是 `queueOnKey(key, fn)` 与 `syncQueueKey(userRoot, peerId)`，都从 `src/sync/orchestrator.js` 导出。同步 HTTP 层对 `/session/ref` 反向同步使用同一个 key，从而让对端在本侧 `runPull` 进行中到达的推送等待本地 pull 完成。

### 没有被锁住的场景

配对到同一用户的两个不同对端（笔记本 + 手机）使用不同的 `(userRoot, peerId)` 键，因此可以并发对同一用户的活动树执行反向同步。`write-file-atomic` 保证单文件写一致性；该场景下的跨文件一致性由用户自己负责（不要并行跑两个同步）。按 spec §4.4，一把 per-userRoot 的活动写锁才能彻底覆盖这种情形，但 v1 暂不引入这么多复杂度。

Spec §4.4 还描述了一个全应用范围的 `SYNC_IN_PROGRESS` 闸门，在同步窗口期间对用户主动触发的写入端点（`/api/chats/save`、`/api/settings/save`、`/api/presets/save` 等）统一返回 HTTP 409。这个闸门防止活动数据树在协调器执行 snapshot → merge → reconcile 期间被用户写入移动；否则会出现"同步期间编辑的内容凭空消失"（被 snapshot 捕获，又被 reconcile 覆盖）和 SQLite 旧 inode 失效（`closeHandle` 换文件后 engine 句柄指向旧的、已 unlink 的文件）这两种失败模式。

闸门位于 `src/sync/in-progress-gate.js`，在 `src/server-main.js` 中挂载于 `requireLoginMiddleware` 之后。它是**按 handle 隔离**的：handle `A` 的同步进行中，不会阻塞 handle `B` 的写入。协调器在 `queueOnKey` 回调内部标记 `(handle, peerId)` 进行中（让队列中**等待**的拉取不会预先 409 用户写入），并在 `try/finally` 中清除（让抛出的错误、对端超时、待解决冲突的提前返回都能释放闸门）。三个协调器入口点参与了这一逻辑：`runPull`、`undoLastSync` 以及对端 `/session/ref` 触发的响应方 reconcile。

被闸门保护的路径名单是保守的：每一个写入磁盘 `data/<handle>/` 的 POST/PUT/PATCH/DELETE 都在列；读端点（`/get`、`/list`、`/recent`、`/search`）**不**被闸门拦截，让 UI 在同步运行期间仍能展示数据。被拒的写入收到一个结构化的 409 body（`{error: 'SYNC_IN_PROGRESS', retryAfterMs, peers}`）和一个 `Retry-After` HTTP 头部，让客户端能为重试加上去抖。

闸门**不**覆盖的场景：两个绑定到同一 handle 的对端（笔记本 + 手机）同时向同一用户的活动树推送——跨对端竞争。每个 `(userRoot, peerId)` 对都有独立的队列，`write-file-atomic` 保证单文件写入跨这个边界仍然一致，但跨文件一致性在此场景下由用户负责（不要并行运行同一 handle 的两个同步流）。

## 性能特征

典型用户（约 3000 个文件，约 100 MB）的表现：

- **首次配对**：数秒（快照 + 初始提交 + 全树对象传输）。耗时主要花在把每个文件从磁盘读出来做哈希；后续操作只会重新哈希 mtime 改变过的文件。
- **增量同步**：变更集较小时远低于一秒。线上开销只与新增 git 对象数量有关，与活动数据总量无关——一次输入的角色消息只会改一个 `chat_*.jsonl`，运送一个新 commit、每个被触及目录一个新 tree、加上一个新 blob。
- **小型同步的线上总量**：通常合计几 KB（commit + 几个 tree + 变更的 blob）。
- **影子 `.git` 目录**：大约是已同步活动数据大小的 40%；git 自带的 zlib 在 Luker 数据中占主导的小 JSON 文件上压缩得很好。

## 源文件清单

- `src/sync/categories.js`——同步数据分类注册表
- `src/sync/session.js`——token 缓存（沿用 `src/lan-migration.js` 的模式）
- `src/sync/shadow.js`——影子路径、`ensureShadowRepo`、`snapshotLiveToShadow`、`reconcileShadowToLive`
- `src/sync/objects.js`——线格式编解码（`readObjectForWire`、`writeObjectFromWire`）与对象图遍历（`fetchMissingObjects`、`hasObjectLocally`）
- `src/sync/conflicts.js`——`attemptMerge` 与 `applyResolutions`
- `src/sync/sqlite-snapshot.js`——`snapshotSqliteToFile`（`VACUUM INTO`）与 `replaceSqliteFile`
- `src/sync/state.js`——`state.json` 读写辅助函数
- `src/sync/orchestrator.js`——`runPull`、`undoLastSync`、`queueOnKey`、`isAncestor`，以及 SQLite 门控辅助函数
- `src/sync/in-progress-gate.js`——按 handle 隔离的 `SYNC_IN_PROGRESS` 注册表与 Express 中间件（spec §4.4）
- `src/endpoints/sync.js`——`/api/sync/v1/*` 的 HTTP 路由
- `src/middleware/basicAuth.js`——`SYNC_SESSION_PATH_PATTERN`，用于鉴权绕过
- `src/server-main.js`——`/api/sync/v1/session/*` 的 CSRF 跳过规则，让服务器到服务器的对端 fetch 可用
- `public/scripts/lan-sync.js` + `public/scripts/templates/userLanSync.html`——UI 面板，入口路径：账号 → 备份与恢复 → 局域网同步

## 测试

- `tests/sync/*.test.js`——每个模块的单元覆盖
- `tests/sync/integration/*.test.js`——通过 supertest 完成的两服务器集成测试，包含配对、同步、冲突、解决、撤销的全链路往返
