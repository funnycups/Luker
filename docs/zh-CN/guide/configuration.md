# 基础配置

Luker 的配置文件为项目根目录下的 `config.yaml`。首次启动时，如果该文件不存在，Luker 会从 `default/config.yaml` 复制一份默认配置。

## 核心配置项

### 数据目录

```yaml
dataRoot: ./data
```

所有用户数据（角色卡、聊天记录、预设、世界书等）的根目录。多用户模式下，每个用户的数据存储在 `<dataRoot>/<用户名>/` 子目录中。

### 端口设置

```yaml
port: 8000
```

服务监听端口。如需从局域网访问，还需将 `listen` 设为 `true`：

```yaml
listen: true
listenAddress:
  ipv4: 0.0.0.0
  ipv6: "[::]"
protocol:
  ipv4: true
  ipv6: false
```

### SSL/TLS

```yaml
ssl:
  enabled: false
  certPath: "./certs/cert.pem"
  keyPath: "./certs/privkey.pem"
  keyPassphrase: ""
```

启用 HTTPS 时，将 `enabled` 设为 `true` 并提供证书和私钥路径。如果私钥有密码，填入 `keyPassphrase`。

### 代理设置

SillyTavern 支持通过 HTTP、HTTPS 或 SOCKS 代理转发出站请求（如 API 调用），Luker 继承了这一功能：

```yaml
requestProxy:
  enabled: false
  url: socks5://username:password@example.com:1080
  bypass:
    - localhost
    - 127.0.0.1
```

- `url`：代理服务器地址，支持 `http://`、`https://`、`socks://`、`socks4://`、`socks4a://`、`socks5://`、`socks5h://` 和 `pac+*://` 协议
- `bypass`：不走代理的地址列表

### CORS 代理

```yaml
enableCorsProxy: false
```

启用后，Luker 会提供一个 CORS 代理端点，用于前端跨域请求转发。

## 认证与多用户

### 基础认证

```yaml
basicAuthMode: false
basicAuthUser:
  username: user
  password: password
```

启用后，访问 Luker 需要输入用户名和密码。适用于单用户场景。

### 多用户模式

```yaml
enableUserAccounts: true
enableDiscreetLogin: false
perUserBasicAuth: false
```

- `enableUserAccounts`：启用多用户账户系统，每个用户拥有独立的数据目录
- `enableDiscreetLogin`：启用隐蔽登录模式
- `perUserBasicAuth`：为每个用户启用独立的 HTTP Basic 认证

### 密码重置

如果你忘记了用户密码，可以通过命令行工具重置：

```bash
# 重置用户密码
node recover.js <用户名> <新密码>

# 例如重置 default-user 的密码
node recover.js default-user myNewPassword

# 不提供密码则清空密码
node recover.js default-user
```

::: tip
此命令需要在 Luker 项目根目录下执行，且服务无需处于运行状态。
:::

### SSO 单点登录

```yaml
sso:
  autheliaAuth: false
  authentikAuth: false
```

Luker 支持通过 Authelia 或 Authentik 等反向代理认证方案实现单点登录。详细配置请参阅 [认证与配额](/zh-CN/improvements/auth-and-quota)。

### 主机白名单

```yaml
hostWhitelist:
  enabled: false
  scan: true
  hosts: []
```

限制允许访问的主机地址。启用 `scan` 后会记录来自不在白名单中的不受信任主机的请求警告，但不会阻止它们（除非同时将 `enabled` 设置为 `true`）。

## 安全设置

### IP 白名单

```yaml
whitelistMode: true
enableForwardedWhitelist: true
whitelist:
  - ::1
  - 127.0.0.1
whitelistDockerHosts: true
```

默认启用白名单模式，仅允许本机访问。如需局域网访问，将对应 IP 加入 `whitelist` 列表，或关闭 `whitelistMode`。

::: warning 关闭白名单可能导致进程退出
设置 `whitelistMode: false` 后，Luker 要求至少存在另一种保护机制，否则启动时会判定为不安全配置并直接终止进程（Docker 下表现为容器反复重启）。安全暴露服务时，请至少满足以下任一条件：

- 启用 `basicAuthMode` 并配置 `basicAuthUser` —— 详见 [鉴权](/zh-CN/guide/authentication)
- 启用多用户模式（`enableUserAccounts: true`），**并且**通过 `node recover.js default-user <密码>` 给所有 admin 用户设置密码 —— 详见 [鉴权 › 密码重置](/zh-CN/guide/authentication#密码重置)。两步缺一不可：只开多用户但 admin 没密码仍会被拦下，只设密码但没开多用户同样会被拦下。
- 设置 `securityOverride: true`（仅用于调试，**严禁**用于公网部署）
:::

### 会话与 CSRF

```yaml
sessionTimeout: -1
disableCsrfProtection: false
securityOverride: false
```

- `sessionTimeout`：会话超时时间（秒），`-1` 表示不超时
- `disableCsrfProtection`：禁用 CSRF 保护（不推荐）
- `securityOverride`：安全覆盖开关（仅用于调试）

## 备份与存储

```yaml
backups:
  common:
    numberOfBackups: 50
  chat:
    enabled: true
    checkIntegrity: true
    maxTotalBackups: -1
    throttleInterval: 10000
  allowFullDataBackup: true
```

- `checkIntegrity`：启用聊天文件完整性校验，防止并发写入冲突
- `throttleInterval`：备份节流间隔（毫秒），避免频繁备份
- `maxTotalBackups`：聊天备份最大数量，`-1` 表示不限制

## 存储后端

```yaml
storage:
  mode: fs
  mysql:
    url: mysql://user:pass@host:3306/luker
    poolSize: 10
  postgres:
    url: postgresql://user:pass@host:5432/luker
    poolSize: 10
```

Luker 支持四种用户数据持久化后端，由 `mode` 选择；只有匹配的子块会被读取。

- `fs`（默认）：每条聊天/预设/世界书等都是 `<dataRoot>/<handle>/` 下的一个文件。最适合单用户安装，也是最方便手动查看的后端。
- `sqlite`：每个用户一个独立的 `luker-storage.sqlite` 文件，位于 `<dataRoot>/<handle>/`。适合希望使用单文件事务存储、又不想运行独立数据库服务的安装。
- `mysql`：所有用户共享一个 MySQL 8.0+ 数据库，以 `handle` 列区分。适合已经在跑 MySQL 的多用户部署。
- `postgres`：所有用户共享一个 PostgreSQL 14+ 数据库，结构与 MySQL 相同，使用 PostgreSQL。

切换后端前需先运行迁移工具。管理面板的「存储后端」标签页提供 `fs ↔ sqlite` 的可视化迁移流程，并在 `<dataRoot>/_storage-migrations/` 留下永久备份。切换到/离开 `mysql` 或 `postgres` 时，可在 `config.yaml` 修改 `storage.mode` 后重启服务器；迁移工具目前只在 `fs` 与 `sqlite` 之间路由，因此把已有安装迁到 MySQL 或 PostgreSQL 需要要么从空数据库开始，要么经 SQLite 中转。

无图形界面时，可用 `node scripts/storage-migrate.js --from fs --to sqlite`（以及反向方向）跑同样的迁移流程。

## 其他配置

```yaml
logging:
  enableAccessLog: true
  minLogLevel: 0

rateLimiting:
  preferRealIpHeader: false

thumbnails:
  enabled: true
  format: jpg
  quality: 95
```

- `logging`：日志配置，`minLogLevel` 控制最低日志级别
- `rateLimiting`：速率限制，`preferRealIpHeader` 在反向代理后使用真实 IP
- `thumbnails`：缩略图生成配置

## 插件与扩展路径

```yaml
serverPluginsPath: ./plugins
globalExtensionsPath: ./public/scripts/extensions/third-party
```

- `serverPluginsPath`：服务端插件目录
- `globalExtensionsPath`：全局前端扩展目录（第三方扩展安装位置）
