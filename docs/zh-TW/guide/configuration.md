# 基礎設定

Luker 的設定檔為專案根目錄下的 `config.yaml`。首次啟動時，如果該檔案不存在，Luker 會從 `default/config.yaml` 複製一份預設設定。

## 核心設定項

### 資料目錄

```yaml
dataRoot: ./data
```

所有使用者資料（角色卡、聊天記錄、預設、世界書等）的根目錄。多使用者模式下，每個使用者的資料儲存在 `<dataRoot>/<使用者名稱>/` 子目錄中。

### 連接埠設定

```yaml
port: 8000
```

服務監聽連接埠。如需從區域網路存取，還需將 `listen` 設為 `true`：

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

啟用 HTTPS 時，將 `enabled` 設為 `true` 並提供憑證和私鑰路徑。如果私鑰有密碼，填入 `keyPassphrase`。

### 代理設定

SillyTavern 支援透過 HTTP、HTTPS 或 SOCKS 代理轉發出站請求（如 API 呼叫），Luker 繼承了這一功能：

```yaml
requestProxy:
  enabled: false
  url: socks5://username:password@example.com:1080
  bypass:
    - localhost
    - 127.0.0.1
```

- `url`：代理伺服器地址，支援 `http://`、`https://`、`socks://`、`socks4://`、`socks4a://`、`socks5://`、`socks5h://` 和 `pac+*://` 協定
- `bypass`：不走代理的地址列表

### CORS 代理

```yaml
enableCorsProxy: false
```

啟用後，Luker 會提供一個 CORS 代理端點，用於前端跨域請求轉發。

## 認證與多使用者

### 基礎認證

```yaml
basicAuthMode: false
basicAuthUser:
  username: user
  password: password
```

啟用後，存取 Luker 需要輸入使用者名稱和密碼。適用於單一使用者場景。

### 多使用者模式

```yaml
enableUserAccounts: true
enableDiscreetLogin: false
perUserBasicAuth: false
```

- `enableUserAccounts`：啟用多使用者帳號系統，每個使用者擁有獨立的資料目錄
- `enableDiscreetLogin`：啟用隱蔽登入模式
- `perUserBasicAuth`：為每個使用者啟用獨立的 HTTP Basic 認證

### 密碼重設

如果你忘記了使用者密碼，可以透過命令列工具重設：

```bash
# 重設使用者密碼
node recover.js <使用者名稱> <新密碼>

# 例如重設 default-user 的密碼
node recover.js default-user myNewPassword

# 不提供密碼則清空密碼
node recover.js default-user
```

::: tip
此命令需要在 Luker 專案根目錄下執行，且服務無需處於執行狀態。
:::

### SSO 單點登入

```yaml
sso:
  autheliaAuth: false
  authentikAuth: false
```

Luker 支援透過 Authelia 或 Authentik 等反向代理認證方案實現單點登入。詳細設定請參閱 [認證與配額](/zh-TW/improvements/auth-and-quota)。

### 主機白名單

```yaml
hostWhitelist:
  enabled: false
  scan: true
  hosts: []
```

限制允許存取的主機地址。啟用 `scan` 後會記錄來自不在白名單中的不受信任主機的請求警告，但不會阻止它們（除非同時將 `enabled` 設定為 `true`）。

## 安全設定

### IP 白名單

```yaml
whitelistMode: true
enableForwardedWhitelist: true
whitelist:
  - ::1
  - 127.0.0.1
whitelistDockerHosts: true
```

預設啟用白名單模式，僅允許本機存取。如需區域網路存取，將對應 IP 加入 `whitelist` 列表，或關閉 `whitelistMode`。

### 工作階段與 CSRF

```yaml
sessionTimeout: -1
disableCsrfProtection: false
securityOverride: false
```

- `sessionTimeout`：工作階段逾時時間（秒），`-1` 表示不逾時
- `disableCsrfProtection`：停用 CSRF 保護（不建議）
- `securityOverride`：安全覆寫開關（僅用於除錯）

## 備份與儲存

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

- `checkIntegrity`：啟用聊天檔案完整性校驗，防止並行寫入衝突
- `throttleInterval`：備份節流間隔（毫秒），避免頻繁備份
- `maxTotalBackups`：聊天備份最大數量，`-1` 表示不限制

## 其他設定

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

- `logging`：日誌設定，`minLogLevel` 控制最低日誌等級
- `rateLimiting`：速率限制，`preferRealIpHeader` 在反向代理後使用真實 IP
- `thumbnails`：縮圖產生設定

## 外掛與擴充路徑

```yaml
serverPluginsPath: ./plugins
globalExtensionsPath: ./public/scripts/extensions/third-party
```

- `serverPluginsPath`：伺服器端外掛目錄
- `globalExtensionsPath`：全域前端擴充目錄（第三方擴充安裝位置）
