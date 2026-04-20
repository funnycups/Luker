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
